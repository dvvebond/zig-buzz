import type { Pool } from "pg";
import {
  AUTHOR_ONLY_KINDS,
  KIND_GIFT_WRAP,
  KIND_PERSONA,
  KIND_NIP29_DELETE_EVENT,
  KIND_NIP29_CREATE_GROUP,
  KIND_NIP29_DELETE_GROUP,
  KIND_NIP29_EDIT_METADATA,
  KIND_NIP29_JOIN_REQUEST,
  KIND_NIP29_LEAVE_REQUEST,
  KIND_NIP29_PUT_USER,
  KIND_NIP29_REMOVE_USER,
  KIND_IA_ARCHIVED,
  KIND_IA_ARCHIVED_LIST,
  KIND_IA_UNARCHIVED,
  KIND_NIP43_MEMBER_ADDED,
  KIND_NIP43_MEMBER_REMOVED,
  isGlobalOnlyKind,
  KIND_MODERATION_BAN,
  KIND_MODERATION_RESOLVE_REPORT,
  KIND_MODERATION_TIMEOUT,
  KIND_MODERATION_UNBAN,
  KIND_MODERATION_UNTIMEOUT,
  P_GATED_KINDS,
  RELAY_ONLY_KINDS,
  RELAY_ADMIN_ADD_MEMBER,
  RELAY_ADMIN_CHANGE_ROLE,
  RELAY_ADMIN_REMOVE_MEMBER,
  RELAY_ADMIN_SET_WORKSPACE_PROFILE,
  requiresChannelScope,
  type NostrEvent,
} from "@buzz/core";

const CHANNEL_ADMIN_KINDS = new Set<number>([
  KIND_NIP29_PUT_USER,
  KIND_NIP29_REMOVE_USER,
  KIND_NIP29_EDIT_METADATA,
  KIND_NIP29_DELETE_GROUP,
]);
const RELAY_ADMIN_KINDS = new Set<number>([
  RELAY_ADMIN_ADD_MEMBER,
  RELAY_ADMIN_REMOVE_MEMBER,
  RELAY_ADMIN_CHANGE_ROLE,
  RELAY_ADMIN_SET_WORKSPACE_PROFILE,
]);
const MODERATION_COMMAND_KINDS = new Set<number>([
  KIND_MODERATION_BAN,
  KIND_MODERATION_UNBAN,
  KIND_MODERATION_TIMEOUT,
  KIND_MODERATION_UNTIMEOUT,
  KIND_MODERATION_RESOLVE_REPORT,
]);
const CLIENT_FORBIDDEN_KINDS = new Set<number>([
  ...RELAY_ONLY_KINDS,
  KIND_IA_ARCHIVED,
  KIND_IA_UNARCHIVED,
  KIND_IA_ARCHIVED_LIST,
  KIND_NIP43_MEMBER_ADDED,
  KIND_NIP43_MEMBER_REMOVED,
]);

export type RelayAccessPolicy = {
  canConnect(
    community: string,
    pubkey: string,
    delegatedBy?: string,
  ): Promise<boolean>;
  canPublish(
    community: string,
    pubkey: string,
    event: NostrEvent,
    delegatedBy?: string,
    resolvedChannelId?: string | null,
  ): Promise<boolean>;
  canRead(
    community: string,
    pubkey: string,
    event: NostrEvent,
    delegatedBy?: string,
  ): Promise<boolean>;
};

export class OpenRelayAccessPolicy implements RelayAccessPolicy {
  public async canConnect(): Promise<boolean> {
    return true;
  }

  public async canPublish(
    _community: string,
    pubkey: string,
    event: NostrEvent,
    _delegatedBy?: string,
    resolvedChannelId?: string | null,
  ): Promise<boolean> {
    const channelId =
      resolvedChannelId === undefined
        ? eventChannelId(event)
        : (resolvedChannelId ?? undefined);
    return (
      eventSignerMatchesPrincipal(event, pubkey) &&
      !CLIENT_FORBIDDEN_KINDS.has(event.kind) &&
      event.kind !== 1984 &&
      !MODERATION_COMMAND_KINDS.has(event.kind) &&
      !RELAY_ADMIN_KINDS.has(event.kind) &&
      (!requiresChannelScope(event.kind) || channelId !== undefined) &&
      (isGlobalOnlyKind(event.kind) ||
        channelId !== undefined ||
        !event.tags.some((tag) => tag[0] === "h"))
    );
  }

  public async canRead(
    _community: string,
    pubkey: string,
    event: NostrEvent,
  ): Promise<boolean> {
    return eventVisibleToReader(event, pubkey);
  }
}

