import type { IncomingMessage, ServerResponse } from "node:http";

import type { Pool } from "pg";
import { RemoteProtocolError } from "@buzz/remote-agent-protocol";
import { unixNow } from "@buzz/core";

import { authenticateNip98Identity, type Nip98ReplayGuard } from "./nip98.js";

const MAX_ROWS = 500;

export async function handleModerationHttp(
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    readonly community: string;
    readonly pool?: Pool;
    readonly publicUrl: URL;
    readonly replay: Nip98ReplayGuard;
    readonly replayScope: string;
  },
): Promise<boolean> {
  if (request.method !== "GET") return false;
  const url = new URL(request.url ?? "/", httpBaseUrl(input.publicUrl));
  if (
    url.pathname !== "/moderation/reports" &&
    url.pathname !== "/moderation/audit" &&
    url.pathname !== "/moderation/restricted"
  ) {
    return false;
  }
  if (!input.pool) {
    json(response, 404, { error: "not_found" });
    return true;
  }
  try {
    const identity = await authenticateNip98Identity({
      authorizationHeader: request.headers.authorization,
      body: Buffer.alloc(0),
      method: "GET",
      now: unixNow(),
      publicUrl: url.toString(),
      replayGuard: input.replay,
      replayScope: input.replayScope,
    });
    const community = await authorizeModerator(
      input.pool,
      input.community,
      identity.pubkey,
    );
    const limit = readLimit(url.searchParams.get("limit"));
    const rows =
      url.pathname === "/moderation/reports"
        ? await readReports(
            input.pool,
            community,
            url.searchParams.get("status"),
            limit,
          )
        : url.pathname === "/moderation/audit"
          ? await readAudit(input.pool, community, limit)
          : await readRestrictions(input.pool, community);
    response.setHeader("Cache-Control", "no-store");
    json(response, 200, rows);
  } catch (error) {
    writeError(response, error);
  }
  return true;
}

async function authorizeModerator(
  pool: Pool,
  community: string,
  pubkey: string,
): Promise<string> {
  const result = await pool.query<{
    readonly community_id: string;
    readonly role: string;
  }>(
    `SELECT c.id::text AS community_id, rm.role
     FROM communities c
     JOIN relay_members rm ON rm.community_id = c.id
     WHERE lower(c.host) = lower($1)
       AND c.archived_at IS NULL
       AND rm.pubkey = $2
     LIMIT 1`,
    [community, pubkey],
  );
  const row = result.rows[0];
  if (!row || (row.role !== "owner" && row.role !== "admin")) {
    throw new RemoteProtocolError(
      "CAPABILITY_DENIED",
      "restricted: moderator access required",
    );
  }
  return row.community_id;
}

async function readReports(
  pool: Pool,
  communityId: string,
  requestedStatus: string | null,
  limit: number,
): Promise<readonly Record<string, unknown>[]> {
  const status =
    requestedStatus &&
    ["open", "resolved", "dismissed", "escalated"].includes(requestedStatus)
      ? requestedStatus
      : null;
  if (requestedStatus && !status) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "invalid moderation report status",
    );
  }
  const result = await pool.query<ModerationReportRow>(
    `SELECT id::text AS id,
            encode(report_event_id, 'hex') AS report_event_id,
            encode(reporter_pubkey, 'hex') AS reporter_pubkey,
            target_kind,
            encode(target_event_id, 'hex') AS target_event_id,
            encode(target_pubkey, 'hex') AS target_pubkey,
            encode(target_blob_sha256, 'hex') AS target_blob_sha256,
            channel_id::text AS channel_id, report_type, note, status,
            encode(resolved_by, 'hex') AS resolved_by,
            resolved_at, action_id::text AS action_id, created_at
     FROM moderation_reports
     WHERE community_id = $1
       AND ($2::text IS NULL OR status = $2)
     ORDER BY created_at DESC, id DESC
     LIMIT $3`,
    [communityId, status, limit],
  );
  return result.rows.map((row) => ({
    action_id: row.action_id,
    channel_id: row.channel_id,
    created_at: row.created_at,
    id: row.id,
    note: row.note,
    report_event_id: row.report_event_id,
    report_type: row.report_type,
    reporter_pubkey: row.reporter_pubkey,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    status: row.status,
    target:
      row.target_kind === "event"
        ? row.target_event_id
        : row.target_kind === "pubkey"
          ? row.target_pubkey
          : row.target_blob_sha256,
    target_kind: row.target_kind,
  }));
}

async function readAudit(
  pool: Pool,
  communityId: string,
  limit: number,
): Promise<readonly Record<string, unknown>[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT id::text AS id, encode(actor_pubkey, 'hex') AS actor_pubkey,
            action, encode(target_pubkey, 'hex') AS target_pubkey,
            encode(target_event_id, 'hex') AS target_event_id,
            channel_id::text AS channel_id, reason_code, public_reason,
            private_reason, matched_principal, created_at
     FROM moderation_actions
     WHERE community_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [communityId, limit],
  );
  return result.rows;
}

async function readRestrictions(
  pool: Pool,
  communityId: string,
): Promise<readonly Record<string, unknown>[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT encode(pubkey, 'hex') AS pubkey, banned, ban_expires_at,
            ban_reason, muted_until, mute_reason,
            encode(actor_pubkey, 'hex') AS actor_pubkey, updated_at
     FROM community_bans
     WHERE community_id = $1
       AND (
         (banned = true AND (ban_expires_at IS NULL OR ban_expires_at > now()))
         OR muted_until > now()
       )
     ORDER BY updated_at DESC, pubkey`,
    [communityId],
  );
  return result.rows;
}

function readLimit(value: string | null): number {
  if (value === null) return MAX_ROWS;
  if (!/^[0-9]{1,9}$/.test(value)) {
    throw new RemoteProtocolError("CONFIG_INVALID", "invalid moderation limit");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RemoteProtocolError("CONFIG_INVALID", "invalid moderation limit");
  }
  return Math.min(parsed, MAX_ROWS);
}

type ModerationReportRow = {
  readonly action_id: string | null;
  readonly channel_id: string | null;
  readonly created_at: Date;
  readonly id: string;
  readonly note: string | null;
  readonly report_event_id: string;
  readonly report_type: string;
  readonly reporter_pubkey: string;
  readonly resolved_at: Date | null;
  readonly resolved_by: string | null;
  readonly status: string;
  readonly target_blob_sha256: string | null;
  readonly target_event_id: string | null;
  readonly target_kind: "blob" | "event" | "pubkey";
  readonly target_pubkey: string | null;
};

function writeError(response: ServerResponse, error: unknown): void {
  const status =
    error instanceof RemoteProtocolError &&
    (error.code === "AUTH_REQUIRED" ||
      error.code === "SIGNATURE_INVALID" ||
      error.code === "MESSAGE_EXPIRED")
      ? 401
      : error instanceof RemoteProtocolError &&
          error.code === "CAPABILITY_DENIED"
        ? 403
        : error instanceof RemoteProtocolError && error.code === "RATE_LIMITED"
          ? 429
          : error instanceof RemoteProtocolError
            ? 400
            : 500;
  json(response, status, {
    error:
      error instanceof RemoteProtocolError ? error.message : "internal_error",
  });
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function httpBaseUrl(publicUrl: URL): URL {
  const url = new URL(publicUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}
