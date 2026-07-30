import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { TokenBucketRateLimiter } from "@buzz/auth";
import { unixNow } from "@buzz/core";
import type { Pool, PoolClient } from "pg";

import { authenticateNip98Identity, type Nip98ReplayGuard } from "./nip98.js";

const DEFAULT_TTL_SECONDS = 72 * 60 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_USES = 10_000;
const MAX_BODY_BYTES = 64 * 1024;
const POLICY_RECEIPT_SECONDS = 10 * 60;
const CODE = /^v2\.([A-Za-z0-9_-]{43})$/;

export type JoinPolicy = {
  ageAttestationRequired: boolean;
  privacyMarkdown: string | null;
  termsMarkdown: string | null;
  version: string;
};

type MemoryInvite = {
  createdBy: string;
  expiresAt: number;
  maxUses: number | null;
  tokenHash: string;
  useCount: number;
};

export class RelayInviteHttp {
  readonly #claimRate = new TokenBucketRateLimiter({
    capacity: 10,
    refillPerSecond: 10 / 60,
    maximumKeys: 10_000,
  });
  readonly #community: string;
  readonly #memoryInvites = new Map<string, MemoryInvite>();
  readonly #memoryMembers = new Set<string>();
  readonly #ownerPubkeys: ReadonlySet<string>;
  readonly #policy: JoinPolicy | null;
  readonly #pool: Pool | undefined;
  readonly #publicUrl: URL;
  readonly #receiptKey: Buffer;
  readonly #replay: Nip98ReplayGuard;
  readonly #replayScope: string;
  readonly #onMemberAdded: (pubkey: string) => Promise<void>;

  constructor(input: {
    community: string;
    ownerPubkeys: ReadonlySet<string>;
    publicUrl: URL;
    replay: Nip98ReplayGuard;
    joinPolicy?: JoinPolicy;
    pool?: Pool;
    relaySecretKey?: Uint8Array;
    replayScope: string;
    onMemberAdded?: (pubkey: string) => Promise<void>;
  }) {
    this.#community = input.community;
    this.#ownerPubkeys = input.ownerPubkeys;
    this.#publicUrl = input.publicUrl;
    this.#replay = input.replay;
    this.#replayScope = input.replayScope;
    this.#policy = input.joinPolicy ?? null;
    this.#pool = input.pool;
    this.#onMemberAdded = input.onMemberAdded ?? (async () => undefined);
    const source = input.relaySecretKey ?? randomBytes(32);
    this.#receiptKey = createHash("sha256")
      .update(source)
      .update("buzz-invite-v1", "utf8")
      .digest();
    for (const owner of input.ownerPubkeys) this.#memoryMembers.add(owner);
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const url = new URL(request.url ?? "/", httpBaseUrl(this.#publicUrl));
    if (request.method === "GET" && url.pathname === "/api/join-policy") {
      noStore(response);
      json(response, 200, {
        ...(this.#policy
          ? {
              policy: {
                age_attestation_required: this.#policy.ageAttestationRequired,
                ...(this.#policy.privacyMarkdown
                  ? { privacy_markdown: this.#policy.privacyMarkdown }
                  : {}),
                ...(this.#policy.termsMarkdown
                  ? { terms_markdown: this.#policy.termsMarkdown }
                  : {}),
                version: this.#policy.version,
              },
            }
          : {}),
      });
      return true;
    }
    if (
      request.method === "GET" &&
      (url.pathname === "/api/join-policy/terms" ||
        url.pathname === "/api/join-policy/privacy")
    ) {
      const terms = url.pathname.endsWith("/terms");
      const markdown = terms
        ? this.#policy?.termsMarkdown
        : this.#policy?.privacyMarkdown;
      if (!markdown) {
        json(response, 404, { error: "join_policy_not_configured" });
        return true;
      }
      noStore(response);
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      );
      response.end(
        policyHtml(terms ? "Terms of Service" : "Privacy Policy", markdown),
      );
      return true;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/invites/accept-policy"
    ) {
      await this.#acceptPolicy(request, response);
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/invites") {
      await this.#mint(request, response, url);
      return true;
    }
    if (request.method === "POST" && url.pathname === "/api/invites/claim") {
      await this.#claim(request, response, url);
      return true;
    }
    return false;
  }

  async #acceptPolicy(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (!this.#policy) throw httpError(404, "join_policy_not_configured");
      const body = await readJson(request);
      const code = requireCode(body.code);
      if (
        body.policy_version !== this.#policy.version ||
        (this.#policy.ageAttestationRequired && body.age_confirmed !== true)
      ) {
        throw httpError(400, "join_policy_not_accepted");
      }
      const expiresAt = unixNow() + POLICY_RECEIPT_SECONDS;
      // Preserve the Rust relay receipt contract during the TypeScript
      // migration: canonical compact JSON, then base64url(payload).HMAC.
      const payload = Buffer.from(
        JSON.stringify({
          c: hashCode(code),
          v: this.#policy.version,
          e: expiresAt,
        }),
        "utf8",
      );
      const mac = createHmac("sha256", this.#receiptKey)
        .update(payload)
        .digest("base64url");
      noStore(response);
      json(response, 200, {
        receipt: `${payload.toString("base64url")}.${mac}`,
      });
    } catch (error) {
      writeError(response, error);
    }
  }

  async #mint(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    try {
      const bodyBytes = await readBody(request);
      const identity = await authenticateNip98Identity({
        authorizationHeader: request.headers.authorization,
        body: bodyBytes,
        method: "POST",
        now: unixNow(),
        publicUrl: url.toString(),
        replayGuard: this.#replay,
        replayScope: this.#replayScope,
      });
      if (!(await this.#mayMint(identity.pubkey))) {
        throw httpError(403, "only relay owners and admins can create invites");
      }
      const body = parseJsonObject(bodyBytes);
      const ttl =
        body.ttl_secs === undefined
          ? DEFAULT_TTL_SECONDS
          : requireInteger(
              body.ttl_secs,
              "ttl_secs",
              MIN_TTL_SECONDS,
              MAX_TTL_SECONDS,
            );
      const maxUses =
        body.max_uses === undefined || body.max_uses === null
          ? null
          : requireInteger(body.max_uses, "max_uses", 1, MAX_USES);
      const code = `v2.${randomBytes(32).toString("base64url")}`;
      const tokenHash = hashCode(code);
      const expiresAt = unixNow() + ttl;
      if (this.#pool) {
        const communityId = await resolveCommunityId(
          this.#pool,
          this.#community,
        );
        await this.#pool.query(
          `INSERT INTO relay_invites (
             community_id, token_hash, role, max_uses, expires_at, created_by
           )
           VALUES ($1, $2, 'member', $3, to_timestamp($4), $5)`,
          [
            communityId,
            Buffer.from(tokenHash, "hex"),
            maxUses,
            expiresAt,
            identity.pubkey,
          ],
        );
      } else {
        this.#memoryInvites.set(tokenHash, {
          createdBy: identity.pubkey,
          expiresAt,
          maxUses,
          tokenHash,
          useCount: 0,
        });
      }
      const landing = new URL(`/invite/${code}`, httpBaseUrl(this.#publicUrl));
      noStore(response);
      json(response, 201, {
        code,
        expires_at: expiresAt,
        max_uses: maxUses,
        url: landing.toString(),
        uses_remaining: maxUses,
      });
    } catch (error) {
      writeError(response, error);
    }
  }

  async #claim(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    try {
      const bodyBytes = await readBody(request);
      const identity = await authenticateNip98Identity({
        authorizationHeader: request.headers.authorization,
        body: bodyBytes,
        method: "POST",
        now: unixNow(),
        publicUrl: url.toString(),
        replayGuard: this.#replay,
        replayScope: this.#replayScope,
      });
      if (
        !this.#claimRate.consume(`${this.#community}:${identity.pubkey}`, 1)
      ) {
        throw httpError(429, "too many invite claim attempts, slow down");
      }
      const body = parseJsonObject(bodyBytes);
      const code = requireCode(body.code);
      this.#verifyPolicyReceipt(
        code,
        typeof body.policy_receipt === "string" ? body.policy_receipt : null,
      );
      const outcome = this.#pool
        ? await claimPostgres(
            this.#pool,
            this.#community,
            hashCode(code),
            identity.pubkey,
            this.#policy?.version ?? null,
          )
        : claimMemory(
            this.#memoryInvites,
            this.#memoryMembers,
            hashCode(code),
            identity.pubkey,
            this.#community,
          );
      if (outcome.status === "joined") {
        await this.#onMemberAdded(identity.pubkey);
      }
      noStore(response);
      json(response, 200, outcome);
    } catch (error) {
      writeError(response, error);
    }
  }

  async #mayMint(pubkey: string): Promise<boolean> {
    if (this.#ownerPubkeys.has(pubkey)) return true;
    if (!this.#pool) return false;
    const result = await this.#pool.query(
      `SELECT 1
       FROM relay_members rm
       JOIN communities c ON c.id = rm.community_id
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND rm.pubkey = $2
         AND rm.role IN ('owner', 'admin')
       LIMIT 1`,
      [this.#community, pubkey],
    );
    return result.rowCount === 1;
  }

  #verifyPolicyReceipt(code: string, receipt: string | null): void {
    if (!this.#policy) return;
    if (!receipt || Buffer.byteLength(receipt, "utf8") > 2_048) {
      throw httpError(403, "join_policy_required");
    }
    const parts = receipt.split(".");
    if (
      parts.length !== 2 ||
      !parts[0] ||
      !parts[1] ||
      !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[1])
    ) {
      throw httpError(403, "join_policy_required");
    }
    const payload = decodeCanonicalBase64Url(parts[0]);
    const received = decodeCanonicalBase64Url(parts[1]);
    const expected = createHmac("sha256", this.#receiptKey)
      .update(payload)
      .digest();
    if (
      received.byteLength !== expected.byteLength ||
      !timingSafeEqual(received, expected)
    ) {
      throw httpError(403, "join_policy_required");
    }
    let evidence: unknown;
    try {
      evidence = JSON.parse(payload.toString("utf8"));
    } catch {
      throw httpError(403, "join_policy_required");
    }
    if (
      typeof evidence !== "object" ||
      evidence === null ||
      Array.isArray(evidence)
    ) {
      throw httpError(403, "join_policy_required");
    }
    const record = evidence as Record<string, unknown>;
    if (
      !Number.isSafeInteger(record.e) ||
      (record.e as number) < unixNow() ||
      record.c !== hashCode(code) ||
      record.v !== this.#policy.version
    ) {
      throw httpError(403, "join_policy_required");
    }
  }
}

