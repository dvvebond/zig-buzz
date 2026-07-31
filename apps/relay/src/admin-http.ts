import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  blobKey,
  getSidecar,
  serveInline,
  type MediaStorage,
} from "@buzz/media";
import type { Pool } from "pg";

import { normalizeCandidateHost } from "./operator-http.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_EXT = /^[a-z0-9]{1,8}$/;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ADMIN_PREFIX = "/api/admin/v1";

export type RelayAdminHttpOptions = {
  readonly host: string;
  readonly mediaStorage?: MediaStorage;
  readonly pool: Pool;
};

/**
 * Private, deployment-global, read-only moderation and feedback API.
 *
 * The private ingress remains the human authentication boundary. This
 * handler independently requires its exact configured Host and, when a
 * browser Origin is present, the matching same-origin value.
 */
export class RelayAdminHttp {
  readonly #host: string;
  readonly #mediaStorage: MediaStorage | undefined;
  readonly #pool: Pool;

  public constructor(options: RelayAdminHttpOptions) {
    this.#host = validateAdminHost(options.host);
    this.#mediaStorage = options.mediaStorage;
    this.#pool = options.pool;
  }

  public async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const url = new URL(request.url ?? "/", "http://admin.invalid");
    if (!url.pathname.startsWith(`${ADMIN_PREFIX}/`)) return false;
    applyAdminHeaders(response);
    try {
      this.#authorize(request);
      const route = adminRoute(url.pathname);
      if (!route) throw AdminHttpError.notFound();
      const allowed =
        route.type === "feedback_attachment"
          ? new Set(["GET", "HEAD"])
          : new Set(["GET"]);
      const method = request.method?.toUpperCase() ?? "";
      if (!allowed.has(method)) {
        response.setHeader("Allow", [...allowed].join(", "));
        throw new AdminHttpError(
          405,
          "method_not_allowed",
          "method is not allowed",
        );
      }
      if ((await readBoundedRequestBody(request, 1_024)).length !== 0) {
        throw new AdminHttpError(
          400,
          "unexpected_body",
          "request body must be empty",
        );
      }

      switch (route.type) {
        case "reports":
          await this.#reports(url, response);
          break;
        case "report":
          await this.#report(route.id, response);
          break;
        case "feedback":
          await this.#feedback(response);
          break;
        case "feedback_detail":
          await this.#feedbackDetail(route.id, response);
          break;
        case "feedback_attachment":
          await this.#feedbackAttachment(
            route.id,
            route.sha256,
            method === "HEAD",
            response,
          );
          break;
      }
    } catch (error) {
      writeAdminError(response, error);
    }
    return true;
  }

  #authorize(request: IncomingMessage): void {
    if (request.headers.host !== this.#host) {
      throw AdminHttpError.forbidden();
    }
    const origin = request.headers.origin;
    if (
      origin !== undefined &&
      origin !== `https://${this.#host}` &&
      origin !== `http://${this.#host}`
    ) {
      throw AdminHttpError.forbidden();
    }
  }

  async #reports(url: URL, response: ServerResponse): Promise<void> {
    const allowed = new Set([
      "after",
      "before",
      "communityId",
      "limit",
      "reportType",
      "status",
      "targetKind",
    ]);
    requireQueryShape(url, allowed);
    const communityId = optionalUuid(
      url.searchParams.get("communityId"),
      "invalid_community_id",
    );
    const status = optionalEnum(
      url.searchParams.get("status"),
      ["open", "resolved", "dismissed", "escalated"],
      "invalid_status",
    );
    const reportType = optionalBoundedText(
      url.searchParams.get("reportType"),
      128,
      "invalid_report_type",
    );
    const targetKind = optionalEnum(
      url.searchParams.get("targetKind"),
      ["event", "pubkey", "blob"],
      "invalid_target_kind",
    );
    const after = optionalDate(url.searchParams.get("after"), "invalid_after");
    const before = optionalDate(
      url.searchParams.get("before"),
      "invalid_before",
    );
    const limit = parseLimit(url.searchParams.get("limit"));
    const result = await this.#pool.query<AdminReportRow>(
      `${adminReportSelect()}
       WHERE ($1::uuid IS NULL OR r.community_id = $1::uuid)
         AND ($2::text IS NULL OR r.status = $2)
         AND ($3::text IS NULL OR r.report_type = $3)
         AND ($4::text IS NULL OR r.target_kind = $4)
         AND ($5::timestamptz IS NULL OR r.created_at >= $5)
         AND ($6::timestamptz IS NULL OR r.created_at < $6)
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT $7`,
      [communityId, status, reportType, targetKind, after, before, limit],
    );
    adminJson(response, 200, result.rows.map(reportFromRow));
  }

  async #report(id: string, response: ServerResponse): Promise<void> {
    const result = await this.#pool.query<
      AdminReportRow & {
        readonly message_author_pubkey: string | null;
        readonly message_content: string | null;
        readonly message_created_at: Date | null;
        readonly message_deleted_at: Date | null;
      }
    >(
      `SELECT ${adminReportColumns()},
              encode(target.pubkey, 'hex') AS message_author_pubkey,
              target.content AS message_content,
              target.created_at AS message_created_at,
              target.deleted_at AS message_deleted_at
       FROM moderation_reports r
       JOIN communities c ON c.id = r.community_id
       LEFT JOIN LATERAL (
         SELECT e.pubkey, e.content, e.created_at, e.deleted_at
         FROM events e
         WHERE r.target_kind = 'event'
           AND e.community_id = r.community_id
           AND e.id = r.target_event_id
         ORDER BY e.created_at DESC
         LIMIT 1
       ) target ON TRUE
       WHERE r.id = $1::uuid
       LIMIT 1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw AdminHttpError.notFound();
    adminJson(response, 200, {
      ...reportFromRow(row),
      message:
        row.message_author_pubkey &&
        row.message_content !== null &&
        row.message_created_at
          ? {
              authorPubkey: row.message_author_pubkey,
              content: row.message_content,
              createdAt: row.message_created_at,
              deletedAt: row.message_deleted_at,
            }
          : null,
    });
  }

  async #feedback(response: ServerResponse): Promise<void> {
    const result = await this.#pool.query<AdminFeedbackRow>(
      `${adminFeedbackSelect()}
       ORDER BY f.received_at DESC, f.id DESC
       LIMIT 100`,
    );
    adminJson(
      response,
      200,
      result.rows.map((row) => ({
        bodySummary: summarizeFeedback(row.body, row.tags),
        category: row.category,
        communityHost: row.community_host,
        communityId: row.community_id,
        id: row.id,
        receivedAt: row.received_at,
        submitterPubkey: row.submitter_pubkey,
      })),
    );
  }

  async #feedbackDetail(id: string, response: ServerResponse): Promise<void> {
    const row = await this.#readFeedback(id);
    if (!row) throw AdminHttpError.notFound();
    adminJson(response, 200, feedbackFromRow(row));
  }

  async #feedbackAttachment(
    id: string,
    sha256: string,
    headOnly: boolean,
    response: ServerResponse,
  ): Promise<void> {
    if (!SHA256.test(sha256) || !this.#mediaStorage) {
      throw AdminHttpError.notFound();
    }
    const feedback = await this.#readFeedback(id);
    if (
      !feedback ||
      !feedbackReferencesHash(feedback.tags, feedback.community_host, sha256)
    ) {
      throw AdminHttpError.notFound();
    }
    const resolved = await this.#pool.query<{ readonly id: string }>(
      `SELECT id
       FROM communities
       WHERE lower(host) = lower($1) AND archived_at IS NULL
       LIMIT 1`,
      [feedback.community_host],
    );
    if (resolved.rows[0]?.id !== feedback.community_id) {
      throw AdminHttpError.notFound();
    }
    const sidecar = await getSidecar(
      this.#mediaStorage,
      feedback.community_id,
      sha256,
    );
    if (!sidecar || !SAFE_EXT.test(sidecar.ext)) {
      throw AdminHttpError.notFound();
    }
    const object = await this.#mediaStorage
      .get(blobKey(sha256, sidecar.ext))
      .catch(() => undefined);
    if (!object) throw AdminHttpError.notFound();
    response.statusCode = 200;
    response.setHeader("Content-Length", object.bytes.byteLength);
    response.setHeader(
      "Content-Disposition",
      serveInline(sidecar.mimeType) ? "inline" : "attachment",
    );
    response.setHeader("Content-Type", sidecar.mimeType);
    if (headOnly) response.end();
    else response.end(Buffer.from(object.bytes));
  }

  async #readFeedback(id: string): Promise<AdminFeedbackRow | undefined> {
    const result = await this.#pool.query<AdminFeedbackRow>(
      `${adminFeedbackSelect()}
       WHERE f.id = $1::uuid
       LIMIT 1`,
      [id],
    );
    return result.rows[0];
  }
}

type AdminReportRow = {
  readonly action_id: string | null;
  readonly channel_id: string | null;
  readonly community_host: string;
  readonly community_id: string;
  readonly created_at: Date;
  readonly id: string;
  readonly note: string | null;
  readonly report_event_id: string;
  readonly report_type: string;
  readonly reporter_pubkey: string;
  readonly resolved_at: Date | null;
  readonly resolved_by: string | null;
  readonly status: string;
  readonly target: string;
  readonly target_kind: string;
};

type AdminFeedbackRow = {
  readonly body: string;
  readonly category: string | null;
  readonly community_host: string;
  readonly community_id: string;
  readonly event_created_at: Date;
  readonly event_id: string;
  readonly id: string;
  readonly received_at: Date;
  readonly submitter_pubkey: string;
  readonly tags: unknown;
};

function adminReportSelect(): string {
  return `SELECT ${adminReportColumns()}
          FROM moderation_reports r
          JOIN communities c ON c.id = r.community_id`;
}

function adminReportColumns(): string {
  return `r.id, r.community_id, c.host AS community_host,
          encode(r.report_event_id, 'hex') AS report_event_id,
          encode(r.reporter_pubkey, 'hex') AS reporter_pubkey,
          r.target_kind,
          CASE r.target_kind
            WHEN 'event' THEN encode(r.target_event_id, 'hex')
            WHEN 'pubkey' THEN encode(r.target_pubkey, 'hex')
            WHEN 'blob' THEN encode(r.target_blob_sha256, 'hex')
            ELSE ''
          END AS target,
          r.channel_id, r.report_type, r.note, r.status,
          encode(r.resolved_by, 'hex') AS resolved_by,
          r.resolved_at, r.action_id, r.created_at`;
}

function adminFeedbackSelect(): string {
  return `SELECT f.id, f.community_id, c.host AS community_host,
                 encode(f.event_id, 'hex') AS event_id,
                 encode(f.submitter_pubkey, 'hex') AS submitter_pubkey,
                 f.category, f.body, f.tags, f.event_created_at, f.received_at
          FROM product_feedback f
          JOIN communities c ON c.id = f.community_id`;
}

function reportFromRow(row: AdminReportRow): Record<string, unknown> {
  return {
    actionId: row.action_id,
    channelId: row.channel_id,
    communityHost: row.community_host,
    communityId: row.community_id,
    createdAt: row.created_at,
    id: row.id,
    note: row.note,
    reportEventId: row.report_event_id,
    reportType: row.report_type,
    reporterPubkey: row.reporter_pubkey,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    status: row.status,
    target: row.target,
    targetKind: row.target_kind,
  };
}

function feedbackFromRow(row: AdminFeedbackRow): Record<string, unknown> {
  return {
    body: row.body,
    category: row.category,
    communityHost: row.community_host,
    communityId: row.community_id,
    eventCreatedAt: row.event_created_at,
    eventId: row.event_id,
    id: row.id,
    receivedAt: row.received_at,
    submitterPubkey: row.submitter_pubkey,
    tags: row.tags,
  };
}

type AdminRoute =
  | { readonly type: "feedback" }
  | { readonly id: string; readonly type: "feedback_detail" }
  | {
      readonly id: string;
      readonly sha256: string;
      readonly type: "feedback_attachment";
    }
  | { readonly id: string; readonly type: "report" }
  | { readonly type: "reports" };

function adminRoute(pathname: string): AdminRoute | undefined {
  if (pathname === `${ADMIN_PREFIX}/reports`) return { type: "reports" };
  if (pathname === `${ADMIN_PREFIX}/feedback`) return { type: "feedback" };
  let match = new RegExp(`^${ADMIN_PREFIX}/reports/([^/]+)$`).exec(pathname);
  if (match?.[1] && UUID.test(match[1])) {
    return { id: match[1].toLowerCase(), type: "report" };
  }
  match = new RegExp(`^${ADMIN_PREFIX}/feedback/([^/]+)$`).exec(pathname);
  if (match?.[1] && UUID.test(match[1])) {
    return { id: match[1].toLowerCase(), type: "feedback_detail" };
  }
  match = new RegExp(
    `^${ADMIN_PREFIX}/feedback/([^/]+)/attachments/([^/]+)$`,
  ).exec(pathname);
  if (match?.[1] && match[2] && UUID.test(match[1])) {
    return {
      id: match[1].toLowerCase(),
      sha256: match[2],
      type: "feedback_attachment",
    };
  }
  return undefined;
}

function summarizeFeedback(body: string, tags: unknown): string {
  const attachmentUrls = new Set(
    imetaTags(tags).flatMap((tag) =>
      tag.flatMap((value) =>
        value.startsWith("url ") ? [value.slice(4)] : [],
      ),
    ),
  );
  const text = body
    .split(/\r?\n/)
    .filter((line) => {
      const match = /!?\[[^\]]*\]\(([^)]+)\)\s*$/.exec(line.trim());
      return !match?.[1] || !attachmentUrls.has(match[1]);
    })
    .join("\n")
    .trim();
  const characters = [...text];
  return characters.length <= 240
    ? text
    : `${characters.slice(0, 240).join("")}…`;
}

function feedbackReferencesHash(
  tags: unknown,
  communityHost: string,
  sha256: string,
): boolean {
  return imetaTags(tags).some((tag) => {
    const fields = new Map<string, string>();
    for (const value of tag.slice(1)) {
      const split = value.indexOf(" ");
      if (split > 0) fields.set(value.slice(0, split), value.slice(split + 1));
    }
    const url = fields.get("url");
    return (
      fields.get("x") === sha256 &&
      url !== undefined &&
      attachmentUrlMatches(url, communityHost, sha256)
    );
  });
}

function imetaTags(tags: unknown): string[][] {
  if (!Array.isArray(tags)) return [];
  return tags.filter(
    (tag): tag is string[] =>
      Array.isArray(tag) &&
      tag.length > 0 &&
      tag[0] === "imeta" &&
      tag.every((value) => typeof value === "string"),
  );
}

function attachmentUrlMatches(
  value: string,
  communityHost: string,
  sha256: string,
): boolean {
  let url: URL;
  try {
    url = value.startsWith("/")
      ? new URL(value, `https://${communityHost}`)
      : new URL(value);
  } catch {
    return false;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.search ||
    url.hash
  ) {
    return false;
  }
  let sourceHost: string;
  let expectedHost: string;
  try {
    sourceHost = normalizeCandidateHost(url.host);
    expectedHost = normalizeCandidateHost(communityHost);
  } catch {
    return false;
  }
  const match = /^\/media\/([0-9a-f]{64})\.([a-z0-9]{1,8})$/.exec(url.pathname);
  return (
    sourceHost === expectedHost &&
    match?.[1] === sha256 &&
    SAFE_EXT.test(match[2] ?? "")
  );
}

