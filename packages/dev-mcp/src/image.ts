import { readFile } from "node:fs/promises";
import { Jimp } from "jimp";
import {
  object,
  optionalInteger,
  optionalString,
  resolvePath,
  string,
} from "./files.js";

const MAX_SOURCE = 20 * 1024 * 1024;
const MAX_WIRE = 3 * 1024 * 1024;
const MAX_PIXELS = 64 * 1024 * 1024;

interface ImageInfo {
  readonly width: number;
  readonly height: number;
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
  readonly resizable: boolean;
}

export async function viewImageTool(args: unknown): Promise<{
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}> {
  const value = object(args);
  const source = string(value.source ?? value.path, "source");
  const maxDim = optionalInteger(value.max_dim, 1_568, 64, 2_048);
  let bytes: Buffer;
  if (source.startsWith("data:")) bytes = decodeDataUrl(source);
  else if (/^https?:\/\//.test(source)) bytes = await fetchImage(source);
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    throw new Error("unsupported URL scheme");
  } else {
    bytes = await readFile(resolvePath(source, optionalString(value.workdir)));
  }
  if (bytes.byteLength > MAX_SOURCE)
    throw new Error("image source exceeds 20 MiB");
  const info = inspectImage(bytes);
  if (
    !Number.isSafeInteger(info.width * info.height) ||
    info.width * info.height > MAX_PIXELS
  ) {
    throw new Error("image dimensions exceed 64 megapixels");
  }
  let output = bytes;
  let mimeType: "image/jpeg" | "image/png" | "image/webp" = info.mimeType;
  if (
    info.width > maxDim ||
    info.height > maxDim ||
    output.byteLength > MAX_WIRE
  ) {
    if (!info.resizable) {
      throw new Error("WebP images that require resizing are not supported");
    }
    const image = await Jimp.fromBuffer(bytes);
    const scale = Math.min(maxDim / info.width, maxDim / info.height, 1);
    image.resize({
      w: Math.max(1, Math.floor(info.width * scale)),
      h: Math.max(1, Math.floor(info.height * scale)),
    });
    const hasAlpha = image.hasAlpha();
    output = hasAlpha
      ? await image.getBuffer("image/png", { compressionLevel: 9 })
      : await image.getBuffer("image/jpeg", { quality: 85 });
    mimeType = hasAlpha ? "image/png" : "image/jpeg";
  }
  if (output.byteLength > MAX_WIRE)
    throw new Error("processed image exceeds 3 MiB");
  return { type: "image", data: output.toString("base64"), mimeType };
}

function inspectImage(bytes: Buffer): ImageInfo {
  if (
    bytes.byteLength >= 24 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    if (bytes.toString("ascii", 12, 16) !== "IHDR")
      throw new Error("invalid PNG image");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (containsPngChunk(bytes, "acTL"))
      throw new Error("animated images are not supported");
    return dimensions(width, height, "image/png", true);
  }
  if (bytes.byteLength >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return inspectJpeg(bytes);
  }
  if (
    bytes.byteLength >= 10 &&
    (bytes.toString("ascii", 0, 6) === "GIF87a" ||
      bytes.toString("ascii", 0, 6) === "GIF89a")
  ) {
    throw new Error("animated images are not supported");
  }
  if (
    bytes.byteLength >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return inspectWebp(bytes);
  }
  throw new Error("unsupported image format; use PNG, JPEG, or WebP");
}

function containsPngChunk(bytes: Buffer, wanted: string): boolean {
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.byteLength)
      throw new Error("invalid PNG chunk");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === wanted) return true;
    if (type === "IEND") return false;
    offset = end;
  }
  throw new Error("truncated PNG image");
}

function inspectJpeg(bytes: Buffer): ImageInfo {
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (marker === 0xda) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.byteLength)
      throw new Error("invalid JPEG segment");
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (length < 7) throw new Error("invalid JPEG dimensions");
      return dimensions(
        bytes.readUInt16BE(offset + 5),
        bytes.readUInt16BE(offset + 3),
        "image/jpeg",
        true,
      );
    }
    offset += length;
  }
  throw new Error("JPEG image has no dimensions");
}

function inspectWebp(bytes: Buffer): ImageInfo {
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    const flags = bytes[20] ?? 0;
    if ((flags & 0x02) !== 0)
      throw new Error("animated images are not supported");
    return dimensions(
      1 + readUInt24LE(bytes, 24),
      1 + readUInt24LE(bytes, 27),
      "image/webp",
      false,
    );
  }
  if (chunk === "VP8 " && bytes.byteLength >= 30) {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      throw new Error("invalid WebP frame");
    }
    return dimensions(
      bytes.readUInt16LE(26) & 0x3fff,
      bytes.readUInt16LE(28) & 0x3fff,
      "image/webp",
      false,
    );
  }
  if (chunk === "VP8L" && bytes.byteLength >= 25 && bytes[20] === 0x2f) {
    const b1 = bytes[21] ?? 0;
    const b2 = bytes[22] ?? 0;
    const b3 = bytes[23] ?? 0;
    const b4 = bytes[24] ?? 0;
    return dimensions(
      1 + b1 + ((b2 & 0x3f) << 8),
      1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
      "image/webp",
      false,
    );
  }
  throw new Error("unsupported WebP encoding");
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  );
}

function dimensions(
  width: number,
  height: number,
  mimeType: ImageInfo["mimeType"],
  resizable: boolean,
): ImageInfo {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height))
    throw new Error("invalid image dimensions");
  if (width < 1 || height < 1) throw new Error("invalid image dimensions");
  return { width, height, mimeType, resizable };
}

async function fetchImage(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("unsupported URL");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(parsed, {
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "image/*" },
    });
    if (!response.ok)
      throw new Error(`image fetch returned ${response.status}`);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_SOURCE)
      throw new Error("image too large");
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function decodeDataUrl(value: string): Buffer {
  const match =
    /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(
      value,
    );
  if (!match?.[1]) throw new Error("invalid image data URL");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.toString("base64") !== match[1])
    throw new Error("non-canonical base64");
  return bytes;
}
