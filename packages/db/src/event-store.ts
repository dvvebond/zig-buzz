import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import {
  eventMatchesFilter,
  isEphemeralKind,
  isParameterizedReplaceableKind,
  verifyNostrEvent,
  KIND_AUTH,
  KIND_AGENT_PROFILE,
  KIND_DELETION,
  KIND_NIP29_DELETE_EVENT,
  KIND_PUSH_LEASE,
  KIND_REACTION,
  KIND_THREAD_SUMMARY,
  KIND_NIP29_CREATE_GROUP,
  KIND_NIP29_DELETE_GROUP,
  KIND_NIP29_EDIT_METADATA,
  KIND_NIP29_JOIN_REQUEST,
  KIND_NIP29_LEAVE_REQUEST,
  KIND_NIP29_PUT_USER,
  KIND_NIP29_REMOVE_USER,
  KIND_DM_ADD_MEMBER,
  KIND_DM_HIDE,
  KIND_DM_OPEN,
  KIND_DM_VISIBILITY,
  KIND_NIP43_MEMBER_ADDED,
  KIND_NIP43_MEMBER_REMOVED,
  KIND_NIP43_MEMBERSHIP_LIST,
  KIND_NIP29_GROUP_ADMINS,
  KIND_MEMBER_ADDED_NOTIFICATION,
  KIND_MEMBER_REMOVED_NOTIFICATION,
  KIND_SYSTEM_MESSAGE,
  RELAY_ADMIN_ADD_MEMBER,
  RELAY_ADMIN_CHANGE_ROLE,
  RELAY_ADMIN_REMOVE_MEMBER,
  publicKeyFromSecret,
  signNostrEvent,
  type NostrEvent,
  type NostrFilter,
} from "@buzz/core";

export type StoreEventResult = {
  readonly channelAccessChanges?: readonly {
    readonly channelId: string;
    readonly mode: "all" | "non_members";
  }[];
  readonly derivedEvents?: readonly NostrEvent[];
  readonly message?: string;
  readonly revokedChannelMembers?: readonly {
    readonly channelId: string;
    readonly pubkey: string;
  }[];
  readonly status: "inserted" | "duplicate" | "ephemeral" | "superseded";
};

export type EventStoreTransactionEffect = (
  client: PoolClient,
  communityId: string,
) => Promise<void>;

export type ThreadMetadata = {
  readonly broadcast: boolean;
  readonly channelId: string;
  readonly depth: number;
  readonly eventCreatedAt: number;
  readonly eventId: string;
  readonly parentEventCreatedAt: number;
  readonly parentEventId: string;
  readonly rootEventCreatedAt: number;
  readonly rootEventId: string;
};

export type ThreadMetadataRecord = ThreadMetadata & {
  readonly descendantCount: number;
  readonly replyCount: number;
};

export type ThreadSummary = {
  readonly descendantCount: number;
  readonly lastReplyAt?: number;
  readonly participants: readonly string[];
  readonly replyCount: number;
};

export type ChannelWindowRow = {
  readonly storedEvent: StoredEvent;
  readonly threadSummary?: ThreadSummary;
};

export type ChannelWindow = {
  readonly hasMore: boolean;
  readonly nextCursor?: EventCursor;
  readonly rows: readonly ChannelWindowRow[];
};

export type ExpiredChannelOutcome = {
  readonly channelId: string;
  readonly community: string;
  readonly communityId: string;
  readonly derivedEvents: readonly NostrEvent[];
};

export type EventStore = {
  canDeleteChannelEvent(
    community: string,
    actorPubkey: string,
    target: StoredEvent,
    channelId: string,
    targetAuthorPubkey: string,
  ): Promise<boolean>;
  canManageAuthor(
    community: string,
    actorPubkey: string,
    targetPubkey: string,
  ): Promise<boolean>;
  store(
    community: string,
    event: NostrEvent,
    channelId?: string,
    transactionEffect?: EventStoreTransactionEffect,
    threadMetadata?: ThreadMetadata,
  ): Promise<StoreEventResult>;
  query(community: string, filter: NostrFilter): Promise<NostrEvent[]>;
  queryPage(
    community: string,
    filter: NostrFilter,
    cursor: EventCursor | undefined,
    pageSize: number,
  ): Promise<NostrEvent[]>;
  count(community: string, filter: NostrFilter): Promise<number>;
  getById(
    community: string,
    eventId: string,
    options?: { readonly includeDeleted?: boolean },
  ): Promise<StoredEvent | undefined>;
  getByAddress(
    community: string,
    kind: number,
    pubkey: string,
    dTag: string,
    options?: { readonly includeDeleted?: boolean },
  ): Promise<StoredEvent | undefined>;
  getThreadMetadata(
    community: string,
    eventId: string,
  ): Promise<ThreadMetadataRecord | undefined>;
  getThreadSummary(
    community: string,
    eventId: string,
  ): Promise<ThreadSummary | undefined>;
  queryChannelWindow(
    community: string,
    channelId: string,
    options: {
      readonly cursor?: EventCursor;
      readonly kinds?: readonly number[];
      readonly limit: number;
    },
  ): Promise<ChannelWindow>;
};

export type StoredEvent = {
  readonly channelId?: string;
  readonly event: NostrEvent;
};

export type EventCursor = {
  readonly createdAt: number;
  readonly id: string;
};

export class MemoryEventStore implements EventStore {
  readonly #events = new Map<string, Map<string, NostrEvent>>();
  readonly #deletedEvents = new Map<string, Map<string, NostrEvent>>();
  readonly #channelIds = new Map<string, Map<string, string | undefined>>();
  readonly #reactions = new Map<string, Set<string>>();
  readonly #threads = new Map<string, Map<string, MemoryThreadRecord>>();

  public async canManageAuthor(
    _community: string,
    actorPubkey: string,
    targetPubkey: string,
  ): Promise<boolean> {
    return actorPubkey === targetPubkey;
  }

  public async canDeleteChannelEvent(
    _community: string,
    actorPubkey: string,
    target: StoredEvent,
    channelId: string,
    targetAuthorPubkey: string,
  ): Promise<boolean> {
    return target.channelId === channelId && targetAuthorPubkey === actorPubkey;
  }

  public async store(
    community: string,
    event: NostrEvent,
    _channelId?: string,
    transactionEffect?: EventStoreTransactionEffect,
    threadMetadata?: ThreadMetadata,
  ): Promise<StoreEventResult> {
    if (transactionEffect) {
      throw new Error(
        "transactional event effects require the PostgreSQL event store",
      );
    }
    validateStorableEvent(event);
    if (isEphemeralKind(event.kind)) return { status: "ephemeral" };
    const scoped = this.#events.get(community) ?? new Map<string, NostrEvent>();
    this.#events.set(community, scoped);
    if (scoped.has(event.id)) return { status: "duplicate" };
    const reactionKey =
      event.kind === KIND_REACTION
        ? memoryReactionKey(event, scoped)
        : undefined;
    const reactions = this.#reactions.get(community) ?? new Set<string>();
    if (reactionKey && reactions.has(reactionKey)) {
      return {
        message: "duplicate: reaction already exists",
        status: "duplicate",
      };
    }
    if (hasWinningReplaceableEvent(scoped.values(), event)) {
      return { status: "superseded" };
    }
    removeSupersededEvents(scoped, event);
    if (
      event.kind === KIND_DELETION ||
      event.kind === KIND_NIP29_DELETE_EVENT
    ) {
      const threads = this.#threads.get(community);
      applyMemoryDeletion(
        event,
        scoped,
        this.#deletedEvents,
        community,
        reactions,
        (deleted) => {
          if (threads) decrementMemoryThread(threads, deleted.id);
        },
      );
    }
    scoped.set(event.id, event);
    const coordinates =
      this.#channelIds.get(community) ?? new Map<string, string | undefined>();
    this.#channelIds.set(community, coordinates);
    coordinates.set(event.id, _channelId);
    if (reactionKey) {
      this.#reactions.set(community, reactions);
      reactions.add(reactionKey);
    }
    if (threadMetadata) {
      if (
        threadMetadata.eventId !== event.id ||
        threadMetadata.eventCreatedAt !== event.created_at ||
        threadMetadata.channelId !== _channelId
      ) {
        throw new Error("thread metadata does not match the stored event");
      }
      const threads =
        this.#threads.get(community) ?? new Map<string, MemoryThreadRecord>();
      this.#threads.set(community, threads);
      insertMemoryThread(threads, threadMetadata);
    }
    return { status: "inserted" };
  }

  public async getById(
    community: string,
    eventId: string,
    options: { readonly includeDeleted?: boolean } = {},
  ): Promise<StoredEvent | undefined> {
    const event =
      this.#events.get(community)?.get(eventId) ??
      (options.includeDeleted
        ? this.#deletedEvents.get(community)?.get(eventId)
        : undefined);
    if (!event) return undefined;
    const channelId = this.#channelIds.get(community)?.get(eventId);
    return {
      ...(channelId === undefined ? {} : { channelId }),
      event,
    };
  }

