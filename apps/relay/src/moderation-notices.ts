import { createHash, randomUUID } from "node:crypto";

import {
  KIND_NIP29_GROUP_MEMBERS,
  KIND_NIP29_GROUP_METADATA,
  KIND_PROFILE,
  KIND_STREAM_MESSAGE,
  signNostrEvent,
  unixNow,
  type NostrEvent,
} from "@buzz/core";
import type { EventStore } from "@buzz/db";
import { getPublicKey } from "nostr-tools/pure";
import type { Pool, PoolClient } from "pg";

const MODERATION_SOURCE_TAG = "moderation_source";

export type ModerationNotice =
  | {
      readonly actionId: string;
      readonly kind: "content";
      readonly publicReason: string;
    }
  | {
      readonly actionId: string;
      readonly kind: "restriction";
      readonly publicReason: string;
      readonly restriction: "ban" | "timeout";
    }
  | {
      readonly kind: "report-resolved";
      readonly reportId: string;
      readonly status: "dismissed" | "resolved";
      readonly summary: string;
    };

export type ModerationNoticeDelivery = {
  readonly notice: ModerationNotice;
  readonly recipientPubkey: string;
};

/**
 * Delivers relay-authored, tenant-local moderation notices in a private
 * two-party DM. Notice bodies intentionally contain only sanitized fields.
 */
export class RelayModerationNotices {
  readonly #relayPubkey: string;
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
    this.#relayPubkey = getPublicKey(this.#relaySecretKey);
  }

  public async deliver(delivery: ModerationNoticeDelivery): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(delivery.recipientPubkey)) {
      throw new Error("moderation notice recipient is not a valid pubkey");
    }
    if (delivery.recipientPubkey === this.#relayPubkey) return;

    const channel = await openModerationDm(
      this.options.pool,
      this.options.community,
      this.#relayPubkey,
      delivery.recipientPubkey,
    );
    const sourceId = moderationNoticeSourceId(delivery.notice);
    const prior = await this.options.eventStore.query(this.options.community, {
      "#h": [channel.id],
      authors: [this.#relayPubkey],
      kinds: [KIND_STREAM_MESSAGE],
      limit: 1_000,
    });
    if (
      prior.some((event) =>
        event.tags.some(
          (tag) => tag[0] === MODERATION_SOURCE_TAG && tag[1] === sourceId,
        ),
      )
    ) {
      return;
    }

    await this.#publishProfile();
    for (const discovery of buildDmDiscoveryEvents(
      channel.id,
      channel.snapshotAt,
      this.#relayPubkey,
      delivery.recipientPubkey,
      this.#relaySecretKey,
    )) {
      await this.options.publishEvent(discovery);
    }

    const event = signNostrEvent(
      {
        content: moderationNoticeBody(delivery.notice, this.options.community),
        created_at: unixNow(),
        kind: KIND_STREAM_MESSAGE,
        tags: [
          ["h", channel.id],
          [MODERATION_SOURCE_TAG, sourceId],
        ],
      },
      this.#relaySecretKey,
    );
    const stored = await this.options.eventStore.store(
      this.options.community,
      event,
      channel.id,
    );
    if (stored.status === "inserted" || stored.status === "ephemeral") {
      await this.options.publishEvent(event);
    }
  }

  async #publishProfile(): Promise<void> {
    const name = `${this.options.community} Moderation`;
    const profile = signNostrEvent(
      {
        content: JSON.stringify({
          about:
            "Automated notices about moderation actions in this community. Replies are not monitored.",
          display_name: name,
          name,
        }),
        created_at: unixNow(),
        kind: KIND_PROFILE,
        tags: [],
      },
      this.#relaySecretKey,
    );
    const stored = await this.options.eventStore.store(
      this.options.community,
      profile,
    );
    if (stored.status === "inserted" || stored.status === "ephemeral") {
      await this.options.publishEvent(profile);
    }
  }
}

/** Render a recipient-safe notice without reporter or moderator identities. */
export function moderationNoticeBody(
  notice: ModerationNotice,
  community: string,
): string {
  if (notice.kind === "report-resolved") {
    const outcome =
      notice.status === "resolved"
        ? "was reviewed and acted on"
        : "was reviewed; no action was taken";
    return `Thanks for your report to ${community}. Your report ${outcome}.\n\n${notice.summary}`;
  }
  if (notice.kind === "content") {
    return `A moderator in ${community} took action on your content.\n\nReason: ${notice.publicReason}`;
  }
  const action =
    notice.restriction === "ban"
      ? "You have been banned from"
      : "You have been timed out in";
  return `${action} ${community}.\n\nReason: ${notice.publicReason}`;
}

