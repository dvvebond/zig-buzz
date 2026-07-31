import {
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  KIND_HUDDLE_STARTED,
  signNostrEvent,
  unixNow,
  type NostrEvent,
} from "@buzz/core";
import type { EventStore } from "@buzz/db";
import type { Pool, PoolClient } from "pg";

export type HuddleLifecycle = {
  authorizeJoin(input: {
    readonly channelId: string;
    readonly parentChannelId: string;
    readonly pubkey: string;
  }): Promise<{ readonly parentChannelId: string }>;
  participantJoined(input: {
    readonly channelId: string;
    readonly parentChannelId: string;
    readonly pubkey: string;
  }): Promise<void>;
  participantLeft(input: {
    readonly channelId: string;
    readonly parentChannelId: string;
    readonly pubkey: string;
    readonly roomEmpty: boolean;
  }): Promise<void>;
};

/**
 * Durable, tenant-scoped huddle lifecycle state. Only the fenced owner invokes
 * join/left/end mutations; ingress pods merely forward their authenticated
 * peer registration to that owner.
 */
export class RelayHuddleLifecycle implements HuddleLifecycle {
  readonly #operations = new Map<string, Promise<void>>();
  readonly #relaySecretKey: Uint8Array;

  public constructor(
    private readonly options: {
      readonly community: string;
      readonly eventStore: EventStore;
      readonly pool: Pool;
      readonly publishEvent: (event: NostrEvent) => Promise<void>;
      readonly relaySecretKey: Uint8Array;
    },
  ) {
    this.#relaySecretKey = Uint8Array.from(options.relaySecretKey);
  }

  public async authorizeJoin(input: {
    readonly channelId: string;
    readonly parentChannelId: string;
    readonly pubkey: string;
  }): Promise<{ readonly parentChannelId: string }> {
    const client = await this.options.pool.connect();
    try {
      await client.query("BEGIN");
      const communityId = await resolveCommunityId(
        client,
        this.options.community,
      );
      const channelResult = await client.query<{
        readonly archived_at: Date | null;
        readonly created_by: string;
        readonly ttl_seconds: number | null;
        readonly visibility: "open" | "private";
      }>(
        `SELECT ch.archived_at,
                encode(ch.created_by, 'hex') AS created_by,
                ch.ttl_seconds,
                ch.visibility::text AS visibility
         FROM channels ch
         WHERE ch.community_id = $1
           AND ch.id = $2::uuid
           AND ch.deleted_at IS NULL
         LIMIT 1
         FOR SHARE`,
        [communityId, input.channelId],
      );
      const channel = channelResult.rows[0];
      if (!channel) throw new Error("huddle channel is unavailable");
      if (channel.archived_at) throw new Error("huddle has ended");

      const parentChannelId =
        channel.ttl_seconds === null ? input.channelId : input.parentChannelId;
      if (
        channel.ttl_seconds !== null &&
        !(await hasCreatorStartedLink(
          client,
          communityId,
          input.channelId,
          parentChannelId,
          channel.created_by,
        ))
      ) {
        throw new Error("ephemeral huddle is not linked to the claimed parent");
      }

      if (
        await isActiveMember(client, communityId, input.channelId, input.pubkey)
      ) {
        await client.query("COMMIT");
        return { parentChannelId };
      }
      if (channel.visibility === "open") {
        await client.query("COMMIT");
        return { parentChannelId };
      }
      if (
        channel.ttl_seconds !== null &&
        (await isActiveMember(
          client,
          communityId,
          parentChannelId,
          input.pubkey,
        ))
      ) {
        await client.query(
          `INSERT INTO channel_members (
             community_id, channel_id, pubkey, role, invited_by
           )
           VALUES (
             $1, $2::uuid, decode($3, 'hex'), 'member',
             decode($4, 'hex')
           )
           ON CONFLICT (community_id, channel_id, pubkey)
           DO UPDATE SET
             removed_at = NULL, removed_by = NULL, role = 'member'`,
          [communityId, input.channelId, input.pubkey, channel.created_by],
        );
        await client.query("COMMIT");
        return { parentChannelId };
      }
      throw new Error("identity is not a huddle member");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async participantJoined(input: {
    readonly channelId: string;
    readonly parentChannelId: string;
    readonly pubkey: string;
  }): Promise<void> {
    await this.#serialize(input.channelId, () =>
      this.#emit(
        KIND_HUDDLE_PARTICIPANT_JOINED,
        input.channelId,
        input.parentChannelId,
        input.pubkey,
      ),
    );
  }

