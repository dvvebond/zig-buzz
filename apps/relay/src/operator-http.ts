import type { IncomingMessage, ServerResponse } from "node:http";

import { unixNow } from "@buzz/core";
import { RemoteProtocolError } from "@buzz/remote-agent-protocol";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { authenticateNip98, type Nip98ReplayGuard } from "./nip98.js";

const PUBKEY = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATOR_PATHS = new Set([
  "/operator/communities",
  "/operator/communities/archive",
  "/operator/communities/availability",
  "/operator/communities/transfer",
  "/operator/communities/unarchive",
]);
const MAX_BODY_BYTES = 64 * 1024;

const provisionSchema = z
  .object({
    create_only: z.boolean().optional().default(false),
    host: z.string().min(1).max(255),
    initial_owner_pubkey: z.string().regex(PUBKEY).optional(),
  })
  .strict();
const lifecycleSchema = z
  .object({
    host: z.string().min(1).max(255),
    owner_pubkey: z.string().regex(PUBKEY),
  })
  .strict();
const transferSchema = z
  .object({
    community_id: z.string().regex(UUID),
    expected_owner_pubkey: z.string().regex(PUBKEY),
    new_owner_pubkey: z.string().regex(PUBKEY),
  })
  .strict();

export type RelayOperatorOptions = {
  readonly apiOrigin: URL;
  readonly deploymentHost: string;
  readonly maxCommunitiesPerOwner?: number;
  readonly onCommunityArchived?: (
    communityId: string,
    host: string,
  ) => Promise<void>;
  readonly onMembershipChanged?: (
    communityId: string,
    host: string,
  ) => Promise<void>;
  readonly operatorPubkeys: ReadonlySet<string>;
  readonly pool: Pool;
  readonly replay: Nip98ReplayGuard;
};

/**
 * Deployment-global community management plane.
 *
 * Operator authorization is deliberately independent of tenant resolution:
 * the signed URL is built from the configured operator origin and the raw
 * request target, while the inbound Host header has no authority.
 */
export class RelayOperatorHttp {
  readonly #apiOrigin: string;
  readonly #deploymentHost: string;
  readonly #maxCommunitiesPerOwner: number;
  readonly #onCommunityArchived:
    | RelayOperatorOptions["onCommunityArchived"]
    | undefined;
  readonly #onMembershipChanged:
    | RelayOperatorOptions["onMembershipChanged"]
    | undefined;
  readonly #operatorPubkeys: ReadonlySet<string>;
  readonly #pool: Pool;
  readonly #replay: Nip98ReplayGuard;