function requireQueryShape(url: URL, allowed: ReadonlySet<string>): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new AdminHttpError(400, "invalid_query", "query filter is invalid");
    }
    if (url.searchParams.getAll(key).length !== 1) {
      throw new AdminHttpError(400, "invalid_query", "query filter is invalid");
    }
  }
}

function optionalUuid(value: string | null, code: string): string | null {
  if (value === null) return null;
  if (!UUID.test(value)) {
    throw new AdminHttpError(400, code, "filter is invalid");
  }
  return value.toLowerCase();
}

function optionalEnum(
  value: string | null,
  allowed: readonly string[],
  code: string,
): string | null {
  if (value !== null && !allowed.includes(value)) {
    throw new AdminHttpError(400, code, "filter is invalid");
  }
  return value;
}

function optionalBoundedText(
  value: string | null,
  maximumBytes: number,
  code: string,
): string | null {
  if (
    value !== null &&
    (value.length === 0 || Buffer.byteLength(value, "utf8") > maximumBytes)
  ) {
    throw new AdminHttpError(400, code, "filter is invalid");
  }
  return value;
}

function optionalDate(value: string | null, code: string): Date | null {
  if (value === null) return null;
  const date = new Date(value);
  if (!RFC3339.test(value) || Number.isNaN(date.getTime())) {
    throw new AdminHttpError(400, code, "filter is invalid");
  }
  return date;
}