export class PostgresRelayAccessPolicy implements RelayAccessPolicy {
  public constructor(
    private readonly pool: Pool,
    private readonly requireRelayMembership: boolean,
  ) {}

  public async canConnect(
    community: string,
    pubkey: string,
    delegatedBy?: string,
  ): Promise<boolean> {
    const principals = [...new Set([pubkey, delegatedBy].filter(isString))];
    const result = await this.pool.query(
      `SELECT 1
       FROM communities c
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND (
           $3::boolean = false OR EXISTS (
             SELECT 1 FROM relay_members rm
             WHERE rm.community_id = c.id
               AND rm.pubkey = ANY($2::text[])
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM community_bans cb
           WHERE cb.community_id = c.id
             AND cb.pubkey = ANY(
               SELECT decode(value, 'hex')
               FROM unnest($2::text[]) AS value
             )
             AND cb.banned = true
             AND (cb.ban_expires_at IS NULL OR cb.ban_expires_at > now())
         )
       LIMIT 1`,
      [community, principals, this.requireRelayMembership],
    );
    return result.rowCount === 1;
  }

  public async canPublish(
    community: string,
    pubkey: string,
    event: NostrEvent,
    delegatedBy?: string,
    resolvedChannelId?: string | null,
  ): Promise<boolean> {
    if (!eventSignerMatchesPrincipal(event, pubkey)) return false;
    if (!(await this.canConnect(community, pubkey, delegatedBy))) {
      return false;
    }
    if (CLIENT_FORBIDDEN_KINDS.has(event.kind)) {
      return false;
    }
    if (RELAY_ADMIN_KINDS.has(event.kind)) {
      return this.relayAdminAccess(community, pubkey, event.kind, delegatedBy);
    }
    if (MODERATION_COMMAND_KINDS.has(event.kind)) {
      return this.relayAdminAccess(community, pubkey, event.kind, delegatedBy);
    }
    if (await this.isTimedOut(community, pubkey, delegatedBy)) {
      return false;
    }
    const channelId =
      resolvedChannelId === undefined
        ? eventChannelId(event)
        : (resolvedChannelId ?? undefined);
    if (requiresChannelScope(event.kind) && !channelId) return false;
    if (
      !isGlobalOnlyKind(event.kind) &&
      !channelId &&
      event.tags.some((tag) => tag[0] === "h")
    ) {
      return false;
    }
    if (!channelId) return this.canConnect(community, pubkey, delegatedBy);
    if (event.kind === KIND_NIP29_CREATE_GROUP) {
      if (!validCreateGroup(event)) return false;
      return this.canCreateChannel(community, pubkey, channelId, delegatedBy);
    }
    if (event.kind === KIND_NIP29_JOIN_REQUEST) {
      return this.canJoinChannel(community, pubkey, channelId, delegatedBy);
    }
    if (event.kind === KIND_NIP29_LEAVE_REQUEST) {
      return this.channelAccess(
        community,
        pubkey,
        channelId,
        true,
        delegatedBy,
      );
    }
    if (event.kind === KIND_NIP29_DELETE_EVENT) {
      return this.channelDeleteAccess(community, pubkey, channelId, event);
    }
    if (CHANNEL_ADMIN_KINDS.has(event.kind)) {
      // These signed requests are validated and applied under the channel row
      // lock by PostgresEventStore. Admission here only proves the host-bound
      // channel exists; duplicating the role matrix in two pre-transaction
      // reads caused open-channel invites, self-removal, and agent-owner
      // controls to be rejected before the authoritative command handler.
      return this.channelCommandCandidate(community, channelId, event);
    }
    return this.channelAccess(community, pubkey, channelId, true, delegatedBy);
  }

  public async canRead(
    community: string,
    pubkey: string,
    event: NostrEvent,
    delegatedBy?: string,
  ): Promise<boolean> {
    if (!eventVisibleToReader(event, pubkey)) return false;
    const channelId = eventChannelId(event);
    if (
      !isGlobalOnlyKind(event.kind) &&
      !channelId &&
      event.tags.some((tag) => tag[0] === "h")
    ) {
      return false;
    }
    if (!channelId) return this.canConnect(community, pubkey, delegatedBy);
    return this.channelAccess(community, pubkey, channelId, false, delegatedBy);
  }

