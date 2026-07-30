import { open, type FileHandle } from "node:fs/promises";

import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";

import type { MediaConfig } from "./config.js";
import { mediaError } from "./error.js";

const IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

const ACTIVE_TEXT = [
  /^\s*<!doctype\s+html/i,
  /^\s*<html[\s>]/i,
  /^\s*<svg[\s>]/i,
  /^\s*<\?xml[\s\S]{0,1024}<svg[\s>]/i,
  /^\s*(?:import\s|export\s|function\s|\(\s*\)\s*=>|javascript:)/i,
];

const BLOCKED_MIME = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/javascript",
  "text/javascript",
  "application/x-msdownload",
  "application/x-executable",
  "application/vnd.microsoft.portable-executable",
  "application/x-mach-binary",
  "application/x-sharedlib",
  "application/x-elf",
  "application/x-msi",
  "application/vnd.android.package-archive",
  "application/x-apple-diskimage",
]);

export type ImageValidation = {
  readonly mime: string;
  readonly ext: string;
  readonly width: number;
  readonly height: number;
};

export type FileValidation = {
  readonly mime: string;
  readonly ext: string;
};

export type VideoValidation = {
  readonly mime: "video/mp4";
  readonly ext: "mp4";
};

export type VideoMetadata = VideoValidation & {
  readonly durationSecs: number;
  readonly hasAudio: boolean;
  readonly height: number;
  readonly width: number;
};

export function looksLikeIsoBmff(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 16) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const compact = view.getUint32(0);
  if (Buffer.from(bytes.subarray(4, 8)).toString("ascii") !== "ftyp") {
    return false;
  }
  if (compact === 1) {
    if (bytes.byteLength < 24) return false;
    const size = view.getBigUint64(8);
    return size >= 24n;
  }
  return compact === 0 || compact >= 16;
}

export async function validateImageContent(
  bytes: Uint8Array,
  config: MediaConfig,
): Promise<ImageValidation> {
  if (bytes.byteLength > config.maxImageBytes) {
    throw mediaError(
      "FILE_TOO_LARGE",
      `image exceeds ${config.maxImageBytes} bytes`,
    );
  }
  if (looksLikeIsoBmff(bytes)) {
    throw mediaError("DISALLOWED_CONTENT_TYPE", "video is not an image");
  }
  const detected = await fileTypeFromBuffer(bytes);
  const ext = detected ? IMAGE_TYPES.get(detected.mime) : undefined;
  if (!detected || !ext) {
    throw mediaError("DISALLOWED_CONTENT_TYPE", "unsupported image format");
  }
  if (detected.mime === "image/gif" && bytes.byteLength > config.maxGifBytes) {
    throw mediaError(
      "FILE_TOO_LARGE",
      `animated image exceeds ${config.maxGifBytes} bytes`,
    );
  }
  validateImageMetadataFree(Buffer.from(bytes), detected.mime);
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(bytes, {
      animated: true,
      failOn: "warning",
      limitInputPixels: 25_000_000,
      sequentialRead: true,
    }).metadata();
  } catch {
    throw mediaError("INVALID_CONTENT", "image cannot be decoded safely");
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (
    width <= 0 ||
    height <= 0 ||
    width * height > 25_000_000 ||
    (metadata.pages ?? 1) > 500
  ) {
    throw mediaError("INVALID_CONTENT", "image dimensions are unsafe");
  }
  // Exact-byte CAS means metadata cannot be stripped after hashing. Reject
  // private/active metadata instead of publishing bytes the uploader did not
  // visibly intend to share.
  if (metadata.exif || metadata.xmp || metadata.iptc || metadata.icc) {
    throw mediaError(
      "INVALID_CONTENT",
      "image contains private metadata; remove metadata before upload",
    );
  }
  return { ext, height, mime: detected.mime, width };
}