async function claimPostgres(
  pool: Pool,
  community: string,
  tokenHash: string,
  pubkey: string,
  policyVersion: string | null,
): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const communityResult = await client.query<{
      id: string;
      host: string;
    }>(
      `SELECT id, host
       FROM communities
       WHERE lower(host) = lower($1) AND archived_at IS NULL
       FOR SHARE`,
      [community],
    );
    const row = communityResult.rows[0];
    if (!row) throw httpError(404, "community_not_found");
    const invite = await client.query<{
      expires_at: Date;
      max_uses: number | null;
      use_count: number;
    }>(
      `SELECT expires_at, max_uses, use_count
       FROM relay_invites
       WHERE community_id = $1 AND token_hash = $2
       FOR UPDATE`,
      [row.id, Buffer.from(tokenHash, "hex")],
    );
    const record = invite.rows[0];
    if (!record) throw httpError(403, "invite_invalid");
    if (record.expires_at.getTime() <= Date.now()) {
      throw httpError(403, "invite_expired");
    }
    if (record.max_uses !== null && record.use_count >= record.max_uses) {
      throw httpError(403, "invite_exhausted");
    }
    const existing = await client.query(
      `SELECT 1 FROM relay_members
       WHERE community_id = $1 AND pubkey = $2`,
      [row.id, pubkey],
    );
    let status: "already_member" | "joined";
    if (existing.rowCount === 1) {
      status = "already_member";
    } else {
      const consumed = await client.query(
        `UPDATE relay_invites
         SET use_count = use_count + 1
         WHERE community_id = $1
           AND token_hash = $2
           AND expires_at > now()
           AND (max_uses IS NULL OR use_count < max_uses)`,
        [row.id, Buffer.from(tokenHash, "hex")],
      );
      if (consumed.rowCount !== 1) {
        throw httpError(403, "invite_exhausted");
      }
      await client.query(
        `INSERT INTO relay_members (
           community_id, pubkey, role, added_by
         ) VALUES ($1, $2, 'member', NULL)`,
        [row.id, pubkey],
      );
      if (policyVersion) {
        await client.query(
          `INSERT INTO join_policy_acceptances (
             community_id, pubkey, policy_version
           ) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [row.id, pubkey, policyVersion],
        );
      }
      status = "joined";
    }
    await client.query("COMMIT");
    return {
      community_id: row.id,
      host: row.host,
      role: "member",
      status,
    };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

function claimMemory(
  invites: Map<string, MemoryInvite>,
  members: Set<string>,
  tokenHash: string,
  pubkey: string,
  community: string,
): Record<string, unknown> {
  const invite = invites.get(tokenHash);
  if (!invite) throw httpError(403, "invite_invalid");
  if (invite.expiresAt <= unixNow()) {
    throw httpError(403, "invite_expired");
  }
  if (
    invite.maxUses !== null &&
    invite.useCount >= invite.maxUses &&
    !members.has(pubkey)
  ) {
    throw httpError(403, "invite_exhausted");
  }
  const already = members.has(pubkey);
  if (!already) {
    invite.useCount += 1;
    members.add(pubkey);
  }
  return {
    community_id: community,
    host: community,
    role: "member",
    status: already ? "already_member" : "joined",
  };
}

async function resolveCommunityId(
  pool: Pool,
  community: string,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM communities
     WHERE lower(host) = lower($1) AND archived_at IS NULL
     LIMIT 1`,
    [community],
  );
  const id = result.rows[0]?.id;
  if (!id) throw httpError(404, "community_not_found");
  return id;
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
}

function requireCode(value: unknown): string {
  if (typeof value !== "string" || !CODE.test(value)) {
    throw httpError(403, "invite_invalid");
  }
  const decoded = Buffer.from(value.slice(3), "base64url");
  if (
    decoded.byteLength !== 32 ||
    decoded.toString("base64url") !== value.slice(3)
  ) {
    throw httpError(403, "invite_invalid");
  }
  return value;
}

function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function decodeCanonicalBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw httpError(403, "join_policy_required");
  }
  return decoded;
}