  private async channelAccess(
    community: string,
    pubkey: string,
    channelId: string,
    write: boolean,
    delegatedBy?: string,
  ): Promise<boolean> {
    const result = await this.pool.query<{
      readonly visibility: "open" | "private";
      readonly is_member: boolean;
      readonly is_moderator: boolean;
    }>(
      `SELECT ch.visibility::text AS visibility,
              EXISTS (
                SELECT 1 FROM channel_members cm
                WHERE cm.community_id = ch.community_id
                  AND cm.channel_id = ch.id
                  AND cm.pubkey = decode($3, 'hex')
                  AND cm.removed_at IS NULL
              ) AS is_member,
              EXISTS (
                SELECT 1 FROM relay_members rm
                WHERE rm.community_id = ch.community_id
                  AND rm.pubkey = $3
                  AND rm.role IN ('owner', 'admin')
              ) AS is_moderator
       FROM channels ch
       JOIN communities c ON c.id = ch.community_id
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND ch.id = $2::uuid
         AND ch.archived_at IS NULL
         AND ch.deleted_at IS NULL`,
      [community, channelId, pubkey],
    );
    const row = result.rows[0];
    if (!row) return false;
    if (row.is_member || row.is_moderator) return true;
    return !write && row.visibility === "open"
      ? this.canConnect(community, pubkey, delegatedBy)
      : false;
  }

  private async canCreateChannel(
    community: string,
    pubkey: string,
    channelId: string,
    delegatedBy?: string,
  ): Promise<boolean> {
    if (!(await this.canConnect(community, pubkey, delegatedBy))) return false;
    const result = await this.pool.query(
      `SELECT 1
       FROM channels ch
       JOIN communities c ON c.id = ch.community_id
       WHERE lower(c.host) = lower($1) AND ch.id = $2::uuid
       LIMIT 1`,
      [community, channelId],
    );
    return result.rowCount === 0;
  }

  private async canJoinChannel(
    community: string,
    pubkey: string,
    channelId: string,
    delegatedBy?: string,
  ): Promise<boolean> {
    if (!(await this.canConnect(community, pubkey, delegatedBy))) return false;
    const result = await this.pool.query(
      `SELECT 1
       FROM channels ch
       JOIN communities c ON c.id = ch.community_id
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND ch.id = $2::uuid
         AND ch.visibility = 'open'
         AND ch.archived_at IS NULL
         AND ch.deleted_at IS NULL
       LIMIT 1`,
      [community, channelId],
    );
    return result.rowCount === 1;
  }

  private async channelCommandCandidate(
    community: string,
    channelId: string,
    event: NostrEvent,
  ): Promise<boolean> {
    const isUnarchive =
      event.kind === KIND_NIP29_EDIT_METADATA &&
      event.tags.some(
        (tag) =>
          tag.length === 2 && tag[0] === "archived" && tag[1] === "false",
      );
    const result = await this.pool.query(
      `SELECT 1
       FROM channels ch
       JOIN communities c ON c.id = ch.community_id
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND ch.id = $2::uuid
         AND ch.deleted_at IS NULL
         AND (ch.archived_at IS NULL OR $3::boolean)
       LIMIT 1`,
      [community, channelId, isUnarchive],
    );
    return result.rowCount === 1;
  }

  private async channelDeleteAccess(
    community: string,
    pubkey: string,
    channelId: string,
    event: NostrEvent,
  ): Promise<boolean> {
    const targetId = event.tags.find(
      (tag) =>
        tag[0] === "e" &&
        tag[1] !== undefined &&
        /^[0-9a-f]{64}$/i.test(tag[1]),
    )?.[1];
    if (!targetId) return false;
    const result = await this.pool.query(
      `SELECT 1
       FROM events target
       JOIN channels ch
         ON ch.community_id = target.community_id
        AND ch.id = target.channel_id
       JOIN communities c ON c.id = target.community_id
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND target.id = decode($2, 'hex')
         AND target.deleted_at IS NULL
         AND target.channel_id = $3::uuid
         AND ch.deleted_at IS NULL
         AND (
           (
             target.pubkey = decode($4, 'hex')
             AND (
               ch.visibility = 'open'
               OR EXISTS (
                 SELECT 1
                 FROM channel_members self_member
                 WHERE self_member.community_id = ch.community_id
                   AND self_member.channel_id = ch.id
                   AND self_member.pubkey = decode($4, 'hex')
                   AND self_member.removed_at IS NULL
               )
             )
           )
           OR EXISTS (
             SELECT 1
             FROM users target_author
             WHERE target_author.community_id = ch.community_id
               AND target_author.pubkey = target.pubkey
               AND target_author.agent_owner_pubkey = decode($4, 'hex')
           )
           OR EXISTS (
             SELECT 1
             FROM channel_members elevated
             WHERE elevated.community_id = ch.community_id
               AND elevated.channel_id = ch.id
               AND elevated.pubkey = decode($4, 'hex')
               AND elevated.role IN ('owner', 'admin')
               AND elevated.removed_at IS NULL
           )
           OR EXISTS (
             SELECT 1
             FROM relay_members relay_elevated
             WHERE relay_elevated.community_id = ch.community_id
               AND relay_elevated.pubkey = $4
               AND relay_elevated.role IN ('owner', 'admin')
           )
         )
       LIMIT 1`,
      [community, targetId.toLowerCase(), channelId, pubkey],
    );
    return result.rowCount === 1;
  }

