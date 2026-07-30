import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import type { NostrEvent } from "@buzz/core";
import { encode } from "blurhash";
import sharp from "sharp";

import { verifyBlossomUploadAuth } from "./auth.js";
import type { MediaConfig } from "./config.js";
import { mediaError } from "./error.js";
import {
  blobKey,
  getSidecar,
  putSidecar,
  thumbKey,
  type MediaStorage,
} from "./storage.js";
import type { BlobDescriptor, BlobMeta, UploadAttribution } from "./types.js";
import { recordUploadEvent } from "./upload-record.js";
import {
  validateFileContent,
  validateImageContent,
  validateVideoFile,
  validateVideoPrefixAndSize,
} from "./validation.js";

type CommonUpload = {
  readonly storage: MediaStorage;
  readonly config: MediaConfig;
  readonly communityId: string;
  readonly communityHost: string;
  readonly authEvent: NostrEvent;
  readonly attribution?: UploadAttribution;
  readonly now?: number;
};

export async function processImageUpload(
  input: CommonUpload & { readonly bytes: Uint8Array },
): Promise<BlobDescriptor> {
  const validated = await validateImageContent(input.bytes, input.config);
  const sha256 = digest(input.bytes);
  verifyBlossomUploadAuth({
    event: input.authEvent,
    maxAgeSeconds: 600,
    ...(input.now === undefined ? {} : { now: input.now }),
    serverHost: input.communityHost,
    sha256,
  });
  const existing = await publishedMeta(input, sha256);
  if (existing) {
    await maybeRecord(input, sha256, existing, input.authEvent.pubkey);
    return descriptor(input.config, sha256, existing);
  }
  const uploadedAt = input.now ?? Math.floor(Date.now() / 1_000);
  const thumbnail = await buildThumbnail(input.bytes);
  const meta: BlobMeta = {
    blurhash: thumbnail.blurhash,
    dim: `${validated.width}x${validated.height}`,
    ext: validated.ext,
    mimeType: validated.mime,
    size: input.bytes.byteLength,
    thumbUrl: `${input.config.publicBaseUrl}/${sha256}.thumb.jpg`,
    uploadedAt,
  };
  await input.storage.put(
    blobKey(sha256, validated.ext),
    input.bytes,
    validated.mime,
  );
  await input.storage.put(thumbKey(sha256), thumbnail.bytes, "image/jpeg");
  await maybeRecord(input, sha256, meta, input.authEvent.pubkey);
  await putSidecar(input.storage, input.communityId, sha256, meta);
  return descriptor(input.config, sha256, meta);
}

export async function processFileUpload(
  input: CommonUpload & { readonly bytes: Uint8Array },
): Promise<BlobDescriptor> {
  const validated = await validateFileContent(input.bytes, input.config);
  const sha256 = digest(input.bytes);
  verifyBlossomUploadAuth({
    event: input.authEvent,
    maxAgeSeconds: 600,
    ...(input.now === undefined ? {} : { now: input.now }),
    serverHost: input.communityHost,
    sha256,
  });
  const existing = await publishedMeta(input, sha256);
  if (existing) {
    await maybeRecord(input, sha256, existing, input.authEvent.pubkey);
    return descriptor(input.config, sha256, existing);
  }
  const meta: BlobMeta = {
    blurhash: "",
    dim: "",
    ext: validated.ext,
    mimeType: validated.mime,
    size: input.bytes.byteLength,
    thumbUrl: "",
    uploadedAt: input.now ?? Math.floor(Date.now() / 1_000),
  };
  await input.storage.put(
    blobKey(sha256, validated.ext),
    input.bytes,
    validated.mime,
  );
  await maybeRecord(input, sha256, meta, input.authEvent.pubkey);
  await putSidecar(input.storage, input.communityId, sha256, meta);
  return descriptor(input.config, sha256, meta);
}

