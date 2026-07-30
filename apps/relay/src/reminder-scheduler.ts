import { randomBytes } from "node:crypto";

import {
  KIND_EVENT_REMINDER,
  verifyNostrEvent,
  type NostrEvent,
} from "@buzz/core";
import type { Pool } from "pg";

type DueReminderRow = {
  readonly content: string;
  readonly community_id: string;
  readonly created_at: Date;
  readonly host: string;
  readonly id: string;
  readonly kind: number;
  readonly pubkey: string;
  readonly sig: string;
  readonly tags: unknown;
};

export type ReminderPublisher = (
  event: NostrEvent,
  community: string,
) => Promise<void>;

/**
 * Claim-before-publish NIP-ER reminder delivery worker.
 *
 * The opaque BIGINT claim stamp makes delivery single-winner across relay pods
 * and permits compare-and-clear retry when publication fails.
 */
export class ReminderScheduler {
  readonly #batchLimit: number;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #tick: Promise<number> | undefined;

  public constructor(
    private readonly pool: Pool,
    private readonly publish: ReminderPublisher,
    options: {
      readonly batchLimit?: number;
      readonly intervalMs?: number;
    } = {},
  ) {
    this.#batchLimit = boundedInteger(
      options.batchLimit ?? 100,
      1,
      1_000,
      "reminder batch limit",
    );
    this.#intervalMs = boundedInteger(
      options.intervalMs ?? 10_000,
      100,
      3_600_000,
      "reminder interval",
    );
  }

  public start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.#intervalMs);
    this.#timer.unref();
  }

  public stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  public async tick(now = Math.floor(Date.now() / 1_000)): Promise<number> {
    if (this.#tick) return this.#tick;
    this.#tick = this.#runTick(now).finally(() => {
      this.#tick = undefined;
    });
    return this.#tick;
  }

  async #runTick(now: number): Promise<number> {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError("reminder scheduler timestamp is invalid");
    }
    const due = await this.pool.query<DueReminderRow>(
      `SELECT DISTINCT ON (e.community_id, e.pubkey, e.d_tag)
         e.community_id::text AS community_id,
         c.host,
         encode(e.id, 'hex') AS id,
         encode(e.pubkey, 'hex') AS pubkey,
         e.created_at,
         e.kind,
         e.tags,
         e.content,
         encode(e.sig, 'hex') AS sig
       FROM events e
       JOIN communities c ON c.id = e.community_id
       WHERE e.kind = $1
         AND e.not_before IS NOT NULL
         AND e.not_before <= $2
         AND e.deleted_at IS NULL
         AND e.delivered_at IS NULL
         AND c.archived_at IS NULL
       ORDER BY
         e.community_id,
         e.pubkey,
         e.d_tag,
         e.created_at DESC,
         e.id ASC
       LIMIT $3`,
      [KIND_EVENT_REMINDER, now, this.#batchLimit],
    );
    let delivered = 0;
    for (const row of due.rows) {
      const event = eventFromDueRow(row);
      const stamp = deliveryStamp();
      const claimed = await this.pool.query(
        `UPDATE events e
         SET delivered_at = $4::bigint
         WHERE e.community_id = $1::uuid
           AND e.created_at = $2
           AND e.id = decode($3, 'hex')
           AND e.delivered_at IS NULL
           AND e.deleted_at IS NULL
         RETURNING e.id`,
        [row.community_id, row.created_at, row.id, stamp],
      );
      if (claimed.rowCount !== 1) continue;
      try {
        await this.publish(event, row.host);
        delivered += 1;
      } catch (error) {
        try {
          await this.pool.query(
            `UPDATE events e
             SET delivered_at = NULL
             WHERE e.community_id = $1::uuid
               AND e.created_at = $2
               AND e.id = decode($3, 'hex')
               AND e.delivered_at = $4::bigint`,
            [row.community_id, row.created_at, row.id, stamp],
          );
        } catch {
          // Preserve the original publish failure; a failed compare-and-clear
          // leaves the row claimed instead of risking duplicate delivery.
        }
        throw error;
      }
    }
    return delivered;
  }
}

function eventFromDueRow(row: DueReminderRow): NostrEvent {
  if (
    !Array.isArray(row.tags) ||
    !row.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((part) => typeof part === "string"),
    )
  ) {
    throw new Error("due reminder contains malformed tags");
  }
  const event: NostrEvent = {
    content: row.content,
    created_at: Math.floor(row.created_at.getTime() / 1_000),
    id: row.id,
    kind: row.kind,
    pubkey: row.pubkey,
    sig: row.sig,
    tags: row.tags,
  };
  if (!verifyNostrEvent(event) || event.kind !== KIND_EVENT_REMINDER) {
    throw new Error("due reminder event is invalid");
  }
  return event;
}

function deliveryStamp(): string {
  const value = BigInt.asUintN(63, randomBytes(8).readBigInt64BE());
  return (value === 0n ? 1n : value).toString();
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
