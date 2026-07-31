import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { verifyEvent, type Event } from "nostr-tools";

import type { IdentityService } from "./identity.js";
import type { RelayFilter, RelayHttpClient } from "./relay-http.js";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_CANDIDATES = 500;
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_BATCH_BYTES = 32 * 1024 * 1024;
const HEX_64 = /^[0-9a-f]{64}$/;
const SCOPE_VALUE = /^[A-Za-z0-9._:-]{1,512}$/;
const SCOPES = new Set(["channel_h", "owner_p", "referenced_e"]);

type ScopeType = "channel_h" | "owner_p" | "referenced_e";
type SqlRow = Record<string, string | number | bigint | Uint8Array | null>;

type ParsedCandidate = {
  readonly event: Event;
  readonly raw: string;
  readonly scopeType: ScopeType;
  readonly scopeValue: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS save_subscriptions (
  identity_pubkey TEXT NOT NULL,
  relay_url TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  kinds TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (identity_pubkey, relay_url, scope_type, scope_value)
);
CREATE TABLE IF NOT EXISTS archived_events (
  identity_pubkey TEXT NOT NULL,
  relay_url TEXT NOT NULL,
  id TEXT NOT NULL,
  kind INTEGER NOT NULL,
  pubkey TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  encrypted_json TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  PRIMARY KEY (identity_pubkey, relay_url, id)
);
CREATE TABLE IF NOT EXISTS archived_event_scopes (
  identity_pubkey TEXT NOT NULL,
  relay_url TEXT NOT NULL,
  id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  PRIMARY KEY (identity_pubkey, relay_url, id, scope_type, scope_value)
);
CREATE TABLE IF NOT EXISTS observer_channel_index (
  identity_pubkey TEXT NOT NULL,
  relay_url TEXT NOT NULL,
  id TEXT NOT NULL,
  channel_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (identity_pubkey, relay_url, id)
);
CREATE INDEX IF NOT EXISTS idx_archive_scope_page
  ON archived_event_scopes
  (identity_pubkey, relay_url, scope_type, scope_value, id);
CREATE INDEX IF NOT EXISTS idx_archive_event_page
  ON archived_events
  (identity_pubkey, relay_url, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_observer_channel_page
  ON observer_channel_index
  (identity_pubkey, relay_url, channel_id, created_at DESC, id DESC);
`;

export class ArchiveService {
  readonly #database: DatabaseSync;
  readonly #identity: IdentityService;
  readonly #key: Buffer;
  readonly #relay: RelayHttpClient;
  #relayUrl: string;

  constructor(input: {
    readonly database: DatabaseSync;
    readonly identity: IdentityService;
    readonly key: Uint8Array;
    readonly relay: RelayHttpClient;
    readonly relayUrl: string;
  }) {
    if (input.key.byteLength !== KEY_BYTES) {
      throw new Error("archive encryption key must contain 32 bytes");
    }
    this.#database = input.database;
    this.#identity = input.identity;
    this.#key = Buffer.from(input.key);
    this.#relay = input.relay;
    this.#relayUrl = normalizedRelayUrl(input.relayUrl);
    this.#database.exec(
      "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.#database.exec(SCHEMA);
  }

  static async create(input: {
    readonly dataDirectory: string;
    readonly identity: IdentityService;
    readonly relay: RelayHttpClient;
    readonly relayUrl: string;
  }): Promise<ArchiveService> {
    const directory = path.resolve(input.dataDirectory, "archive");
    await mkdir(directory, { mode: 0o700, recursive: true });
    await chmod(directory, 0o700);
    const keyPath = path.join(directory, "archive.key");
    const key = await loadOrCreateKey(keyPath);
    const databasePath = path.join(directory, "archive.sqlite3");
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    await chmod(databasePath, 0o600);
    return new ArchiveService({ ...input, database, key });
  }

  static memory(input: {
    readonly identity: IdentityService;
    readonly relay: RelayHttpClient;
    readonly relayUrl: string;
  }): ArchiveService {
    return new ArchiveService({
      ...input,
      database: new DatabaseSync(":memory:"),
      key: randomBytes(KEY_BYTES),
    });
  }

  close(): void {
    this.#database.close();
    this.#key.fill(0);
  }

  setRelayUrl(relayUrl: string): void {
    this.#relayUrl = normalizedRelayUrl(relayUrl);
  }

  async createSubscription(args: Record<string, unknown>): Promise<void> {
    const scopeType = scope(args.scopeType);
    const parsedScopeValue = scopeValue(scopeType, args.scopeValue);
    const kinds = kindsValue(args.kinds);
    const owner = this.#identity.info().pubkey;
    if (scopeType === "owner_p") {
      if (parsedScopeValue !== owner) {
        throw new Error("owner_p scope must equal the current identity");
      }
    } else if (scopeType === "referenced_e") {
      const events = await this.#relay.query([
        { ids: [parsedScopeValue], limit: 1 },
      ]);
      if (events.length === 0) {
        throw new Error("referenced event is not readable");
      }
    } else {
      const membership = await this.#relay.query([
        { "#d": [parsedScopeValue], kinds: [39_002], limit: 1 },
      ]);
      if (membership.length > 0) {
        const event = membership[0];
        const admitted =
          event?.pubkey === owner ||
          event?.tags.some((tag) => tag[0] === "p" && tag[1] === owner);
        if (!admitted)
          throw new Error("current identity is not a channel member");
      } else {
        const metadata = await this.#relay.query([
          { "#d": [parsedScopeValue], kinds: [39_000], limit: 1 },
        ]);
        if (metadata.length === 0) {
          throw new Error("channel is not readable");
        }
      }
    }
    this.#upsertSubscription(scopeType, parsedScopeValue, kinds);
  }

  listSubscriptions(): SqlRow[] {
    const { identity, relay } = this.#scope();
    return this.#database
      .prepare(
        `SELECT identity_pubkey, relay_url, scope_type, scope_value, kinds, created_at
           FROM save_subscriptions
          WHERE identity_pubkey = ? AND relay_url = ?
          ORDER BY created_at ASC`,
      )
      .all(identity, relay) as SqlRow[];
  }

  deleteSubscription(args: Record<string, unknown>): boolean {
    const scopeType = scope(args.scopeType);
    const scopeValueParsed = scopeValue(scopeType, args.scopeValue);
    const { identity, relay } = this.#scope();
    const result = this.#database
      .prepare(
        `DELETE FROM save_subscriptions
          WHERE identity_pubkey = ? AND relay_url = ?
            AND scope_type = ? AND scope_value = ?`,
      )
      .run(identity, relay, scopeType, scopeValueParsed);
    return result.changes > 0;
  }

  mergeOwnerKind(kindValue: unknown): void {
    const kind = kindValueParsed(kindValue);
    const { identity } = this.#scope();
    this.#transaction(() => {
      const existing = this.#subscriptionKinds("owner_p", identity);
      const kinds = existing ? parseKindsJson(existing) : [];
      if (!kinds.includes(kind)) kinds.push(kind);
      this.#upsertSubscription("owner_p", identity, kinds);
    });
  }

  removeOwnerKind(kindValue: unknown): void {
    const kind = kindValueParsed(kindValue);
    const { identity, relay } = this.#scope();
    this.#transaction(() => {
      const existing = this.#subscriptionKinds("owner_p", identity);
      if (!existing) return;
      const kinds = parseKindsJson(existing).filter((value) => value !== kind);
      if (kinds.length === 0) {
        this.#database
          .prepare(
            `DELETE FROM save_subscriptions
              WHERE identity_pubkey = ? AND relay_url = ?
                AND scope_type = 'owner_p' AND scope_value = ?`,
          )
          .run(identity, relay, identity);
      } else {
        this.#upsertSubscription("owner_p", identity, kinds);
      }
    });
  }

  async archive(args: Record<string, unknown>): Promise<{
    persisted: number;
    dropped: number;
  }> {
    if (
      !Array.isArray(args.candidates) ||
      args.candidates.length > MAX_CANDIDATES
    ) {
      throw new Error(
        `candidates must contain at most ${MAX_CANDIDATES} entries`,
      );
    }
    const persistent: ParsedCandidate[] = [];
    const ephemeral: ParsedCandidate[] = [];
    let dropped = 0;
    let totalBytes = 0;
    for (const rawCandidate of args.candidates) {
      try {
        const candidate = object(rawCandidate, "archive candidate");
        const raw = requireString(candidate.raw_event_json, "raw_event_json");
        const size = Buffer.byteLength(raw, "utf8");
        totalBytes += size;
        if (size > MAX_EVENT_BYTES || totalBytes > MAX_BATCH_BYTES) {
          throw new Error("archive candidate exceeds its size limit");
        }
        const matched = object(candidate.matched_scope, "matched_scope");
        const scopeType = scope(matched.scope_type);
        const scopeValueParsed = scopeValue(scopeType, matched.scope_value);
        const eventValue: unknown = JSON.parse(raw);
        const event = eventValue as Event;
        if (!verifyEvent(event)) throw new Error("invalid signed event");
        const allowed = this.#subscriptionKinds(scopeType, scopeValueParsed);
        if (!allowed || !parseKindsJson(allowed).includes(event.kind)) {
          throw new Error("event kind is not subscribed");
        }
        const parsed = {
          event,
          raw,
          scopeType,
          scopeValue: scopeValueParsed,
        } satisfies ParsedCandidate;
        if (event.kind !== 44_200 && scopeType === "owner_p") {
          if (!this.#validObserverFrame(parsed)) {
            throw new Error("invalid ephemeral observer frame");
          }
          ephemeral.push(parsed);
        } else {
          persistent.push(parsed);
        }
      } catch {
        dropped += 1;
      }
    }

    const uniquePersistent = deduplicatePersistent(persistent);
    const admitted = await this.#reprobe(uniquePersistent);
    dropped += uniquePersistent.length - admitted.length;
    let persisted = 0;
    this.#transaction(() => {
      for (const candidate of [...admitted, ...ephemeral]) {
        let stored = candidate.raw;
        if (candidate.event.kind === 44_200) {
          try {
            const payload = this.#metricPayload(candidate.event);
            stored = JSON.stringify(payload);
          } catch {
            dropped += 1;
            continue;
          }
        }
        this.#store(candidate, stored);
        if (candidate.event.kind === 24_200) {
          let channelId: string | null = null;
          try {
            const payload = JSON.parse(
              this.#identity.decryptFromPeer(
                candidate.event.pubkey,
                candidate.event.content,
              ),
            ) as unknown;
            if (
              typeof payload === "object" &&
              payload !== null &&
              "channelId" in payload &&
              typeof payload.channelId === "string" &&
              payload.channelId.length <= 512
            ) {
              channelId = payload.channelId;
            }
          } catch {
            // A null index row records the failed attempt without exposing it
            // in channel-scoped reads.
          }
          this.#indexObserver(
            candidate.event.id,
            channelId,
            candidate.event.created_at,
          );
        }
        persisted += 1;
      }
    });
    return { dropped, persisted };
  }

  read(args: Record<string, unknown>): string[] {
    const scopeType = scope(args.scopeType);
    const scopeValueParsed = scopeValue(scopeType, args.scopeValue);
    const kinds =
      args.kinds === undefined || args.kinds === null
        ? undefined
        : kindsValue(args.kinds);
    const { beforeAt, beforeId, limit } = pagination(args);
    const { identity, relay } = this.#scope();
    const parameters: Array<string | number> = [
      identity,
      relay,
      scopeType,
      scopeValueParsed,
    ];
    let extra = "";
    if (kinds) {
      if (kinds.length === 0) return [];
      extra += ` AND ae.kind IN (${kinds.map(() => "?").join(",")})`;
      parameters.push(...kinds);
    }
    if (beforeAt !== undefined && beforeId !== undefined) {
      extra += " AND (ae.created_at < ? OR (ae.created_at = ? AND ae.id < ?))";
      parameters.push(beforeAt, beforeAt, beforeId);
    }
    parameters.push(limit);
    const rows = this.#database
      .prepare(
        `SELECT ae.id, ae.encrypted_json
           FROM archived_events ae
           JOIN archived_event_scopes aes
             ON aes.identity_pubkey = ae.identity_pubkey
            AND aes.relay_url = ae.relay_url AND aes.id = ae.id
          WHERE ae.identity_pubkey = ? AND ae.relay_url = ?
            AND aes.scope_type = ? AND aes.scope_value = ?
            ${extra}
          ORDER BY ae.created_at DESC, ae.id DESC
          LIMIT ?`,
      )
      .all(...parameters) as SqlRow[];
    return rows.map((row) =>
      this.#decryptRow(String(row.id), String(row.encrypted_json)),
    );
  }

  indexObserver(args: Record<string, unknown>): void {
    if (!Array.isArray(args.entries) || args.entries.length > 5_000) {
      throw new Error("entries must contain at most 5000 items");
    }
    const entries = args.entries;
    this.#transaction(() => {
      for (const itemValue of entries) {
        const item = object(itemValue, "observer index entry");
        const eventId = requireHex(item.event_id, "event_id");
        const channelId =
          item.channel_id === null
            ? null
            : requireBoundedText(item.channel_id, "channel_id", 512);
        const archived = this.#archivedEvent(eventId);
        if (!archived || Number(archived.kind) !== 24_200) {
          throw new Error(
            "observer index entry does not reference an archived frame",
          );
        }
        const requestedCreatedAt = integer(
          item.created_at,
          "created_at",
          0,
          Number.MAX_SAFE_INTEGER,
        );
        if (requestedCreatedAt !== Number(archived.created_at)) {
          throw new Error(
            "observer index timestamp does not match the archived frame",
          );
        }
        this.#indexObserver(eventId, channelId, requestedCreatedAt);
      }
    });
  }

  readUnindexedObservers(): SqlRow[] {
    const { identity, relay } = this.#scope();
    const rows = this.#database
      .prepare(
        `SELECT ae.id, ae.created_at, ae.encrypted_json
           FROM archived_events ae
           JOIN archived_event_scopes aes
             ON aes.identity_pubkey = ae.identity_pubkey
            AND aes.relay_url = ae.relay_url AND aes.id = ae.id
          WHERE ae.identity_pubkey = ? AND ae.relay_url = ?
            AND ae.kind = 24200 AND aes.scope_type = 'owner_p'
            AND NOT EXISTS (
              SELECT 1 FROM observer_channel_index oci
               WHERE oci.identity_pubkey = ae.identity_pubkey
                 AND oci.relay_url = ae.relay_url AND oci.id = ae.id
            )
          ORDER BY ae.created_at DESC, ae.id DESC`,
      )
      .all(identity, relay) as SqlRow[];
    return rows.map((row) => ({
      created_at: Number(row.created_at),
      id: String(row.id),
      raw_json: this.#decryptRow(String(row.id), String(row.encrypted_json)),
    }));
  }

  readObserversForChannel(args: Record<string, unknown>): string[] {
    const channelId = requireBoundedText(args.channelId, "channelId", 512);
    const { beforeAt, beforeId, limit } = pagination(args);
    const { identity, relay } = this.#scope();
    const parameters: Array<string | number> = [identity, relay, channelId];
    let cursor = "";
    if (beforeAt !== undefined && beforeId !== undefined) {
      cursor =
        " AND (oci.created_at < ? OR (oci.created_at = ? AND oci.id < ?))";
      parameters.push(beforeAt, beforeAt, beforeId);
    }
    parameters.push(limit);
    const rows = this.#database
      .prepare(
        `SELECT ae.id, ae.encrypted_json
           FROM observer_channel_index oci
           JOIN archived_events ae
             ON ae.identity_pubkey = oci.identity_pubkey
            AND ae.relay_url = oci.relay_url AND ae.id = oci.id
          WHERE oci.identity_pubkey = ? AND oci.relay_url = ?
            AND oci.channel_id = ? AND ae.kind = 24200
            ${cursor}
          ORDER BY oci.created_at DESC, oci.id DESC
          LIMIT ?`,
      )
      .all(...parameters) as SqlRow[];
    return rows.map((row) =>
      this.#decryptRow(String(row.id), String(row.encrypted_json)),
    );
  }

  #scope(): { readonly identity: string; readonly relay: string } {
    return {
      identity: this.#identity.info().pubkey,
      relay: this.#relayUrl,
    };
  }

  #upsertSubscription(
    scopeType: ScopeType,
    scopeValueParsed: string,
    kinds: readonly number[],
  ): void {
    const { identity, relay } = this.#scope();
    this.#database
      .prepare(
        `INSERT INTO save_subscriptions
          (identity_pubkey, relay_url, scope_type, scope_value, kinds, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (identity_pubkey, relay_url, scope_type, scope_value)
         DO UPDATE SET kinds = excluded.kinds`,
      )
      .run(
        identity,
        relay,
        scopeType,
        scopeValueParsed,
        JSON.stringify([...new Set(kinds)]),
        Math.floor(Date.now() / 1_000),
      );
  }

  #subscriptionKinds(
    scopeType: ScopeType,
    scopeValueParsed: string,
  ): string | null {
    const { identity, relay } = this.#scope();
    const row = this.#database
      .prepare(
        `SELECT kinds FROM save_subscriptions
          WHERE identity_pubkey = ? AND relay_url = ?
            AND scope_type = ? AND scope_value = ?`,
      )
      .get(identity, relay, scopeType, scopeValueParsed) as SqlRow | undefined;
    return row ? String(row.kinds) : null;
  }

  async #reprobe(
    candidates: readonly ParsedCandidate[],
  ): Promise<ParsedCandidate[]> {
    const groups = new Map<string, ParsedCandidate[]>();
    for (const candidate of candidates) {
      const key = `${candidate.scopeType}\0${candidate.scopeValue}`;
      const group = groups.get(key) ?? [];
      group.push(candidate);
      groups.set(key, group);
    }
    const admitted: ParsedCandidate[] = [];
    for (const group of groups.values()) {
      const first = group[0];
      if (!first) continue;
      const ids = [...new Set(group.map((candidate) => candidate.event.id))];
      const filter: RelayFilter = {
        ids,
        kinds: [...new Set(group.map((candidate) => candidate.event.kind))],
        limit: ids.length,
        ...(first.scopeType === "channel_h"
          ? { "#h": [first.scopeValue] }
          : first.scopeType === "referenced_e"
            ? { "#e": [first.scopeValue] }
            : { "#p": [first.scopeValue] }),
      };
      try {
        const returned = new Set(
          (await this.#relay.query([filter])).map((event) => event.id),
        );
        admitted.push(
          ...group.filter((candidate) => returned.has(candidate.event.id)),
        );
      } catch {
        // A failed access probe drops the bucket; archive sync will retry on
        // a later live event without persisting unverified data.
      }
    }
    return admitted;
  }

  #validObserverFrame(candidate: ParsedCandidate): boolean {
    const owner = this.#identity.info().pubkey;
    const agent = firstTag(candidate.event, "agent");
    return (
      candidate.scopeValue === owner &&
      candidate.event.kind === 24_200 &&
      tagContains(candidate.event, "p", owner) &&
      firstTag(candidate.event, "frame") === "telemetry" &&
      agent !== null &&
      candidate.event.pubkey === agent
    );
  }

  #metricPayload(event: Event): unknown {
    if (event.content.length < 132 || event.content.length > 87_472) {
      throw new Error("metric ciphertext length is invalid");
    }
    const plaintext = this.#identity.decryptFromPeer(
      event.pubkey,
      event.content,
    );
    if (Buffer.byteLength(plaintext, "utf8") > 65_535) {
      throw new Error("metric payload exceeds its size limit");
    }
    const value: unknown = JSON.parse(plaintext);
    const metric = object(value, "metric payload");
    requireBoundedText(metric.harness, "metric.harness", 256);
    requireBoundedText(metric.timestamp, "metric.timestamp", 128);
    validateTokenCounts(metric.turn, "metric.turn");
    validateTokenCounts(metric.cumulative, "metric.cumulative");
    if (metric.cumulative !== undefined && metric.cumulative !== null) {
      requireBoundedText(metric.sessionId, "metric.sessionId", 512);
      integer(metric.turnSeq, "metric.turnSeq", 0, Number.MAX_SAFE_INTEGER);
    }
    return value;
  }

  #store(candidate: ParsedCandidate, raw: string): void {
    const { identity, relay } = this.#scope();
    const encrypted = this.#encryptRow(candidate.event.id, raw);
    const now = Math.floor(Date.now() / 1_000);
    this.#database
      .prepare(
        `INSERT INTO archived_events
          (identity_pubkey, relay_url, id, kind, pubkey, created_at,
           encrypted_json, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (identity_pubkey, relay_url, id) DO NOTHING`,
      )
      .run(
        identity,
        relay,
        candidate.event.id,
        candidate.event.kind,
        candidate.event.pubkey,
        candidate.event.created_at,
        encrypted,
        now,
      );
    this.#database
      .prepare(
        `INSERT INTO archived_event_scopes
          (identity_pubkey, relay_url, id, scope_type, scope_value, archived_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (identity_pubkey, relay_url, id, scope_type, scope_value)
         DO NOTHING`,
      )
      .run(
        identity,
        relay,
        candidate.event.id,
        candidate.scopeType,
        candidate.scopeValue,
        now,
      );
  }

  #archivedEvent(id: string): SqlRow | undefined {
    const { identity, relay } = this.#scope();
    return this.#database
      .prepare(
        `SELECT kind, created_at FROM archived_events
          WHERE identity_pubkey = ? AND relay_url = ? AND id = ?`,
      )
      .get(identity, relay, id) as SqlRow | undefined;
  }

  #indexObserver(
    id: string,
    channelId: string | null,
    createdAt: number,
  ): void {
    const { identity, relay } = this.#scope();
    this.#database
      .prepare(
        `INSERT INTO observer_channel_index
          (identity_pubkey, relay_url, id, channel_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (identity_pubkey, relay_url, id) DO NOTHING`,
      )
      .run(identity, relay, id, channelId, createdAt);
  }

  #encryptRow(id: string, value: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(this.#aad(id));
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return JSON.stringify({
      c: ciphertext.toString("base64"),
      n: nonce.toString("base64"),
      t: cipher.getAuthTag().toString("base64"),
      v: 1,
    });
  }

  #decryptRow(id: string, value: string): string {
    let envelope: unknown;
    try {
      envelope = JSON.parse(value);
    } catch {
      throw new Error("archived event ciphertext is malformed");
    }
    if (
      typeof envelope !== "object" ||
      envelope === null ||
      !("v" in envelope) ||
      envelope.v !== 1 ||
      !("c" in envelope) ||
      typeof envelope.c !== "string" ||
      !("n" in envelope) ||
      typeof envelope.n !== "string" ||
      Buffer.from(envelope.n, "base64").byteLength !== NONCE_BYTES ||
      !("t" in envelope) ||
      typeof envelope.t !== "string" ||
      Buffer.from(envelope.t, "base64").byteLength !== TAG_BYTES
    ) {
      throw new Error("archived event ciphertext is malformed");
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      Buffer.from(envelope.n, "base64"),
    );
    decipher.setAAD(this.#aad(id));
    decipher.setAuthTag(Buffer.from(envelope.t, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.c, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  #aad(id: string): Buffer {
    const { identity, relay } = this.#scope();
    return Buffer.from(`buzz.archive.v1\0${identity}\0${relay}\0${id}`, "utf8");
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original transactional error.
      }
      throw error;
    }
  }
}

async function loadOrCreateKey(keyPath: string): Promise<Buffer> {
  try {
    const key = await readFile(keyPath);
    if (key.byteLength !== KEY_BYTES) throw new Error("invalid archive key");
    await chmod(keyPath, 0o600);
    return key;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const generated = randomBytes(KEY_BYTES);
  try {
    await writeFile(keyPath, generated, { flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    const key = await readFile(keyPath);
    if (key.byteLength !== KEY_BYTES) throw new Error("invalid archive key");
    return key;
  }
}

function normalizedRelayUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "wss:" &&
      !(
        url.protocol === "ws:" &&
        ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
      )) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("archive relay URL must use secure WebSocket");
  }
  url.pathname = "/";
  return url.toString();
}

function scope(value: unknown): ScopeType {
  if (typeof value !== "string" || !SCOPES.has(value)) {
    throw new Error("scopeType is invalid");
  }
  return value as ScopeType;
}

function scopeValue(type: ScopeType, value: unknown): string {
  if (typeof value !== "string") throw new Error("scopeValue must be a string");
  if ((type === "owner_p" || type === "referenced_e") && !HEX_64.test(value)) {
    throw new Error(
      `${type} scopeValue must be 64 lowercase hexadecimal characters`,
    );
  }
  if (type === "channel_h" && !SCOPE_VALUE.test(value)) {
    throw new Error("channel_h scopeValue is invalid");
  }
  return value;
}

function kindsValue(value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error("kinds must contain at most 256 entries");
  }
  return [...new Set(value.map(kindValueParsed))];
}

function kindValueParsed(value: unknown): number {
  return integer(value, "kind", 0, 65_535);
}

function parseKindsJson(value: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("archive subscription has malformed kinds");
  }
  return kindsValue(parsed);
}

function pagination(args: Record<string, unknown>): {
  readonly beforeAt?: number;
  readonly beforeId?: string;
  readonly limit: number;
} {
  const limit =
    args.limit === undefined || args.limit === null
      ? 50
      : integer(args.limit, "limit", 1, 500);
  const hasAt =
    args.beforeCreatedAt !== undefined && args.beforeCreatedAt !== null;
  const hasId = args.beforeId !== undefined && args.beforeId !== null;
  if (hasAt !== hasId) {
    throw new Error("beforeCreatedAt and beforeId must be supplied together");
  }
  if (!hasAt) return { limit };
  return {
    beforeAt: integer(
      args.beforeCreatedAt,
      "beforeCreatedAt",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    beforeId: requireHex(args.beforeId, "beforeId"),
    limit,
  };
}

function deduplicatePersistent(
  candidates: readonly ParsedCandidate[],
): ParsedCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.scopeType}\0${candidate.scopeValue}\0${candidate.event.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function firstTag(event: Event, name: string): string | null {
  const tag = event.tags.find(
    (candidate) =>
      candidate.length >= 2 &&
      candidate[0] === name &&
      typeof candidate[1] === "string",
  );
  return tag?.[1] ?? null;
}

function tagContains(event: Event, name: string, value: string): boolean {
  return event.tags.some(
    (candidate) =>
      candidate.length >= 2 && candidate[0] === name && candidate[1] === value,
  );
}

function validateTokenCounts(value: unknown, name: string): void {
  if (value === undefined || value === null) return;
  const counts = object(value, name);
  for (const field of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ]) {
    if (counts[field] !== undefined && counts[field] !== null) {
      integer(counts[field], `${name}.${field}`, 0, Number.MAX_SAFE_INTEGER);
    }
  }
  if (counts.costUsd !== undefined && counts.costUsd !== null) {
    if (
      typeof counts.costUsd !== "number" ||
      !Number.isFinite(counts.costUsd) ||
      counts.costUsd < 0
    ) {
      throw new Error(`${name}.costUsd is invalid`);
    }
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function requireBoundedText(
  value: unknown,
  name: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximum
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function requireHex(value: unknown, name: string): string {
  if (typeof value !== "string" || !HEX_64.test(value)) {
    throw new Error(`${name} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
