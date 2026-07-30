import type { Pool, PoolClient } from "pg";

import {
  KIND_MODERATION_BAN,
  KIND_MODERATION_RESOLVE_REPORT,
  KIND_MODERATION_TIMEOUT,
  KIND_MODERATION_UNBAN,
  KIND_MODERATION_UNTIMEOUT,
  KIND_REPORT,
  isModerationCommandKind,
  unixNow,
  type NostrEvent,
} from "@buzz/core";
import { getSidecar, type MediaStorage } from "@buzz/media";
import { RemoteProtocolError } from "@buzz/remote-agent-protocol";
import type {
  ModerationNoticeDelivery,
  RelayModerationNotices,
} from "./moderation-notices.js";

const REPORT_TYPES = new Set([
  "illegal",
  "nudity",
  "malware",
  "spam",
  "impersonation",
  "profanity",
  "other",
]);
const COMMAND_SKEW_SECONDS = 120;

export type ModerationCommandResult = {
  readonly disconnectPubkey?: string;
  readonly handled: boolean;
};

/**
 * Executes privacy-sensitive NIP-56 reports and moderation direct commands.
 * These events are deliberately not inserted into the public event table or
 * subscription fan-out.
 */
export class RelayModerationCommands {
  public constructor(
    private readonly pool: Pool,
    private readonly community: string,
    private readonly media?: {
      readonly communityId: string;
      readonly storage: MediaStorage;
    },
    private readonly notices?: Pick<RelayModerationNotices, "deliver">,
  ) {}

  public handles(kind: number): boolean {
    return kind === KIND_REPORT || isModerationCommandKind(kind);
  }