export async function validateFileContent(
  bytes: Uint8Array,
  config: MediaConfig,
): Promise<FileValidation> {
  if (bytes.byteLength > config.maxFileBytes) {
    throw mediaError(
      "FILE_TOO_LARGE",
      `file exceeds ${config.maxFileBytes} bytes`,
    );
  }
  if (looksLikeIsoBmff(bytes)) {
    throw mediaError(
      "DISALLOWED_CONTENT_TYPE",
      "ISO-BMFF media must use the video upload path",
    );
  }
  const prefix = Buffer.from(bytes.subarray(0, 16_384)).toString("utf8");
  if (ACTIVE_TEXT.some((pattern) => pattern.test(prefix))) {
    throw mediaError(
      "DISALLOWED_CONTENT_TYPE",
      "active web content cannot be hosted as an attachment",
    );
  }
  const detected = await fileTypeFromBuffer(bytes);
  if (!detected) return { ext: "bin", mime: "application/octet-stream" };
  if (
    detected.mime.startsWith("image/") ||
    detected.mime.startsWith("video/") ||
    detected.mime.startsWith("audio/") ||
    BLOCKED_MIME.has(detected.mime)
  ) {
    throw mediaError(
      "DISALLOWED_CONTENT_TYPE",
      `content type ${detected.mime} is not accepted as a generic file`,
    );
  }
  const ext = /^[A-Za-z0-9]{1,8}$/.test(detected.ext) ? detected.ext : "bin";
  return { ext, mime: detected.mime };
}

export async function validateVideoPrefixAndSize(
  prefix: Uint8Array,
  size: number,
  config: MediaConfig,
): Promise<VideoValidation> {
  if (!Number.isSafeInteger(size) || size <= 0 || size > config.maxVideoBytes) {
    throw mediaError(
      "FILE_TOO_LARGE",
      `video exceeds ${config.maxVideoBytes} bytes`,
    );
  }
  if (!looksLikeIsoBmff(prefix)) {
    throw mediaError(
      "DISALLOWED_CONTENT_TYPE",
      "video must be an MP4 container",
    );
  }
  const detected = await fileTypeFromBuffer(prefix);
  if (detected?.mime !== "video/mp4") {
    throw mediaError("DISALLOWED_CONTENT_TYPE", "unsupported MP4 brand");
  }
  return { ext: "mp4", mime: "video/mp4" };
}

export async function validateVideoFile(
  file: string,
  size: number,
  config: MediaConfig,
): Promise<VideoMetadata> {
  if (!Number.isSafeInteger(size) || size <= 0 || size > config.maxVideoBytes) {
    throw mediaError("FILE_TOO_LARGE");
  }
  const handle = await open(file, "r");
  try {
    const top = await readBoxes(handle, 0, size, 1_024);
    const ftyp = top.find((box) => box.type === "ftyp");
    const moovIndex = top.findIndex((box) => box.type === "moov");
    const mdatIndex = top.findIndex((box) => box.type === "mdat");
    if (!ftyp || moovIndex < 0 || mdatIndex < 0) invalidVideo();
    if (moovIndex > mdatIndex) {
      throw mediaError("INVALID_CONTENT", "video must be fast-start MP4");
    }
    const brand = await readBytes(handle, ftyp.payloadStart, 4);
    if (brand.toString("ascii") === "qt  ") {
      throw mediaError("DISALLOWED_CONTENT_TYPE", "QuickTime MOV is not MP4");
    }
    await validateMp4MetadataFree(handle, size);

    const moov = top[moovIndex] as Mp4Box;
    const moovChildren = await readBoxes(
      handle,
      moov.payloadStart,
      moov.end,
      10_000,
    );
    const tracks = moovChildren.filter((box) => box.type === "trak");
    let video:
      | {
          readonly durationSecs: number;
          readonly height: number;
          readonly width: number;
        }
      | undefined;
    let hasAudio = false;
    for (const track of tracks) {
      const parsed = await parseTrack(handle, track);
      if (parsed.type === "video") {
        if (video) metadataVideoForbidden();
        if (parsed.codec !== "avc1") wrongVideoCodec();
        if (parsed.durationSecs <= 0 || !Number.isFinite(parsed.durationSecs)) {
          invalidVideo();
        }
        if (parsed.durationSecs > 600) {
          throw mediaError(
            "INVALID_CONTENT",
            "video duration exceeds 600 seconds",
          );
        }
        if (
          parsed.width <= 0 ||
          parsed.height <= 0 ||
          parsed.width > 3_840 ||
          parsed.height > 2_160
        ) {
          throw mediaError(
            "INVALID_CONTENT",
            "video resolution exceeds 3840x2160",
          );
        }
        video = parsed;
      } else if (parsed.type === "audio") {
        if (hasAudio) metadataVideoForbidden();
        if (parsed.codec !== "mp4a") wrongVideoCodec();
        hasAudio = true;
      } else {
        metadataVideoForbidden();
      }
    }
    if (!video) {
      throw mediaError(
        "DISALLOWED_CONTENT_TYPE",
        hasAudio ? "audio-only MP4 is not a video" : "MP4 has no video track",
      );
    }
    return {
      durationSecs: video.durationSecs,
      ext: "mp4",
      hasAudio,
      height: video.height,
      mime: "video/mp4",
      width: video.width,
    };
  } finally {
    await handle.close();
  }
}

