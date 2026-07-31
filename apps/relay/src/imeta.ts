import { blobKey, getSidecar, thumbKey, type MediaStorage } from "@buzz/media";
import type { NostrEvent } from "@buzz/core";
import { RemoteProtocolError } from "@buzz/remote-agent-protocol";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_EXT = /^[a-z0-9]{1,8}$/;
const ALLOWED_KEYS = new Set([
  "url",
  "m",
  "x",
  "size",
  "dim",
  "blurhash",
  "alt",
  "thumb",
  "fallback",
  "duration",
  "bitrate",
  "image",
  "filename",
]);
const SINGLETON_KEYS = new Set([
  "url",
  "m",
  "x",
  "size",
  "dim",
  "blurhash",
  "thumb",
  "alt",
  "duration",
  "bitrate",
  "image",
  "filename",
]);
const PREVIEW_MIME_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["video/mp4", "mp4"],
]);
const IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export type ImetaMedia = {
  readonly communityId: string;
  readonly publicBaseUrl: string;
  readonly storage: MediaStorage;
};

/** Validate every imeta claim and prove the referenced tenant blob exists. */
export async function validateEventMedia(
  event: NostrEvent,
  media: ImetaMedia | undefined,
): Promise<void> {
  const tags = event.tags.filter((tag) => tag[0] === "imeta");
  if (tags.length === 0) return;
  if (!media) invalid("imeta references require configured media storage");
  for (const tag of tags) {
    const fields = parseImeta(tag, media.publicBaseUrl);
    const sidecar = await getSidecar(
      media.storage,
      media.communityId,
      fields.x,
    );
    if (!sidecar) invalid(`imeta references nonexistent blob: ${fields.x}`);
    if (!(await media.storage.head(blobKey(fields.x, sidecar.ext)))) {
      invalid(`imeta blob object is missing: ${fields.x}`);
    }
    if (sidecar.mimeType !== fields.mime) {
      invalid("imeta MIME does not match the stored blob");
    }
    if (sidecar.size !== fields.size) {
      invalid("imeta size does not match the stored blob");
    }
    if (
      sidecar.durationSecs !== undefined &&
      fields.duration !== undefined &&
      Math.abs(sidecar.durationSecs - fields.duration) > 0.1
    ) {
      invalid("imeta duration does not match the stored blob");
    }
    if (fields.urlExtension !== sidecar.ext) {
      invalid("imeta URL extension does not match the stored blob");
    }
    if (fields.thumb && !(await media.storage.head(thumbKey(fields.x)))) {
      invalid("imeta thumbnail is missing");
    }
    if (fields.image) {
      const imageHash = mediaPath(fields.image, media.publicBaseUrl)?.hash;
      if (!imageHash) invalid("imeta image URL has no content hash");
      const poster = await getSidecar(
        media.storage,
        media.communityId,
        imageHash,
      );
      if (!poster) invalid("imeta poster image does not exist");
      if (!IMAGE_MIMES.has(poster.mimeType)) {
        invalid("imeta poster must reference an image blob");
      }
      const imageExtension = mediaPath(
        fields.image,
        media.publicBaseUrl,
      )?.extension;
      if (imageExtension !== poster.ext) {
        invalid("imeta poster extension does not match stored metadata");
      }
      if (!(await media.storage.head(blobKey(imageHash, poster.ext)))) {
        invalid("imeta poster blob is missing");
      }
    }
  }
}

type ParsedImeta = {
  readonly duration?: number;
  readonly image?: string;
  readonly mime: string;
  readonly size: number;
  readonly thumb?: string;
  readonly urlExtension: string;
  readonly x: string;
};