function parseLimit(value: string | null): number {
  if (value === null) return 50;
  if (!/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/.test(value)) {
    throw new AdminHttpError(
      400,
      "invalid_limit",
      "limit must be between 1 and 200",
    );
  }
  return Number(value);
}

class AdminHttpError extends Error {
  public constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  static forbidden(): AdminHttpError {
    return new AdminHttpError(403, "forbidden", "request is not authorized");
  }

  static notFound(): AdminHttpError {
    return new AdminHttpError(404, "not_found", "record was not found");
  }
}

function validateAdminHost(value: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 255 ||
    /[/\\@]/.test(value)
  ) {
    throw new TypeError("admin host must be an exact authority");
  }
  normalizeCandidateHost(value);
  return value;
}

async function readBoundedRequestBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(rawChunk as Uint8Array);
    total += chunk.length;
    if (total > maximumBytes) {
      throw new AdminHttpError(
        413,
        "body_too_large",
        "request body is too large",
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function applyAdminHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function writeAdminError(response: ServerResponse, error: unknown): void {
  const known =
    error instanceof AdminHttpError
      ? error
      : new AdminHttpError(500, "internal_error", "request failed");
  adminJson(response, known.status, {
    error: {
      code: known.code,
      message: known.message,
      requestId: randomUUID(),
    },
  });
}

function adminJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
