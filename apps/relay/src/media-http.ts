import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RelayAccessPolicy } from "@buzz/db";
import {
  getSidecar,
  mediaError,
  parseBlossomAuthorization,
  parsePort,
  parsePublicIp,
  processFileUpload,
  processImageUpload,
  processVideoUpload,
  serveInline,
  thumbKey,
  validateMediaConfig,
  verifyBlossomGetAuth,
  verifyBlossomUploadAuth,
  blobKey,
  type MediaConfig,
  type MediaStorage,
  type UploadAttribution,
  MediaError,
} from "@buzz/media";
import type { Pool } from "pg";

const SHA = /^[0-9a-f]{64}$/;
const SAFE_EXT = /^[a-z0-9]{1,8}$/;
const MAX_RANGE_CHUNK = 16 * 1024 * 1024;

export type RelayMediaOptions = {
  readonly storage: MediaStorage;
  readonly config: MediaConfig;
  readonly communityId: string;
  readonly requireGetAuth?: boolean;
  readonly pool?: Pool;
  readonly maxConcurrentUploads?: number;
  readonly maxConcurrentUploadsPerPubkey?: number;
  readonly uploadsPerMinute?: number;
};

export class MediaUploadGate {
  #active = 0;
  readonly #perIdentity = new Map<string, number>();
  readonly #windows = new Map<
    string,
    { readonly startedAt: number; count: number }
  >();

  public constructor(
    private readonly maximum: number,
    private readonly maximumPerIdentity: number,
    private readonly perMinute: number,
  ) {}

  public acquire(identity: string, now = Date.now()): () => void {
    const window = this.#windows.get(identity);
    if (!window || now - window.startedAt >= 60_000) {
      this.#windows.set(identity, { count: 1, startedAt: now });
    } else {
      if (window.count >= this.perMinute) {
        throw new MediaError(
          "STORAGE_ERROR",
          "upload rate limit exceeded",
          429,
        );
      }
      window.count += 1;
    }
    const active = this.#perIdentity.get(identity) ?? 0;
    if (this.#active >= this.maximum || active >= this.maximumPerIdentity) {
      throw new MediaError(
        "STORAGE_ERROR",
        "upload concurrency limit reached",
        429,
      );
    }
    this.#active += 1;
    this.#perIdentity.set(identity, active + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      const current = this.#perIdentity.get(identity) ?? 1;
      if (current <= 1) this.#perIdentity.delete(identity);
      else this.#perIdentity.set(identity, current - 1);
    };
  }
}

export async function handleMediaHttp(
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    readonly accessPolicy: RelayAccessPolicy;
    readonly community: string;
    readonly media: RelayMediaOptions;
    readonly gate: MediaUploadGate;
  },
): Promise<boolean> {
  const pathname = new URL(request.url ?? "/", "http://relay.invalid").pathname;
  if (
    request.method === "PUT" &&
    (pathname === "/upload" || pathname === "/media/upload")
  ) {
    await upload(request, response, input, pathname === "/media/upload");
    return true;
  }
  const match = /^\/media\/([^/]+)$/.exec(pathname);
  if (match?.[1] && (request.method === "GET" || request.method === "HEAD")) {
    await read(request, response, input, match[1]);
    return true;
  }
  return false;
}