function moderationNoticeSourceId(notice: ModerationNotice): string {
  return notice.kind === "report-resolved" ? notice.reportId : notice.actionId;
}

async function openModerationDm(
  pool: Pool,
  community: string,
  relayPubkey: string,
  recipientPubkey: string,
): Promise<{
  readonly id: string;
  readonly snapshotAt: number;
}> {
  const participants = [relayPubkey, recipientPubkey].sort();
  const participantHash = createHash("sha256")
    .update(
      Buffer.concat(participants.map((pubkey) => Buffer.from(pubkey, "hex"))),
    )
    .digest();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const communityResult = await client.query<{ readonly id: string }>(
      `SELECT id::text AS id
       FROM communities
       WHERE lower(host) = lower($1) AND archived_at IS NULL
       LIMIT 1
       FOR SHARE`,
      [community],
    );
    const communityId = communityResult.rows[0]?.id;
    if (!communityId) throw new Error("community is unavailable");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${communityId}:moderation-dm:${participantHash.toString("hex")}`],
    );
    const existing = await findDm(client, communityId, participantHash, true);
    let channelId = existing;
    if (!channelId) {
      const candidate = randomUUID();
      const inserted = await client.query(
        `INSERT INTO channels (
           community_id, id, name, channel_type, visibility, created_by,
           participant_hash
         )
         VALUES (
           $1, $2::uuid, 'DM', 'dm', 'private', decode($3, 'hex'), $4
         )
         ON CONFLICT (community_id, participant_hash)
           WHERE participant_hash IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [communityId, candidate, relayPubkey, participantHash],
      );
      channelId =
        inserted.rowCount === 1
          ? candidate
          : await findDm(client, communityId, participantHash, false);
      if (!channelId) throw new Error("moderation DM creation conflicted");
    }
    for (const pubkey of participants) {
      await client.query(
        `INSERT INTO channel_members (
           community_id, channel_id, pubkey, role, invited_by
         )
         VALUES (
           $1, $2::uuid, decode($3, 'hex'), 'member', decode($4, 'hex')
         )
         ON CONFLICT (community_id, channel_id, pubkey)
         DO UPDATE SET
           removed_at = NULL, removed_by = NULL, role = 'member',
           hidden_at = NULL`,
        [communityId, channelId, pubkey, relayPubkey],
      );
    }
    const clock = await client.query<{ readonly now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    await client.query("COMMIT");
    return {
      id: channelId,
      snapshotAt: Math.floor(
        (clock.rows[0]?.now.getTime() ?? Date.now()) / 1_000,
      ),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function findDm(
  client: PoolClient,
  communityId: string,
  participantHash: Buffer,
  lock: boolean,
): Promise<string | undefined> {
  const result = await client.query<{ readonly id: string }>(
    `SELECT id::text AS id
     FROM channels
     WHERE community_id = $1
       AND participant_hash = $2
       AND channel_type = 'dm'
       AND deleted_at IS NULL
     LIMIT 1${lock ? "\n     FOR UPDATE" : ""}`,
    [communityId, participantHash],
  );
  return result.rows[0]?.id;
}

function buildDmDiscoveryEvents(
  channelId: string,
  createdAt: number,
  relayPubkey: string,
  recipientPubkey: string,
  relaySecretKey: Uint8Array,
): readonly NostrEvent[] {
  const participants = [relayPubkey, recipientPubkey].sort();
  return [
    signNostrEvent(
      {
        content: "",
        created_at: createdAt,
        kind: KIND_NIP29_GROUP_METADATA,
        tags: [
          ["d", channelId],
          ["name", "DM"],
          ["t", "dm"],
          ["channel_type", "dm"],
          ["visibility", "private"],
          ["private"],
          ...participants.map((pubkey) => ["p", pubkey]),
          ["hidden"],
        ],
      },
      relaySecretKey,
    ),
    signNostrEvent(
      {
        content: "",
        created_at: createdAt,
        kind: KIND_NIP29_GROUP_MEMBERS,
        tags: [
          ["d", channelId],
          ...participants.map((pubkey) => ["p", pubkey, "", "member"]),
        ],
      },
      relaySecretKey,
    ),
  ];
}
