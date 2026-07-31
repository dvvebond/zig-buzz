import { createHash, randomUUID } from "node:crypto";

import {
  KIND_REACTION,
  KIND_STREAM_MESSAGE,
  KIND_SYSTEM_MESSAGE,
  signNostrEvent,
  unixNow,
  type NostrEvent,
} from "@buzz/core";
import type { Pool } from "pg";
import type { WorkflowActionContext, WorkflowActionSink } from "@buzz/workflow";

export type WorkflowCommunityIdentity = {
  readonly communityHost: string;
  readonly communityId: string;
  readonly relaySecretKey: Uint8Array;
};

export class RelayWorkflowActionSink implements WorkflowActionSink {
  public constructor(
    private readonly pool: Pool,
    private readonly community: string,
    private readonly relaySecretKey: Uint8Array,
    private readonly submit: (
      event: NostrEvent,
      channelId: string,
      identity: WorkflowCommunityIdentity,
    ) => Promise<void>,
    private readonly resolveCommunityIdentity?: (
      communityId: string,
    ) => Promise<WorkflowCommunityIdentity>,
  ) {}

  public async sendMessage(
    input: WorkflowActionContext & {
      readonly channelId: string;
      readonly text: string;
    },
  ): Promise<{ readonly eventId: string }> {
    assertActive(input.signal);
    if (!input.text.trim()) throw new Error("workflow message is empty");
    if (input.workflowChannelId !== input.channelId) {
      throw new Error("workflow cannot post outside its channel");
    }
    const identity = await this.#identity(input.communityId);
    const event = signNostrEvent(
      {
        content: input.text,
        created_at: unixNow(),
        kind: KIND_STREAM_MESSAGE,
        tags: [
          ["h", input.channelId],
          ["p", input.ownerPubkey],
          ["actor", input.ownerPubkey],
          ["workflow", input.workflowId],
          ["run", input.runId],
        ],
      },
      identity.relaySecretKey,
    );
    await this.submit(event, input.channelId, identity);
    return { eventId: event.id };
  }

  public async sendDm(
    input: WorkflowActionContext & {
      readonly recipientPubkey: string;
      readonly text: string;
    },
  ): Promise<{ readonly eventId: string; readonly channelId: string }> {
    assertActive(input.signal);
    if (!input.text.trim()) throw new Error("workflow DM is empty");
    const identity = await this.#identity(input.communityId);
    const channelId = await this.resolveDmChannel(
      input.communityId,
      input.ownerPubkey,
      input.recipientPubkey,
    );
    const event = signNostrEvent(
      {
        content: input.text,
        created_at: unixNow(),
        kind: KIND_STREAM_MESSAGE,
        tags: [
          ["h", channelId],
          ["p", input.ownerPubkey],
          ["p", input.recipientPubkey],
          ["actor", input.ownerPubkey],
          ["workflow", input.workflowId],
          ["run", input.runId],
        ],
      },
      identity.relaySecretKey,
    );
    await this.submit(event, channelId, identity);
    return { channelId, eventId: event.id };
  }

  public async setChannelTopic(
    input: WorkflowActionContext & {
      readonly channelId: string;
      readonly topic: string;
    },
  ): Promise<{ readonly eventId: string }> {
    assertActive(input.signal);
    if (input.workflowChannelId !== input.channelId) {
      throw new Error("workflow cannot update another channel");
    }
    const identity = await this.#identity(input.communityId);
    const updated = await this.pool.query(
      `UPDATE channels ch
       SET topic = $4,
           topic_set_by = decode($3, 'hex'),
           topic_set_at = now(),
           updated_at = now()
       WHERE ch.community_id = $1::uuid
         AND ch.id = $2::uuid
         AND ch.archived_at IS NULL
         AND ch.deleted_at IS NULL`,
      [input.communityId, input.channelId, input.ownerPubkey, input.topic],
    );
    if (updated.rowCount !== 1)
      throw new Error("workflow channel is unavailable");
    const event = signNostrEvent(
      {
        content: JSON.stringify({
          actor: input.ownerPubkey,
          topic: input.topic,
          type: "topic_changed",
        }),
        created_at: unixNow(),
        kind: KIND_SYSTEM_MESSAGE,
        tags: [
          ["h", input.channelId],
          ["actor", input.ownerPubkey],
          ["workflow", input.workflowId],
          ["run", input.runId],
        ],
      },
      identity.relaySecretKey,
    );
    await this.submit(event, input.channelId, identity);
    return { eventId: event.id };
  }

