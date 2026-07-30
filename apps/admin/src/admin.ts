import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  KIND_NIP43_MEMBERSHIP_LIST,
  signNostrEvent,
  type NostrEvent,
} from "@buzz/core";
import { PostgresEventStore } from "@buzz/db";
import type { EventBus } from "@buzz/pubsub";
import { nip19 } from "nostr-tools";
import { getPublicKey } from "nostr-tools/pure";
import type { Pool, PoolClient } from "pg";

export type RelayMember = {
  readonly pubkey: string;
  readonly role: "owner" | "admin" | "member";
  readonly addedBy?: string;
  readonly createdAt: string;
};

export class BuzzAdmin {
  public constructor(
    private readonly pool: Pool,
    private readonly community: string,
    private readonly relaySecretKey?: Uint8Array,
    private readonly eventBus?: EventBus,
  ) {}

  public async listMembers(): Promise<RelayMember[]> {
    const result = await this.pool.query<{
      readonly pubkey: string;
      readonly role: RelayMember["role"];
      readonly added_by: string | null;
      readonly created_at: Date;
    }>(
      `SELECT rm.pubkey, rm.role, rm.added_by, rm.created_at
       FROM relay_members rm
       JOIN communities c ON c.id = rm.community_id
       WHERE lower(c.host) = lower($1) AND c.archived_at IS NULL
       ORDER BY
         CASE rm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
         rm.created_at,
         rm.pubkey`,
      [this.community],
    );
    return result.rows.map((row) => ({
      ...(row.added_by ? { addedBy: row.added_by } : {}),
      createdAt: row.created_at.toISOString(),
      pubkey: row.pubkey,
      role: row.role,
    }));
  }