async function upload(
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    readonly accessPolicy: RelayAccessPolicy;
    readonly community: string;
    readonly media: RelayMediaOptions;
    readonly gate: MediaUploadGate;
  },
  legacyImageOnly: boolean,
): Promise<void> {
  let release: (() => void) | undefined;
  try {
    const config = validateMediaConfig(input.media.config);
    const authEvent = parseBlossomAuthorization(request.headers.authorization);
    const claimedHash = singleHeader(request, "x-sha-256");
    if (!SHA.test(claimedHash)) throw mediaError("HASH_MISMATCH");
    verifyBlossomUploadAuth({
      event: authEvent,
      maxAgeSeconds: 3_600,
      serverHost: input.community,
      sha256: claimedHash,
    });
    if (
      !(await input.accessPolicy.canConnect(input.community, authEvent.pubkey))
    ) {
      throw mediaError("AUTHENTICATION_FAILED");
    }
    release = input.gate.acquire(authEvent.pubkey);
    const contentLength = parseContentLength(request.headers["content-length"]);
    const replay = sniffAndReplay(request, 4_096);
    const first = await replay.next();
    if (first.done) throw mediaError("INVALID_CONTENT", "empty upload");
    const prefix = first.value.prefix;
    const stream = first.value.stream;
    const attribution = await resolveAttribution(
      request,
      input.media,
      authEvent.pubkey,
    );
    const common = {
      ...(attribution ? { attribution } : {}),
      authEvent,
      communityHost: input.community,
      communityId: input.media.communityId,
      config,
      storage: input.media.storage,
    };
    let descriptor;
    if (looksLikeVideo(prefix)) {
      if (legacyImageOnly) {
        throw mediaError(
          "DISALLOWED_CONTENT_TYPE",
          "legacy media upload accepts images only",
        );
      }
      descriptor = await processVideoUpload({
        ...common,
        body: stream,
        claimedSha256: claimedHash,
        ...(contentLength === undefined ? {} : { contentLength }),
      });
    } else {
      const maximum = Math.max(config.maxImageBytes, config.maxFileBytes);
      const bytes = await collectBounded(stream, maximum);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== claimedHash) throw mediaError("HASH_MISMATCH");
      const image = looksLikeImage(bytes);
      if (legacyImageOnly && !image) {
        throw mediaError(
          "DISALLOWED_CONTENT_TYPE",
          "legacy media upload accepts images only",
        );
      }
      descriptor = image
        ? await processImageUpload({ ...common, bytes })
        : await processFileUpload({ ...common, bytes });
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify(descriptor));
  } catch (error) {
    writeMediaError(response, error);
  } finally {
    release?.();
  }
}