async function readJson(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  return parseJsonObject(await readBody(request));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const contentType = request.headers["content-type"]?.split(";")[0]?.trim();
  if (contentType !== "application/json") {
    throw httpError(415, "content_type_must_be_application_json");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw httpError(413, "request_body_too_large");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function parseJsonObject(body: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw httpError(400, "invalid_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw httpError(400, "invalid_json");
  }
  return parsed as Record<string, unknown>;
}

function requireInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw httpError(400, `${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function policyHtml(title: string, markdown: string): string {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(markdown)
    .split(/\r?\n\r?\n/)
    .map((paragraph) => `<p>${paragraph.replaceAll("\n", "<br>")}</p>`)
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<style>body{max-width:42rem;margin:2rem auto;padding:0 1rem;font-family:system-ui,sans-serif;line-height:1.6}</style>
</head><body><h1>${safeTitle}</h1>${safeBody}</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function httpBaseUrl(publicUrl: URL): URL {
  const url = new URL(publicUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

type HttpError = Error & { status: number };

function httpError(status: number, message: string): HttpError {
  return Object.assign(new Error(message), { status });
}

function writeError(response: ServerResponse, error: unknown): void {
  const status =
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : 500;
  const message =
    status >= 500
      ? "internal_error"
      : error instanceof Error
        ? error.message
        : "request_failed";
  noStore(response);
  json(response, status, { error: message });
}

function noStore(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