  public constructor(options: RelayOperatorOptions) {
    this.#apiOrigin = validateOperatorOrigin(options.apiOrigin);
    this.#deploymentHost = normalizeCandidateHost(options.deploymentHost);
    this.#operatorPubkeys = options.operatorPubkeys;
    this.#pool = options.pool;
    this.#replay = options.replay;
    this.#maxCommunitiesPerOwner = options.maxCommunitiesPerOwner ?? 3;
    if (
      !Number.isSafeInteger(this.#maxCommunitiesPerOwner) ||
      this.#maxCommunitiesPerOwner < 1
    ) {
      throw new TypeError(
        "maxCommunitiesPerOwner must be a positive safe integer",
      );
    }
    this.#onCommunityArchived = options.onCommunityArchived;
    this.#onMembershipChanged = options.onMembershipChanged;
  }

  public async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const requestTarget = request.url ?? "";
    let parsed: URL;
    try {
      parsed = new URL(requestTarget, this.#apiOrigin);
    } catch {
      return false;
    }
    if (!OPERATOR_PATHS.has(parsed.pathname)) return false;
    const expectedMethod =
      parsed.pathname === "/operator/communities" ||
      parsed.pathname === "/operator/communities/availability"
        ? new Set(["GET", "POST"])
        : new Set(["POST"]);
    const method = request.method?.toUpperCase() ?? "";
    if (!expectedMethod.has(method)) {
      response.setHeader("Allow", [...expectedMethod].join(", "));
      operatorJson(response, 405, { error: "method not allowed" });
      return true;
    }
    if (
      parsed.pathname === "/operator/communities/availability" &&
      method !== "GET"
    ) {
      response.setHeader("Allow", "GET");
      operatorJson(response, 405, { error: "method not allowed" });
      return true;
    }

    try {
      const body =
        method === "POST"
          ? await readJsonBody(request)
          : await readEmptyBody(request);
      const signer = await authenticateNip98({
        authorizationHeader: request.headers.authorization,
        body,
        method,
        now: unixNow(),
        publicUrl: `${this.#apiOrigin}${requestTarget}`,
        replayGuard: this.#replay,
        replayScope: "operator-management",
      });
      if (!this.#operatorPubkeys.has(signer)) {
        throw new OperatorHttpError(
          403,
          "actor not authorized: not a relay operator",
        );
      }

      if (method === "GET") {
        if (parsed.pathname === "/operator/communities/availability") {
          await this.#availability(parsed, response);
        } else {
          await this.#list(parsed, response);
        }
        return true;
      }

      const json = parseBodyJson(body);
      switch (parsed.pathname) {
        case "/operator/communities":
          await this.#provision(json, response);
          break;
        case "/operator/communities/archive":
          await this.#archive(json, response);
          break;
        case "/operator/communities/unarchive":
          await this.#unarchive(json, response);
          break;
        case "/operator/communities/transfer":
          await this.#transfer(json, response);
          break;
        default:
          throw new OperatorHttpError(404, "not found");
      }
    } catch (error) {
      writeOperatorError(response, error);
    }
    return true;
  }

  async #availability(url: URL, response: ServerResponse): Promise<void> {
    requireOnlyQueryKeys(url, ["host"]);
    const requestedHost = url.searchParams.get("host");
    if (requestedHost === null) {
      throw new OperatorHttpError(400, "host query parameter is required");
    }
    const normalizedHost = normalizeCandidateHost(requestedHost);
    const result = await this.#pool.query<{ readonly id: string }>(
      `SELECT id
       FROM communities
       WHERE lower(host) = lower($1)
       LIMIT 1`,
      [normalizedHost],
    );
    operatorJson(response, 200, {
      available: result.rows[0] === undefined,
      community_id: result.rows[0]?.id ?? null,
      host: requestedHost,
      normalized_host: normalizedHost,
    });
  }

  async #list(url: URL, response: ServerResponse): Promise<void> {
    requireOnlyQueryKeys(url, ["owner_pubkey"]);
    const ownerPubkey = url.searchParams.get("owner_pubkey");
    if (!ownerPubkey || !PUBKEY.test(ownerPubkey)) {
      throw new OperatorHttpError(
        400,
        "invalid owner_pubkey: expected 64-char lowercase hex pubkey",
      );
    }
    const result = await this.#pool.query<{
      readonly archived_at: Date | null;
      readonly created_at: Date;
      readonly host: string;
      readonly id: string;
    }>(
      `SELECT c.id, c.host, c.created_at, c.archived_at
       FROM communities c
       JOIN relay_members rm ON rm.community_id = c.id
       WHERE rm.pubkey = $1 AND rm.role = 'owner'
       ORDER BY c.created_at, c.host`,
      [ownerPubkey],
    );
    operatorJson(response, 200, {
      communities: result.rows.map((row) => ({
        archived_at: row.archived_at,
        community_id: row.id,
        created_at: row.created_at,
        host: row.host,
      })),
      owner_pubkey: ownerPubkey,
    });
  }

  async #provision(value: unknown, response: ServerResponse): Promise<void> {
    const request = parseSchema(provisionSchema, value);
    const canonicalHost = normalizeCandidateHost(request.host);
    if (canonicalHost !== request.host) {
      throw new OperatorHttpError(
        400,
        `host is not normalized: expected ${JSON.stringify(canonicalHost)}`,
      );
    }
    if (request.create_only && !request.initial_owner_pubkey) {
      throw new OperatorHttpError(
        400,
        "initial_owner_pubkey is required when create_only is true",
      );
    }

    const result = request.create_only
      ? await this.#createOnly(
          canonicalHost,
          request.initial_owner_pubkey as string,
        )
      : await this.#ensureCommunity(
          canonicalHost,
          request.initial_owner_pubkey,
        );
    if (result === "host_exists") {
      throw new OperatorHttpError(409, "community already exists");
    }
    if (result === "limit_reached") {
      throw new OperatorHttpError(
        409,
        "limit_reached: owner already owns the maximum number of communities",
      );
    }
    if (request.initial_owner_pubkey) {
      await this.#notifyMembershipChanged(result.id, result.host);
    }
    operatorJson(response, 200, {
      community_id: result.id,
      host: result.host,
      ...(request.initial_owner_pubkey
        ? { owner_pubkey: request.initial_owner_pubkey }
        : {}),
      status: result.created ? "created" : "existed",
    });
  }

  async #createOnly(
    host: string,
    ownerPubkey: string,
  ): Promise<
    | { readonly created: true; readonly host: string; readonly id: string }
    | "host_exists"
    | "limit_reached"
  > {
    return this.#transaction(async (client) => {
      await advisoryOwnerLock(client, ownerPubkey);
      const inserted = await client.query<{
        readonly host: string;
        readonly id: string;
      }>(
        `INSERT INTO communities (host)
         VALUES ($1)
         ON CONFLICT (lower(host)) DO NOTHING
         RETURNING id, host`,
        [host],
      );
      const row = inserted.rows[0];
      if (!row) {
        const retry = await client.query<{
          readonly host: string;
          readonly id: string;
        }>(
          `SELECT c.id, c.host
           FROM communities c
           JOIN relay_members rm ON rm.community_id = c.id
           WHERE lower(c.host) = lower($1)
             AND lower(rm.pubkey) = lower($2)
             AND rm.role = 'owner'
             AND c.archived_at IS NULL
           LIMIT 1`,
          [host, ownerPubkey],
        );
        const existing = retry.rows[0];
        return existing
          ? { created: true as const, host: existing.host, id: existing.id }
          : "host_exists";
      }
      const count = await client.query<{ readonly count: string }>(
        `SELECT count(*)::text AS count
         FROM relay_members
         WHERE pubkey = $1 AND role = 'owner'`,
        [ownerPubkey],
      );
      if (
        Number.parseInt(count.rows[0]?.count ?? "0", 10) >=
        this.#maxCommunitiesPerOwner
      ) {
        return "limit_reached";
      }
      await client.query(
        `INSERT INTO relay_members (community_id, pubkey, role, added_by)
         VALUES ($1, $2, 'owner', NULL)`,
        [row.id, ownerPubkey],
      );
      return { created: true as const, host: row.host, id: row.id };
    });
  }

  async #ensureCommunity(
    host: string,
    ownerPubkey: string | undefined,
  ): Promise<{
    readonly created: boolean;
    readonly host: string;
    readonly id: string;
  }> {
    return this.#transaction(async (client) => {
      const inserted = await client.query<{
        readonly created: boolean;
        readonly host: string;
        readonly id: string;
      }>(
        `INSERT INTO communities (host)
         VALUES ($1)
         ON CONFLICT (lower(host))
         DO UPDATE SET host = communities.host
         RETURNING id, host, (xmax = 0) AS created`,
        [host],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("community upsert returned no row");
      if (ownerPubkey) {
        await client.query(
          `INSERT INTO relay_members (community_id, pubkey, role, added_by)
           VALUES ($1, $2, 'owner', NULL)
           ON CONFLICT (community_id, pubkey)
           DO UPDATE SET role = 'owner', updated_at = now()`,
          [row.id, ownerPubkey],
        );
        await client.query(
          `UPDATE relay_members
           SET role = 'admin', updated_at = now()
           WHERE community_id = $1
             AND role = 'owner'
             AND pubkey <> $2`,
          [row.id, ownerPubkey],
        );
      }
      return row;
    });
  }

  async #archive(value: unknown, response: ServerResponse): Promise<void> {
    const request = parseSchema(lifecycleSchema, value);
    const host = normalizeCandidateHost(request.host);
    if (host === this.#deploymentHost) {
      throw new OperatorHttpError(
        409,
        "the deployment community cannot be archived",
      );
    }
    const result = await this.#pool.query<{
      readonly archived_at: Date;
      readonly host: string;
      readonly id: string;
    }>(
      `UPDATE communities c
       SET archived_at = COALESCE(c.archived_at, now())
       FROM relay_members rm
       WHERE lower(c.host) = lower($1)
         AND rm.community_id = c.id
         AND lower(rm.pubkey) = lower($2)
         AND rm.role = 'owner'
         AND lower(c.host) <> lower($3)
       RETURNING c.id, c.host, c.archived_at`,
      [host, request.owner_pubkey, this.#deploymentHost],
    );
    const row = result.rows[0];
    if (!row) throw new OperatorHttpError(404, "community not found");
    try {
      await this.#onCommunityArchived?.(row.id, row.host);
    } catch {
      operatorJson(response, 503, {
        archived_at: row.archived_at,
        community_id: row.id,
        error: "connection propagation pending — retry this request",
        host: row.host,
        propagation: "pending",
        status: "archived",
      });
      return;
    }
    operatorJson(response, 200, {
      archived_at: row.archived_at,
      community_id: row.id,
      host: row.host,
      status: "archived",
    });
  }

  async #unarchive(value: unknown, response: ServerResponse): Promise<void> {
    const request = parseSchema(lifecycleSchema, value);
    const host = normalizeCandidateHost(request.host);
    const result = await this.#pool.query<{
      readonly host: string;
      readonly id: string;
    }>(
      `UPDATE communities c
       SET archived_at = NULL
       FROM relay_members rm
       WHERE lower(c.host) = lower($1)
         AND rm.community_id = c.id
         AND lower(rm.pubkey) = lower($2)
         AND rm.role = 'owner'
       RETURNING c.id, c.host`,
      [host, request.owner_pubkey],
    );
    const row = result.rows[0];
    if (!row) throw new OperatorHttpError(404, "community not found");
    operatorJson(response, 200, {
      archived_at: null,
      community_id: row.id,
      host: row.host,
      status: "active",
    });
  }

  async #transfer(value: unknown, response: ServerResponse): Promise<void> {
    const request = parseSchema(transferSchema, value);
    const result = await this.#transaction(async (client) => {
      await advisoryOwnerLock(client, request.new_owner_pubkey);
      const owners = await client.query<{ readonly pubkey: string }>(
        `SELECT pubkey
         FROM relay_members
         WHERE community_id = $1::uuid AND role = 'owner'
         FOR UPDATE`,
        [request.community_id],
      );
      if (owners.rows.length === 0) return "no_owner" as const;
      if (
        !owners.rows.some(
          ({ pubkey }) => pubkey === request.expected_owner_pubkey,
        )
      ) {
        return "owner_conflict" as const;
      }
      if (
        owners.rows.length === 1 &&
        owners.rows[0]?.pubkey === request.new_owner_pubkey
      ) {
        return "already_owner" as const;
      }
      const previousOwner =
        owners.rows.length === 1
          ? owners.rows[0]?.pubkey
          : owners.rows.find(
              ({ pubkey }) => pubkey !== request.new_owner_pubkey,
            )?.pubkey;
      const count = await client.query<{ readonly count: string }>(
        `SELECT count(*)::text AS count
         FROM relay_members
         WHERE pubkey = $1 AND role = 'owner'`,
        [request.new_owner_pubkey],
      );
      if (
        Number.parseInt(count.rows[0]?.count ?? "0", 10) >=
        this.#maxCommunitiesPerOwner
      ) {
        return "limit_reached" as const;
      }
      await client.query(
        `INSERT INTO relay_members (community_id, pubkey, role, added_by)
         VALUES ($1::uuid, $2, 'owner', NULL)
         ON CONFLICT (community_id, pubkey)
         DO UPDATE SET role = 'owner', updated_at = now()`,
        [request.community_id, request.new_owner_pubkey],
      );
      await client.query(
        `UPDATE relay_members
         SET role = 'member', updated_at = now()
         WHERE community_id = $1::uuid
           AND role = 'owner'
           AND pubkey <> $2`,
        [request.community_id, request.new_owner_pubkey],
      );
      const host = await client.query<{ readonly host: string }>(
        "SELECT host FROM communities WHERE id = $1::uuid LIMIT 1",
        [request.community_id],
      );
      return {
        host: host.rows[0]?.host,
        previousOwner,
        status: "transferred" as const,
      };
    });
    if (result === "no_owner") {
      throw new OperatorHttpError(
        404,
        "community has no owner to transfer from",
      );
    }
    if (result === "owner_conflict") {
      throw new OperatorHttpError(
        409,
        "owner_conflict: the current owner no longer matches expected_owner_pubkey",
      );
    }
    if (result === "limit_reached") {
      throw new OperatorHttpError(
        409,
        "limit_reached: transferee already owns the maximum number of communities",
      );
    }
    if (result !== "already_owner" && result.host) {
      await this.#notifyMembershipChanged(request.community_id, result.host);
    }
    operatorJson(response, 200, {
      community_id: request.community_id,
      new_owner_pubkey: request.new_owner_pubkey,
      ...(result !== "already_owner" && result.previousOwner
        ? { previous_owner: result.previousOwner }
        : {}),
      status: result === "already_owner" ? "already_owner" : result.status,
    });
  }

  async #notifyMembershipChanged(
    communityId: string,
    host: string,
  ): Promise<void> {
    try {
      await this.#onMembershipChanged?.(communityId, host);
    } catch {
      // The database mutation is authoritative. Snapshot publication is
      // repairable and must not make an idempotent operator retry misleading.
    }
  }

  async #transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      if (result === "limit_reached" || result === "host_exists") {
        await client.query("ROLLBACK");
      } else {
        await client.query("COMMIT");
      }
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