async function read(
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    readonly accessPolicy: RelayAccessPolicy;
    readonly community: string;
    readonly media: RelayMediaOptions;
  },
  requested: string,
): Promise<void> {
  try {
    const parsed = parseMediaPath(requested);
    const meta = await getSidecar(
      input.media.storage,
      input.media.communityId,
      parsed.sha256,
    );
    if (!meta) throw mediaError("NOT_FOUND");
    if (input.media.requireGetAuth) {
      const event = parseBlossomAuthorization(request.headers.authorization);
      verifyBlossomGetAuth({
        event,
        maxAgeSeconds: 3_600,
        serverHost: input.community,
        sha256: parsed.sha256,
      });
      if (
        !(await input.accessPolicy.canConnect(input.community, event.pubkey))
      ) {
        throw mediaError("AUTHENTICATION_FAILED");
      }
    }
    if (!parsed.thumbnail && parsed.ext && parsed.ext !== meta.ext) {
      throw mediaError("NOT_FOUND");
    }
    const key = parsed.thumbnail
      ? thumbKey(parsed.sha256)
      : blobKey(parsed.sha256, meta.ext);
    const head = await input.media.storage.head(key);
    if (!head) throw mediaError("NOT_FOUND");
    const mime = parsed.thumbnail ? "image/jpeg" : meta.mimeType;
    const disposition = serveInline(mime) ? "inline" : "attachment";
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader(
      "Cache-Control",
      input.media.requireGetAuth
        ? "private, max-age=31536000, immutable"
        : "public, max-age=31536000, immutable",
    );
    response.setHeader("Content-Disposition", disposition);
    response.setHeader("Content-Security-Policy", "default-src 'none'");
    response.setHeader("Content-Type", mime);
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method === "HEAD") {
      response.statusCode = 200;
      response.setHeader("Content-Length", String(head.size));
      response.end();
      return;
    }
    const range = parseRange(request.headers.range, head.size);
    if (range === null) {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${head.size}`);
      response.end();
      return;
    }
    if (range) {
      const end = Math.min(
        range.end,
        range.start + MAX_RANGE_CHUNK - 1,
        head.size - 1,
      );
      const object = await input.media.storage.get(key, {
        end,
        start: range.start,
      });
      response.statusCode = 206;
      response.setHeader("Content-Length", String(object.bytes.byteLength));
      response.setHeader(
        "Content-Range",
        `bytes ${range.start}-${end}/${head.size}`,
      );
      response.end(object.bytes);
      return;
    }
    const object = await input.media.storage.get(key);
    response.statusCode = 200;
    response.setHeader("Content-Length", String(object.bytes.byteLength));
    response.end(object.bytes);
  } catch (error) {
    writeMediaError(response, error);
  }
}

async function* sniffAndReplay(
  source: AsyncIterable<Uint8Array>,
  maximum: number,
): AsyncGenerator<{
  readonly prefix: Uint8Array;
  readonly stream: AsyncIterable<Uint8Array>;
}> {
  const iterator = source[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < maximum) {
    const item = await iterator.next();
    if (item.done) break;
    chunks.push(item.value);
    length += item.value.byteLength;
  }
  const prefix = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
  ).subarray(0, maximum);
  async function* replay(): AsyncGenerator<Uint8Array> {
    yield* chunks;
    while (true) {
      const item = await iterator.next();
      if (item.done) return;
      yield item.value;
    }
  }
  yield { prefix, stream: replay() };
}

async function collectBounded(
  stream: AsyncIterable<Uint8Array>,
  maximum: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > maximum) throw mediaError("FILE_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function looksLikeImage(bytes: Uint8Array): boolean {
  const prefix = Buffer.from(bytes.subarray(0, 16));
  return (
    prefix.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    prefix.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "latin1")) ||
    prefix
      .subarray(0, 6)
      .toString("ascii")
      .match(/^GIF8[79]a$/) !== null ||
    (prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
      prefix.subarray(8, 12).toString("ascii") === "WEBP")
  );
}

function looksLikeVideo(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 16 &&
    Buffer.from(bytes.subarray(4, 8)).toString("ascii") === "ftyp"
  );
}

function parseMediaPath(value: string): {
  readonly sha256: string;
  readonly ext?: string;
  readonly thumbnail: boolean;
} {
  const thumb = /^([0-9a-f]{64})\.thumb\.jpg$/.exec(value);
  if (thumb?.[1]) return { sha256: thumb[1], thumbnail: true };
  const blob = /^([0-9a-f]{64})(?:\.([a-z0-9]{1,8}))?$/.exec(value);
  if (!blob?.[1] || (blob[2] && !SAFE_EXT.test(blob[2]))) {
    throw mediaError("NOT_FOUND");
  }
  return {
    ...(blob[2] ? { ext: blob[2] } : {}),
    sha256: blob[1],
    thumbnail: false,
  };
}

function parseRange(
  value: string | undefined,
  total: number,
): { readonly start: number; readonly end: number } | null | undefined {
  if (!value) return undefined;
  if (value.includes(",")) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { end: total - 1, start: Math.max(0, total - suffix) };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : total - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    requestedEnd < start ||
    start >= total
  ) {
    return null;
  }
  return { end: Math.min(requestedEnd, total - 1), start };
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) throw mediaError("FILE_TOO_LARGE");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw mediaError("FILE_TOO_LARGE");
  }
  return parsed;
}

function singleHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value) {
    throw mediaError("AUTHENTICATION_FAILED");
  }
  return value;
}

async function resolveAttribution(
  request: IncomingMessage,
  media: RelayMediaOptions,
  pubkey: string,
): Promise<UploadAttribution | undefined> {
  if (!media.config.uploadRecordsEnabled) return undefined;
  let uploaderName: string | undefined;
  if (media.pool) {
    const result = await media.pool.query<{
      readonly display_name: string | null;
    }>(
      `SELECT u.display_name
       FROM users u
       WHERE u.community_id = $1
         AND u.pubkey = decode($2, 'hex')
       LIMIT 1`,
      [media.communityId, pubkey],
    );
    uploaderName = result.rows[0]?.display_name?.trim() || undefined;
  }
  const ipHeader = media.config.uploadIpHeader
    ? request.headers[media.config.uploadIpHeader]
    : undefined;
  const portHeader = media.config.uploadPortHeader
    ? request.headers[media.config.uploadPortHeader]
    : undefined;
  const ip = typeof ipHeader === "string" ? parsePublicIp(ipHeader) : undefined;
  const port =
    ip && typeof portHeader === "string" ? parsePort(portHeader) : undefined;
  return {
    network: {
      ...(ip ? { ip } : {}),
      ...(port ? { port } : {}),
    },
    ...(uploaderName ? { uploaderName } : {}),
  };
}

function writeMediaError(response: ServerResponse, error: unknown): void {
  const media =
    error instanceof MediaError
      ? error
      : mediaError("STORAGE_ERROR", "media request failed");
  response.statusCode = media.status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(
    JSON.stringify({
      error:
        media.status === 401
          ? "authentication failed"
          : media.status === 404
            ? "not found"
            : media.message,
    }),
  );
}