  public async execute(event: NostrEvent): Promise<ModerationCommandResult> {
    if (!this.handles(event.kind)) return { handled: false };
    if (event.kind === KIND_REPORT) {
      await this.#insertReport(event);
      return { handled: true };
    }
    if (Math.abs(event.created_at - unixNow()) > COMMAND_SKEW_SECONDS) {
      throw invalid(
        "moderation command timestamp is outside the 120 second window",
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const communityId = await resolveCommunityId(client, this.community);
      const result = await executeCommand(client, communityId, event);
      await client.query("COMMIT");
      const { notice, ...publicResult } = result;
      if (notice) {
        await this.notices?.deliver(notice).catch(() => undefined);
      }
      return { handled: true, ...publicResult };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #insertReport(event: NostrEvent): Promise<void> {
    const report = parseReport(event);
    if (report.targetKind === "blob") {
      if (
        !this.media ||
        !(await getSidecar(
          this.media.storage,
          this.media.communityId,
          report.target,
        ))
      ) {
        throw invalid("report target blob not found");
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const communityId = await resolveCommunityId(client, this.community);
      let channelId: string | null = null;
      if (report.targetKind === "event") {
        const target = await client.query<{
          readonly channel_id: string | null;
        }>(
          `SELECT channel_id::text AS channel_id
           FROM events
           WHERE community_id = $1
             AND id = decode($2, 'hex')
             AND deleted_at IS NULL
           ORDER BY created_at DESC
           LIMIT 1`,
          [communityId, report.target],
        );
        if (!target.rows[0]) throw invalid("report target event not found");
        channelId = target.rows[0].channel_id;
      }
      await client.query(
        `INSERT INTO moderation_reports (
           community_id, report_event_id, reporter_pubkey, target_kind,
           target_event_id, target_pubkey, target_blob_sha256, channel_id,
           report_type, note
         )
         VALUES (
           $1, decode($2, 'hex'), decode($3, 'hex'), $4,
           CASE WHEN $4 = 'event' THEN decode($5, 'hex') ELSE NULL END,
           CASE WHEN $4 = 'pubkey' THEN decode($5, 'hex') ELSE NULL END,
           CASE WHEN $4 = 'blob' THEN decode($5, 'hex') ELSE NULL END,
           $6::uuid, $7, $8
         )
         ON CONFLICT (community_id, report_event_id)
         DO UPDATE SET report_event_id = EXCLUDED.report_event_id`,
        [
          communityId,
          event.id,
          event.pubkey,
          report.targetKind,
          report.target,
          channelId,
          report.reportType,
          event.content || null,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function executeCommand(
  client: PoolClient,
  communityId: string,
  event: NostrEvent,
): Promise<CommandExecutionResult> {
  const actor = await client.query<{ readonly role: string }>(
    `SELECT role
     FROM relay_members
     WHERE community_id = $1 AND pubkey = $2
     FOR UPDATE`,
    [communityId, event.pubkey],
  );
  const actorRole = actor.rows[0]?.role;
  if (actorRole !== "owner" && actorRole !== "admin") {
    throw denied("moderator access required");
  }
  const bannedActor = await client.query(
    `SELECT 1 FROM community_bans
     WHERE community_id = $1
       AND pubkey = decode($2, 'hex')
       AND banned = true
       AND (ban_expires_at IS NULL OR ban_expires_at > now())
     LIMIT 1`,
    [communityId, event.pubkey],
  );
  if (bannedActor.rowCount === 1) {
    throw denied("you are banned from this community");
  }

  if (
    event.kind === KIND_MODERATION_BAN ||
    event.kind === KIND_MODERATION_UNBAN ||
    event.kind === KIND_MODERATION_TIMEOUT ||
    event.kind === KIND_MODERATION_UNTIMEOUT
  ) {
    return executeRestrictionCommand(client, communityId, event, actorRole);
  }
  if (event.kind === KIND_MODERATION_RESOLVE_REPORT) {
    return executeReportResolution(client, communityId, event);
  }
  throw invalid("unsupported moderation command");
}

async function executeRestrictionCommand(
  client: PoolClient,
  communityId: string,
  event: NostrEvent,
  actorRole: string,
): Promise<CommandExecutionResult> {
  const target = exactHexTag(event, "p");
  if (
    actorRole === "admin" &&
    (event.kind === KIND_MODERATION_BAN ||
      event.kind === KIND_MODERATION_TIMEOUT)
  ) {
    const targetRole = await client.query<{ readonly role: string }>(
      `SELECT role FROM relay_members
       WHERE community_id = $1 AND pubkey = $2
       LIMIT 1`,
      [communityId, target],
    );
    if (
      targetRole.rows[0]?.role === "owner" ||
      targetRole.rows[0]?.role === "admin"
    ) {
      throw denied(
        "an admin cannot ban or time out a community owner or fellow admin",
      );
    }
  }
  const reason = optionalTag(event, "reason", 4_096);
  if (event.kind === KIND_MODERATION_BAN) {
    const expiration = optionalExpiration(event);
    await client.query(
      `INSERT INTO community_bans (
         community_id, pubkey, banned, ban_expires_at, ban_reason,
         actor_pubkey
       )
       VALUES (
         $1, decode($2, 'hex'), true, to_timestamp($3), $4,
         decode($5, 'hex')
       )
       ON CONFLICT (community_id, pubkey)
       DO UPDATE SET
         banned = true,
         ban_expires_at = EXCLUDED.ban_expires_at,
         ban_reason = EXCLUDED.ban_reason,
         actor_pubkey = EXCLUDED.actor_pubkey,
         updated_at = now()`,
      [communityId, target, expiration, reason, event.pubkey],
    );
    const actionId = await insertAction(
      client,
      communityId,
      event.pubkey,
      "ban",
      {
        ...(reason ? { publicReason: reason } : {}),
        targetPubkey: target,
      },
    );
    return {
      disconnectPubkey: target,
      notice: {
        notice: {
          actionId,
          kind: "restriction",
          publicReason: reason ?? "",
          restriction: "ban",
        },
        recipientPubkey: target,
      },
    };
  }
  if (event.kind === KIND_MODERATION_UNBAN) {
    const result = await client.query(
      `UPDATE community_bans
       SET banned = false, ban_expires_at = NULL, ban_reason = NULL,
           actor_pubkey = decode($3, 'hex'), updated_at = now()
       WHERE community_id = $1
         AND pubkey = decode($2, 'hex')
         AND banned = true`,
      [communityId, target, event.pubkey],
    );
    if (result.rowCount !== 1) throw invalid("member is not banned");
    await insertAction(client, communityId, event.pubkey, "unban", {
      targetPubkey: target,
    });
    return {};
  }
  if (event.kind === KIND_MODERATION_TIMEOUT) {
    const expiration = requiredExpiration(event);
    if (expiration <= unixNow()) {
      throw invalid("timeout expiration must be in the future");
    }
    await client.query(
      `INSERT INTO community_bans (
         community_id, pubkey, muted_until, mute_reason, actor_pubkey
       )
       VALUES (
         $1, decode($2, 'hex'), to_timestamp($3), $4,
         decode($5, 'hex')
       )
       ON CONFLICT (community_id, pubkey)
       DO UPDATE SET
         muted_until = EXCLUDED.muted_until,
         mute_reason = EXCLUDED.mute_reason,
         actor_pubkey = EXCLUDED.actor_pubkey,
         updated_at = now()`,
      [communityId, target, expiration, reason, event.pubkey],
    );
    const actionId = await insertAction(
      client,
      communityId,
      event.pubkey,
      "timeout",
      {
        ...(reason ? { publicReason: reason } : {}),
        targetPubkey: target,
      },
    );
    return {
      notice: {
        notice: {
          actionId,
          kind: "restriction",
          publicReason: reason ?? "",
          restriction: "timeout",
        },
        recipientPubkey: target,
      },
    };
  }
  const result = await client.query(
    `UPDATE community_bans
     SET muted_until = NULL, mute_reason = NULL,
         actor_pubkey = decode($3, 'hex'), updated_at = now()
     WHERE community_id = $1
       AND pubkey = decode($2, 'hex')
       AND muted_until > now()`,
    [communityId, target, event.pubkey],
  );
  if (result.rowCount !== 1) throw invalid("member is not timed out");
  await insertAction(client, communityId, event.pubkey, "untimeout", {
    targetPubkey: target,
  });
  return {};
}

async function executeReportResolution(
  client: PoolClient,
  communityId: string,
  event: NostrEvent,
): Promise<CommandExecutionResult> {
  const reportEventId = exactHexTag(event, "report");
  const status = exactTag(event, "status", 32);
  const requestedAction = exactTag(event, "action", 32);
  const reason = optionalTag(event, "reason", 4_096);
  if (status !== "resolved" && status !== "dismissed") {
    throw invalid("report status must be resolved or dismissed");
  }
  const actionMap: Readonly<Record<string, string>> = {
    ban: "resolve:ban",
    delete: "resolve:delete",
    dismiss: "dismiss_report",
    escalate: "escalate",
    kick: "resolve:kick",
    timeout: "resolve:timeout",
  };
  const auditAction = actionMap[requestedAction];
  if (!auditAction) throw invalid("unsupported report resolution action");
  if ((requestedAction === "dismiss") !== (status === "dismissed")) {
    throw invalid("dismiss action must pair with dismissed status");
  }
  const report = await client.query<{
    readonly id: string;
    readonly reporter_pubkey: string;
    readonly status: string;
    readonly target_event_id: string | null;
    readonly target_pubkey: string | null;
  }>(
    `SELECT id::text AS id, status,
            encode(reporter_pubkey, 'hex') AS reporter_pubkey,
            encode(target_event_id, 'hex') AS target_event_id,
            encode(target_pubkey, 'hex') AS target_pubkey
     FROM moderation_reports
     WHERE community_id = $1
       AND report_event_id = decode($2, 'hex')
     LIMIT 1
     FOR UPDATE`,
    [communityId, reportEventId],
  );
  const row = report.rows[0];
  if (!row) throw invalid("report not found in this community");
  if (row.status !== "open") throw invalid("report is not open");
  const actionId = await insertAction(
    client,
    communityId,
    event.pubkey,
    auditAction,
    {
      ...(reason ? { publicReason: reason } : {}),
      ...(row.target_event_id ? { targetEventId: row.target_event_id } : {}),
      ...(row.target_pubkey ? { targetPubkey: row.target_pubkey } : {}),
    },
  );
  const resolved = await client.query(
    `UPDATE moderation_reports
     SET status = $3, resolved_by = decode($4, 'hex'),
         resolved_at = now(), action_id = $5::uuid
     WHERE community_id = $1 AND id = $2::uuid AND status = 'open'`,
    [communityId, row.id, status, event.pubkey, actionId],
  );
  if (resolved.rowCount !== 1) throw invalid("report is not open");
  return {
    notice: {
      notice: {
        kind: "report-resolved",
        reportId: row.id,
        status,
        summary:
          reason ??
          (status === "dismissed"
            ? "Your report was reviewed and dismissed."
            : "Your report was reviewed and acted on."),
      },
      recipientPubkey: row.reporter_pubkey,
    },
  };
}

type CommandExecutionResult = {
  readonly disconnectPubkey?: string;
  readonly notice?: ModerationNoticeDelivery;
};

async function insertAction(
  client: PoolClient,
  communityId: string,
  actorPubkey: string,
  action: string,
  input: {
    readonly publicReason?: string;
    readonly targetEventId?: string;
    readonly targetPubkey?: string;
  },
): Promise<string> {
  const result = await client.query<{ readonly id: string }>(
    `INSERT INTO moderation_actions (
       community_id, actor_pubkey, action, target_pubkey, target_event_id,
       public_reason
     )
     VALUES (
       $1, decode($2, 'hex'), $3,
       CASE WHEN $4::text IS NULL THEN NULL ELSE decode($4, 'hex') END,
       CASE WHEN $5::text IS NULL THEN NULL ELSE decode($5, 'hex') END,
       $6
     )
     RETURNING id::text AS id`,
    [
      communityId,
      actorPubkey,
      action,
      input.targetPubkey ?? null,
      input.targetEventId ?? null,
      input.publicReason ?? null,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("moderation audit insert did not return an ID");
  return id;
}

function parseReport(event: NostrEvent): {
  readonly reportType: string;
  readonly target: string;
  readonly targetKind: "blob" | "event" | "pubkey";
} {
  const p = reportTags(event, "p");
  const e = reportTags(event, "e");
  const x = reportTags(event, "x");
  if (p.length !== 1) throw invalid("report requires exactly one p tag");
  if (e.length > 1 || x.length > 1 || (e.length > 0 && x.length > 0)) {
    throw invalid("report must target only one event or blob");
  }
  const selected = e[0] ?? x[0] ?? p[0];
  if (!selected || !/^[0-9a-f]{64}$/.test(selected.value)) {
    throw invalid("report target must be a lowercase 64-character hex value");
  }
  if (!selected.reportType || !REPORT_TYPES.has(selected.reportType)) {
    throw invalid("report target has an unsupported report type");
  }
  return {
    reportType: selected.reportType,
    target: selected.value,
    targetKind: e.length > 0 ? "event" : x.length > 0 ? "blob" : "pubkey",
  };
}

function reportTags(
  event: NostrEvent,
  name: string,
): { readonly value: string; readonly reportType?: string }[] {
  return event.tags
    .filter((tag) => tag[0] === name)
    .map((tag) => ({
      ...(tag[2] ? { reportType: tag[2] } : {}),
      value: tag[1] ?? "",
    }));
}

function exactHexTag(event: NostrEvent, name: string): string {
  const value = exactTag(event, name, 64);
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw invalid(`${name} tag must be a lowercase 64-character hex value`);
  }
  return value;
}

function exactTag(
  event: NostrEvent,
  name: string,
  maximumBytes: number,
): string {
  const matches = event.tags.filter((tag) => tag[0] === name);
  if (
    matches.length !== 1 ||
    matches[0]?.length !== 2 ||
    !matches[0][1] ||
    Buffer.byteLength(matches[0][1], "utf8") > maximumBytes
  ) {
    throw invalid(`moderation command requires exactly one ${name} tag`);
  }
  return matches[0][1];
}

function optionalTag(
  event: NostrEvent,
  name: string,
  maximumBytes: number,
): string | undefined {
  const matches = event.tags.filter((tag) => tag[0] === name);
  if (matches.length === 0) return undefined;
  if (
    matches.length !== 1 ||
    matches[0]?.length !== 2 ||
    !matches[0][1] ||
    Buffer.byteLength(matches[0][1], "utf8") > maximumBytes
  ) {
    throw invalid(`moderation command has an invalid ${name} tag`);
  }
  return matches[0][1];
}

function optionalExpiration(event: NostrEvent): number | null {
  const raw = optionalTag(event, "expiration", 20);
  if (raw === undefined) return null;
  if (!/^(0|[1-9][0-9]{0,9})$/.test(raw)) {
    throw invalid("expiration tag is invalid");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw invalid("expiration tag is invalid");
  return value;
}

function requiredExpiration(event: NostrEvent): number {
  const value = optionalExpiration(event);
  if (value === null) throw invalid("timeout requires an expiration tag");
  return value;
}

async function resolveCommunityId(
  client: PoolClient,
  community: string,
): Promise<string> {
  const result = await client.query<{ readonly id: string }>(
    `SELECT id::text AS id
     FROM communities
     WHERE lower(host) = lower($1) AND archived_at IS NULL
     LIMIT 1
     FOR SHARE`,
    [community],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new RemoteProtocolError(
      "CAPABILITY_DENIED",
      "community is unavailable",
    );
  }
  return id;
}

function invalid(message: string): RemoteProtocolError {
  return new RemoteProtocolError("CONFIG_INVALID", message);
}

function denied(message: string): RemoteProtocolError {
  return new RemoteProtocolError("CAPABILITY_DENIED", message);
}