  public async addMember(
    pubkeyInput: string,
    roleInput: string,
  ): Promise<{
    readonly changed: boolean;
    readonly pubkey: string;
    readonly role: "admin" | "member";
  }> {
    const pubkey = parsePubkey(pubkeyInput);
    const role = validateMutableRole(roleInput);
    let changed = false;
    await this.withCommunityTransaction(async (client, communityId) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('buzz-admin-members:' || $1::text))",
        [communityId],
      );
      const inserted = await client.query(
        `INSERT INTO relay_members (community_id, pubkey, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (community_id, pubkey) DO NOTHING`,
        [communityId, pubkey, role],
      );
      changed = inserted.rowCount === 1;
    });
    const member = (await this.listMembers()).find(
      (candidate) => candidate.pubkey === pubkey,
    );
    if (!member) throw new Error("member write did not persist");
    if (member.role !== role) {
      throw new Error(
        `already a member with role '${member.role}'; use a signed relay role-change command`,
      );
    }
    if (changed) await this.publishMembershipList();
    return { changed, pubkey, role };
  }

  public async removeMember(
    pubkeyInput: string,
    expectedRole?: string,
  ): Promise<{ readonly removed: true; readonly pubkey: string }> {
    const pubkey = parsePubkey(pubkeyInput);
    const role = expectedRole ? validateMutableRole(expectedRole) : undefined;
    let removed = false;
    await this.withCommunityTransaction(async (client, communityId) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('buzz-admin-members:' || $1::text))",
        [communityId],
      );
      const selected = await client.query<{ readonly role: string }>(
        `SELECT role FROM relay_members
         WHERE community_id = $1 AND pubkey = $2
         FOR UPDATE`,
        [communityId, pubkey],
      );
      const current = selected.rows[0]?.role;
      if (!current) throw new Error(`member not found: ${pubkey}`);
      if (current === "owner") {
        throw new Error(
          "cannot remove the relay owner; change the relay owner configuration",
        );
      }
      if (role && current !== role) {
        throw new Error(`role mismatch: member is '${current}', not '${role}'`);
      }
      const deleted = await client.query(
        `DELETE FROM relay_members
         WHERE community_id = $1 AND pubkey = $2 AND role <> 'owner'`,
        [communityId, pubkey],
      );
      removed = deleted.rowCount === 1;
    });
    if (!removed) throw new Error("member was not removed");
    await this.publishMembershipList();
    return { pubkey, removed: true };
  }

  public async listProductFeedback(limit: number): Promise<unknown[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("feedback limit must be between 1 and 1000");
    }
    const result = await this.pool.query(
      `SELECT pf.id, c.host AS community_host,
              encode(pf.event_id, 'hex') AS event_id,
              encode(pf.submitter_pubkey, 'hex') AS submitter_pubkey,
              pf.category, pf.body, pf.tags, pf.event_created_at,
              pf.received_at
       FROM product_feedback pf
       JOIN communities c ON c.id = pf.community_id
       ORDER BY pf.received_at DESC, pf.id
       LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  public async reconcileChannels(): Promise<{
    readonly reconciled: number;
    readonly skipped: number;
  }> {
    const secret = this.requiredRelaySecret();
    const eventStore = new PostgresEventStore(this.pool);
    const result = await this.pool.query<{
      readonly id: string;
      readonly name: string;
      readonly channel_type: string;
      readonly visibility: string;
      readonly description: string | null;
    }>(
      `SELECT ch.id, ch.name, ch.channel_type::text, ch.visibility::text,
              ch.description
       FROM channels ch
       JOIN communities c ON c.id = ch.community_id
       WHERE lower(c.host) = lower($1)
         AND c.archived_at IS NULL
         AND ch.deleted_at IS NULL
       ORDER BY ch.created_at, ch.id`,
      [this.community],
    );
    let reconciled = 0;
    let skipped = 0;
    for (const channel of result.rows) {
      if (
        (
          await eventStore.query(this.community, {
            "#d": [channel.id],
            kinds: [39_000],
            limit: 1,
          })
        ).length
      ) {
        skipped += 1;
        continue;
      }
      const members = await this.pool.query<{
        readonly pubkey: string;
        readonly role: string;
      }>(
        `SELECT encode(cm.pubkey, 'hex') AS pubkey, cm.role::text AS role
         FROM channel_members cm
         JOIN communities c ON c.id = cm.community_id
         WHERE lower(c.host) = lower($1)
           AND cm.channel_id = $2::uuid
           AND cm.removed_at IS NULL
         ORDER BY cm.created_at, cm.pubkey`,
        [this.community, channel.id],
      );
      const metadata = signNostrEvent(
        {
          content: "",
          created_at: Math.floor(Date.now() / 1_000),
          kind: 39_000,
          tags: [
            ["d", channel.id],
            ["name", channel.name],
            ...(channel.description
              ? [["about", channel.description] as [string, string]]
              : []),
            [channel.visibility === "private" ? "private" : "public"],
            ["closed"],
            ["t", channel.channel_type],
            ...(channel.channel_type === "dm" ? [["hidden"]] : []),
          ],
        },
        secret,
      );
      const admins = signNostrEvent(
        {
          content: "",
          created_at: metadata.created_at,
          kind: 39_001,
          tags: [
            ["d", channel.id],
            ...members.rows
              .filter(
                (member) => member.role === "owner" || member.role === "admin",
              )
              .map((member) => ["p", member.pubkey, member.role]),
          ],
        },
        secret,
      );
      const roster = signNostrEvent(
        {
          content: "",
          created_at: metadata.created_at,
          kind: 39_002,
          tags: [
            ["d", channel.id],
            ...members.rows.map((member) => [
              "p",
              member.pubkey,
              "",
              member.role,
            ]),
          ],
        },
        secret,
      );
      for (const event of [metadata, admins, roster]) {
        const stored = await eventStore.store(
          this.community,
          event,
          channel.id,
        );
        if (stored.status === "inserted") {
          await this.eventBus?.publish(this.community, event);
        }
      }
      reconciled += 1;
    }
    return { reconciled, skipped };
  }

  public async migrate(migrationsDirectory: string): Promise<string[]> {
    const files = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(name))
      .sort();
    const applied: string[] = [];
    const client = await this.pool.connect();
    try {
      await client.query(
        "SELECT pg_advisory_lock(hashtext('buzz-ts-migrate'))",
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS buzz_ts_migrations (
           version TEXT PRIMARY KEY,
           checksum TEXT NOT NULL,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
      );
      const baseline = await client.query(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'communities'",
      );
      const tracked = await client.query(
        "SELECT count(*)::int AS count FROM buzz_ts_migrations",
      );
      if (
        baseline.rowCount === 1 &&
        (tracked.rows[0] as { count: number } | undefined)?.count === 0
      ) {
        for (const file of files) {
          const sql = await readFile(join(migrationsDirectory, file), "utf8");
          await client.query(
            `INSERT INTO buzz_ts_migrations (version, checksum)
             VALUES ($1, $2)`,
            [file, createHash("sha256").update(sql).digest("hex")],
          );
        }
        return [];
      }
      for (const file of files) {
        const sql = await readFile(join(migrationsDirectory, file), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        const existing = await client.query<{ readonly checksum: string }>(
          "SELECT checksum FROM buzz_ts_migrations WHERE version = $1",
          [file],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].checksum !== checksum) {
            throw new Error(`migration checksum changed: ${file}`);
          }
          continue;
        }
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            `INSERT INTO buzz_ts_migrations (version, checksum)
             VALUES ($1, $2)`,
            [file, checksum],
          );
          await client.query("COMMIT");
          applied.push(file);
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
      return applied;
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtext('buzz-ts-migrate'))")
        .catch(() => undefined);
      client.release();
    }
  }

  private async publishMembershipList(): Promise<NostrEvent> {
    const secret = this.requiredRelaySecret();
    const pubkey = getPublicKey(secret);
    const eventStore = new PostgresEventStore(this.pool);
    const latest = await eventStore.query(this.community, {
      authors: [pubkey],
      kinds: [KIND_NIP43_MEMBERSHIP_LIST],
      limit: 1,
    });
    const createdAt = Math.max(
      Math.floor(Date.now() / 1_000),
      (latest[0]?.created_at ?? 0) + 1,
    );
    const members = await this.listMembers();
    const event = signNostrEvent(
      {
        content: "",
        created_at: createdAt,
        kind: KIND_NIP43_MEMBERSHIP_LIST,
        tags: [
          ["-"],
          ...members.map((member) => ["member", member.pubkey, member.role]),
        ],
      },
      secret,
    );
    const stored = await eventStore.store(this.community, event);
    if (stored.status === "inserted") {
      await this.eventBus?.publish(this.community, event);
    }
    return event;
  }

  private async withCommunityTransaction(
    operation: (client: PoolClient, communityId: string) => Promise<void>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ readonly id: string }>(
        `SELECT id FROM communities
         WHERE lower(host) = lower($1) AND archived_at IS NULL
         FOR SHARE`,
        [this.community],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error(`community is not mapped: ${this.community}`);
      await operation(client, id);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private requiredRelaySecret(): Uint8Array {
    if (!this.relaySecretKey) {
      throw new Error(
        "BUZZ_RELAY_PRIVATE_KEY is required for signed roster/discovery events",
      );
    }
    return this.relaySecretKey;
  }
}

export function validateMutableRole(value: string): "admin" | "member" {
  if (value === "admin" || value === "member") return value;
  if (value === "owner") {
    throw new Error(
      "role 'owner' cannot be assigned by the admin CLI; configure the relay owner",
    );
  }
  throw new Error("role must be 'admin' or 'member'");
}

export function parsePubkey(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  try {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "npub") throw new Error();
    return decoded.data;
  } catch {
    throw new Error("pubkey must be an npub or 64-character hex key");
  }
}
