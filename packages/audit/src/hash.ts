import { createHash } from "node:crypto";

import type { AuditEntry, JsonValue } from "./types.js";

export const GENESIS_HASH = new Uint8Array(32);

export function computeAuditHash(entry: AuditEntry): Uint8Array {
  const hash = createHash("sha256");
  hash.update(uuidBytes(entry.communityId));
  const sequence = Buffer.alloc(8);
  sequence.writeBigInt64BE(entry.seq);
  hash.update(sequence);
  hash.update(normalizeAuditTimestamp(entry.createdAt), "utf8");
  hash.update(entry.action, "utf8");
  updateOptionalBytes(hash, entry.actorPubkey);
  updateOptionalText(hash, entry.objectId);
  hash.update(canonicalJson(entry.detail), "utf8");
  hash.update(entry.prevHash ?? GENESIS_HASH);
  return Uint8Array.from(hash.digest());
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("invalid audit JSON scalar");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key] as JsonValue)}`,
    )
    .join(",")}}`;
}

export function normalizeAuditTimestamp(value: string | Date): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new TypeError("invalid audit timestamp");
    }
    const iso = value.toISOString();
    const fraction = iso.slice(20, 23);
    return `${iso.slice(0, 19)}${fraction === "000" ? "" : `.${fraction}`}+00:00`;
  }
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|\+00:00)$/.exec(
      value,
    );
  if (!match) throw new TypeError("invalid UTC audit timestamp");
  const fraction = (match[2] ?? "").padEnd(9, "0").slice(0, 6);
  const normalizedFraction = /^0{6}$/.test(fraction)
    ? ""
    : fraction.endsWith("000")
      ? `.${fraction.slice(0, 3)}`
      : `.${fraction}`;
  return `${match[1]}${normalizedFraction}+00:00`;
}

function uuidBytes(value: string): Uint8Array {
  const normalized = value.toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      normalized,
    )
  ) {
    throw new TypeError("audit communityId must be a UUID");
  }
  return Uint8Array.from(Buffer.from(normalized.replaceAll("-", ""), "hex"));
}

function updateOptionalBytes(
  hash: ReturnType<typeof createHash>,
  value: Uint8Array | null,
): void {
  hash.update(Uint8Array.of(value === null ? 0 : 1));
  if (value !== null) hash.update(value);
}

function updateOptionalText(
  hash: ReturnType<typeof createHash>,
  value: string | null,
): void {
  hash.update(Uint8Array.of(value === null ? 0 : 1));
  if (value !== null) hash.update(value, "utf8");
}