export function serveInline(mime: string): boolean {
  return mime.startsWith("image/") || mime.startsWith("video/");
}

type Mp4Box = {
  readonly end: number;
  readonly headerSize: number;
  readonly payloadStart: number;
  readonly size: number;
  readonly start: number;
  readonly type: string;
};

const MP4_CONTAINERS = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "edts",
  "dinf",
  "sinf",
  "schi",
]);
const MP4_FORBIDDEN = new Set([
  "meta",
  "ilst",
  "keys",
  "data",
  "uuid",
  "xml ",
  "bxml",
  "loci",
  "©xyz",
  "name",
  "chap",
]);
const MP4_ALLOWED = new Set([
  "ftyp",
  "moov",
  "mdat",
  "free",
  "skip",
  "wide",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "edts",
  "dinf",
  "sinf",
  "schi",
  "udta",
  "mvhd",
  "tkhd",
  "mdhd",
  "hdlr",
  "vmhd",
  "smhd",
  "dref",
  "url ",
  "urn ",
  "stsd",
  "stts",
  "stss",
  "ctts",
  "stsc",
  "stsz",
  "stco",
  "co64",
  "sgpd",
  "sbgp",
  "elst",
]);
const EMPTY_FFMPEG_UDTA = Buffer.from([
  0, 0, 0, 0x35, 0x6d, 0x65, 0x74, 0x61, 0, 0, 0, 0, 0, 0, 0, 0x21, 0x68, 0x64,
  0x6c, 0x72, 0, 0, 0, 0, 0, 0, 0, 0, 0x6d, 0x64, 0x69, 0x72, 0x61, 0x70, 0x70,
  0x6c, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 0x69, 0x6c, 0x73, 0x74,
]);

async function validateMp4MetadataFree(
  handle: FileHandle,
  size: number,
): Promise<void> {
  const state = { boxes: 0 };
  await walkMp4Boxes(handle, 0, size, 0, state);
}

async function walkMp4Boxes(
  handle: FileHandle,
  start: number,
  end: number,
  depth: number,
  state: { boxes: number },
): Promise<void> {
  if (depth > 32) invalidVideo();
  let offset = start;
  while (offset < end) {
    state.boxes += 1;
    if (state.boxes > 100_000) invalidVideo();
    const box = await readBox(handle, offset, end);
    if (MP4_FORBIDDEN.has(box.type) || !MP4_ALLOWED.has(box.type)) {
      metadataVideoForbidden();
    }
    if (box.type === "udta") {
      if (box.size !== box.headerSize + EMPTY_FFMPEG_UDTA.length) {
        metadataVideoForbidden();
      }
      const body = await readBytes(
        handle,
        box.payloadStart,
        EMPTY_FFMPEG_UDTA.length,
      );
      if (!body.equals(EMPTY_FFMPEG_UDTA)) metadataVideoForbidden();
    } else if (MP4_CONTAINERS.has(box.type)) {
      await walkMp4Boxes(handle, box.payloadStart, box.end, depth + 1, state);
    }
    offset = box.end;
  }
  if (offset !== end) invalidVideo();
}

async function parseTrack(
  handle: FileHandle,
  track: Mp4Box,
): Promise<
  | {
      readonly codec: string;
      readonly durationSecs: number;
      readonly height: number;
      readonly type: "video";
      readonly width: number;
    }
  | { readonly codec: string; readonly type: "audio" }
  | { readonly codec: string; readonly type: "other" }