  public async participantLeft(input: {
    readonly channelId: string;
    readonly parentChannelId: string;
    readonly pubkey: string;
    readonly roomEmpty: boolean;
  }): Promise<void> {
    await this.#serialize(input.channelId, async () => {
      await this.#emit(
        KIND_HUDDLE_PARTICIPANT_LEFT,
        input.channelId,
        input.parentChannelId,
        input.pubkey,
      );
      if (!input.roomEmpty) return;
      const archived = await this.options.pool.query(
        `UPDATE channels ch
           SET archived_at = COALESCE(ch.archived_at, now()),
               updated_at = now()
           FROM communities c
           WHERE c.id = ch.community_id
             AND lower(c.host) = lower($1)
             AND c.archived_at IS NULL
             AND ch.id = $2::uuid
             AND ch.deleted_at IS NULL
           RETURNING ch.id`,
        [this.options.community, input.channelId],
      );
      if (archived.rowCount !== 1) {
        throw new Error("huddle channel disappeared during auto-archive");
      }
      await this.#emit(
        KIND_HUDDLE_ENDED,
        input.channelId,
        input.parentChannelId,
        input.pubkey,
      );
    });
  }

  async #serialize(
    channelId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const prior = this.#operations.get(channelId) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    this.#operations.set(channelId, current);
    try {
      await current;
    } finally {
      if (this.#operations.get(channelId) === current) {
        this.#operations.delete(channelId);
      }
    }
  }

  async #emit(
    kind:
      | typeof KIND_HUDDLE_ENDED
      | typeof KIND_HUDDLE_PARTICIPANT_JOINED
      | typeof KIND_HUDDLE_PARTICIPANT_LEFT,
    channelId: string,
    parentChannelId: string,
    pubkey: string,
  ): Promise<void> {
    const event = signNostrEvent(
      {
        content: JSON.stringify({ ephemeral_channel_id: channelId }),
        created_at: unixNow(),
        kind,
        tags: [
          ["h", parentChannelId],
          ["p", pubkey],
        ],
      },
      this.#relaySecretKey,
    );
    try {
      const stored = await this.options.eventStore.store(
        this.options.community,
        event,
        parentChannelId,
      );
      if (stored.status === "duplicate" || stored.status === "superseded") {
        return;
      }
    } catch {
      // Live state must still advance when a disconnect-time DB write fails.
    }
    await this.options.publishEvent(event).catch(() => undefined);
  }
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
  if (!id) throw new Error("community is unavailable");
  return id;
}

async function isActiveMember(
  client: PoolClient,
  communityId: string,
  channelId: string,
  pubkey: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
     FROM channel_members
     WHERE community_id = $1
       AND channel_id = $2::uuid
       AND pubkey = decode($3, 'hex')
       AND removed_at IS NULL
     LIMIT 1`,
    [communityId, channelId, pubkey],
  );
  return result.rowCount === 1;
}

async function hasCreatorStartedLink(
  client: PoolClient,
  communityId: string,
  channelId: string,
  parentChannelId: string,
  creatorPubkey: string,
): Promise<boolean> {
  const result = await client.query<{
    readonly content: string;
    readonly tags: unknown;
  }>(
    `SELECT content, tags
     FROM events
     WHERE community_id = $1
       AND channel_id = $2::uuid
       AND kind = $3
       AND pubkey = decode($4, 'hex')
       AND deleted_at IS NULL
     ORDER BY created_at DESC, id ASC
     LIMIT 100`,
    [communityId, parentChannelId, KIND_HUDDLE_STARTED, creatorPubkey],
  );
  return result.rows.some((row) => {
    if (
      !Array.isArray(row.tags) ||
      !row.tags.some(
        (tag) =>
          Array.isArray(tag) &&
          tag.length === 2 &&
          tag[0] === "h" &&
          tag[1] === parentChannelId,
      )
    ) {
      return false;
    }
    try {
      const content = JSON.parse(row.content) as unknown;
      return (
        typeof content === "object" &&
        content !== null &&
        !Array.isArray(content) &&
        "ephemeral_channel_id" in content &&
        content.ephemeral_channel_id === channelId
      );
    } catch {
      return false;
    }
  });
}