function parseImeta(tag: readonly string[], baseUrl: string): ParsedImeta {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (const part of tag.slice(1)) {
    const separator = part.indexOf(" ");
    const key = separator < 0 ? part : part.slice(0, separator);
    const value = separator < 0 ? "" : part.slice(separator + 1);
    if (!ALLOWED_KEYS.has(key)) invalid(`disallowed imeta key: ${key}`);
    if (SINGLETON_KEYS.has(key) && seen.has(key)) {
      invalid(`duplicate imeta key: ${key}`);
    }
    if (SINGLETON_KEYS.has(key)) seen.add(key);
    values.set(key, value);
  }
  const url = values.get("url");
  const mime = values.get("m");
  const x = values.get("x");
  const rawSize = values.get("size");
  if (
    url === undefined ||
    mime === undefined ||
    x === undefined ||
    rawSize === undefined
  ) {
    invalid("imeta tag must include url, m, x, and size");
  }
  const path = mediaPath(url, baseUrl);
  if (!path || path.thumbnail) {
    invalid("imeta url must be a local primary /media/ path");
  }
  if (!validMime(mime)) invalid("imeta m must be a valid MIME type");
  if (!SHA256.test(x)) invalid("imeta x must be lowercase SHA-256");
  const size = canonicalPositiveInteger(rawSize, "imeta size");
  if (path.hash !== x) invalid("imeta url hash does not match x");
  const expectedExtension = PREVIEW_MIME_EXTENSIONS.get(mime);
  if (expectedExtension && path.extension !== expectedExtension) {
    invalid("imeta url extension does not match m");
  }

  const thumb = values.get("thumb");
  if (thumb !== undefined) {
    const thumbPath = mediaPath(thumb, baseUrl);
    if (
      !thumbPath?.thumbnail ||
      thumbPath.hash !== x ||
      thumbPath.extension !== "jpg"
    ) {
      invalid("imeta thumb must be the local matching .thumb.jpg path");
    }
  }
  const duration = values.get("duration");
  const parsedDuration = duration === undefined ? undefined : Number(duration);
  if (
    parsedDuration !== undefined &&
    (!Number.isFinite(parsedDuration) || parsedDuration <= 0)
  ) {
    invalid("imeta duration must be a positive finite number");
  }
  const bitrate = values.get("bitrate");
  if (bitrate !== undefined) canonicalPositiveInteger(bitrate, "imeta bitrate");
  const image = values.get("image");
  if (
    mime !== "video/mp4" &&
    (duration !== undefined || bitrate !== undefined || image !== undefined)
  ) {
    invalid("imeta duration, bitrate, and image are valid only for video/mp4");
  }
  if (image !== undefined) {
    const imagePath = mediaPath(image, baseUrl);
    if (
      !imagePath ||
      imagePath.thumbnail ||
      !["jpg", "png", "gif", "webp"].includes(imagePath.extension)
    ) {
      invalid("imeta image must be a local standalone image path");
    }
  }
  const filename = values.get("filename");
  if (
    filename !== undefined &&
    (Buffer.byteLength(filename, "utf8") < 1 ||
      Buffer.byteLength(filename, "utf8") > 255 ||
      /[/\\\p{Cc}]/u.test(filename))
  ) {
    invalid("imeta filename is invalid");
  }
  return {
    ...(parsedDuration === undefined ? {} : { duration: parsedDuration }),
    ...(image === undefined ? {} : { image }),
    mime,
    size,
    ...(thumb === undefined ? {} : { thumb }),
    urlExtension: path.extension,
    x,
  };
}

function mediaPath(
  value: string,
  baseUrl: string,
):
  | {
      readonly extension: string;
      readonly hash: string;
      readonly thumbnail: boolean;
    }
  | undefined {
  const base = baseUrl.replace(/\/+$/, "");
  const relative = value.startsWith("/media/")
    ? value.slice("/media/".length)
    : value.startsWith(`${base}/`)
      ? value.slice(base.length + 1)
      : undefined;
  if (
    relative === undefined ||
    relative.includes("?") ||
    relative.includes("#") ||
    relative.includes("%") ||
    relative.includes("/")
  ) {
    return undefined;
  }
  const primary = /^([0-9a-f]{64})\.([a-z0-9]{1,8})$/.exec(relative);
  if (primary?.[1] && primary[2] && SAFE_EXT.test(primary[2])) {
    return {
      extension: primary[2],
      hash: primary[1],
      thumbnail: false,
    };
  }
  const thumbnail = /^([0-9a-f]{64})\.thumb\.jpg$/.exec(relative);
  return thumbnail?.[1]
    ? {
        extension: "jpg",
        hash: thumbnail[1],
        thumbnail: true,
      }
    : undefined;
}

function validMime(value: string): boolean {
  const separator = value.indexOf("/");
  return (
    separator > 0 &&
    separator < value.length - 1 &&
    Buffer.byteLength(value, "utf8") <= 255 &&
    !/[\s\p{Cc}]/u.test(value)
  );
}

function canonicalPositiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value))
    invalid(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    invalid(`${label} exceeds the supported range`);
  return parsed;
}

function invalid(message: string): never {
  throw new RemoteProtocolError("CONFIG_INVALID", message);
}
