import { isIP } from "node:net";

import { nip19 } from "nostr-tools";
import { ulid } from "ulid";

import type { MediaStorage } from "./storage.js";
import type { UploadAttribution, UploadRecord } from "./types.js";

export const UPLOAD_RECORD_VERSION = 1 as const;

export function uploadRecordKey(
  communityId: string,
  sha256: string,
  eventId: string,
): string {
  return `_uploads/${communityId}/${sha256}/${eventId}.json`;
}

export async function recordUploadEvent(input: {
  readonly storage: MediaStorage;
  readonly communityId: string;
  readonly communityHost: string;
  readonly uploaderPubkey: string;
  readonly attribution: UploadAttribution;
  readonly sha256: string;
  readonly ext: string;
  readonly mime: string;
  readonly size: number;
  readonly uploadedAt: number;
}): Promise<UploadRecord> {
  const eventId = ulid();
  const ip = parsePublicIp(input.attribution.network.ip ?? "");
  const port = ip
    ? parsePort(String(input.attribution.network.port ?? ""))
    : undefined;
  const record: UploadRecord = {
    communityHost: input.communityHost,
    communityId: input.communityId,
    eventId,
    ext: input.ext,
    ...(ip ? { ip } : {}),
    mimeType: input.mime,
    ...(port ? { port } : {}),
    sha256: input.sha256,
    size: input.size,
    uploadedAt: input.uploadedAt,
    uploaderId: input.uploaderPubkey,
    ...(input.attribution.uploaderName
      ? { uploaderName: input.attribution.uploaderName.slice(0, 256) }
      : {}),
    uploaderNpub: nip19.npubEncode(input.uploaderPubkey),
    version: UPLOAD_RECORD_VERSION,
  };
  await input.storage.put(
    uploadRecordKey(input.communityId, input.sha256, eventId),
    Buffer.from(JSON.stringify(record)),
    "application/json",
  );
  return record;
}

export function parsePort(raw: string): number | undefined {
  if (!/^[0-9]{1,5}$/.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  return Number.isInteger(value) && value > 0 && value <= 65_535
    ? value
    : undefined;
}

export function parsePublicIp(raw: string): string | undefined {
  const value = raw.trim();
  const family = isIP(value);
  if (family === 4) {
    const octets = value.split(".").map(Number);
    const [a = 0, b = 0, c = 0] = octets;
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    ) {
      return undefined;
    }
    return value;
  }
  if (family === 6) {
    const lower = value.toLowerCase();
    if (
      lower === "::" ||
      lower === "::1" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      /^fe[89ab]/.test(lower) ||
      lower.startsWith("ff") ||
      lower.startsWith("2001:db8:") ||
      lower.startsWith("2001:") ||
      lower.startsWith("100:")
    ) {
      return undefined;
    }
    return value;
  }
  return undefined;
}
