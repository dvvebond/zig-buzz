import type { NostrTag } from "@buzz/core";

export type ParsedMedia = {
  readonly url: string;
  readonly mimeType?: string;
  readonly kind: "image" | "video" | "file";
  readonly blurhash?: string;
  readonly alt?: string;
  readonly posterUrl?: string;
  readonly aspectRatio?: number;
};

const IMAGE_EXTENSIONS = /\.(?:avif|bmp|heic|heif|jpe?g|png|webp)$/i;

export function parseMediaTags(
  tags: readonly NostrTag[],
): readonly ParsedMedia[] {
  const byUrl = new Map<string, ParsedMedia>();
  for (const tag of tags) {
    if (tag[0] !== "imeta") continue;
    const parsed = parseImeta(tag);
    if (parsed) byUrl.set(parsed.url, parsed);
  }
  return [...byUrl.values()];
}

export function parseImeta(tag: NostrTag): ParsedMedia | undefined {
  if (tag[0] !== "imeta") return undefined;
  const parts = new Map<string, string>();
  for (const value of tag.slice(1)) {
    const separator = value.indexOf(" ");
    if (separator <= 0) continue;
    const key = value.slice(0, separator);
    if (!parts.has(key)) parts.set(key, value.slice(separator + 1));
  }
  const url = safeMediaUrl(parts.get("url"));
  if (!url) return undefined;
  const mimeType = bounded(parts.get("m"), 256);
  const posterUrl = safeMediaUrl(parts.get("image") ?? parts.get("thumb"));
  const dimensions = parseDimensions(parts.get("dim"));
  const alt = bounded(parts.get("alt"), 1_024);
  const blurhash = bounded(parts.get("blurhash"), 256);
  return {
    kind: classifyMedia(url, mimeType),
    url,
    ...(mimeType ? { mimeType } : {}),
    ...(posterUrl ? { posterUrl } : {}),
    ...(dimensions ? { aspectRatio: dimensions[0] / dimensions[1] } : {}),
    ...(alt ? { alt } : {}),
    ...(blurhash ? { blurhash } : {}),
  };
}

function classifyMedia(
  url: string,
  mimeType: string | undefined,
): ParsedMedia["kind"] {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType === "video/mp4") return "video";
  const path = new URL(url).pathname;
  if (IMAGE_EXTENSIONS.test(path)) return "image";
  if (/\.mp4$/i.test(path)) return "video";
  return "file";
}

function parseDimensions(
  value: unknown,
): readonly [number, number] | undefined {
  if (typeof value !== "string") return undefined;
  const [width, height] = value.split("x").map(Number);
  return Number.isFinite(width) &&
    Number.isFinite(height) &&
    (width ?? 0) > 0 &&
    (height ?? 0) > 0
    ? [width as number, height as number]
    : undefined;
}

function safeMediaUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    const development = typeof __DEV__ !== "undefined" && Boolean(__DEV__);
    return url.protocol === "https:" ||
      (development && url.protocol === "http:")
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function bounded(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum
    ? value
    : undefined;
}