> {
  const trackChildren = await readBoxes(
    handle,
    track.payloadStart,
    track.end,
    1_024,
  );
  const tkhd = trackChildren.find((box) => box.type === "tkhd");
  const mdia = trackChildren.find((box) => box.type === "mdia");
  if (!mdia) invalidVideo();
  const mediaChildren = await readBoxes(
    handle,
    mdia.payloadStart,
    mdia.end,
    1_024,
  );
  const hdlr = mediaChildren.find((box) => box.type === "hdlr");
  const mdhd = mediaChildren.find((box) => box.type === "mdhd");
  const minf = mediaChildren.find((box) => box.type === "minf");
  if (!hdlr || !mdhd || !minf) invalidVideo();
  const handler = (await readBytes(handle, hdlr.payloadStart + 8, 4)).toString(
    "ascii",
  );
  const codec = await trackCodec(handle, minf);
  if (handler === "soun") return { codec, type: "audio" };
  if (handler !== "vide") return { codec, type: "other" };
  if (!tkhd || tkhd.size < tkhd.headerSize + 8) invalidVideo();
  const dimensions = await readBytes(handle, tkhd.end - 8, 8);
  const width = dimensions.readUInt32BE(0) / 65_536;
  const height = dimensions.readUInt32BE(4) / 65_536;
  return {
    codec,
    durationSecs: await mediaDuration(handle, mdhd),
    height,
    type: "video",
    width,
  };
}

async function trackCodec(handle: FileHandle, minf: Mp4Box): Promise<string> {
  const minfChildren = await readBoxes(
    handle,
    minf.payloadStart,
    minf.end,
    1_024,
  );
  const stbl = minfChildren.find((box) => box.type === "stbl");
  if (!stbl) invalidVideo();
  const sampleChildren = await readBoxes(
    handle,
    stbl.payloadStart,
    stbl.end,
    10_000,
  );
  const stsd = sampleChildren.find((box) => box.type === "stsd");
  if (!stsd || stsd.size < stsd.headerSize + 16) invalidVideo();
  const header = await readBytes(handle, stsd.payloadStart, 16);
  const entryCount = header.readUInt32BE(4);
  if (entryCount !== 1) metadataVideoForbidden();
  const entrySize = header.readUInt32BE(8);
  if (entrySize < 8 || stsd.payloadStart + 8 + entrySize > stsd.end) {
    invalidVideo();
  }
  return header.toString("latin1", 12, 16);
}

async function mediaDuration(
  handle: FileHandle,
  mdhd: Mp4Box,
): Promise<number> {
  const prefixLength = Math.min(mdhd.size - mdhd.headerSize, 32);
  const payload = await readBytes(handle, mdhd.payloadStart, prefixLength);
  const version = payload[0];
  let timescale: number;
  let duration: number;
  if (version === 0) {
    if (payload.length < 20) invalidVideo();
    timescale = payload.readUInt32BE(12);
    duration = payload.readUInt32BE(16);
  } else if (version === 1) {
    if (payload.length < 32) invalidVideo();
    timescale = payload.readUInt32BE(20);
    const raw = payload.readBigUInt64BE(24);
    if (raw > BigInt(Number.MAX_SAFE_INTEGER)) invalidVideo();
    duration = Number(raw);
  } else {
    invalidVideo();
  }
  if (timescale === 0) invalidVideo();
  return duration / timescale;
}

async function readBoxes(
  handle: FileHandle,
  start: number,
  end: number,
  maximum: number,
): Promise<Mp4Box[]> {
  const output: Mp4Box[] = [];
  let offset = start;
  while (offset < end) {
    if (output.length >= maximum) invalidVideo();
    const box = await readBox(handle, offset, end);
    output.push(box);
    offset = box.end;
  }
  if (offset !== end) invalidVideo();
  return output;
}

async function readBox(
  handle: FileHandle,
  start: number,
  parentEnd: number,
): Promise<Mp4Box> {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(parentEnd) ||
    start < 0 ||
    parentEnd - start < 8
  ) {
    invalidVideo();
  }
  const header = await readBytes(handle, start, 8);
  const compact = header.readUInt32BE(0);
  const type = header.toString("latin1", 4, 8);
  let size = compact;
  let headerSize = 8;
  if (compact === 1) {
    const extended = (await readBytes(handle, start + 8, 8)).readBigUInt64BE();
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) invalidVideo();
    size = Number(extended);
    headerSize = 16;
  } else if (compact === 0) {
    size = parentEnd - start;
  }
  const end = start + size;
  if (size < headerSize || !Number.isSafeInteger(end) || end > parentEnd) {
    invalidVideo();
  }
  return {
    end,
    headerSize,
    payloadStart: start + headerSize,
    size,
    start,
    type,
  };
}

async function readBytes(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(length) ||
    position < 0 ||
    length < 0 ||
    length > 1024 * 1024
  ) {
    invalidVideo();
  }
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) invalidVideo();
  return buffer;
}

