import type { Pool, PoolClient, QueryResultRow } from "pg";

import { computeAuditHash, normalizeAuditTimestamp } from "./hash.js";
import {
  AUDIT_ACTIONS,
  AuditIntegrityError,
  type AuditAction,
  type AuditEntry,
  type JsonValue,
  type NewAuditEntry,
} from "./types.js";

const AUDIT_LOCK_NAMESPACE = "buzz_audit:";
const MAX_ENTRIES = 10_000;
const CREATED_AT_SQL = `to_char(created_at AT TIME ZONE 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00'`;

type AuditRow = QueryResultRow & {
  readonly community_id: string;
  readonly seq: string;
  readonly hash: Buffer;
  readonly prev_hash: Buffer | null;
  readonly action: string;
  readonly actor_pubkey: Buffer | null;
  readonly object_id: string | null;
  readonly detail: unknown;
  readonly created_at_text: string;
};

export class AuditService {
  public constructor(private readonly pool: Pool) {}

  public async log(input: NewAuditEntry): Promise<AuditEntry> {
    validateInput(input);
    const client = await this.pool.connect();
    const lockKey = `${AUDIT_LOCK_NAMESPACE}${input.communityId}`;
    let locked = false;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
        lockKey,
      ]);
      locked = true;
      return await this.#appendLocked(client, input);
    } finally {
      if (locked) {
        await client
          .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
            lockKey,
          ])
          .catch(() => undefined);
      }
      client.release();
    }
  }

  async #appendLocked(
    client: PoolClient,
    input: NewAuditEntry,
  ): Promise<AuditEntry> {
    await client.query("BEGIN");
    try {
      const head = await client.query<{
        readonly seq: string;
        readonly hash: Buffer;
      }>(
        `SELECT seq::text, hash FROM audit_log
         WHERE community_id = $1
         ORDER BY seq DESC LIMIT 1`,
        [input.communityId],
      );
      const previous = head.rows[0];
      const seq = BigInt(previous?.seq ?? "0") + 1n;
      const timestampResult = await client.query<{ readonly value: string }>(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US') || '+00:00' AS value`,
      );
      const createdAt = normalizeAuditTimestamp(
        timestampResult.rows[0]?.value ??
          (() => {
            throw new Error("database did not return an audit timestamp");
          })(),
      );
      const entry: AuditEntry = {
        action: input.action,
        actorPubkey: input.actorPubkey
          ? Uint8Array.from(input.actorPubkey)
          : null,
        communityId: input.communityId,
        createdAt,
        detail: structuredClone(input.detail),
        hash: new Uint8Array(),
        objectId: input.objectId ?? null,
        prevHash: previous ? Uint8Array.from(previous.hash) : null,
        seq,
      };
      const stored: AuditEntry = {
        ...entry,
        hash: computeAuditHash(entry),
      };
      await client.query(
        `INSERT INTO audit_log
          (community_id, seq, hash, prev_hash, action, actor_pubkey,
           object_id, detail, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)`,
        [
          stored.communityId,
          stored.seq.toString(),
          Buffer.from(stored.hash),
          stored.prevHash ? Buffer.from(stored.prevHash) : null,
          stored.action,
          stored.actorPubkey ? Buffer.from(stored.actorPubkey) : null,
          stored.objectId,
          JSON.stringify(stored.detail),
          stored.createdAt,
        ],
      );
      await client.query("COMMIT");
      return cloneEntry(stored);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  public async verifyChain(
    communityId: string,
    fromSeq: bigint,
    toSeq: bigint,
  ): Promise<boolean> {
    validateCommunityId(communityId);
    if (fromSeq < 0n || toSeq < fromSeq) {
      throw new RangeError("invalid audit sequence range");
    }
    const result = await this.pool.query<AuditRow>(
      `SELECT community_id, seq::text, hash, prev_hash, action,
              actor_pubkey, object_id, detail,
              ${CREATED_AT_SQL} AS created_at_text
       FROM audit_log
       WHERE community_id = $1 AND seq BETWEEN $2 AND $3
       ORDER BY seq ASC`,
      [communityId, fromSeq.toString(), toSeq.toString()],
    );
    if (result.rows.length === 0) return false;
    let expectedPrevious: Uint8Array | undefined;
    for (const row of result.rows) {
      const entry = rowToEntry(row);
      if (
        expectedPrevious &&
        (!entry.prevHash || !equalBytes(entry.prevHash, expectedPrevious))
      ) {
        throw new AuditIntegrityError("CHAIN_VIOLATION", entry.seq);
      }
      if (!equalBytes(entry.hash, computeAuditHash(entry))) {
        throw new AuditIntegrityError("HASH_MISMATCH", entry.seq);
      }
      expectedPrevious = entry.hash;
    }
    return true;
  }

  public async getEntries(
    communityId: string,
    fromSeq: bigint,
    limit = 100,
  ): Promise<AuditEntry[]> {
    validateCommunityId(communityId);
    if (fromSeq < 0n) throw new RangeError("fromSeq must be non-negative");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ENTRIES) {
      throw new RangeError(`audit limit must be between 1 and ${MAX_ENTRIES}`);
    }
    const result = await this.pool.query<AuditRow>(
      `SELECT community_id, seq::text, hash, prev_hash, action,
              actor_pubkey, object_id, detail,
              ${CREATED_AT_SQL} AS created_at_text
       FROM audit_log
       WHERE community_id = $1 AND seq >= $2
       ORDER BY seq ASC
       LIMIT $3`,
      [communityId, fromSeq.toString(), limit],
    );
    return result.rows.map(rowToEntry);
  }
}