class OperatorHttpError extends Error {
  public constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new OperatorHttpError(400, "operator request body is invalid");
  }
  return result.data;
}

function parseBodyJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new OperatorHttpError(400, "operator request body is invalid JSON");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Buffer> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")
  ) {
    throw new OperatorHttpError(415, "content-type must be application/json");
  }
  return readBoundedBody(request);
}

async function readEmptyBody(request: IncomingMessage): Promise<Buffer> {
  const body = await readBoundedBody(request);
  if (body.length !== 0) {
    throw new OperatorHttpError(400, "GET request body must be empty");
  }
  return body;
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(rawChunk as Uint8Array);
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new OperatorHttpError(413, "operator request body is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function requireOnlyQueryKeys(url: URL, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allowedSet.has(key)) {
      throw new OperatorHttpError(400, `unexpected query parameter: ${key}`);
    }
  }
  for (const key of allowed) {
    if (url.searchParams.getAll(key).length > 1) {
      throw new OperatorHttpError(400, `duplicate query parameter: ${key}`);
    }
  }
}

function validateOperatorOrigin(url: URL): string {
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new TypeError(
      "operator API origin must be an http(s) origin without credentials, path, query, or fragment",
    );
  }
  return url.origin;
}

export function normalizeCandidateHost(value: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 255 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    }) ||
    /[/@?#]/.test(value)
  ) {
    throw new OperatorHttpError(400, "host is not a valid bare authority");
  }
  let authority = value.toLowerCase();
  if (authority.endsWith(":443")) {
    authority = authority.slice(0, -4);
  } else if (authority.endsWith(":80")) {
    authority = authority.slice(0, -3);
  }
  const bracket = authority.startsWith("[");
  if (bracket) {
    const close = authority.indexOf("]");
    if (close < 0) {
      throw new OperatorHttpError(400, "host is not a valid authority");
    }
  } else {
    const colon = authority.lastIndexOf(":");
    const hostPart = colon >= 0 ? authority.slice(0, colon) : authority;
    const portPart = colon >= 0 ? authority.slice(colon + 1) : "";
    const withoutDot = hostPart.endsWith(".")
      ? hostPart.slice(0, -1)
      : hostPart;
    authority = `${withoutDot}${colon >= 0 ? `:${portPart}` : ""}`;
  }
  let url: URL;
  try {
    url = new URL(`http://${authority}/`);
  } catch {
    throw new OperatorHttpError(400, "host is not a valid authority");
  }
  if (url.username || url.password || url.pathname !== "/") {
    throw new OperatorHttpError(400, "host is not a valid bare authority");
  }
  const hostname = url.hostname;
  if (!hostname.startsWith("[")) {
    if (Buffer.byteLength(hostname, "ascii") > 253) {
      throw new OperatorHttpError(400, "domain name is too long");
    }
    for (const label of hostname.split(".")) {
      if (
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
      ) {
        throw new OperatorHttpError(400, "domain label is invalid");
      }
    }
  }
  const normalized = url.host;
  if (Buffer.byteLength(normalized, "utf8") > 255) {
    throw new OperatorHttpError(400, "host is too long");
  }
  return normalized;
}

function advisoryOwnerLock(
  client: PoolClient,
  ownerPubkey: string,
): Promise<unknown> {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(ownerPubkey, "ascii")) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
    BigInt.asIntN(64, hash).toString(),
  ]);
}

function writeOperatorError(response: ServerResponse, error: unknown): void {
  if (error instanceof OperatorHttpError) {
    operatorJson(response, error.status, { error: error.message });
    return;
  }
  if (error instanceof RemoteProtocolError) {
    const status =
      error.code === "RATE_LIMITED"
        ? 429
        : error.code === "CAPABILITY_DENIED"
          ? 403
          : 401;
    operatorJson(response, status, { error: error.message });
    return;
  }
  operatorJson(response, 500, { error: "operator request failed" });
}

function operatorJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
