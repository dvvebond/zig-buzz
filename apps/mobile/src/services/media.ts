import type { NostrTag } from "@buzz/core";
import * as FileSystem from "expo-file-system/legacy";
import { finalizeEvent } from "nostr-tools/pure";

import { relayHttpOrigin } from "./mobile-relay";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export type PendingMedia = {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size?: number;
};

export type UploadedMedia = {
  readonly url: string;
  readonly sha256: string;
  readonly mimeType: string;
  readonly size: number;
  readonly dimensions?: readonly [number, number];
  readonly blurhash?: string;
  readonly alt?: string;
};

export async function uploadMedia(input: {
  readonly channelId: string;
  readonly relayUrl: string;
  readonly secretKey: Uint8Array;
  readonly media: PendingMedia;
  readonly alt?: string;
}): Promise<UploadedMedia> {
  if (
    input.media.size !== undefined &&
    (!Number.isSafeInteger(input.media.size) ||
      input.media.size < 0 ||
      input.media.size > MAX_UPLOAD_BYTES)
  ) {
    throw new RangeError("attachment exceeds the 100 MiB upload limit");
  }
  const origin = relayHttpOrigin(input.relayUrl);
  const auth = finalizeEvent(
    {
      content: "Upload media",
      created_at: Math.floor(Date.now() / 1_000),
      kind: 24_242,
      tags: [
        ["t", "upload"],
        ["h", input.channelId],
        ["expiration", String(Math.floor(Date.now() / 1_000) + 300)],
      ],
    },
    input.secretKey,
  );
  const response = await FileSystem.uploadAsync(
    `${origin}/upload`,
    input.media.uri,
    {
      fieldName: "file",
      headers: {
        Authorization: `Nostr ${encodeBase64(JSON.stringify(auth))}`,
      },
      httpMethod: "POST",
      mimeType: input.media.mimeType,
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`media upload failed (${response.status})`);
  }
  const payload = parseDescriptor(response.body);
  return {
    ...payload,
    ...(input.alt?.trim() ? { alt: input.alt.trim().slice(0, 1_024) } : {}),
  };
}

export function mediaTags(
  media: readonly UploadedMedia[],
): readonly NostrTag[] {
  return media.map((item) => [
    "imeta",
    `url ${item.url}`,
    `m ${item.mimeType}`,
    `x ${item.sha256}`,
    `size ${item.size}`,
    ...(item.dimensions
      ? [`dim ${item.dimensions[0]}x${item.dimensions[1]}`]
      : []),
    ...(item.blurhash ? [`blurhash ${item.blurhash}`] : []),
    ...(item.alt ? [`alt ${item.alt}`] : []),
  ]);
}

function parseDescriptor(raw: string): UploadedMedia {
  if (raw.length > 64 * 1024) throw new Error("upload response is too large");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("upload response is invalid JSON");
  }
  if (!isRecord(value)) throw new Error("upload response is invalid");
  const url = safeHttpsUrl(value.url);
  const sha256 =
    typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256)
      ? value.sha256
      : undefined;
  const mimeType =
    typeof value.type === "string"
      ? value.type
      : typeof value.mime_type === "string"
        ? value.mime_type
        : undefined;
  const size =
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    value.size <= MAX_UPLOAD_BYTES
      ? value.size
      : undefined;
  if (!url || !sha256 || !mimeType || size === undefined) {
    throw new Error("upload response descriptor is incomplete");
  }
  const dimensions = parseDimensions(value.dimensions ?? value.dim);
  return {
    mimeType,
    sha256,
    size,
    url,
    ...(dimensions === undefined ? {} : { dimensions }),
    ...(typeof value.blurhash === "string" && value.blurhash.length <= 256
      ? { blurhash: value.blurhash }
      : {}),
  };
}

function parseDimensions(
  value: unknown,
): readonly [number, number] | undefined {
  const parts =
    typeof value === "string"
      ? value.split("x").map(Number)
      : Array.isArray(value)
        ? value.map(Number)
        : [];
  const width = parts[0];
  const height = parts[1];
  return Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    (width ?? 0) > 0 &&
    (height ?? 0) > 0
    ? [width as number, height as number]
    : undefined;
}

function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && __DEV__)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