export async function processVideoUpload(
  input: CommonUpload & {
    readonly body: AsyncIterable<Uint8Array>;
    readonly contentLength?: number;
    readonly claimedSha256?: string;
  },
): Promise<BlobDescriptor> {
  if (
    input.contentLength !== undefined &&
    (input.contentLength <= 0 ||
      input.contentLength > input.config.maxVideoBytes)
  ) {
    throw mediaError("FILE_TOO_LARGE");
  }
  const directory = await mkdtemp(join(tmpdir(), "buzz-media-"));
  const path = join(directory, randomBytes(16).toString("hex"));
  const output = createWriteStream(path, {
    flags: "wx",
    mode: 0o600,
  });
  const hash = createHash("sha256");
  let size = 0;
  let prefix = Buffer.alloc(0);
  try {
    for await (const chunk of input.body) {
      size += chunk.byteLength;
      if (size > input.config.maxVideoBytes) {
        output.destroy();
        throw mediaError("FILE_TOO_LARGE");
      }
      hash.update(chunk);
      if (prefix.byteLength < 16_384) {
        prefix = Buffer.concat([
          prefix,
          Buffer.from(chunk.subarray(0, 16_384 - prefix.byteLength)),
        ]);
      }
      if (!output.write(chunk)) await once(output, "drain");
    }
    output.end();
    await once(output, "close");
    await validateVideoPrefixAndSize(prefix, size, input.config);
    const video = await validateVideoFile(path, size, input.config);
    const sha256 = hash.digest("hex");
    if (input.claimedSha256 && input.claimedSha256 !== sha256) {
      throw mediaError("HASH_MISMATCH");
    }
    verifyBlossomUploadAuth({
      event: input.authEvent,
      maxAgeSeconds: 3_600,
      ...(input.now === undefined ? {} : { now: input.now }),
      serverHost: input.communityHost,
      sha256,
    });
    const existing = await publishedMeta(input, sha256);
    if (existing) {
      await maybeRecord(input, sha256, existing, input.authEvent.pubkey);
      return descriptor(input.config, sha256, existing);
    }
    const meta: BlobMeta = {
      blurhash: "",
      dim: `${video.width}x${video.height}`,
      durationSecs: video.durationSecs,
      ext: "mp4",
      mimeType: "video/mp4",
      size,
      thumbUrl: "",
      uploadedAt: input.now ?? Math.floor(Date.now() / 1_000),
    };
    await input.storage.putFile(blobKey(sha256, "mp4"), path, "video/mp4");
    await maybeRecord(input, sha256, meta, input.authEvent.pubkey);
    await putSidecar(input.storage, input.communityId, sha256, meta);
    return descriptor(input.config, sha256, meta);
  } finally {
    output.destroy();
    await rm(directory, { force: true, recursive: true });
  }
}

async function publishedMeta(
  input: CommonUpload,
  sha256: string,
): Promise<BlobMeta | undefined> {
  const meta = await getSidecar(input.storage, input.communityId, sha256);
  if (!meta) return undefined;
  return (await input.storage.head(blobKey(sha256, meta.ext)))
    ? meta
    : undefined;
}

async function maybeRecord(
  input: CommonUpload,
  sha256: string,
  meta: BlobMeta,
  uploaderPubkey: string,
): Promise<void> {
  if (!input.config.uploadRecordsEnabled) return;
  await recordUploadEvent({
    attribution: input.attribution ?? { network: {} },
    communityHost: input.communityHost,
    communityId: input.communityId,
    ext: meta.ext,
    mime: meta.mimeType,
    sha256,
    size: meta.size,
    storage: input.storage,
    uploadedAt: input.now ?? Math.floor(Date.now() / 1_000),
    uploaderPubkey,
  });
}

function descriptor(
  config: MediaConfig,
  sha256: string,
  meta: BlobMeta,
): BlobDescriptor {
  return {
    ...(meta.blurhash ? { blurhash: meta.blurhash } : {}),
    ...(meta.dim ? { dim: meta.dim } : {}),
    ...(meta.durationSecs === undefined ? {} : { duration: meta.durationSecs }),
    sha256,
    size: meta.size,
    ...(meta.thumbUrl ? { thumb: meta.thumbUrl } : {}),
    type: meta.mimeType,
    uploaded: meta.uploadedAt,
    url: `${config.publicBaseUrl}/${blobKey(sha256, meta.ext)}`,
  };
}

async function buildThumbnail(bytes: Uint8Array): Promise<{
  readonly bytes: Uint8Array;
  readonly blurhash: string;
}> {
  const image = sharp(bytes, { animated: false, failOn: "warning" })
    .rotate()
    .resize(320, 320, { fit: "inside", withoutEnlargement: true });
  const thumbnail = await image.clone().jpeg({ quality: 78 }).toBuffer();
  const raw = await image
    .clone()
    .resize(32, 32, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    blurhash: encode(
      new Uint8ClampedArray(
        raw.data.buffer,
        raw.data.byteOffset,
        raw.data.byteLength,
      ),
      raw.info.width,
      raw.info.height,
      4,
      3,
    ),
    bytes: thumbnail,
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