function rowToEntry(row: AuditRow): AuditEntry {
  if (!AUDIT_ACTIONS.includes(row.action as AuditAction)) {
    throw new Error("unknown audit action in database");
  }
  return {
    action: row.action as AuditAction,
    actorPubkey: row.actor_pubkey ? Uint8Array.from(row.actor_pubkey) : null,
    communityId: row.community_id,
    createdAt: normalizeAuditTimestamp(row.created_at_text),
    detail: validateJson(row.detail),
    hash: Uint8Array.from(row.hash),
    objectId: row.object_id,
    prevHash: row.prev_hash ? Uint8Array.from(row.prev_hash) : null,
    seq: BigInt(row.seq),
  };
}

function validateInput(input: NewAuditEntry): void {
  validateCommunityId(input.communityId);
  if (!AUDIT_ACTIONS.includes(input.action)) {
    throw new TypeError("unknown audit action");
  }
  if (input.actorPubkey && input.actorPubkey.length !== 32) {
    throw new TypeError("audit actor pubkey must be 32 bytes");
  }
  if (input.objectId && Buffer.byteLength(input.objectId, "utf8") > 16 * 1024) {
    throw new RangeError("audit object id exceeds 16 KiB");
  }
  validateJson(input.detail);
}

function validateCommunityId(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new TypeError("audit communityId must be a UUID");
  }
}

function validateJson(value: unknown, depth = 0): JsonValue {
  if (depth > 100) throw new RangeError("audit detail is too deeply nested");
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item) => validateJson(item, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = validateJson(item, depth + 1);
    }
    return result;
  }
  throw new TypeError("audit detail must be valid JSON");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length && Buffer.from(left).equals(Buffer.from(right))
  );
}

function cloneEntry(entry: AuditEntry): AuditEntry {
  return {
    ...entry,
    actorPubkey: entry.actorPubkey ? Uint8Array.from(entry.actorPubkey) : null,
    detail: structuredClone(entry.detail),
    hash: Uint8Array.from(entry.hash),
    prevHash: entry.prevHash ? Uint8Array.from(entry.prevHash) : null,
  };
}