  private async relayAdminAccess(
    community: string,
    pubkey: string,
    kind: number,
    delegatedBy?: string,
  ): Promise<boolean> {
    if (delegatedBy !== undefined) return false;
    const allowedRoles =
      kind === RELAY_ADMIN_CHANGE_ROLE ? ["owner"] : ["owner", "admin"];
    const result = await this.pool.query(
      `SELECT 1
       FROM relay_members rm
       JOIN communities c ON c.id = rm.community_id
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND rm.pubkey = $2
         AND rm.role = ANY($3::text[])
       LIMIT 1`,
      [community, pubkey, allowedRoles],
    );
    return result.rowCount === 1;
  }

  private async isTimedOut(
    community: string,
    pubkey: string,
    delegatedBy?: string,
  ): Promise<boolean> {
    const principals = [...new Set([pubkey, delegatedBy].filter(isString))];
    const result = await this.pool.query(
      `SELECT 1
       FROM communities c
       JOIN community_bans cb ON cb.community_id = c.id
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND cb.pubkey = ANY(
           SELECT decode(value, 'hex')
           FROM unnest($2::text[]) AS value
         )
         AND cb.muted_until > now()
       LIMIT 1`,
      [community, principals],
    );
    return result.rowCount === 1;
  }
}

/**
 * Per-result privacy gate shared by historical queries, counts, and live
 * fan-out. Knowing an event id or using a broad filter never grants access.
 */
export function eventVisibleToReader(
  event: NostrEvent,
  readerPubkey: string,
): boolean {
  if (AUTHOR_ONLY_KINDS.has(event.kind)) {
    return event.pubkey === readerPubkey;
  }
  if (
    event.kind === KIND_PERSONA &&
    event.pubkey !== readerPubkey &&
    !event.tags.some(
      (tag) => tag.length === 2 && tag[0] === "shared" && tag[1] === "true",
    )
  ) {
    return false;
  }
  if (P_GATED_KINDS.has(event.kind)) {
    return event.tags.some(
      (tag) => tag.length >= 2 && tag[0] === "p" && tag[1] === readerPubkey,
    );
  }
  return true;
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function eventSignerMatchesPrincipal(
  event: NostrEvent,
  principalPubkey: string,
): boolean {
  return event.kind === KIND_GIFT_WRAP || event.pubkey === principalPubkey;
}

export function exactChannelId(event: NostrEvent): string | undefined {
  const tags = event.tags.filter((tag) => tag[0] === "h");
  if (tags.length !== 1 || tags[0]?.length !== 2) return undefined;
  const value = tags[0][1];
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : undefined;
}

/** Resolve the persistence/policy channel coordinate for a signed event. */
export function eventChannelId(event: NostrEvent): string | undefined {
  return isGlobalOnlyKind(event.kind) ? undefined : exactChannelId(event);
}

function validCreateGroup(event: NostrEvent): boolean {
  const name = singleTagValue(event, "name");
  if (!name || canonicalChannelName(name).length === 0) return false;
  const visibility = optionalSingleTagValue(event, "visibility");
  if (
    visibility === null ||
    (visibility !== undefined &&
      visibility !== "open" &&
      visibility !== "private")
  ) {
    return false;
  }
  const channelType = optionalSingleTagValue(event, "channel_type");
  if (
    channelType === null ||
    (channelType !== undefined &&
      !["stream", "forum", "dm", "workflow"].includes(channelType))
  ) {
    return false;
  }
  const ttl = optionalSingleTagValue(event, "ttl");
  return (
    ttl !== null &&
    (ttl === undefined ||
      (/^[1-9][0-9]*$/.test(ttl) && Number(ttl) <= 2_147_483_647))
  );
}

function singleTagValue(event: NostrEvent, name: string): string | undefined {
  const values = event.tags.filter((tag) => tag[0] === name);
  return values.length === 1 && values[0]?.length === 2
    ? values[0][1]
    : undefined;
}

function optionalSingleTagValue(
  event: NostrEvent,
  name: string,
): string | undefined | null {
  const values = event.tags.filter((tag) => tag[0] === name);
  if (values.length === 0) return undefined;
  return values.length === 1 && values[0]?.length === 2 ? values[0][1] : null;
}

function canonicalChannelName(value: string): string {
  return value.trim().replace(/^#+/, "");
}