  public async addReaction(
    input: WorkflowActionContext & {
      readonly eventId: string;
      readonly emoji: string;
    },
  ): Promise<{ readonly eventId: string }> {
    assertActive(input.signal);
    const identity = await this.#identity(input.communityId);
    const target = await this.pool.query<{ readonly channel_id: string }>(
      `SELECT e.channel_id
       FROM events e
       WHERE e.community_id = $1::uuid
         AND e.id = decode($2, 'hex')
         AND e.deleted_at IS NULL
         AND e.channel_id IS NOT NULL
       ORDER BY e.created_at DESC
       LIMIT 1`,
      [input.communityId, input.eventId],
    );
    const channelId = target.rows[0]?.channel_id;
    if (!channelId || channelId !== input.workflowChannelId) {
      throw new Error("workflow reaction target is unavailable");
    }
    const event = signNostrEvent(
      {
        content: input.emoji,
        created_at: unixNow(),
        kind: KIND_REACTION,
        tags: [
          ["e", input.eventId],
          ["h", channelId],
          ["actor", input.ownerPubkey],
          ["workflow", input.workflowId],
          ["run", input.runId],
        ],
      },
      identity.relaySecretKey,
    );
    await this.submit(event, channelId, identity);
    return { eventId: event.id };
  }

  private async resolveDmChannel(
    communityId: string,
    ownerPubkey: string,
    recipientPubkey: string,
  ): Promise<string> {
    const participants = [ownerPubkey, recipientPubkey].sort();
    const participantHash = createHash("sha256")
      .update(participants.join(":"))
      .digest();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${communityId}:${participants.join(":")}`],
      );
      const community = await client.query<{ readonly id: string }>(
        `SELECT id FROM communities
         WHERE id = $1::uuid AND archived_at IS NULL
         FOR SHARE`,
        [communityId],
      );
      const resolvedCommunityId = community.rows[0]?.id;
      if (!resolvedCommunityId) {
        throw new Error("workflow community is unavailable");
      }
      const existing = await client.query<{ readonly id: string }>(
        `SELECT id FROM channels
         WHERE community_id = $1
           AND participant_hash = $2
           AND deleted_at IS NULL
         LIMIT 1`,
        [resolvedCommunityId, participantHash],
      );
      const channelId = existing.rows[0]?.id ?? randomUUID();
      if (existing.rowCount === 0) {
        await client.query(
          `INSERT INTO channels (
             community_id, id, name, channel_type, visibility, created_by,
             participant_hash
           )
           VALUES (
             $1, $2::uuid, 'Direct message', 'dm', 'private',
             decode($3, 'hex'), $4
           )`,
          [resolvedCommunityId, channelId, ownerPubkey, participantHash],
        );
      }
      for (const pubkey of participants) {
        await client.query(
          `INSERT INTO channel_members (
             community_id, channel_id, pubkey, role
           )
           VALUES ($1, $2::uuid, decode($3, 'hex'), 'member')
           ON CONFLICT (community_id, channel_id, pubkey)
           DO UPDATE SET removed_at = NULL, removed_by = NULL`,
          [resolvedCommunityId, channelId, pubkey],
        );
      }
      await client.query("COMMIT");
      return channelId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #identity(communityId: string): Promise<WorkflowCommunityIdentity> {
    if (this.resolveCommunityIdentity) {
      const identity = await this.resolveCommunityIdentity(communityId);
      if (identity.communityId !== communityId) {
        throw new Error("workflow community resolver returned a mismatched id");
      }
      return {
        ...identity,
        relaySecretKey: Uint8Array.from(identity.relaySecretKey),
      };
    }
    return {
      communityHost: this.community,
      communityId,
      relaySecretKey: Uint8Array.from(this.relaySecretKey),
    };
  }
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("workflow action was cancelled");
}