  public async getByAddress(
    community: string,
    kind: number,
    pubkey: string,
    dTag: string,
    options: { readonly includeDeleted?: boolean } = {},
  ): Promise<StoredEvent | undefined> {
    const candidates = [
      ...(this.#events.get(community)?.values() ?? []),
      ...(options.includeDeleted
        ? (this.#deletedEvents.get(community)?.values() ?? [])
        : []),
    ]
      .filter(
        (event) =>
          event.kind === kind &&
          event.pubkey === pubkey &&
          extractDTag(event) === dTag,
      )
      .sort(compareEvents);
    const event = candidates[0];
    return event ? this.getById(community, event.id, options) : undefined;
  }

  public async getThreadMetadata(
    community: string,
    eventId: string,
  ): Promise<ThreadMetadataRecord | undefined> {
    const row = this.#threads.get(community)?.get(eventId);
    return row ? publicThreadRecord(row) : undefined;
  }

  public async getThreadSummary(
    community: string,
    eventId: string,
  ): Promise<ThreadSummary | undefined> {
    const threads = this.#threads.get(community);
    const row = threads?.get(eventId);
    if (!threads || !row) return undefined;
    return memoryThreadSummary(
      threads,
      this.#events.get(community) ?? new Map(),
      eventId,
    );
  }

  public async queryChannelWindow(
    community: string,
    channelId: string,
    options: {
      readonly cursor?: EventCursor;
      readonly kinds?: readonly number[];
      readonly limit: number;
    },
  ): Promise<ChannelWindow> {
    const threads = this.#threads.get(community) ?? new Map();
    const events = this.#events.get(community) ?? new Map();
    const coordinates = this.#channelIds.get(community) ?? new Map();
    const candidates = [...events.values()]
      .filter((event) => {
        if (coordinates.get(event.id) !== channelId) return false;
        if (options.kinds && !options.kinds.includes(event.kind)) return false;
        if (!isAfterCursor(event, options.cursor)) return false;
        const thread = threads.get(event.id);
        return (
          !thread ||
          thread.depth === 0 ||
          (thread.depth === 1 && thread.broadcast)
        );
      })
      .sort(compareEvents);
    const retained = candidates.slice(0, options.limit);
    const hasMore = candidates.length > options.limit;
    const last = retained.at(-1);
    return {
      hasMore,
      ...(hasMore && last
        ? { nextCursor: { createdAt: last.created_at, id: last.id } }
        : {}),
      rows: retained.map((event) => {
        const summary = threads.get(event.id);
        return {
          storedEvent: {
            channelId,
            event,
          },
          ...(summary && summary.replyCount > 0
            ? {
                threadSummary: memoryThreadSummary(threads, events, event.id),
              }
            : {}),
        };
      }),
    };
  }

  public async query(
    community: string,
    filter: NostrFilter,
  ): Promise<NostrEvent[]> {
    const limit = clampLimit(filter.limit);
    return [...(this.#events.get(community)?.values() ?? [])]
      .filter((event) => eventMatchesFilter(event, filter))
      .sort(compareEvents)
      .slice(0, limit);
  }

  public async count(community: string, filter: NostrFilter): Promise<number> {
    return [...(this.#events.get(community)?.values() ?? [])].filter((event) =>
      eventMatchesFilter(event, filter),
    ).length;
  }

  public async queryPage(
    community: string,
    filter: NostrFilter,
    cursor: EventCursor | undefined,
    pageSize: number,
  ): Promise<NostrEvent[]> {
    const limit = clampPageSize(pageSize);
    const unlimitedFilter = withoutLimit(filter);
    return [...(this.#events.get(community)?.values() ?? [])]
      .filter(
        (event) =>
          eventMatchesFilter(event, unlimitedFilter) &&
          isAfterCursor(event, cursor),
      )
      .sort(compareEvents)
      .slice(0, limit);
  }
}

export class PostgresEventStore implements EventStore {
  readonly #relaySecretKey: Uint8Array | undefined;

  public constructor(
    private readonly pool: Pool,
    options: { readonly relaySecretKey?: Uint8Array } = {},
  ) {
    this.#relaySecretKey = options.relaySecretKey
      ? Uint8Array.from(options.relaySecretKey)
      : undefined;
  }

  /**
   * Atomically archive and materialize relay events for expired TTL channels.
   * Row locks make concurrent reapers on separate relay pods single-winner.
   */
  public async reapExpiredChannels(
    limit = 100,
  ): Promise<readonly ExpiredChannelOutcome[]> {
    if (!this.#relaySecretKey) {
      throw new Error("channel reaping requires a relay signing key");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("channel reaper limit must be between 1 and 1000");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const expired = await client.query<{
        readonly channel_id: string;
        readonly community_id: string;
        readonly host: string;
      }>(
        `SELECT ch.community_id::text AS community_id,
                ch.id::text AS channel_id,
                c.host
         FROM channels ch
         JOIN communities c ON c.id = ch.community_id
         WHERE ch.ttl_deadline IS NOT NULL
           AND ch.ttl_deadline <= clock_timestamp()
           AND ch.archived_at IS NULL
           AND ch.deleted_at IS NULL
           AND c.archived_at IS NULL
         ORDER BY ch.ttl_deadline, ch.community_id, ch.id
         LIMIT $1
         FOR UPDATE OF ch SKIP LOCKED`,
        [limit],
      );
      const outcomes: ExpiredChannelOutcome[] = [];
      for (const row of expired.rows) {
        const claimed = await client.query(
          `UPDATE channels
           SET archived_at = now(), updated_at = now()
           WHERE community_id = $1::uuid
             AND id = $2::uuid
             AND archived_at IS NULL
           RETURNING id`,
          [row.community_id, row.channel_id],
        );
        if (claimed.rowCount !== 1) continue;
        const system = await storeChannelCommandDerivedEvents(
          client,
          row.community_id,
          {
            channelAccessChanges: [{ channelId: row.channel_id, mode: "all" }],
            channelId: row.channel_id,
            notifications: [],
            revokedChannelMembers: [],
            systemContents: [{ type: "channel_auto_archived" }],
          },
          this.#relaySecretKey,
        );
        const snapshotCreatedAt = await allocateChannelSnapshotCreatedAt(
          client,
          row.community_id,
          row.channel_id,
        );
        const snapshots = await buildChannelSnapshots(
          client,
          row.community_id,
          row.channel_id,
          this.#relaySecretKey,
          snapshotCreatedAt,
        );
        outcomes.push({
          channelId: row.channel_id,
          community: row.host,
          communityId: row.community_id,
          derivedEvents: [
            ...system,
            ...(await storeChannelSnapshots(
              client,
              row.community_id,
              row.channel_id,
              snapshots,
            )),
          ],
        });
      }
      await client.query("COMMIT");
      return outcomes;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async canManageAuthor(
    community: string,
    actorPubkey: string,
    targetPubkey: string,
  ): Promise<boolean> {
    if (
      !/^[0-9a-f]{64}$/.test(actorPubkey) ||
      !/^[0-9a-f]{64}$/.test(targetPubkey)
    ) {
      return false;
    }
    if (actorPubkey === targetPubkey) return true;
    const result = await this.pool.query(
      `SELECT 1
       FROM users u
       JOIN communities c ON c.id = u.community_id
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND u.pubkey = decode($2, 'hex')
         AND u.agent_owner_pubkey = decode($3, 'hex')
       LIMIT 1`,
      [community, targetPubkey, actorPubkey],
    );
    return result.rowCount === 1;
  }

  public async canDeleteChannelEvent(
    community: string,
    actorPubkey: string,
    target: StoredEvent,
    channelId: string,
    targetAuthorPubkey: string,
  ): Promise<boolean> {
    if (target.channelId !== channelId) return false;
    if (
      await this.canManageAuthor(community, actorPubkey, targetAuthorPubkey)
    ) {
      return true;
    }
    const result = await this.pool.query(
      `SELECT 1
       FROM channels ch
       JOIN communities c ON c.id = ch.community_id
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND ch.id = $2::uuid
         AND ch.deleted_at IS NULL
         AND (
           EXISTS (
             SELECT 1
             FROM channel_members cm
             WHERE cm.community_id = ch.community_id
               AND cm.channel_id = ch.id
               AND cm.pubkey = decode($3, 'hex')
               AND cm.role IN ('owner', 'admin')
               AND cm.removed_at IS NULL
           )
           OR EXISTS (
             SELECT 1
             FROM relay_members rm
             WHERE rm.community_id = ch.community_id
               AND rm.pubkey = $3
               AND rm.role IN ('owner', 'admin')
           )
         )
       LIMIT 1`,
      [community, channelId, actorPubkey],
    );
    return result.rowCount === 1;
  }

  public async store(
    community: string,
    event: NostrEvent,
    channelId?: string,
    transactionEffect?: EventStoreTransactionEffect,
    threadMetadata?: ThreadMetadata,
  ): Promise<StoreEventResult> {
    validateStorableEvent(event);
    if (isEphemeralKind(event.kind)) return { status: "ephemeral" };
    const client = await this.pool.connect();
    let derivedEvents: readonly NostrEvent[] | undefined;
    let message: string | undefined;
    let eventChannelId = channelId;
    let revokedChannelMembers:
      | readonly { readonly channelId: string; readonly pubkey: string }[]
      | undefined;
    let channelAccessChanges:
      | readonly {
          readonly channelId: string;
          readonly mode: "all" | "non_members";
        }[]
      | undefined;
    let deletionOutcome: PostgresDeletionOutcome = {
      deletedEvents: [],
      threadRoots: [],
    };
    try {
      await client.query("BEGIN");
      const communityResult = await client.query<{ id: string }>(
        `SELECT id FROM communities
         WHERE lower(host) = lower($1) AND archived_at IS NULL
         FOR SHARE`,
        [community],
      );
      const communityId = communityResult.rows[0]?.id;
      if (!communityId) throw new Error("community is unavailable");
      if (event.kind === KIND_REACTION) {
        const targetId = reactionTargetId(event);
        const target = await client.query<{ readonly created_at: Date }>(
          `SELECT created_at
           FROM events
           WHERE community_id = $1
             AND id = decode($2, 'hex')
             AND deleted_at IS NULL
           LIMIT 1
           FOR SHARE`,
          [communityId, targetId],
        );
        const targetCreatedAt = target.rows[0]?.created_at;
        if (!targetCreatedAt)
          throw new Error("reaction target event not found");
        const reaction = await client.query(
          `INSERT INTO reactions (
             community_id, event_created_at, event_id, pubkey, emoji,
             reaction_event_id
           )
           VALUES (
             $1, $2, decode($3, 'hex'), decode($4, 'hex'), $5,
             decode($6, 'hex')
           )
           ON CONFLICT (
             community_id, event_created_at, event_id, pubkey, emoji
           )
           DO UPDATE SET
             created_at = now(),
             removed_at = NULL,
             reaction_event_id = EXCLUDED.reaction_event_id
           WHERE reactions.removed_at IS NOT NULL
           RETURNING event_id`,
          [
            communityId,
            targetCreatedAt,
            targetId,
            event.pubkey,
            reactionEmoji(event),
            event.id,
          ],
        );
        if (reaction.rowCount !== 1) {
          await client.query("COMMIT");
          return {
            message: "duplicate: reaction already exists",
            status: "duplicate",
          };
        }
      }
      const dTag = extractDTag(event);
      if (isReplaceableKind(event.kind)) {
        const winner = await client.query<{
          readonly created_at: Date;
          readonly id: string;
        }>(
          `SELECT e.created_at, encode(e.id, 'hex') AS id
           FROM events e
           WHERE e.community_id = $1
             AND e.pubkey = decode($2, 'hex')
             AND e.kind = $3
             AND e.channel_id IS NOT DISTINCT FROM $4::uuid
             AND e.d_tag IS NOT DISTINCT FROM $5::text
             AND e.deleted_at IS NULL
           ORDER BY e.created_at DESC, e.id ASC
           LIMIT 1
           FOR UPDATE`,
          [communityId, event.pubkey, event.kind, channelId ?? null, dTag],
        );
        const current = winner.rows[0];
        if (
          current &&
          (Math.floor(current.created_at.getTime() / 1_000) >
            event.created_at ||
            (Math.floor(current.created_at.getTime() / 1_000) ===
              event.created_at &&
              current.id < event.id))
        ) {
          await client.query("COMMIT");
          return { status: "superseded" };
        }
        if (current?.id === event.id) {
          await client.query("COMMIT");
          return { status: "duplicate" };
        }
        await client.query(
          `UPDATE events
           SET deleted_at = now()
           WHERE community_id = $1
             AND pubkey = decode($2, 'hex')
             AND kind = $3
             AND deleted_at IS NULL
             AND created_at <= to_timestamp($4)
             AND ($5::text IS NULL OR d_tag = $5)`,
          [communityId, event.pubkey, event.kind, event.created_at, dTag],
        );
      }
      const inserted = await client.query(
        `INSERT INTO events (
           community_id, id, pubkey, created_at, kind, tags, content, sig,
           channel_id, d_tag, not_before
         )
         VALUES (
           $1, decode($2, 'hex'), decode($3, 'hex'), to_timestamp($4), $5,
           $6::jsonb, $7, decode($8, 'hex'), $9::uuid, $10, $11
         )
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          communityId,
          event.id,
          event.pubkey,
          event.created_at,
          event.kind,
          JSON.stringify(event.tags),
          event.content,
          event.sig,
          channelId ?? null,
          dTag,
          extractNotBefore(event),
        ],
      );
      if (inserted.rowCount === 1) {
        if (threadMetadata) {
          if (
            threadMetadata.eventId !== event.id ||
            threadMetadata.eventCreatedAt !== event.created_at ||
            threadMetadata.channelId !== channelId
          ) {
            throw new Error("thread metadata does not match the stored event");
          }
          await insertPostgresThreadMetadata(
            client,
            communityId,
            threadMetadata,
          );
        }
        if (
          event.kind === KIND_DELETION ||
          event.kind === KIND_NIP29_DELETE_EVENT
        ) {
          deletionOutcome = await applyPostgresDeletion(
            client,
            communityId,
            event,
          );
        }
        await applyProfileEvent(client, communityId, community, event);
        await transactionEffect?.(client, communityId);
        const dmResult = await applyDmCommand(
          client,
          communityId,
          event,
          channelId,
        );
        if (dmResult) {
          eventChannelId = dmResult.channelId;
          message = `response:${JSON.stringify({
            channel_id: dmResult.channelId,
            created: dmResult.created,
          })}`;
          if (this.#relaySecretKey) {
            const snapshotCreatedAt = await allocateChannelSnapshotCreatedAt(
              client,
              communityId,
              dmResult.channelId,
            );
            const snapshots = await buildChannelSnapshots(
              client,
              communityId,
              dmResult.channelId,
              this.#relaySecretKey,
              snapshotCreatedAt,
            );
            const dmVisibilityCreatedAt =
              await allocateGlobalAddressableCreatedAt(
                client,
                communityId,
                KIND_DM_VISIBILITY,
                event.pubkey,
                this.#relaySecretKey,
              );
            const dmVisibility = await buildDmVisibilitySnapshot(
              client,
              communityId,
              event.pubkey,
              this.#relaySecretKey,
              dmVisibilityCreatedAt,
            );
            derivedEvents = [
              ...(await storeChannelSnapshots(
                client,
                communityId,
                dmResult.channelId,
                snapshots,
              )),
              ...(await storeGlobalAddressableEvents(client, communityId, [
                dmVisibility,
              ])),
            ];
          }
          await client.query(
            `UPDATE events
             SET channel_id = $4::uuid
             WHERE community_id = $1
               AND id = decode($2, 'hex')
               AND pubkey = decode($3, 'hex')`,
            [communityId, event.id, event.pubkey, dmResult.channelId],
          );
        }
        const relayAdminResult = await applyRelayAdminCommand(
          client,
          communityId,
          event,
        );
        if (relayAdminResult && this.#relaySecretKey) {
          const relayEvents: NostrEvent[] = [];
          if (relayAdminResult.deltaKind !== undefined) {
            relayEvents.push(
              signNostrEvent(
                {
                  content: "",
                  created_at: Math.floor(Date.now() / 1_000),
                  kind: relayAdminResult.deltaKind,
                  tags: [["-"], ["p", relayAdminResult.targetPubkey]],
                },
                this.#relaySecretKey,
              ),
            );
          }
          relayEvents.push(
            await buildRelayMembershipSnapshot(
              client,
              communityId,
              this.#relaySecretKey,
            ),
          );
          derivedEvents = [...(derivedEvents ?? []), ...relayEvents];
        }
        const channelCommand = await applyChannelCommand(
          client,
          communityId,
          event,
          channelId,
        );
        if (channelCommand) {
          const commandDerived = await storeChannelCommandDerivedEvents(
            client,
            communityId,
            channelCommand,
            this.#relaySecretKey,
          );
          derivedEvents = [...(derivedEvents ?? []), ...commandDerived];
          revokedChannelMembers = channelCommand.revokedChannelMembers;
          channelAccessChanges = channelCommand.channelAccessChanges;
        }
        if (
          this.#relaySecretKey &&
          channelId &&
          CHANNEL_COMMAND_KINDS.has(event.kind)
        ) {
          const snapshotCreatedAt = await allocateChannelSnapshotCreatedAt(
            client,
            communityId,
            channelId,
          );
          const snapshots = await buildChannelSnapshots(
            client,
            communityId,
            channelId,
            this.#relaySecretKey,
            snapshotCreatedAt,
          );
          derivedEvents = [
            ...(derivedEvents ?? []),
            ...(await storeChannelSnapshots(
              client,
              communityId,
              channelId,
              snapshots,
            )),
          ];
        }
        if (this.#relaySecretKey && threadMetadata) {
          const summary = await buildPostgresThreadSummary(
            client,
            communityId,
            threadMetadata.rootEventId,
          );
          if (summary) {
            derivedEvents = [
              ...(derivedEvents ?? []),
              buildThreadSummaryEvent(
                this.#relaySecretKey,
                threadMetadata.channelId,
                threadMetadata.rootEventId,
                summary,
              ),
            ];
          }
        }
        if (this.#relaySecretKey) {
          if (event.kind === KIND_NIP29_DELETE_EVENT) {
            for (const deletedEvent of deletionOutcome.deletedEvents) {
              const deletionDerived = await storeChannelCommandDerivedEvents(
                client,
                communityId,
                {
                  channelAccessChanges: [],
                  channelId: deletedEvent.channelId,
                  notifications: [],
                  revokedChannelMembers: [],
                  systemContents: [
                    deletionTombstoneContent(event, deletedEvent.eventId),
                  ],
                },
                this.#relaySecretKey,
              );
              derivedEvents = [...(derivedEvents ?? []), ...deletionDerived];
            }
          }
          for (const deletedThread of deletionOutcome.threadRoots) {
            const summary = await buildPostgresThreadSummary(
              client,
              communityId,
              deletedThread.rootEventId,
            );
            if (!summary) continue;
            derivedEvents = [
              ...(derivedEvents ?? []),
              buildThreadSummaryEvent(
                this.#relaySecretKey,
                deletedThread.channelId,
                deletedThread.rootEventId,
                summary,
              ),
            ];
          }
        }
        const mentions = uniqueTagValues(event, "p").filter((value) =>
          /^[0-9a-f]{64}$/.test(value),
        );
        for (const pubkey of mentions) {
          await client.query(
            `INSERT INTO event_mentions (
               community_id, pubkey_hex, event_id, event_created_at,
               channel_id, event_kind
             )
             VALUES (
               $1, $2, decode($3, 'hex'), to_timestamp($4), $5::uuid, $6
             )
             ON CONFLICT DO NOTHING`,
            [
              communityId,
              pubkey,
              event.id,
              event.created_at,
              eventChannelId ?? null,
              event.kind,
            ],
          );
        }
      }
      await client.query("COMMIT");
      return {
        ...(channelAccessChanges?.length ? { channelAccessChanges } : {}),
        ...(derivedEvents?.length ? { derivedEvents } : {}),
        ...(message !== undefined ? { message } : {}),
        ...(revokedChannelMembers?.length ? { revokedChannelMembers } : {}),
        status: inserted.rowCount === 1 ? "inserted" : "duplicate",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async query(
    community: string,
    filter: NostrFilter,
  ): Promise<NostrEvent[]> {
    const query = buildFilterQuery(community, filter, false);
    const result = await this.pool.query<EventRow>(query.text, query.values);
    const stored = result.rows.map(eventFromRow);
    const virtual = await this.#queryChannelSnapshots(community, filter);
    return mergeFilteredEvents(
      stored,
      virtual,
      filter,
      clampLimit(filter.limit),
    );
  }

  public async getById(
    community: string,
    eventId: string,
    options: { readonly includeDeleted?: boolean } = {},
  ): Promise<StoredEvent | undefined> {
    if (!/^[0-9a-f]{64}$/.test(eventId)) return undefined;
    const result = await this.pool.query<
      EventRow & { readonly channel_id: string | null }
    >(
      `SELECT encode(e.id, 'hex') AS id,
              encode(e.pubkey, 'hex') AS pubkey,
              e.created_at,
              e.kind,
              e.tags,
              e.content,
              encode(e.sig, 'hex') AS sig,
              e.channel_id::text AS channel_id
       FROM events e
       JOIN communities c ON c.id = e.community_id
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND e.id = decode($2, 'hex')
         ${options.includeDeleted ? "" : "AND e.deleted_at IS NULL"}
       LIMIT 1`,
      [community, eventId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      ...(row.channel_id === null ? {} : { channelId: row.channel_id }),
      event: eventFromRow(row),
    };
  }

  public async getByAddress(
    community: string,
    kind: number,
    pubkey: string,
    dTag: string,
    options: { readonly includeDeleted?: boolean } = {},
  ): Promise<StoredEvent | undefined> {
    if (!Number.isSafeInteger(kind) || !/^[0-9a-f]{64}$/.test(pubkey)) {
      return undefined;
    }
    const result = await this.pool.query<
      EventRow & { readonly channel_id: string | null }
    >(
      `SELECT encode(e.id, 'hex') AS id,
              encode(e.pubkey, 'hex') AS pubkey,
              e.created_at,
              e.kind,
              e.tags,
              e.content,
              encode(e.sig, 'hex') AS sig,
              e.channel_id::text AS channel_id
       FROM events e
       JOIN communities c ON c.id = e.community_id
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND e.kind = $2
         AND e.pubkey = decode($3, 'hex')
         AND e.d_tag = $4
         ${options.includeDeleted ? "" : "AND e.deleted_at IS NULL"}
       ORDER BY e.created_at DESC, e.id ASC
       LIMIT 1`,
      [community, kind, pubkey, dTag],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      ...(row.channel_id === null ? {} : { channelId: row.channel_id }),
      event: eventFromRow(row),
    };
  }

  public async getThreadMetadata(
    community: string,
    eventId: string,
  ): Promise<ThreadMetadataRecord | undefined> {
    if (!/^[0-9a-f]{64}$/.test(eventId)) return undefined;
    const result = await this.pool.query<{
      readonly broadcast: boolean;
      readonly channel_id: string;
      readonly depth: number;
      readonly descendant_count: number;
      readonly event_created_at: Date;
      readonly parent_event_created_at: Date | null;
      readonly parent_event_id: string | null;
      readonly reply_count: number;
      readonly root_event_created_at: Date | null;
      readonly root_event_id: string | null;
    }>(
      `SELECT
         tm.event_created_at,
         tm.channel_id::text AS channel_id,
         CASE WHEN tm.parent_event_id IS NULL
           THEN NULL ELSE encode(tm.parent_event_id, 'hex') END AS parent_event_id,
         tm.parent_event_created_at,
         CASE WHEN tm.root_event_id IS NULL
           THEN NULL ELSE encode(tm.root_event_id, 'hex') END AS root_event_id,
         tm.root_event_created_at,
         tm.depth,
         tm.reply_count,
         tm.descendant_count,
         tm.broadcast
       FROM thread_metadata tm
       JOIN communities c ON c.id = tm.community_id
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND tm.event_id = decode($2, 'hex')
       LIMIT 1`,
      [community, eventId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      broadcast: row.broadcast,
      channelId: row.channel_id,
      depth: row.depth,
      descendantCount: row.descendant_count,
      eventCreatedAt: Math.floor(row.event_created_at.getTime() / 1_000),
      eventId,
      parentEventCreatedAt: Math.floor(
        (row.parent_event_created_at ?? row.event_created_at).getTime() / 1_000,
      ),
      parentEventId: row.parent_event_id ?? eventId,
      replyCount: row.reply_count,
      rootEventCreatedAt: Math.floor(
        (row.root_event_created_at ?? row.event_created_at).getTime() / 1_000,
      ),
      rootEventId: row.root_event_id ?? eventId,
    };
  }

  public async getThreadSummary(
    community: string,
    eventId: string,
  ): Promise<ThreadSummary | undefined> {
    if (!/^[0-9a-f]{64}$/.test(eventId)) return undefined;
    const client = await this.pool.connect();
    try {
      const communityResult = await client.query<{ readonly id: string }>(
        `SELECT id
         FROM communities
         WHERE lower(host) = lower($1) AND archived_at IS NULL
         LIMIT 1`,
        [community],
      );
      const communityId = communityResult.rows[0]?.id;
      if (!communityId) return undefined;
      return buildPostgresThreadSummary(client, communityId, eventId);
    } finally {
      client.release();
    }
  }

  public async queryChannelWindow(
    community: string,
    channelId: string,
    options: {
      readonly cursor?: EventCursor;
      readonly kinds?: readonly number[];
      readonly limit: number;
    },
  ): Promise<ChannelWindow> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        channelId,
      )
    ) {
      throw new Error("channel window requires a valid channel UUID");
    }
    const values: unknown[] = [community, channelId, options.limit + 1];
    const clauses = [
      "lower(c.host) = lower($1)",
      "c.archived_at IS NULL",
      "e.channel_id = $2::uuid",
      "e.deleted_at IS NULL",
      `(tm.depth IS NULL
        OR tm.depth = 0
        OR (tm.depth = 1 AND tm.broadcast = true))`,
    ];
    if (options.cursor) {
      values.push(options.cursor.createdAt, options.cursor.id);
      clauses.push(
        `(e.created_at < to_timestamp($4)
          OR (e.created_at = to_timestamp($4)
            AND e.id > decode($5, 'hex')))`,
      );
    }
    if (options.kinds) {
      values.push(options.kinds);
      clauses.push(`e.kind = ANY($${values.length}::int[])`);
    }
    const limitBind = "$3";
    const result = await this.pool.query<
      EventRow & {
        readonly channel_id: string;
        readonly descendant_count: number | null;
        readonly last_reply_at: Date | null;
        readonly reply_count: number | null;
      }
    >(
      `SELECT
         encode(e.id, 'hex') AS id,
         encode(e.pubkey, 'hex') AS pubkey,
         e.created_at,
         e.kind,
         e.tags,
         e.content,
         encode(e.sig, 'hex') AS sig,
         e.channel_id::text AS channel_id,
         tm.reply_count,
         tm.descendant_count,
         tm.last_reply_at
       FROM events e
       JOIN communities c ON c.id = e.community_id
       LEFT JOIN thread_metadata tm
         ON tm.community_id = e.community_id
        AND tm.event_created_at = e.created_at
        AND tm.event_id = e.id
       WHERE ${clauses.join("\n AND ")}
       ORDER BY e.created_at DESC, e.id ASC
       LIMIT ${limitBind}`,
      values,
    );
    const hasMore = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const roots = rows
      .filter((row) => (row.reply_count ?? 0) > 0)
      .map((row) => row.id);
    const participants = await postgresThreadParticipants(
      this.pool,
      community,
      roots,
    );
    const last = rows.at(-1);
    return {
      hasMore,
      ...(hasMore && last
        ? {
            nextCursor: {
              createdAt: Math.floor(last.created_at.getTime() / 1_000),
              id: last.id,
            },
          }
        : {}),
      rows: rows.map((row) => ({
        storedEvent: {
          channelId: row.channel_id,
          event: eventFromRow(row),
        },
        ...((row.reply_count ?? 0) > 0
          ? {
              threadSummary: {
                descendantCount: row.descendant_count ?? 0,
                ...(row.last_reply_at
                  ? {
                      lastReplyAt: Math.floor(
                        row.last_reply_at.getTime() / 1_000,
                      ),
                    }
                  : {}),
                participants: participants.get(row.id) ?? [],
                replyCount: row.reply_count ?? 0,
              },
            }
          : {}),
      })),
    };
  }

  public async count(community: string, filter: NostrFilter): Promise<number> {
    const query = buildFilterQuery(community, filter, true);
    const result = await this.pool.query<{ count: string }>(
      query.text,
      query.values,
    );
    const storedCount = Number(result.rows[0]?.count ?? "0");
    const virtual = await this.#queryChannelSnapshots(community, filter);
    const count = storedCount + virtual.length;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("database returned an invalid event count");
    }
    return count;
  }

  public async queryPage(
    community: string,
    filter: NostrFilter,
    cursor: EventCursor | undefined,
    pageSize: number,
  ): Promise<NostrEvent[]> {
    const query = buildFilterQuery(
      community,
      withoutLimit(filter),
      false,
      cursor,
      clampPageSize(pageSize),
    );
    const result = await this.pool.query<EventRow>(query.text, query.values);
    const stored = result.rows.map(eventFromRow);
    const virtual = (
      await this.#queryChannelSnapshots(community, filter)
    ).filter((event) => isAfterCursor(event, cursor));
    return mergeFilteredEvents(
      stored,
      virtual,
      filter,
      clampPageSize(pageSize),
    );
  }

  async #queryChannelSnapshots(
    community: string,
    filter: NostrFilter,
  ): Promise<NostrEvent[]> {
    if (
      !this.#relaySecretKey ||
      filter.search !== undefined ||
      (filter.kinds &&
        !filter.kinds.includes(39_000) &&
        !filter.kinds.includes(KIND_NIP29_GROUP_ADMINS) &&
        !filter.kinds.includes(39_002) &&
        !filter.kinds.includes(KIND_DM_VISIBILITY) &&
        !filter.kinds.includes(KIND_NIP43_MEMBERSHIP_LIST))
    ) {
      return [];
    }
    const client = await this.pool.connect();
    try {
      const communityResult = await client.query<{ readonly id: string }>(
        `SELECT id FROM communities
         WHERE lower(host) = lower($1) AND archived_at IS NULL
         LIMIT 1`,
        [community],
      );
      const communityId = communityResult.rows[0]?.id;
      if (!communityId) return [];
      const output: NostrEvent[] = [];
      if (!filter.kinds || filter.kinds.includes(KIND_NIP43_MEMBERSHIP_LIST)) {
        output.push(
          await buildRelayMembershipSnapshot(
            client,
            communityId,
            this.#relaySecretKey,
          ),
        );
      }
      if (
        !filter.kinds ||
        filter.kinds.includes(39_000) ||
        filter.kinds.includes(KIND_NIP29_GROUP_ADMINS) ||
        filter.kinds.includes(39_002)
      ) {
        const channelIds = await client.query<{ readonly id: string }>(
          `SELECT id::text AS id
           FROM channels
           WHERE community_id = $1 AND deleted_at IS NULL
           ORDER BY id`,
          [communityId],
        );
        for (const row of channelIds.rows) {
          output.push(
            ...(await buildChannelSnapshots(
              client,
              communityId,
              row.id,
              this.#relaySecretKey,
            )),
          );
        }
      }
      const matching = output.filter((event) =>
        eventMatchesFilter(event, filter),
      );
      if (matching.length === 0) return [];
      const persisted = await client.query<{ readonly id: string }>(
        `SELECT encode(id, 'hex') AS id
         FROM events
         WHERE community_id = $1
           AND deleted_at IS NULL
           AND encode(id, 'hex') = ANY($2::text[])`,
        [communityId, matching.map((event) => event.id)],
      );
      const persistedIds = new Set(persisted.rows.map((row) => row.id));
      return matching.filter((event) => !persistedIds.has(event.id));
    } finally {
      client.release();
    }
  }
}

async function applyProfileEvent(
  client: PoolClient,
  communityId: string,
  community: string,
  event: NostrEvent,
): Promise<void> {
  if (event.kind === KIND_AGENT_PROFILE) {
    let value: unknown;
    try {
      value = JSON.parse(event.content) as unknown;
    } catch {
      throw new Error("kind:10100 agent profile content must be valid JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("kind:10100 agent profile content must be a JSON object");
    }
    const policy = (value as { channel_add_policy?: unknown })
      .channel_add_policy;
    if (policy !== "anyone" && policy !== "owner_only" && policy !== "nobody") {
      throw new Error("kind:10100 channel_add_policy is invalid");
    }
    await client.query(
      `INSERT INTO users (community_id, pubkey, channel_add_policy)
       VALUES ($1, decode($2, 'hex'), $3::channel_add_policy)
       ON CONFLICT (community_id, pubkey)
       DO UPDATE SET
         channel_add_policy = EXCLUDED.channel_add_policy,
         updated_at = now()`,
      [communityId, event.pubkey, policy],
    );
    return;
  }
  if (event.kind !== 0) return;
  let content: unknown;
  try {
    content = JSON.parse(event.content);
  } catch {
    throw new Error("kind:0 profile content must be valid JSON");
  }
  if (
    typeof content !== "object" ||
    content === null ||
    Array.isArray(content)
  ) {
    throw new Error("kind:0 profile content must be a JSON object");
  }
  const record = content as Record<string, unknown>;
  const displayName =
    stringValue(record.display_name) ?? stringValue(record.name);
  const avatarUrl = stringValue(record.picture) ?? stringValue(record.image);
  const about = stringValue(record.about);
  const nip05 = canonicalizeProfileNip05(
    stringValue(record.nip05) ?? "",
    community,
  );

  const write = async (updateNip05: boolean): Promise<void> => {
    if (updateNip05) {
      await client.query(
        `INSERT INTO users (
           community_id, pubkey, display_name, avatar_url, about,
           nip05_handle, metadata_event_id
         )
         VALUES (
           $1, decode($2, 'hex'), NULLIF($3, ''), NULLIF($4, ''),
           NULLIF($5, ''), $6, decode($7, 'hex')
         )
         ON CONFLICT (community_id, pubkey)
         DO UPDATE SET
           display_name = EXCLUDED.display_name,
           avatar_url = EXCLUDED.avatar_url,
           about = EXCLUDED.about,
           nip05_handle = EXCLUDED.nip05_handle,
           metadata_event_id = EXCLUDED.metadata_event_id,
           updated_at = now()`,
        [
          communityId,
          event.pubkey,
          displayName ?? "",
          avatarUrl ?? "",
          about ?? "",
          nip05,
          event.id,
        ],
      );
      return;
    }
    // A contested handle must not prevent the rest of the absolute profile
    // state from advancing. Preserve an existing valid handle on updates,
    // matching the legacy relay's collision fallback.
    await client.query(
      `INSERT INTO users (
         community_id, pubkey, display_name, avatar_url, about,
         metadata_event_id
       )
       VALUES (
         $1, decode($2, 'hex'), NULLIF($3, ''), NULLIF($4, ''),
         NULLIF($5, ''), decode($6, 'hex')
       )
       ON CONFLICT (community_id, pubkey)
       DO UPDATE SET
         display_name = EXCLUDED.display_name,
         avatar_url = EXCLUDED.avatar_url,
         about = EXCLUDED.about,
         metadata_event_id = EXCLUDED.metadata_event_id,
         updated_at = now()`,
      [
        communityId,
        event.pubkey,
        displayName ?? "",
        avatarUrl ?? "",
        about ?? "",
        event.id,
      ],
    );
  };

  if (!nip05) {
    await write(true);
    return;
  }
  await client.query("SAVEPOINT buzz_profile_nip05");
  try {
    await write(true);
    await client.query("RELEASE SAVEPOINT buzz_profile_nip05");
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    await client.query("ROLLBACK TO SAVEPOINT buzz_profile_nip05");
    await client.query("RELEASE SAVEPOINT buzz_profile_nip05");
    await write(false);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function canonicalizeProfileNip05(
  value: string,
  community: string,
): string | null {
  const trimmed = value.trim();
  const separator = trimmed.indexOf("@");
  if (
    separator < 1 ||
    separator !== trimmed.lastIndexOf("@") ||
    separator === trimmed.length - 1
  ) {
    return null;
  }
  const local = trimmed.slice(0, separator);
  const suppliedDomain = trimmed.slice(separator + 1).toLowerCase();
  let expectedDomain: string;
  try {
    expectedDomain = new URL(`http://${community}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (
    !/^[A-Za-z0-9._-]{1,64}$/.test(local) ||
    suppliedDomain !== expectedDomain
  ) {
    return null;
  }
  return `${local.toLowerCase()}@${expectedDomain}`;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

async function applyDmCommand(
  client: PoolClient,
  communityId: string,
  event: NostrEvent,
  channelId: string | undefined,
): Promise<
  { readonly channelId: string; readonly created: boolean } | undefined
> {
  if (
    event.kind !== KIND_DM_OPEN &&
    event.kind !== KIND_DM_ADD_MEMBER &&
    event.kind !== KIND_DM_HIDE
  ) {
    return undefined;
  }
  if (event.kind === KIND_DM_HIDE) {
    if (!channelId) throw new Error("DM hide requires a channel");
    const result = await client.query(
      `UPDATE channel_members cm
       SET hidden_at = now()
       FROM channels ch
       WHERE cm.community_id = $1
         AND cm.channel_id = $2::uuid
         AND cm.pubkey = decode($3, 'hex')
         AND cm.removed_at IS NULL
         AND ch.community_id = cm.community_id
         AND ch.id = cm.channel_id
         AND ch.channel_type = 'dm'
         AND ch.deleted_at IS NULL`,
      [communityId, channelId, event.pubkey],
    );
    if (result.rowCount !== 1) throw new Error("DM is unavailable");
    return { channelId, created: false };
  }

  let participants = uniqueTagValues(event, "p");
  if (participants.some((pubkey) => !/^[0-9a-f]{64}$/.test(pubkey))) {
    throw new Error("DM contains an invalid participant pubkey");
  }
  if (event.kind === KIND_DM_ADD_MEMBER) {
    if (!channelId) throw new Error("DM add-member requires a channel");
    const current = await client.query<{ readonly pubkey: string }>(
      `SELECT encode(cm.pubkey, 'hex') AS pubkey
       FROM channel_members cm
       JOIN channels ch
         ON ch.community_id = cm.community_id AND ch.id = cm.channel_id
       WHERE cm.community_id = $1
         AND cm.channel_id = $2::uuid
         AND cm.removed_at IS NULL
         AND ch.channel_type = 'dm'
         AND ch.deleted_at IS NULL
       ORDER BY cm.pubkey
       FOR UPDATE OF ch`,
      [communityId, channelId],
    );
    if (!current.rows.some((row) => row.pubkey === event.pubkey)) {
      throw new Error("only a DM member may add participants");
    }
    participants = [...participants, ...current.rows.map((row) => row.pubkey)];
  }
  const all = [...new Set([event.pubkey, ...participants])].sort();
  if (all.length < 2 || all.length > 9) {
    throw new Error("DM requires between 2 and 9 unique participants");
  }
  const participantHash = createHash("sha256")
    .update(Buffer.concat(all.map((pubkey) => Buffer.from(pubkey, "hex"))))
    .digest();
  const existing = await client.query<{ readonly id: string }>(
    `SELECT id::text AS id
     FROM channels
     WHERE community_id = $1
       AND participant_hash = $2
       AND channel_type = 'dm'
       AND deleted_at IS NULL
     LIMIT 1
     FOR UPDATE`,
    [communityId, participantHash],
  );
  let resolvedChannelId = existing.rows[0]?.id;
  let created = resolvedChannelId === undefined;
  if (!resolvedChannelId) {
    resolvedChannelId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO channels (
         community_id, id, name, channel_type, visibility, created_by,
         participant_hash
       )
       VALUES (
         $1, $2::uuid, $3, 'dm', 'private', decode($4, 'hex'), $5
       )
       ON CONFLICT (community_id, participant_hash)
         WHERE participant_hash IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        communityId,
        resolvedChannelId,
        all.length === 2 ? "DM" : `Group DM (${all.length})`,
        event.pubkey,
        participantHash,
      ],
    );
    if (inserted.rowCount !== 1) {
      created = false;
      const winner = await client.query<{ readonly id: string }>(
        `SELECT id::text AS id
         FROM channels
         WHERE community_id = $1
           AND participant_hash = $2
           AND channel_type = 'dm'
           AND deleted_at IS NULL
         LIMIT 1`,
        [communityId, participantHash],
      );
      resolvedChannelId = winner.rows[0]?.id;
      if (!resolvedChannelId) throw new Error("DM creation conflicted");
    }
  }
  for (const pubkey of all) {
    await client.query(
      `INSERT INTO channel_members (
         community_id, channel_id, pubkey, role, invited_by
       )
       VALUES (
         $1, $2::uuid, decode($3, 'hex'), 'member', decode($4, 'hex')
       )
       ON CONFLICT (community_id, channel_id, pubkey)
       DO UPDATE SET removed_at = NULL, removed_by = NULL, role = 'member'`,
      [communityId, resolvedChannelId, pubkey, event.pubkey],
    );
  }
  await client.query(
    `UPDATE channel_members
     SET hidden_at = NULL
     WHERE community_id = $1
       AND channel_id = $2::uuid
       AND pubkey = decode($3, 'hex')`,
    [communityId, resolvedChannelId, event.pubkey],
  );
  return { channelId: resolvedChannelId, created };
}

type RelayAdminResult = {
  readonly deltaKind?: number;
  readonly targetPubkey: string;
};

async function applyRelayAdminCommand(
  client: PoolClient,
  communityId: string,
  event: NostrEvent,
): Promise<RelayAdminResult | undefined> {
  if (
    event.kind !== RELAY_ADMIN_ADD_MEMBER &&
    event.kind !== RELAY_ADMIN_REMOVE_MEMBER &&
    event.kind !== RELAY_ADMIN_CHANGE_ROLE
  ) {
    return undefined;
  }
  if (Math.abs(Math.floor(Date.now() / 1_000) - event.created_at) > 120) {
    throw new Error(
      "relay admin event timestamp is outside the 120 second window",
    );
  }
  const targetPubkey = requiredHexTag(event, "p");
  const actor = await client.query<{ readonly role: string }>(
    `SELECT role
     FROM relay_members
     WHERE community_id = $1 AND pubkey = $2
     FOR UPDATE`,
    [communityId, event.pubkey],
  );
  const actorRole = actor.rows[0]?.role;
  if (actorRole !== "owner" && actorRole !== "admin") {
    throw new Error("actor must be a relay admin or owner");
  }

  if (event.kind === RELAY_ADMIN_ADD_MEMBER) {
    const role = optionalSingleTag(event, "role") ?? "member";
    if (role !== "member" && role !== "admin") {
      throw new Error("new relay member role must be member or admin");
    }
    if (role === "admin" && actorRole !== "owner") {
      throw new Error("only a relay owner may grant the admin role");
    }
    const result = await client.query(
      `INSERT INTO relay_members (
         community_id, pubkey, role, added_by
       )
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (community_id, pubkey) DO NOTHING`,
      [communityId, targetPubkey, role, event.pubkey],
    );
    return result.rowCount === 1
      ? { deltaKind: KIND_NIP43_MEMBER_ADDED, targetPubkey }
      : undefined;
  }

  if (targetPubkey === event.pubkey) {
    throw new Error("relay administrators cannot remove or demote themselves");
  }
  if (event.kind === RELAY_ADMIN_REMOVE_MEMBER) {
    const result = await client.query<{ readonly role: string }>(
      `DELETE FROM relay_members
       WHERE community_id = $1
         AND pubkey = $2
         AND role = ANY($3::text[])
       RETURNING role`,
      [
        communityId,
        targetPubkey,
        actorRole === "owner" ? ["member", "admin"] : ["member"],
      ],
    );
    if (result.rowCount === 1) {
      return { deltaKind: KIND_NIP43_MEMBER_REMOVED, targetPubkey };
    }
    const target = await client.query<{ readonly role: string }>(
      `SELECT role FROM relay_members
       WHERE community_id = $1 AND pubkey = $2`,
      [communityId, targetPubkey],
    );
    if (!target.rows[0]) throw new Error("relay member not found");
    if (target.rows[0].role === "owner") {
      throw new Error("the relay owner cannot be removed");
    }
    throw new Error("relay admins may remove only members");
  }

  if (actorRole !== "owner") {
    throw new Error("only a relay owner may change member roles");
  }
  const newRole = requiredSingleTag(event, "role");
  if (newRole !== "member" && newRole !== "admin") {
    throw new Error("relay member role must be member or admin");
  }
  const updated = await client.query(
    `UPDATE relay_members
     SET role = $3, updated_at = now()
     WHERE community_id = $1
       AND pubkey = $2
       AND role <> 'owner'`,
    [communityId, targetPubkey, newRole],
  );
  if (updated.rowCount !== 1) {
    const target = await client.query<{ readonly role: string }>(
      `SELECT role FROM relay_members
       WHERE community_id = $1 AND pubkey = $2`,
      [communityId, targetPubkey],
    );
    if (!target.rows[0]) throw new Error("relay member not found");
    throw new Error("the relay owner's role cannot be changed");
  }
  return { targetPubkey };
}

type EventRow = {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: Date;
  readonly kind: number;
  readonly tags: unknown;
  readonly content: string;
  readonly sig: string;
};

type MemoryThreadRecord = {
  readonly broadcast: boolean;
  readonly channelId: string;
  readonly depth: number;
  descendantCount: number;
  readonly eventCreatedAt: number;
  readonly eventId: string;
  lastReplyAt?: number;
  readonly parentEventCreatedAt?: number;
  readonly parentEventId?: string;
  replyCount: number;
  readonly rootEventCreatedAt?: number;
  readonly rootEventId?: string;
};

function publicThreadRecord(row: MemoryThreadRecord): ThreadMetadataRecord {
  return {
    broadcast: row.broadcast,
    channelId: row.channelId,
    depth: row.depth,
    descendantCount: row.descendantCount,
    eventCreatedAt: row.eventCreatedAt,
    eventId: row.eventId,
    parentEventCreatedAt: row.parentEventCreatedAt ?? row.eventCreatedAt,
    parentEventId: row.parentEventId ?? row.eventId,
    replyCount: row.replyCount,
    rootEventCreatedAt: row.rootEventCreatedAt ?? row.eventCreatedAt,
    rootEventId: row.rootEventId ?? row.eventId,
  };
}

function insertMemoryThread(
  threads: Map<string, MemoryThreadRecord>,
  metadata: ThreadMetadata,
): void {
  if (threads.has(metadata.eventId)) return;
  threads.set(metadata.eventId, {
    broadcast: metadata.broadcast,
    channelId: metadata.channelId,
    depth: metadata.depth,
    descendantCount: 0,
    eventCreatedAt: metadata.eventCreatedAt,
    eventId: metadata.eventId,
    parentEventCreatedAt: metadata.parentEventCreatedAt,
    parentEventId: metadata.parentEventId,
    replyCount: 0,
    rootEventCreatedAt: metadata.rootEventCreatedAt,
    rootEventId: metadata.rootEventId,
  });
  const parent =
    threads.get(metadata.parentEventId) ??
    ({
      broadcast: false,
      channelId: metadata.channelId,
      depth: 0,
      descendantCount: 0,
      eventCreatedAt: metadata.parentEventCreatedAt,
      eventId: metadata.parentEventId,
      replyCount: 0,
    } satisfies MemoryThreadRecord);
  threads.set(metadata.parentEventId, parent);
  if (!threads.has(metadata.rootEventId)) {
    threads.set(metadata.rootEventId, {
      broadcast: false,
      channelId: metadata.channelId,
      depth: 0,
      descendantCount: 0,
      eventCreatedAt: metadata.rootEventCreatedAt,
      eventId: metadata.rootEventId,
      replyCount: 0,
    });
  }
  parent.replyCount += 1;
  parent.lastReplyAt = Math.floor(Date.now() / 1_000);
  const root = threads.get(metadata.rootEventId) as MemoryThreadRecord;
  root.descendantCount += 1;
}

function decrementMemoryThread(
  threads: Map<string, MemoryThreadRecord>,
  eventId: string,
): void {
  const metadata = threads.get(eventId);
  if (!metadata?.parentEventId) return;
  const parent = threads.get(metadata.parentEventId);
  if (parent) parent.replyCount = Math.max(0, parent.replyCount - 1);
  const root = metadata.rootEventId
    ? threads.get(metadata.rootEventId)
    : undefined;
  if (root) root.descendantCount = Math.max(0, root.descendantCount - 1);
}

function memoryThreadSummary(
  threads: Map<string, MemoryThreadRecord>,
  events: Map<string, NostrEvent>,
  rootEventId: string,
): ThreadSummary {
  const row = threads.get(rootEventId);
  if (!row) {
    return {
      descendantCount: 0,
      participants: [],
      replyCount: 0,
    };
  }
  const participants: string[] = [];
  const seen = new Set<string>();
  const replies = [...threads.values()]
    .filter(
      (metadata) =>
        metadata.rootEventId === rootEventId && events.has(metadata.eventId),
    )
    .sort((left, right) => right.eventCreatedAt - left.eventCreatedAt);
  for (const reply of replies) {
    const pubkey = events.get(reply.eventId)?.pubkey;
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    participants.push(pubkey);
    if (participants.length === 10) break;
  }
  return {
    descendantCount: row.descendantCount,
    ...(row.lastReplyAt !== undefined ? { lastReplyAt: row.lastReplyAt } : {}),
    participants,
    replyCount: row.replyCount,
  };
}

async function insertPostgresThreadMetadata(
  client: PoolClient,
  communityId: string,
  metadata: ThreadMetadata,
): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO thread_metadata (
       community_id, event_created_at, event_id, channel_id,
       parent_event_id, parent_event_created_at,
       root_event_id, root_event_created_at, depth, broadcast
     )
     VALUES (
       $1, to_timestamp($2), decode($3, 'hex'), $4::uuid,
       decode($5, 'hex'), to_timestamp($6),
       decode($7, 'hex'), to_timestamp($8), $9, $10
     )
     ON CONFLICT DO NOTHING
     RETURNING event_id`,
    [
      communityId,
      metadata.eventCreatedAt,
      metadata.eventId,
      metadata.channelId,
      metadata.parentEventId,
      metadata.parentEventCreatedAt,
      metadata.rootEventId,
      metadata.rootEventCreatedAt,
      metadata.depth,
      metadata.broadcast,
    ],
  );
  if (inserted.rowCount !== 1) return;
  await client.query(
    `INSERT INTO thread_metadata (
       community_id, event_created_at, event_id, channel_id,
       depth, broadcast
     )
     VALUES ($1, to_timestamp($2), decode($3, 'hex'), $4::uuid, 0, false)
     ON CONFLICT DO NOTHING`,
    [
      communityId,
      metadata.parentEventCreatedAt,
      metadata.parentEventId,
      metadata.channelId,
    ],
  );
  if (metadata.rootEventId !== metadata.parentEventId) {
    await client.query(
      `INSERT INTO thread_metadata (
         community_id, event_created_at, event_id, channel_id,
         depth, broadcast
       )
       VALUES ($1, to_timestamp($2), decode($3, 'hex'), $4::uuid, 0, false)
       ON CONFLICT DO NOTHING`,
      [
        communityId,
        metadata.rootEventCreatedAt,
        metadata.rootEventId,
        metadata.channelId,
      ],
    );
  }
  await client.query(
    `UPDATE thread_metadata
     SET reply_count = reply_count + 1, last_reply_at = now()
     WHERE community_id = $1 AND event_id = decode($2, 'hex')`,
    [communityId, metadata.parentEventId],
  );
  await client.query(
    `UPDATE thread_metadata
     SET descendant_count = descendant_count + 1
     WHERE community_id = $1 AND event_id = decode($2, 'hex')`,
    [communityId, metadata.rootEventId],
  );
}

async function buildPostgresThreadSummary(
  client: Pick<PoolClient, "query">,
  communityId: string,
  eventId: string,
): Promise<ThreadSummary | undefined> {
  const result = await client.query<{
    readonly descendant_count: number;
    readonly last_reply_at: Date | null;
    readonly reply_count: number;
  }>(
    `SELECT reply_count, descendant_count, last_reply_at
     FROM thread_metadata
     WHERE community_id = $1 AND event_id = decode($2, 'hex')
     LIMIT 1`,
    [communityId, eventId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const participants = await client.query<{ readonly pubkey: string }>(
    `SELECT pubkey
     FROM (
       SELECT encode(e.pubkey, 'hex') AS pubkey,
              MAX(e.created_at) AS last_seen
       FROM thread_metadata tm
       JOIN events e
         ON e.community_id = tm.community_id
        AND e.created_at = tm.event_created_at
        AND e.id = tm.event_id
       WHERE tm.community_id = $1
         AND tm.root_event_id = decode($2, 'hex')
         AND e.deleted_at IS NULL
       GROUP BY e.pubkey
     ) participants
     ORDER BY last_seen DESC
     LIMIT 10`,
    [communityId, eventId],
  );
  return {
    descendantCount: row.descendant_count,
    ...(row.last_reply_at
      ? {
          lastReplyAt: Math.floor(row.last_reply_at.getTime() / 1_000),
        }
      : {}),
    participants: participants.rows.map((participant) => participant.pubkey),
    replyCount: row.reply_count,
  };
}

async function postgresThreadParticipants(
  pool: Pool,
  community: string,
  rootEventIds: readonly string[],
): Promise<Map<string, readonly string[]>> {
  if (rootEventIds.length === 0) return new Map();
  const result = await pool.query<{
    readonly pubkey: string;
    readonly root_event_id: string;
  }>(
    `SELECT root_event_id, pubkey
     FROM (
       SELECT encode(tm.root_event_id, 'hex') AS root_event_id,
              encode(e.pubkey, 'hex') AS pubkey,
              ROW_NUMBER() OVER (
                PARTITION BY tm.root_event_id
                ORDER BY MAX(e.created_at) DESC
              ) AS participant_rank
       FROM thread_metadata tm
       JOIN events e
         ON e.community_id = tm.community_id
        AND e.created_at = tm.event_created_at
        AND e.id = tm.event_id
       JOIN communities c ON c.id = tm.community_id
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND tm.root_event_id = ANY(
           SELECT decode(value, 'hex') FROM unnest($2::text[]) AS value
         )
         AND e.deleted_at IS NULL
       GROUP BY tm.root_event_id, e.pubkey
     ) participants
     WHERE participant_rank <= 10
     ORDER BY root_event_id, participant_rank`,
    [community, rootEventIds],
  );
  const output = new Map<string, string[]>();
  for (const row of result.rows) {
    const values = output.get(row.root_event_id) ?? [];
    values.push(row.pubkey);
    output.set(row.root_event_id, values);
  }
  return output;
}

function buildThreadSummaryEvent(
  relaySecretKey: Uint8Array,
  channelId: string,
  rootEventId: string,
  summary: ThreadSummary,
): NostrEvent {
  return signNostrEvent(
    {
      content: JSON.stringify({
        reply_count: summary.replyCount,
        descendant_count: summary.descendantCount,
        last_reply_at: summary.lastReplyAt ?? null,
        participants: summary.participants,
      }),
      created_at: Math.floor(Date.now() / 1_000),
      kind: KIND_THREAD_SUMMARY,
      tags: [
        ["e", rootEventId],
        ["d", rootEventId],
        ["h", channelId],
      ],
    },
    relaySecretKey,
  );
}

const CHANNEL_COMMAND_KINDS = new Set<number>([
  KIND_NIP29_PUT_USER,
  KIND_NIP29_REMOVE_USER,
  KIND_NIP29_EDIT_METADATA,
  KIND_NIP29_CREATE_GROUP,
  KIND_NIP29_DELETE_GROUP,
  KIND_NIP29_JOIN_REQUEST,
  KIND_NIP29_LEAVE_REQUEST,
]);

type MemberRole = "owner" | "admin" | "member" | "guest" | "bot";

type ChannelSnapshotRow = {
  readonly archived_at: Date | null;
  readonly channel_type: string;
  readonly created_at: Date;
  readonly description: string | null;
  readonly id: string;
  readonly name: string;
  readonly purpose: string | null;
  readonly relay_snapshot_created_at: string;
  readonly snapshot_at: Date;
  readonly topic: string | null;
  readonly ttl_deadline: Date | null;
  readonly ttl_seconds: number | null;
  readonly visibility: string;
};

type ChannelMemberSnapshotRow = {
  readonly pubkey: string;
  readonly role: MemberRole;
};

async function buildChannelSnapshots(
  client: PoolClient,
  communityId: string,
  channelId: string,
  relaySecretKey: Uint8Array,
  snapshotCreatedAt?: number,
): Promise<NostrEvent[]> {
  const channelResult = await client.query<ChannelSnapshotRow>(
    `SELECT
       c.id::text AS id,
       c.name,
       c.channel_type::text AS channel_type,
       c.visibility::text AS visibility,
       c.description,
       c.created_at,
       c.archived_at,
       c.topic,
       c.purpose,
       c.ttl_seconds,
       c.ttl_deadline,
       c.relay_snapshot_created_at::text AS relay_snapshot_created_at,
       GREATEST(
         c.updated_at,
         COALESCE(
           (
             SELECT MAX(GREATEST(cm.joined_at, COALESCE(cm.removed_at, cm.joined_at)))
             FROM channel_members cm
             WHERE cm.community_id = c.community_id AND cm.channel_id = c.id
           ),
           c.updated_at
         )
       ) AS snapshot_at
     FROM channels c
     WHERE c.community_id = $1
       AND c.id = $2::uuid
       AND c.deleted_at IS NULL
     LIMIT 1`,
    [communityId, channelId],
  );
  const channel = channelResult.rows[0];
  if (!channel) return [];
  const memberResult = await client.query<ChannelMemberSnapshotRow>(
    `SELECT encode(pubkey, 'hex') AS pubkey, role::text AS role
     FROM channel_members
     WHERE community_id = $1
       AND channel_id = $2::uuid
       AND removed_at IS NULL
     ORDER BY pubkey`,
    [communityId, channelId],
  );
  const persistedClock = Number(channel.relay_snapshot_created_at);
  const createdAt =
    snapshotCreatedAt ??
    Math.max(
      0,
      Number.isSafeInteger(persistedClock) ? persistedClock : 0,
      Math.floor(channel.snapshot_at.getTime() / 1_000),
    );
  const metadataTags: string[][] = [
    ["d", channel.id],
    ["name", channel.name],
    ["t", channel.channel_type],
    ["channel_type", channel.channel_type],
    ["visibility", channel.visibility],
    [channel.visibility === "open" ? "public" : "private"],
    ["closed"],
  ];
  if (channel.description !== null) {
    metadataTags.push(["about", channel.description]);
  }
  if (channel.archived_at) metadataTags.push(["archived", "true"]);
  if (channel.topic !== null) metadataTags.push(["topic", channel.topic]);
  if (channel.purpose !== null) metadataTags.push(["purpose", channel.purpose]);
  if (channel.ttl_seconds !== null) {
    metadataTags.push(["ttl", String(channel.ttl_seconds)]);
  }
  if (channel.ttl_deadline) {
    metadataTags.push(["ttl_deadline", channel.ttl_deadline.toISOString()]);
  }
  if (channel.channel_type === "dm") {
    for (const member of memberResult.rows) {
      metadataTags.push(["p", member.pubkey]);
    }
    metadataTags.push(["hidden"]);
  }
  const metadata = signNostrEvent(
    {
      content: "",
      created_at: createdAt,
      kind: 39_000,
      tags: metadataTags,
    },
    relaySecretKey,
  );
  const members = signNostrEvent(
    {
      content: "",
      created_at: createdAt,
      kind: 39_002,
      tags: [
        ["d", channel.id],
        ...memberResult.rows.map((member) => [
          "p",
          member.pubkey,
          "",
          member.role,
        ]),
      ],
    },
    relaySecretKey,
  );
  const admins = signNostrEvent(
    {
      content: "",
      created_at: createdAt,
      kind: KIND_NIP29_GROUP_ADMINS,
      tags: [
        ["d", channel.id],
        ...memberResult.rows
          .filter(
            (member) => member.role === "owner" || member.role === "admin",
          )
          .map((member) => ["p", member.pubkey, member.role]),
      ],
    },
    relaySecretKey,
  );
  return [metadata, admins, members];
}

async function allocateChannelSnapshotCreatedAt(
  client: PoolClient,
  communityId: string,
  channelId: string,
): Promise<number> {
  const result = await client.query<{
    readonly relay_snapshot_created_at: string;
  }>(
    `UPDATE channels
     SET relay_snapshot_created_at = GREATEST(
       relay_snapshot_created_at + 1,
       floor(extract(epoch FROM clock_timestamp()))::bigint
     )
     WHERE community_id = $1 AND id = $2::uuid
     RETURNING relay_snapshot_created_at::text`,
    [communityId, channelId],
  );
  const value = Number(result.rows[0]?.relay_snapshot_created_at);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("channel snapshot clock allocation failed");
  }
  return value;
}

async function storeChannelSnapshots(
  client: PoolClient,
  communityId: string,
  channelId: string,
  snapshots: readonly NostrEvent[],
): Promise<readonly NostrEvent[]> {
  const inserted: NostrEvent[] = [];
  for (const event of snapshots) {
    const dTag = extractDTag(event);
    await client.query(
      `UPDATE events
       SET deleted_at = now()
       WHERE community_id = $1
         AND pubkey = decode($2, 'hex')
         AND kind = $3
         AND channel_id = $4::uuid
         AND d_tag = $5
         AND deleted_at IS NULL
         AND id <> decode($6, 'hex')`,
      [communityId, event.pubkey, event.kind, channelId, dTag, event.id],
    );
    const stored = await client.query(
      `INSERT INTO events (
         community_id, id, pubkey, created_at, kind, tags, content, sig,
         channel_id, d_tag
       )
       VALUES (
         $1, decode($2, 'hex'), decode($3, 'hex'), to_timestamp($4), $5,
         $6::jsonb, $7, decode($8, 'hex'), $9::uuid, $10
       )
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        communityId,
        event.id,
        event.pubkey,
        event.created_at,
        event.kind,
        JSON.stringify(event.tags),
        event.content,
        event.sig,
        channelId,
        dTag,
      ],
    );
    if (stored.rowCount === 1) inserted.push(event);
  }
  return inserted;
}

async function allocateGlobalAddressableCreatedAt(
  client: PoolClient,
  communityId: string,
  kind: number,
  dTag: string,
  relaySecretKey: Uint8Array,
): Promise<number> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended($1 || ':' || $2::text || ':' || $3, 0)
     )`,
    [communityId, kind, dTag],
  );
  const relayPubkey = publicKeyFromSecret(relaySecretKey);
  const result = await client.query<{
    readonly created_at: Date | null;
    readonly now: Date;
  }>(
    `SELECT
       (
         SELECT created_at
         FROM events
         WHERE community_id = $1
           AND pubkey = decode($2, 'hex')
           AND kind = $3
           AND channel_id IS NULL
           AND d_tag = $4
           AND deleted_at IS NULL
         ORDER BY created_at DESC, id ASC
         LIMIT 1
       ) AS created_at,
       clock_timestamp() AS now`,
    [communityId, relayPubkey, kind, dTag],
  );
  const row = result.rows[0];
  const now = Math.floor((row?.now.getTime() ?? Date.now()) / 1_000);
  const previous = row?.created_at
    ? Math.floor(row.created_at.getTime() / 1_000)
    : -1;
  return Math.max(now, previous + 1);
}

async function storeGlobalAddressableEvents(
  client: PoolClient,
  communityId: string,
  events: readonly NostrEvent[],
): Promise<readonly NostrEvent[]> {
  const inserted: NostrEvent[] = [];
  for (const event of events) {
    const dTag = extractDTag(event);
    if (dTag === null) {
      throw new Error("global addressable event requires a d tag");
    }
    await client.query(
      `UPDATE events
       SET deleted_at = now()
       WHERE community_id = $1
         AND pubkey = decode($2, 'hex')
         AND kind = $3
         AND channel_id IS NULL
         AND d_tag = $4
         AND deleted_at IS NULL
         AND id <> decode($5, 'hex')`,
      [communityId, event.pubkey, event.kind, dTag, event.id],
    );
    const stored = await client.query(
      `INSERT INTO events (
         community_id, id, pubkey, created_at, kind, tags, content, sig,
         channel_id, d_tag
       )
       VALUES (
         $1, decode($2, 'hex'), decode($3, 'hex'), to_timestamp($4), $5,
         $6::jsonb, $7, decode($8, 'hex'), NULL, $9
       )
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        communityId,
        event.id,
        event.pubkey,
        event.created_at,
        event.kind,
        JSON.stringify(event.tags),
        event.content,
        event.sig,
        dTag,
      ],
    );
    if (stored.rowCount === 1) inserted.push(event);
  }
  return inserted;
}

async function buildDmVisibilitySnapshot(
  client: PoolClient,
  communityId: string,
  viewerPubkey: string,
  relaySecretKey: Uint8Array,
  createdAt: number,
): Promise<NostrEvent> {
  const result = await client.query<{
    readonly channel_id: string;
    readonly snapshot_at: Date;
  }>(
    `SELECT cm.channel_id::text AS channel_id,
            GREATEST(cm.hidden_at, cm.joined_at) AS snapshot_at
     FROM channel_members cm
     JOIN channels ch
       ON ch.community_id = cm.community_id AND ch.id = cm.channel_id
     WHERE cm.community_id = $1
       AND cm.pubkey = decode($2, 'hex')
       AND cm.removed_at IS NULL
       AND cm.hidden_at IS NOT NULL
       AND ch.channel_type = 'dm'
       AND ch.deleted_at IS NULL
     ORDER BY cm.channel_id`,
    [communityId, viewerPubkey],
  );
  return signNostrEvent(
    {
      content: "",
      created_at: createdAt,
      kind: KIND_DM_VISIBILITY,
      tags: [
        ["d", viewerPubkey],
        ["p", viewerPubkey],
        ...result.rows.map((row) => ["h", row.channel_id]),
      ],
    },
    relaySecretKey,
  );
}

async function buildRelayMembershipSnapshot(
  client: PoolClient,
  communityId: string,
  relaySecretKey: Uint8Array,
): Promise<NostrEvent> {
  const members = await client.query<{
    readonly pubkey: string;
    readonly role: string;
  }>(
    `SELECT pubkey, role
     FROM relay_members
     WHERE community_id = $1
     ORDER BY created_at, pubkey`,
    [communityId],
  );
  const databaseNow = await client.query<{ readonly now: Date }>(
    "SELECT clock_timestamp() AS now",
  );
  return signNostrEvent(
    {
      content: "",
      created_at: Math.floor(
        (databaseNow.rows[0]?.now.getTime() ?? Date.now()) / 1_000,
      ),
      kind: KIND_NIP43_MEMBERSHIP_LIST,
      tags: [
        ["-"],
        ...members.rows.map((member) => ["member", member.pubkey, member.role]),
      ],
    },
    relaySecretKey,
  );
}

async function applyChannelCommand(
  client: PoolClient,
  communityId: string,
  event: NostrEvent,
  channelId: string | undefined,
): Promise<ChannelCommandOutcome | undefined> {
  if (!CHANNEL_COMMAND_KINDS.has(event.kind)) return undefined;
  if (!channelId)
    throw new Error("channel command requires exactly one valid h tag");

  if (event.kind === KIND_NIP29_CREATE_GROUP) {
    await createChannel(client, communityId, channelId, event);
    return {
      channelId,
      channelAccessChanges: [],
      notifications: [
        {
          actorPubkey: event.pubkey,
          kind: KIND_MEMBER_ADDED_NOTIFICATION,
          targetPubkey: event.pubkey,
        },
      ],
      revokedChannelMembers: [],
      systemContents: [
        {
          actor: event.pubkey,
          type: "channel_created",
        },
      ],
    };
  }

  const channel = await lockChannel(client, communityId, channelId);
  const isUnarchive =
    event.kind === KIND_NIP29_EDIT_METADATA &&
    tagValues(event, "archived").includes("false");
  if (channel.archived && !isUnarchive) {
    throw new Error("channel is archived");
  }

  switch (event.kind) {
    case KIND_NIP29_PUT_USER:
      await putMember(
        client,
        communityId,
        channelId,
        channel.visibility,
        event,
      );
      return membershipCommandOutcome(
        channelId,
        event,
        requiredHexTag(event, "p"),
        true,
      );
    case KIND_NIP29_REMOVE_USER:
      await removeMember(client, communityId, channelId, event, false);
      await disableMemberWorkflows(
        client,
        communityId,
        channelId,
        requiredHexTag(event, "p"),
      );
      return membershipCommandOutcome(
        channelId,
        event,
        requiredHexTag(event, "p"),
        false,
      );
    case KIND_NIP29_EDIT_METADATA:
      await editChannel(client, communityId, channelId, event);
      return editChannelOutcome(client, communityId, channelId, event);
    case KIND_NIP29_DELETE_GROUP:
      await deleteChannel(client, communityId, channelId, event);
      return {
        channelId,
        channelAccessChanges: [{ channelId, mode: "all" }],
        notifications: [],
        revokedChannelMembers: [],
        systemContents: [
          {
            actor: event.pubkey,
            type: "channel_deleted",
          },
        ],
      };
    case KIND_NIP29_JOIN_REQUEST:
      if (
        !(await joinChannel(
          client,
          communityId,
          channelId,
          channel.visibility,
          event,
        ))
      ) {
        return {
          channelId,
          channelAccessChanges: [],
          notifications: [],
          revokedChannelMembers: [],
          systemContents: [],
        };
      }
      return membershipCommandOutcome(channelId, event, event.pubkey, true);
    case KIND_NIP29_LEAVE_REQUEST:
      await removeMember(client, communityId, channelId, event, true);
      await disableMemberWorkflows(
        client,
        communityId,
        channelId,
        event.pubkey,
      );
      return membershipCommandOutcome(channelId, event, event.pubkey, false);
  }
  return undefined;
}

type ChannelCommandOutcome = {
  readonly channelAccessChanges: readonly {
    readonly channelId: string;
    readonly mode: "all" | "non_members";
  }[];
  readonly channelId: string;
  readonly notifications: readonly {
    readonly actorPubkey: string;
    readonly kind:
      | typeof KIND_MEMBER_ADDED_NOTIFICATION
      | typeof KIND_MEMBER_REMOVED_NOTIFICATION;
    readonly targetPubkey: string;
  }[];
  readonly revokedChannelMembers: readonly {
    readonly channelId: string;
    readonly pubkey: string;
  }[];
  readonly systemContents: readonly Record<string, unknown>[];
};

function membershipCommandOutcome(
  channelId: string,
  event: NostrEvent,
  targetPubkey: string,
  added: boolean,
): ChannelCommandOutcome {
  const self = targetPubkey === event.pubkey;
  return {
    channelId,
    channelAccessChanges: [],
    notifications: [
      {
        actorPubkey: event.pubkey,
        kind: added
          ? KIND_MEMBER_ADDED_NOTIFICATION
          : KIND_MEMBER_REMOVED_NOTIFICATION,
        targetPubkey,
      },
    ],
    revokedChannelMembers: added ? [] : [{ channelId, pubkey: targetPubkey }],
    systemContents: [
      {
        actor: event.pubkey,
        ...(event.kind === KIND_NIP29_LEAVE_REQUEST && !added
          ? {}
          : { target: targetPubkey }),
        type: added ? "member_joined" : self ? "member_left" : "member_removed",
      },
    ],
  };
}

async function editChannelOutcome(
  client: PoolClient,
  communityId: string,
  channelId: string,
  event: NostrEvent,
): Promise<ChannelCommandOutcome> {
  const systemContents: Record<string, unknown>[] = [];
  for (const tag of event.tags) {
    if (tag.length !== 2 || tag[1] === undefined) continue;
    const common = { actor: event.pubkey };
    switch (tag[0]) {
      case "topic":
        systemContents.push({
          ...common,
          topic: tag[1],
          type: "topic_changed",
        });
        break;
      case "purpose":
        systemContents.push({
          ...common,
          purpose: tag[1],
          type: "purpose_changed",
        });
        break;
      case "visibility":
        systemContents.push({
          ...common,
          type: "visibility_changed",
          visibility: tag[1],
        });
        break;
      case "ttl":
        systemContents.push({
          ...common,
          ttl_seconds: tag[1] === "" ? null : Number(tag[1]),
          type: "ttl_changed",
        });
        break;
      case "archived":
        systemContents.push({
          ...common,
          type: tag[1] === "true" ? "channel_archived" : "channel_unarchived",
        });
    }
  }
  const notifications: {
    actorPubkey: string;
    kind:
      | typeof KIND_MEMBER_ADDED_NOTIFICATION
      | typeof KIND_MEMBER_REMOVED_NOTIFICATION;
    targetPubkey: string;
  }[] = [];
  if (tagValues(event, "archived").includes("false")) {
    const members = await client.query<{ readonly pubkey: string }>(
      `SELECT encode(pubkey, 'hex') AS pubkey
       FROM channel_members
       WHERE community_id = $1
         AND channel_id = $2::uuid
         AND removed_at IS NULL
       ORDER BY pubkey`,
      [communityId, channelId],
    );
    for (const member of members.rows) {
      notifications.push({
        actorPubkey: event.pubkey,
        kind: KIND_MEMBER_ADDED_NOTIFICATION,
        targetPubkey: member.pubkey,
      });
    }
  }
  return {
    channelId,
    channelAccessChanges: [
      ...(tagValues(event, "visibility").includes("private")
        ? [{ channelId, mode: "non_members" as const }]
        : []),
      ...(tagValues(event, "archived").includes("true")
        ? [{ channelId, mode: "all" as const }]
        : []),
    ],
    notifications,
    revokedChannelMembers: [],
    systemContents,
  };
}

async function disableMemberWorkflows(
  client: PoolClient,
  communityId: string,
  channelId: string,
  pubkey: string,
): Promise<void> {
  await client.query(
    `UPDATE workflows
     SET enabled = false, updated_at = now()
     WHERE community_id = $1
       AND channel_id = $2::uuid
       AND owner_pubkey = decode($3, 'hex')
       AND enabled = true`,
    [communityId, channelId, pubkey],
  );
}

async function storeChannelCommandDerivedEvents(
  client: PoolClient,
  communityId: string,
  outcome: ChannelCommandOutcome,
  relaySecretKey: Uint8Array | undefined,
): Promise<readonly NostrEvent[]> {
  if (!relaySecretKey) return [];
  const events: NostrEvent[] = [];
  for (const content of outcome.systemContents) {
    events.push(
      signNostrEvent(
        {
          content: JSON.stringify(content),
          created_at: Math.floor(Date.now() / 1_000),
          kind: KIND_SYSTEM_MESSAGE,
          tags: [["h", outcome.channelId]],
        },
        relaySecretKey,
      ),
    );
  }
  for (const notification of outcome.notifications) {
    events.push(
      signNostrEvent(
        {
          content: JSON.stringify({
            actor: notification.actorPubkey,
            channel_id: outcome.channelId,
            type:
              notification.kind === KIND_MEMBER_ADDED_NOTIFICATION
                ? "member_added"
                : "member_removed",
          }),
          created_at: Math.floor(Date.now() / 1_000),
          kind: notification.kind,
          tags: [
            ["p", notification.targetPubkey],
            ["h", outcome.channelId],
          ],
        },
        relaySecretKey,
      ),
    );
  }
  const inserted: NostrEvent[] = [];
  for (const event of events) {
    const stored = await client.query(
      `INSERT INTO events (
         community_id, id, pubkey, created_at, kind, tags, content, sig,
         channel_id
       )
       VALUES (
         $1, decode($2, 'hex'), decode($3, 'hex'), to_timestamp($4), $5,
         $6::jsonb, $7, decode($8, 'hex'), $9::uuid
       )
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        communityId,
        event.id,
        event.pubkey,
        event.created_at,
        event.kind,
        JSON.stringify(event.tags),
        event.content,
        event.sig,
        event.kind === KIND_SYSTEM_MESSAGE ? outcome.channelId : null,
      ],
    );
    if (stored.rowCount === 1) inserted.push(event);
  }
  return inserted;
}

async function createChannel(
  client: PoolClient,
  communityId: string,
  channelId: string,
  event: NostrEvent,
): Promise<void> {
  const name = canonicalChannelName(requiredSingleTag(event, "name"));
  if (name.length === 0) throw new Error("channel name is required");
  const visibility = optionalSingleTag(event, "visibility") ?? "open";
  if (visibility !== "open" && visibility !== "private") {
    throw new Error("channel visibility is invalid");
  }
  const channelType = optionalSingleTag(event, "channel_type") ?? "stream";
  if (!["stream", "forum", "dm", "workflow"].includes(channelType)) {
    throw new Error("channel type is invalid");
  }
  const description = optionalSingleTag(event, "about") ?? null;
  const ttl = parseTtl(optionalSingleTag(event, "ttl"), false);
  const inserted = await client.query(
    `INSERT INTO channels (
       community_id, id, name, channel_type, visibility, description,
       created_by, ttl_seconds, ttl_deadline
     )
     VALUES (
       $1, $2::uuid, $3, $4::channel_type, $5::channel_visibility, $6,
       decode($7, 'hex'), $8,
       CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(secs => $8) END
     )
     ON CONFLICT (community_id, id) DO NOTHING
     RETURNING id`,
    [
      communityId,
      channelId,
      name,
      channelType,
      visibility,
      description,
      event.pubkey,
      ttl,
    ],
  );
  if (inserted.rowCount !== 1) throw new Error("channel already exists");
  await client.query(
    `INSERT INTO channel_members (
       community_id, channel_id, pubkey, role, invited_by
     )
     VALUES ($1, $2::uuid, decode($3, 'hex'), 'owner', decode($3, 'hex'))`,
    [communityId, channelId, event.pubkey],
  );
}

async function putMember(
  client: PoolClient,
  communityId: string,
  channelId: string,
  visibility: "open" | "private",
  event: NostrEvent,
): Promise<void> {
  const target = requiredHexTag(event, "p");
  const requestedRoleValue = optionalSingleTag(event, "role");
  if (
    requestedRoleValue !== undefined &&
    !["owner", "admin", "member", "guest", "bot"].includes(requestedRoleValue)
  ) {
    throw new Error("member role is invalid");
  }
  const requestedRole = requestedRoleValue as MemberRole | undefined;
  const members = await activeMemberRoles(client, communityId, channelId, [
    event.pubkey,
    target,
  ]);
  const actorRole = members.get(event.pubkey);
  const targetRole = members.get(target);
  const actorElevated =
    actorRole === "owner" ||
    actorRole === "admin" ||
    (await relayAdministrator(client, communityId, event.pubkey));

  if (visibility === "private" && !actorRole && !actorElevated) {
    throw new Error(
      "actor is not authorized to invite to this private channel",
    );
  }
  if (
    requestedRole !== undefined &&
    ["owner", "admin"].includes(requestedRole) &&
    !actorElevated
  ) {
    throw new Error("only owners or admins may grant elevated roles");
  }
  if (
    targetRole !== undefined &&
    requestedRole !== undefined &&
    targetRole !== requestedRole &&
    !actorElevated
  ) {
    throw new Error("only owners or admins may change an active member role");
  }
  if (
    targetRole === "owner" &&
    requestedRole !== undefined &&
    requestedRole !== "owner" &&
    (await ownerCount(client, communityId, channelId)) <= 1
  ) {
    throw new Error("cannot demote the last owner");
  }
  if (target !== event.pubkey) {
    const policy = await agentChannelPolicy(client, communityId, target);
    if (policy?.policy === "nobody") {
      throw new Error(
        "policy:nobody — this identity has disabled external channel additions",
      );
    }
    if (
      policy?.policy === "owner_only" &&
      policy.ownerPubkey !== event.pubkey
    ) {
      throw new Error(
        "policy:owner_only — only the registered owner may add this identity",
      );
    }
  }

  const role = requestedRole ?? targetRole ?? "member";
  await client.query(
    `INSERT INTO channel_members (
       community_id, channel_id, pubkey, role, invited_by
     )
     VALUES ($1, $2::uuid, decode($3, 'hex'), $4::member_role, decode($5, 'hex'))
     ON CONFLICT (community_id, channel_id, pubkey)
     DO UPDATE SET
       role = EXCLUDED.role,
       joined_at = now(),
       invited_by = EXCLUDED.invited_by,
       removed_at = NULL,
       removed_by = NULL`,
    [communityId, channelId, target, role, event.pubkey],
  );
}

async function removeMember(
  client: PoolClient,
  communityId: string,
  channelId: string,
  event: NostrEvent,
  selfOnly: boolean,
): Promise<void> {
  const target = selfOnly ? event.pubkey : requiredHexTag(event, "p");
  if (selfOnly && event.tags.some((tag) => tag[0] === "p")) {
    throw new Error("leave request must not target another member");
  }
  const roles = await activeMemberRoles(client, communityId, channelId, [
    event.pubkey,
    target,
  ]);
  const actorRole = roles.get(event.pubkey);
  const targetRole = roles.get(target);
  if (!targetRole) throw new Error("target is not an active member");
  if (target !== event.pubkey) {
    const relayAdmin = await relayAdministrator(
      client,
      communityId,
      event.pubkey,
    );
    const ownsTarget =
      actorRole !== undefined &&
      (await isAgentOwner(client, communityId, target, event.pubkey));
    if (
      actorRole !== "owner" &&
      actorRole !== "admin" &&
      !relayAdmin &&
      !ownsTarget
    ) {
      throw new Error("actor is not authorized to remove this member");
    }
  }
  if (
    targetRole === "owner" &&
    (await ownerCount(client, communityId, channelId)) <= 1
  ) {
    throw new Error("cannot remove the last owner");
  }
  await client.query(
    `UPDATE channel_members
     SET removed_at = now(), removed_by = decode($4, 'hex')
     WHERE community_id = $1
       AND channel_id = $2::uuid
       AND pubkey = decode($3, 'hex')
       AND removed_at IS NULL`,
    [communityId, channelId, target, event.pubkey],
  );
}

async function editChannel(
  client: PoolClient,
  communityId: string,
  channelId: string,
  event: NostrEvent,
): Promise<void> {
  const recognized = [
    "name",
    "about",
    "archived",
    "topic",
    "purpose",
    "visibility",
    "ttl",
  ] as const;
  const present = recognized.filter((name) =>
    event.tags.some((tag) => tag[0] === name),
  );
  if (present.length === 0) {
    throw new Error("channel update contains no recognized metadata");
  }
  for (const name of present) {
    if (tagValues(event, name).length !== 1) {
      throw new Error(`channel update requires exactly one ${name} tag`);
    }
  }
  const privileged = present.some((name) =>
    ["name", "about", "archived", "visibility", "ttl"].includes(name),
  );
  const role = (
    await activeMemberRoles(client, communityId, channelId, [event.pubkey])
  ).get(event.pubkey);
  const relayAdmin = await relayAdministrator(
    client,
    communityId,
    event.pubkey,
  );
  const ownsOwnerAgent = await ownsActiveOwnerAgent(
    client,
    communityId,
    channelId,
    event.pubkey,
  );
  if (
    privileged
      ? role !== "owner" && role !== "admin" && !relayAdmin && !ownsOwnerAgent
      : role === undefined && !relayAdmin
  ) {
    throw new Error("actor is not authorized to update channel metadata");
  }

  const nameValue = optionalSingleTag(event, "name");
  const name =
    nameValue === undefined ? undefined : canonicalChannelName(nameValue);
  if (name !== undefined && name.length === 0) {
    throw new Error("channel name is required");
  }
  const visibility = optionalSingleTag(event, "visibility");
  if (
    visibility !== undefined &&
    visibility !== "open" &&
    visibility !== "private"
  ) {
    throw new Error("channel visibility is invalid");
  }
  const archived = optionalSingleTag(event, "archived");
  if (archived !== undefined && archived !== "true" && archived !== "false") {
    throw new Error("archived must be true or false");
  }
  const ttlValue = optionalSingleTag(event, "ttl");
  const ttl = ttlValue === undefined ? undefined : parseTtl(ttlValue, true);
  const about = optionalSingleTag(event, "about");
  const topic = optionalSingleTag(event, "topic");
  const purpose = optionalSingleTag(event, "purpose");

  await client.query(
    `UPDATE channels
     SET name = COALESCE($3, name),
         description = CASE WHEN $4::boolean THEN $5 ELSE description END,
         visibility = COALESCE($6::channel_visibility, visibility),
         archived_at = CASE
           WHEN $7::text = 'true' THEN COALESCE(archived_at, now())
           WHEN $7::text = 'false' THEN NULL
           ELSE archived_at
         END,
         topic = CASE WHEN $8::boolean THEN $9 ELSE topic END,
         topic_set_by = CASE WHEN $8::boolean THEN decode($12, 'hex') ELSE topic_set_by END,
         topic_set_at = CASE WHEN $8::boolean THEN now() ELSE topic_set_at END,
         purpose = CASE WHEN $10::boolean THEN $11 ELSE purpose END,
         purpose_set_by = CASE WHEN $10::boolean THEN decode($12, 'hex') ELSE purpose_set_by END,
         purpose_set_at = CASE WHEN $10::boolean THEN now() ELSE purpose_set_at END,
         ttl_seconds = CASE WHEN $13::boolean THEN $14 ELSE ttl_seconds END,
         ttl_deadline = CASE
           WHEN NOT $13::boolean THEN ttl_deadline
           WHEN $14::int IS NULL THEN NULL
           ELSE now() + make_interval(secs => $14)
         END,
         updated_at = now()
     WHERE community_id = $1 AND id = $2::uuid`,
    [
      communityId,
      channelId,
      name ?? null,
      about !== undefined,
      about ?? null,
      visibility ?? null,
      archived ?? null,
      topic !== undefined,
      topic ?? null,
      purpose !== undefined,
      purpose ?? null,
      event.pubkey,
      ttl !== undefined,
      ttl ?? null,
    ],
  );
}

async function deleteChannel(
  client: PoolClient,
  communityId: string,
  channelId: string,
  event: NostrEvent,
): Promise<void> {
  const role = (
    await activeMemberRoles(client, communityId, channelId, [event.pubkey])
  ).get(event.pubkey);
  const relayOwner = await relayAdministrator(
    client,
    communityId,
    event.pubkey,
    true,
  );
  const ownsOwnerAgent = await ownsActiveOwnerAgent(
    client,
    communityId,
    channelId,
    event.pubkey,
  );
  if (role !== "owner" && !relayOwner && !ownsOwnerAgent) {
    throw new Error("only an owner can delete a channel");
  }
  await client.query(
    `UPDATE channels
     SET deleted_at = now(), updated_at = now()
     WHERE community_id = $1 AND id = $2::uuid AND deleted_at IS NULL`,
    [communityId, channelId],
  );
  await client.query(
    `UPDATE events
     SET deleted_at = now()
     WHERE community_id = $1
       AND channel_id = $2::uuid
       AND kind = ANY($3::int[])
       AND deleted_at IS NULL`,
    [communityId, channelId, [39_000, KIND_NIP29_GROUP_ADMINS, 39_002]],
  );
}

async function joinChannel(
  client: PoolClient,
  communityId: string,
  channelId: string,
  visibility: "open" | "private",
  event: NostrEvent,
): Promise<boolean> {
  if (visibility !== "open") throw new Error("channel is private");
  const active = await client.query(
    `SELECT 1
     FROM channel_members
     WHERE community_id = $1
       AND channel_id = $2::uuid
       AND pubkey = decode($3, 'hex')
       AND removed_at IS NULL
     LIMIT 1`,
    [communityId, channelId, event.pubkey],
  );
  if (active.rowCount === 1) return false;
  await client.query(
    `INSERT INTO channel_members (
       community_id, channel_id, pubkey, role
     )
     VALUES ($1, $2::uuid, decode($3, 'hex'), 'member')
     ON CONFLICT (community_id, channel_id, pubkey)
     DO UPDATE SET
       role = CASE
         WHEN channel_members.removed_at IS NULL THEN channel_members.role
         ELSE 'member'::member_role
       END,
       joined_at = CASE
         WHEN channel_members.removed_at IS NULL THEN channel_members.joined_at
         ELSE now()
       END,
       removed_at = NULL,
       removed_by = NULL`,
    [communityId, channelId, event.pubkey],
  );
  return true;
}

async function lockChannel(
  client: PoolClient,
  communityId: string,
  channelId: string,
): Promise<{
  readonly visibility: "open" | "private";
  readonly archived: boolean;
}> {
  const result = await client.query<{
    readonly visibility: "open" | "private";
    readonly archived: boolean;
  }>(
    `SELECT visibility::text AS visibility, archived_at IS NOT NULL AS archived
     FROM channels
     WHERE community_id = $1 AND id = $2::uuid AND deleted_at IS NULL
     FOR UPDATE`,
    [communityId, channelId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("channel not found");
  return row;
}

async function activeMemberRoles(
  client: PoolClient,
  communityId: string,
  channelId: string,
  pubkeys: readonly string[],
): Promise<Map<string, MemberRole>> {
  const result = await client.query<{
    readonly pubkey: string;
    readonly role: MemberRole;
  }>(
    `SELECT encode(pubkey, 'hex') AS pubkey, role::text AS role
     FROM channel_members
     WHERE community_id = $1
       AND channel_id = $2::uuid
       AND pubkey = ANY(
         SELECT decode(value, 'hex') FROM unnest($3::text[]) AS value
       )
       AND removed_at IS NULL`,
    [communityId, channelId, pubkeys],
  );
  return new Map(result.rows.map((row) => [row.pubkey, row.role]));
}

async function ownerCount(
  client: PoolClient,
  communityId: string,
  channelId: string,
): Promise<number> {
  const result = await client.query<{ readonly count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM channel_members
     WHERE community_id = $1
       AND channel_id = $2::uuid
       AND role = 'owner'
       AND removed_at IS NULL`,
    [communityId, channelId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function agentChannelPolicy(
  client: PoolClient,
  communityId: string,
  pubkey: string,
): Promise<
  | {
      readonly ownerPubkey?: string;
      readonly policy: "anyone" | "nobody" | "owner_only";
    }
  | undefined
> {
  const result = await client.query<{
    readonly owner_pubkey: string | null;
    readonly policy: "anyone" | "nobody" | "owner_only";
  }>(
    `SELECT channel_add_policy::text AS policy,
            CASE WHEN agent_owner_pubkey IS NULL
              THEN NULL ELSE encode(agent_owner_pubkey, 'hex') END AS owner_pubkey
     FROM users
     WHERE community_id = $1 AND pubkey = decode($2, 'hex')
     LIMIT 1`,
    [communityId, pubkey],
  );
  const row = result.rows[0];
  return row
    ? {
        ...(row.owner_pubkey ? { ownerPubkey: row.owner_pubkey } : {}),
        policy: row.policy,
      }
    : undefined;
}

async function isAgentOwner(
  client: PoolClient,
  communityId: string,
  targetPubkey: string,
  actorPubkey: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM users
     WHERE community_id = $1
       AND pubkey = decode($2, 'hex')
       AND agent_owner_pubkey = decode($3, 'hex')
     LIMIT 1`,
    [communityId, targetPubkey, actorPubkey],
  );
  return result.rowCount === 1;
}

async function ownsActiveOwnerAgent(
  client: PoolClient,
  communityId: string,
  channelId: string,
  actorPubkey: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM channel_members owner_member
     JOIN users owner_identity
       ON owner_identity.community_id = owner_member.community_id
      AND owner_identity.pubkey = owner_member.pubkey
     WHERE owner_member.community_id = $1
       AND owner_member.channel_id = $2::uuid
       AND owner_member.role = 'owner'
       AND owner_member.removed_at IS NULL
       AND owner_identity.agent_owner_pubkey = decode($3, 'hex')
     LIMIT 1`,
    [communityId, channelId, actorPubkey],
  );
  return result.rowCount === 1;
}

async function relayAdministrator(
  client: PoolClient,
  communityId: string,
  pubkey: string,
  ownerOnly = false,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM relay_members
     WHERE community_id = $1
       AND pubkey = $2
       AND role ${ownerOnly ? "= 'owner'" : "IN ('owner', 'admin')"}
     LIMIT 1`,
    [communityId, pubkey],
  );
  return result.rowCount === 1;
}

function requiredHexTag(event: NostrEvent, name: string): string {
  const value = requiredSingleTag(event, name);
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} tag must contain a lowercase 32-byte hex key`);
  }
  return value;
}

function requiredSingleTag(event: NostrEvent, name: string): string {
  const value = optionalSingleTag(event, name);
  if (value === undefined)
    throw new Error(`exactly one ${name} tag is required`);
  return value;
}

function optionalSingleTag(
  event: NostrEvent,
  name: string,
): string | undefined {
  const values = tagValues(event, name);
  if (values.length === 0) return undefined;
  if (values.length !== 1)
    throw new Error(`exactly one ${name} tag is allowed`);
  return values[0];
}

function tagValues(event: NostrEvent, name: string): string[] {
  const matches = event.tags.filter((tag) => tag[0] === name);
  if (matches.some((tag) => tag.length !== 2 || tag[1] === undefined)) {
    throw new Error(`${name} tags must contain exactly one value`);
  }
  return matches.map((tag) => tag[1] as string);
}

function parseTtl(
  value: string | undefined,
  allowClear: boolean,
): number | null {
  if (value === undefined || (allowClear && value === "")) return null;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("ttl must be a positive integer");
  }
  const ttl = Number(value);
  if (!Number.isSafeInteger(ttl) || ttl > 2_147_483_647) {
    throw new Error("ttl exceeds the supported range");
  }
  return ttl;
}

function canonicalChannelName(value: string): string {
  return value.replace(/^[#\s]+/u, "").trimEnd();
}

function buildFilterQuery(
  community: string,
  filter: NostrFilter,
  countOnly: boolean,
  cursor?: EventCursor,
  pageSize?: number,
): { readonly text: string; readonly values: unknown[] } {
  const values: unknown[] = [community];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  const clauses = [
    "lower(c.host) = lower($1)",
    "c.archived_at IS NULL",
    "e.deleted_at IS NULL",
  ];
  if (filter.ids) {
    if (filter.ids.length === 0) return emptyQuery(countOnly);
    clauses.push(
      `(${filter.ids
        .map((prefix) => `encode(e.id, 'hex') LIKE ${bind(`${prefix}%`)}`)
        .join(" OR ")})`,
    );
  }
  if (filter.authors) {
    if (filter.authors.length === 0) return emptyQuery(countOnly);
    clauses.push(
      `(${filter.authors
        .map((prefix) => `encode(e.pubkey, 'hex') LIKE ${bind(`${prefix}%`)}`)
        .join(" OR ")})`,
    );
  }
  if (filter.kinds) {
    if (filter.kinds.length === 0) return emptyQuery(countOnly);
    clauses.push(`e.kind = ANY(${bind(filter.kinds)}::int[])`);
  }
  if (filter.since !== undefined) {
    clauses.push(`e.created_at >= to_timestamp(${bind(filter.since)})`);
  }
  if (filter.until !== undefined) {
    clauses.push(`e.created_at <= to_timestamp(${bind(filter.until)})`);
  }
  if (filter.before_id !== undefined) {
    if (filter.until === undefined) {
      throw new Error("before_id requires an until cursor");
    }
    clauses.push(
      `(e.created_at < to_timestamp(${bind(filter.until)})
        OR (e.created_at = to_timestamp(${bind(filter.until)})
          AND e.id > decode(${bind(filter.before_id)}, 'hex')))`,
    );
  }
  if (cursor) {
    clauses.push(
      `(e.created_at < to_timestamp(${bind(cursor.createdAt)})
        OR (e.created_at = to_timestamp(${bind(cursor.createdAt)})
          AND e.id > decode(${bind(cursor.id)}, 'hex')))`,
    );
  }
  for (const [key, rawValues] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(rawValues)) continue;
    const tagName = key.slice(1);
    const tagValues = rawValues.filter(
      (value): value is string => typeof value === "string",
    );
    if (tagValues.length === 0) return emptyQuery(countOnly);
    clauses.push(
      `(${tagValues
        .map(
          (value) =>
            `e.tags @> ${bind(JSON.stringify([[tagName, value]]))}::jsonb`,
        )
        .join(" OR ")})`,
    );
  }
  const select = countOnly
    ? "COUNT(*)::text AS count"
    : `encode(e.id, 'hex') AS id, encode(e.pubkey, 'hex') AS pubkey,
       e.created_at, e.kind, e.tags, e.content, encode(e.sig, 'hex') AS sig`;
  const suffix = countOnly
    ? ""
    : ` ORDER BY e.created_at DESC, e.id ASC LIMIT ${bind(
        pageSize ?? clampLimit(filter.limit),
      )}`;
  return {
    text: `SELECT ${select}
      FROM events e
      JOIN communities c ON c.id = e.community_id
      WHERE ${clauses.join(" AND ")}${suffix}`,
    values,
  };
}

function emptyQuery(countOnly: boolean): {
  readonly text: string;
  readonly values: unknown[];
} {
  return countOnly
    ? { text: "SELECT '0'::text AS count", values: [] }
    : {
        text: `SELECT ''::text AS id, ''::text AS pubkey, now() AS created_at,
          0::int AS kind, '[]'::jsonb AS tags, ''::text AS content,
          ''::text AS sig WHERE false`,
        values: [],
      };
}

function eventFromRow(row: EventRow): NostrEvent {
  if (
    !Array.isArray(row.tags) ||
    !row.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((value) => typeof value === "string"),
    )
  ) {
    throw new Error("database event contains invalid tags");
  }
  const createdAt = Math.floor(row.created_at.getTime() / 1_000);
  const event: NostrEvent = {
    content: row.content,
    created_at: createdAt,
    id: row.id,
    kind: row.kind,
    pubkey: row.pubkey,
    sig: row.sig,
    tags: row.tags,
  };
  if (!verifyNostrEvent(event)) {
    throw new Error("database event signature is invalid");
  }
  return event;
}

function validateStorableEvent(event: NostrEvent): void {
  if (!verifyNostrEvent(event)) throw new Error("event signature is invalid");
  if (event.kind === KIND_AUTH) {
    throw new Error("authentication events must never be stored");
  }
}

function reactionTargetId(event: NostrEvent): string {
  const targetId = [...event.tags]
    .reverse()
    .find(
      (tag) =>
        tag.length >= 2 &&
        tag[0] === "e" &&
        /^[0-9a-f]{64}$/i.test(tag[1] as string),
    )?.[1];
  if (!targetId) throw new Error("reaction must reference a target event");
  return targetId.toLowerCase();
}

function reactionEmoji(event: NostrEvent): string {
  const emoji = event.content.length === 0 ? "+" : event.content;
  if ([...emoji].length > 64) {
    throw new Error("reaction emoji exceeds 64 characters");
  }
  return emoji;
}

function memoryReactionKey(
  event: NostrEvent,
  events: ReadonlyMap<string, NostrEvent>,
): string {
  const targetId = reactionTargetId(event);
  if (!events.has(targetId)) throw new Error("reaction target event not found");
  return `${targetId}:${event.pubkey}:${reactionEmoji(event)}`;
}

type DeletionTarget =
  | { readonly type: "event"; readonly eventId: string }
  | {
      readonly type: "address";
      readonly eventKind: number;
      readonly pubkey: string;
      readonly dTag: string;
    };

function parseDeletionTarget(event: NostrEvent): DeletionTarget {
  const targetTags = event.tags.filter(
    (tag) => tag[0] === "e" || tag[0] === "a",
  );
  if (targetTags.length !== 1) {
    throw new Error(
      "deletion events must reference exactly one target via e or a tag",
    );
  }
  const tag = targetTags[0] as string[];
  const value = tag[1];
  if (tag[0] === "e") {
    if (!value || !/^[0-9a-f]{64}$/i.test(value)) {
      throw new Error("deletion event has a malformed e target");
    }
    return { eventId: value.toLowerCase(), type: "event" };
  }
  if (event.kind === KIND_NIP29_DELETE_EVENT) {
    throw new Error("NIP-29 channel deletion requires an e target");
  }
  if (!value) throw new Error("deletion event has a malformed a target");
  const parts = value.split(":");
  const eventKind = Number(parts.shift());
  const pubkey = parts.shift();
  const dTag = parts.join(":");
  if (
    !Number.isSafeInteger(eventKind) ||
    eventKind < 0 ||
    !pubkey ||
    !/^[0-9a-f]{64}$/i.test(pubkey)
  ) {
    throw new Error("deletion event has a malformed a target");
  }
  return {
    dTag,
    eventKind,
    pubkey: pubkey.toLowerCase(),
    type: "address",
  };
}

function applyMemoryDeletion(
  deletionEvent: NostrEvent,
  events: Map<string, NostrEvent>,
  deletedByCommunity: Map<string, Map<string, NostrEvent>>,
  community: string,
  reactions: Set<string>,
  onDelete?: (event: NostrEvent) => void,
): void {
  const target = parseDeletionTarget(deletionEvent);
  const deleted =
    deletedByCommunity.get(community) ?? new Map<string, NostrEvent>();
  deletedByCommunity.set(community, deleted);
  const move = (event: NostrEvent): void => {
    if (event.kind === KIND_PUSH_LEASE) return;
    onDelete?.(event);
    events.delete(event.id);
    deleted.set(event.id, event);
    if (event.kind === KIND_REACTION) {
      reactions.delete(
        `${reactionTargetId(event)}:${event.pubkey}:${reactionEmoji(event)}`,
      );
    }
  };
  if (target.type === "event") {
    const event = events.get(target.eventId) ?? deleted.get(target.eventId);
    if (!event) throw new Error("deletion target event not found");
    if (events.has(event.id)) move(event);
    return;
  }
  if (
    target.eventKind === KIND_PUSH_LEASE ||
    !isParameterizedReplaceableKind(target.eventKind)
  ) {
    return;
  }
  for (const event of [...events.values()]) {
    if (
      event.kind === target.eventKind &&
      event.pubkey === target.pubkey &&
      extractDTag(event) === target.dTag
    ) {
      move(event);
    }
  }
}

type PostgresDeletionOutcome = {
  readonly deletedEvents: readonly {
    readonly channelId: string;
    readonly eventId: string;
  }[];
  readonly threadRoots: readonly {
    readonly channelId: string;
    readonly rootEventId: string;
  }[];
};

function deletionTombstoneContent(
  event: NostrEvent,
  targetEventId: string,
): Record<string, unknown> {
  const content: Record<string, unknown> = {
    actor: event.pubkey,
    target_event_id: targetEventId,
    type: "message_deleted",
  };
  for (const name of ["action_id", "reason_code", "public_reason"]) {
    const values = event.tags.filter(
      (tag) => tag.length === 2 && tag[0] === name,
    );
    if (values.length === 1 && values[0]?.[1] !== undefined) {
      content[name] = values[0][1];
    }
  }
  return content;
}

async function applyPostgresDeletion(
  client: PoolClient,
  communityId: string,
  deletionEvent: NostrEvent,
): Promise<PostgresDeletionOutcome> {
  const target = parseDeletionTarget(deletionEvent);
  if (target.type === "address") {
    if (
      target.eventKind === KIND_PUSH_LEASE ||
      !isParameterizedReplaceableKind(target.eventKind)
    ) {
      return { deletedEvents: [], threadRoots: [] };
    }
    const metadata = await client.query<{
      readonly channel_id: string | null;
      readonly event_id: string;
      readonly parent_event_id: string | null;
      readonly root_event_id: string | null;
    }>(
      `SELECT encode(e.id, 'hex') AS event_id,
              e.channel_id::text AS channel_id,
              CASE WHEN tm.parent_event_id IS NULL
                THEN NULL ELSE encode(tm.parent_event_id, 'hex') END AS parent_event_id,
              CASE WHEN tm.root_event_id IS NULL
                THEN NULL ELSE encode(tm.root_event_id, 'hex') END AS root_event_id
       FROM events e
       LEFT JOIN thread_metadata tm
         ON tm.community_id = e.community_id
        AND tm.event_created_at = e.created_at
        AND tm.event_id = e.id
       WHERE e.community_id = $1
         AND e.kind = $2
         AND e.pubkey = decode($3, 'hex')
         AND e.d_tag = $4
         AND e.deleted_at IS NULL
       FOR UPDATE OF e`,
      [communityId, target.eventKind, target.pubkey, target.dTag],
    );
    await client.query(
      `UPDATE events
       SET deleted_at = now()
       WHERE community_id = $1
         AND kind = $2
         AND pubkey = decode($3, 'hex')
         AND d_tag = $4
         AND deleted_at IS NULL`,
      [communityId, target.eventKind, target.pubkey, target.dTag],
    );
    const roots = new Map<string, { channelId: string; rootEventId: string }>();
    for (const row of metadata.rows) {
      await decrementPostgresThreadCounters(
        client,
        communityId,
        row.parent_event_id,
        row.root_event_id,
      );
      if (row.channel_id && row.parent_event_id && row.root_event_id) {
        roots.set(`${row.channel_id}:${row.root_event_id}`, {
          channelId: row.channel_id,
          rootEventId: row.root_event_id,
        });
      }
    }
    if (target.eventKind === 30_620) {
      await client.query(
        `DELETE FROM workflows
         WHERE community_id = $1
           AND owner_pubkey = decode($2, 'hex')
           AND (id::text = $3 OR name = $3)`,
        [communityId, target.pubkey, target.dTag],
      );
    }
    return {
      deletedEvents: metadata.rows.flatMap((row) =>
        row.channel_id
          ? [{ channelId: row.channel_id, eventId: row.event_id }]
          : [],
      ),
      threadRoots: [...roots.values()],
    };
  }

  const existing = await client.query<{
    readonly deleted_at: Date | null;
    readonly kind: number;
    readonly channel_id: string | null;
    readonly parent_event_id: string | null;
    readonly root_event_id: string | null;
  }>(
    `SELECT e.kind,
            e.deleted_at,
            e.channel_id::text AS channel_id,
            CASE WHEN tm.parent_event_id IS NULL
              THEN NULL ELSE encode(tm.parent_event_id, 'hex') END AS parent_event_id,
            CASE WHEN tm.root_event_id IS NULL
              THEN NULL ELSE encode(tm.root_event_id, 'hex') END AS root_event_id
     FROM events e
     LEFT JOIN thread_metadata tm
       ON tm.community_id = e.community_id
      AND tm.event_created_at = e.created_at
      AND tm.event_id = e.id
     WHERE e.community_id = $1
       AND e.id = decode($2, 'hex')
     LIMIT 1
     FOR UPDATE OF e`,
    [communityId, target.eventId],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("deletion target event not found");
  if (row.kind === KIND_PUSH_LEASE || row.deleted_at !== null) {
    return { deletedEvents: [], threadRoots: [] };
  }
  await client.query(
    `UPDATE events
     SET deleted_at = now()
     WHERE community_id = $1
       AND id = decode($2, 'hex')
       AND deleted_at IS NULL`,
    [communityId, target.eventId],
  );
  await decrementPostgresThreadCounters(
    client,
    communityId,
    row.parent_event_id,
    row.root_event_id,
  );
  if (row.kind === KIND_REACTION) {
    await client.query(
      `UPDATE reactions
       SET removed_at = now()
       WHERE community_id = $1
         AND reaction_event_id = decode($2, 'hex')
         AND removed_at IS NULL`,
      [communityId, target.eventId],
    );
  }
  return {
    deletedEvents: row.channel_id
      ? [{ channelId: row.channel_id, eventId: target.eventId }]
      : [],
    threadRoots:
      row.channel_id && row.parent_event_id && row.root_event_id
        ? [
            {
              channelId: row.channel_id,
              rootEventId: row.root_event_id,
            },
          ]
        : [],
  };
}

async function decrementPostgresThreadCounters(
  client: PoolClient,
  communityId: string,
  parentEventId: string | null,
  rootEventId: string | null,
): Promise<void> {
  if (!parentEventId) return;
  await client.query(
    `UPDATE thread_metadata
     SET reply_count = GREATEST(reply_count - 1, 0)
     WHERE community_id = $1 AND event_id = decode($2, 'hex')`,
    [communityId, parentEventId],
  );
  if (!rootEventId) return;
  await client.query(
    `UPDATE thread_metadata
     SET descendant_count = GREATEST(descendant_count - 1, 0)
     WHERE community_id = $1 AND event_id = decode($2, 'hex')`,
    [communityId, rootEventId],
  );
}

function removeSupersededEvents(
  events: Map<string, NostrEvent>,
  incoming: NostrEvent,
): void {
  if (!isReplaceableKind(incoming.kind)) return;
  const incomingD = extractDTag(incoming);
  for (const [id, existing] of events) {
    if (
      existing.pubkey === incoming.pubkey &&
      existing.kind === incoming.kind &&
      extractDTag(existing) === incomingD &&
      (existing.created_at < incoming.created_at ||
        (existing.created_at === incoming.created_at &&
          existing.id > incoming.id))
    ) {
      events.delete(id);
    }
  }
}

function hasWinningReplaceableEvent(
  events: Iterable<NostrEvent>,
  incoming: NostrEvent,
): boolean {
  if (!isReplaceableKind(incoming.kind)) return false;
  const incomingD = extractDTag(incoming);
  for (const existing of events) {
    if (
      existing.pubkey === incoming.pubkey &&
      existing.kind === incoming.kind &&
      extractDTag(existing) === incomingD &&
      (existing.created_at > incoming.created_at ||
        (existing.created_at === incoming.created_at &&
          existing.id < incoming.id))
    ) {
      return true;
    }
  }
  return false;
}

function isReplaceableKind(kind: number): boolean {
  return (
    kind === 0 ||
    kind === 3 ||
    (kind >= 10_000 && kind < 20_000) ||
    isParameterizedReplaceableKind(kind)
  );
}

function extractDTag(event: NostrEvent): string | null {
  if (!isParameterizedReplaceableKind(event.kind)) return null;
  const value = event.tags.find((tag) => tag[0] === "d")?.[1] ?? "";
  if (Buffer.byteLength(value, "utf8") > 1_024) {
    throw new Error("event d tag exceeds 1024 bytes");
  }
  return value;
}

function extractNotBefore(event: NostrEvent): number | null {
  if (event.kind !== 30_300) return null;
  const raw = event.tags.find((tag) => tag[0] === "not_before")?.[1];
  if (!raw || !/^(?:0|[1-9][0-9]*)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function uniqueTagValues(event: NostrEvent, name: string): string[] {
  return [
    ...new Set(
      event.tags
        .filter((tag) => tag[0] === name && tag.length >= 2)
        .map((tag) => tag[1])
        .filter((value): value is string => value !== undefined),
    ),
  ];
}

function mergeFilteredEvents(
  stored: readonly NostrEvent[],
  virtual: readonly NostrEvent[],
  filter: NostrFilter,
  limit: number,
): NostrEvent[] {
  const unique = new Map<string, NostrEvent>();
  for (const event of [...stored, ...virtual]) {
    if (eventMatchesFilter(event, filter)) unique.set(event.id, event);
  }
  return [...unique.values()].sort(compareEvents).slice(0, limit);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 2_000;
  return Math.max(0, Math.min(Math.floor(limit), 2_000));
}

function clampPageSize(pageSize: number): number {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new RangeError("event page size must be between 1 and 1000");
  }
  return pageSize;
}

function withoutLimit(filter: NostrFilter): NostrFilter {
  const { limit: _limit, ...rest } = filter;
  return rest;
}

function isAfterCursor(
  event: NostrEvent,
  cursor: EventCursor | undefined,
): boolean {
  return (
    cursor === undefined ||
    event.created_at < cursor.createdAt ||
    (event.created_at === cursor.createdAt && event.id > cursor.id)
  );
}

function compareEvents(left: NostrEvent, right: NostrEvent): number {
  return right.created_at - left.created_at || left.id.localeCompare(right.id);
}