function invalidVideo(): never {
  throw mediaError("INVALID_CONTENT", "video container is malformed");
}

function metadataVideoForbidden(): never {
  throw mediaError(
    "INVALID_CONTENT",
    "video contains private metadata or a non-canonical metadata channel",
  );
}

function wrongVideoCodec(): never {
  throw mediaError(
    "DISALLOWED_CONTENT_TYPE",
    "video must use H.264 with optional AAC audio",
  );
}

/**
 * Fail-closed structural metadata allowlist. Exact-byte CAS prevents server-side
 * scrubbing after hashing, so clients must upload canonicalized media.
 */
export function validateImageMetadataFree(bytes: Buffer, mime: string): void {
  switch (mime) {
    case "image/jpeg":
      validateJpegMetadataFree(bytes);
      return;
    case "image/png":
      validatePngMetadataFree(bytes);
      return;
    case "image/webp":
      validateWebpMetadataFree(bytes);
      return;
    case "image/gif":
      validateGifMetadataFree(bytes);
      return;
  }
}

function validateJpegMetadataFree(bytes: Buffer): void {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) invalidImage();
  let offset = 2;
  let inScan = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      if (inScan) {
        offset += 1;
        continue;
      }
      invalidImage();
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) invalidImage();
    const marker = bytes[offset] as number;
    offset += 1;
    if (inScan && marker === 0x00) continue;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (marker === 0xd9) {
      if (offset !== bytes.length) metadataForbidden();
      return;
    }
    if (marker === 0xd8 || offset + 2 > bytes.length) invalidImage();
    const length = bytes.readUInt16BE(offset);
    if (length < 2) invalidImage();
    const end = offset + length;
    if (end > bytes.length) invalidImage();
    const payload = bytes.subarray(offset + 2, end);
    if (marker === 0xe0) {
      const canonicalJfif =
        payload.length >= 14 &&
        payload.subarray(0, 5).equals(Buffer.from("JFIF\0", "binary")) &&
        payload.length ===
          14 + 3 * (payload[12] as number) * (payload[13] as number);
      if (!canonicalJfif) metadataForbidden();
    } else if (marker === 0xee) {
      if (
        payload.length !== 12 ||
        !payload.subarray(0, 5).equals(Buffer.from("Adobe", "ascii"))
      ) {
        metadataForbidden();
      }
    } else if (
      (marker >= 0xe1 && marker <= 0xed) ||
      marker === 0xef ||
      marker === 0xfe
    ) {
      metadataForbidden();
    }
    offset = end;
    inScan = marker === 0xda;
  }
  invalidImage();
}

function validatePngMetadataFree(bytes: Buffer): void {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (!bytes.subarray(0, 8).equals(signature)) invalidImage();
  let offset = signature.length;
  let sawEnd = false;
  let sawSnapshot = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalidImage();
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) invalidImage();
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (kind === "tEXt") {
      const payload = bytes.subarray(offset + 8, end - 4);
      if (sawSnapshot || !isSnapshotTextChunk(payload)) metadataForbidden();
      sawSnapshot = true;
      offset = end;
      continue;
    }
    if (["eXIf", "zTXt", "iTXt", "iCCP"].includes(kind)) {
      metadataForbidden();
    }
    const ancillary = ((bytes[offset + 4] as number) & 0x20) !== 0;
    const knownRendering = new Set([
      "cHRM",
      "gAMA",
      "sBIT",
      "sRGB",
      "bKGD",
      "hIST",
      "tRNS",
      "sPLT",
      "acTL",
      "fcTL",
      "fdAT",
    ]);
    if (ancillary && !knownRendering.has(kind)) metadataForbidden();
    offset = end;
    if (kind === "IEND") {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd || offset !== bytes.length) metadataForbidden();
}

function isSnapshotTextChunk(payload: Buffer): boolean {
  for (const keyword of ["buzz_agent_snapshot", "buzz_team_snapshot"]) {
    const prefix = Buffer.from(keyword, "ascii");
    if (
      payload.length > prefix.length &&
      payload.subarray(0, prefix.length).equals(prefix) &&
      payload[prefix.length] === 0
    ) {
      return true;
    }
  }
  return false;
}

