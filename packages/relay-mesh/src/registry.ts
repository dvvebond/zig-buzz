import { createClient, type RedisClientType } from "redis";
import {
  READY_KEY_PREFIX,
  ReadyRecordSchema,
  type ReadyRecord,
  type RuntimeId,
} from "./model.js";
import { verifyReadyRecord } from "./identity.js";

export interface ReadyRegistry {
  publish(record: ReadyRecord, ttlSeconds: number): Promise<void>;
  clear(runtimeId: RuntimeId): Promise<void>;
  list(expectedRelayPubkey: RuntimeId): Promise<ReadyRecord[]>;
  close(): Promise<void>;
}

export class RedisReadyRegistry implements ReadyRegistry {
  readonly #client: RedisClientType;
  readonly #ownsClient: boolean;

  public constructor(redis: string | RedisClientType) {
    this.#ownsClient = typeof redis === "string";
    this.#client =
      typeof redis === "string" ? createClient({ url: redis }) : redis;
  }

  async #ready(): Promise<void> {
    if (!this.#client.isOpen) await this.#client.connect();
  }

  public async publish(record: ReadyRecord, ttlSeconds: number): Promise<void> {
    await this.#ready();
    await this.#client.set(
      `${READY_KEY_PREFIX}${record.runtimeId}`,
      JSON.stringify(record),
      {
        EX: Math.max(1, ttlSeconds),
      },
    );
  }

  public async clear(runtimeId: RuntimeId): Promise<void> {
    await this.#ready();
    await this.#client.del(`${READY_KEY_PREFIX}${runtimeId}`);
  }

  public async list(expectedRelayPubkey: RuntimeId): Promise<ReadyRecord[]> {
    await this.#ready();
    const records: ReadyRecord[] = [];
    let cursor = "0";
    do {
      const page = await this.#client.scan(cursor, {
        MATCH: `${READY_KEY_PREFIX}*`,
        COUNT: 100,
      });
      cursor = page.cursor;
      for (const key of page.keys) {
        const raw = await this.#client.get(key);
        if (!raw) continue;
        try {
          const parsed = ReadyRecordSchema.parse(JSON.parse(raw));
          if (
            key === `${READY_KEY_PREFIX}${parsed.runtimeId}` &&
            verifyReadyRecord(parsed, expectedRelayPubkey)
          ) {
            records.push(parsed);
          }
        } catch {
          // A poisoned bootstrap hint cannot take down healthy membership.
        }
      }
    } while (cursor !== "0");
    return records;
  }

  public async close(): Promise<void> {
    if (this.#ownsClient && this.#client.isOpen) await this.#client.quit();
  }
}

export class InMemoryReadyRegistry implements ReadyRegistry {
  readonly #records = new Map<
    RuntimeId,
    { record: ReadyRecord; expiresAt: number }
  >();

  public async publish(record: ReadyRecord, ttlSeconds: number): Promise<void> {
    this.#records.set(record.runtimeId, {
      record: structuredClone(record),
      expiresAt: Date.now() + ttlSeconds * 1_000,
    });
  }

  public async clear(runtimeId: RuntimeId): Promise<void> {
    this.#records.delete(runtimeId);
  }

  public async list(expectedRelayPubkey: RuntimeId): Promise<ReadyRecord[]> {
    const now = Date.now();
    const result: ReadyRecord[] = [];
    for (const [runtimeId, entry] of this.#records) {
      if (entry.expiresAt <= now) {
        this.#records.delete(runtimeId);
      } else if (verifyReadyRecord(entry.record, expectedRelayPubkey)) {
        result.push(structuredClone(entry.record));
      }
    }
    return result;
  }

  public async close(): Promise<void> {}
}