function validateWebpMetadataFree(bytes: Buffer): void {
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    invalidImage();
  }
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) metadataForbidden();
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) invalidImage();
    const kind = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const end = payloadStart + length + (length & 1);
    if (!Number.isSafeInteger(end) || end > bytes.length) invalidImage();
    if (!["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF"].includes(kind)) {
      metadataForbidden();
    }
    if (kind === "VP8X") {
      const flags = bytes[payloadStart];
      if (flags === undefined) invalidImage();
      if ((flags & (0x20 | 0x08 | 0x04)) !== 0) metadataForbidden();
    } else if (kind === "ANMF") {
      validateWebpFrame(bytes.subarray(payloadStart, payloadStart + length));
    }
    offset = end;
  }
}

function validateWebpFrame(payload: Buffer): void {
  if (payload.length < 16) invalidImage();
  let offset = 16;
  let sawAlpha = false;
  let sawImage = false;
  while (offset < payload.length) {
    if (offset + 8 > payload.length) invalidImage();
    const kind = payload.toString("ascii", offset, offset + 4);
    const length = payload.readUInt32LE(offset + 4);
    const end = offset + 8 + length + (length & 1);
    if (!Number.isSafeInteger(end) || end > payload.length) invalidImage();
    if (kind === "ALPH" && !sawAlpha && !sawImage) {
      sawAlpha = true;
    } else if (kind === "VP8 " && !sawImage) {
      sawImage = true;
    } else if (kind === "VP8L" && !sawAlpha && !sawImage) {
      sawImage = true;
    } else if (["ALPH", "VP8 ", "VP8L"].includes(kind)) {
      invalidImage();
    } else {
      metadataForbidden();
    }
    offset = end;
  }
  if (!sawImage) invalidImage();
}

function validateGifMetadataFree(bytes: Buffer): void {
  const header = bytes.toString("ascii", 0, 6);
  if ((header !== "GIF87a" && header !== "GIF89a") || bytes.length < 13) {
    invalidImage();
  }
  let offset = 13;
  const packed = bytes[10] as number;
  if ((packed & 0x80) !== 0) {
    offset += 3 << ((packed & 0x07) + 1);
    if (offset > bytes.length) invalidImage();
  }
  while (true) {
    const introducer = bytes[offset];
    if (introducer === undefined) invalidImage();
    if (introducer === 0x2c) {
      if (offset + 10 > bytes.length) invalidImage();
      const imagePacked = bytes[offset + 9] as number;
      offset += 10;
      if ((imagePacked & 0x80) !== 0) {
        offset += 3 << ((imagePacked & 0x07) + 1);
        if (offset > bytes.length) invalidImage();
      }
      offset += 1;
      if (offset > bytes.length) invalidImage();
      offset = skipGifSubBlocks(bytes, offset);
      continue;
    }
    if (introducer === 0x21) {
      const label = bytes[offset + 1];
      if (label === undefined) invalidImage();
      offset += 2;
      if (label === 0xf9) {
        if (
          bytes[offset] !== 4 ||
          offset + 6 > bytes.length ||
          bytes[offset + 5] !== 0
        ) {
          invalidImage();
        }
        offset += 6;
      } else if (label === 0xff) {
        if (bytes[offset] !== 11 || offset + 12 > bytes.length) invalidImage();
        const application = bytes.toString("ascii", offset + 1, offset + 12);
        if (application !== "NETSCAPE2.0" && application !== "ANIMEXTS1.0") {
          metadataForbidden();
        }
        offset += 12;
        if (
          bytes[offset] !== 3 ||
          bytes[offset + 1] !== 1 ||
          bytes[offset + 4] !== 0
        ) {
          metadataForbidden();
        }
        offset += 5;
      } else {
        metadataForbidden();
      }
      continue;
    }
    if (introducer === 0x3b) {
      if (offset + 1 !== bytes.length) metadataForbidden();
      return;
    }
    invalidImage();
  }
}

function skipGifSubBlocks(bytes: Buffer, start: number): number {
  let offset = start;
  while (true) {
    const length = bytes[offset];
    if (length === undefined) invalidImage();
    offset += 1;
    if (length === 0) return offset;
    offset += length;
    if (offset > bytes.length) invalidImage();
  }
}

function invalidImage(): never {
  throw mediaError("INVALID_CONTENT", "image container is malformed");
}

function metadataForbidden(): never {
  throw mediaError(
    "INVALID_CONTENT",
    "image contains private metadata or a non-canonical metadata channel",
  );
}
