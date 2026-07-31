import type { MediaStorage } from "@buzz/media";
import { blobKey, getSidecar, thumbKey } from "@buzz/media";
import type { Pool } from "pg";

import type { NostrEvent } from "@buzz/core";

const CATEGORIES = new Set(["bug", "praise", "needs-work"]);
const MAX_BODY_BYTES = 32 * 1024;
const MAX_TAGS_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const MIME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SAFE_EXT = /^[a-z0-9]{1,8}$/;
const ALLOWED_IMETA_KEYS = new Set([
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
const SINGLETON_IMETA_KEYS = new Set([
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

/** Validated fields stored in the deployment-private feedback inbox. */
export type ValidatedProductFeedback = {
  /** Optional supported feedback category. */
  readonly category?: "bug" | "praise" | "needs-work";
  /** Exact signed feedback body. */
  readonly body: string;
  /** Exact signed event tags retained for attachment review. */
  readonly tags: readonly (readonly string[])[];
};

/** Validate the non-storage portion of one signed product-feedback event. */
export function validateProductFeedback(
  event: NostrEvent,
): ValidatedProductFeedback {
  if (
    event.content.trim().length === 0 ||
    Buffer.byteLength(event.content, "utf8") > MAX_BODY_BYTES
  ) {
    throw new Error("feedback body must be nonempty and at most 32768 bytes");
  }
  const encodedTags = Buffer.from(JSON.stringify(event.tags), "utf8");
  if (encodedTags.byteLength > MAX_TAGS_BYTES) {
    throw new Error("feedback tags exceed 65536 bytes");
  }
  const categories = event.tags
    .filter((tag) => tag[0] === "category")
    .map((tag) => tag[1]);
  if (categories.length > 1) {
    throw new Error("feedback must include at most one category tag");
  }
  const category = categories[0];
  if (category !== undefined && !CATEGORIES.has(category)) {
    throw new Error("unsupported feedback category");
  }
  const validatedCategory =
    category === "bug" || category === "praise" || category === "needs-work"
      ? category
      : undefined;
  return {
    body: event.content,
    ...(validatedCategory ? { category: validatedCategory } : {}),
    tags: event.tags,
  };
}

/** Durable, deployment-private product-feedback sidecar. */
export class ProductFeedbackService {
  public constructor(
    private readonly options: {
      /** Host-derived immutable community identifier. */
      readonly communityId: string;
      /** Exact tenant Host used by local attachment URLs. */
      readonly communityHost: string;
      /** Optional tenant media store required by any imeta attachment. */
      readonly mediaStorage?: MediaStorage;
      /** Durable deployment database. */
      readonly pool: Pool;
      /** Tenant public relay URL, used only to derive HTTP media scheme. */
      readonly publicUrl: URL;
    },
  ) {}

  /** Validate attachments and insert idempotently outside public event storage. */
  public async accept(event: NostrEvent): Promise<void> {
    const feedback = validateProductFeedback(event);
    const imeta = event.tags.filter((tag) => tag[0] === "imeta");
    if (imeta.length > 0) {
      if (!this.options.mediaStorage) {
        throw new Error("feedback attachments are not available");
      }
      for (const tag of imeta) {
        await validateImeta(
          tag,
          this.options.communityId,
          this.options.communityHost,
          this.options.publicUrl,
          this.options.mediaStorage,
        );
      }
    }
    await this.options.pool.query(
      `INSERT INTO product_feedback (
         community_id, event_id, submitter_pubkey, category, body, tags,
         event_created_at
       )
       VALUES (
         $1::uuid, decode($2, 'hex'), decode($3, 'hex'), $4, $5, $6::jsonb,
         to_timestamp($7)
       )
       ON CONFLICT (event_id) DO NOTHING`,
      [
        this.options.communityId,
        event.id,
        event.pubkey,
        feedback.category ?? null,
        feedback.body,
        JSON.stringify(feedback.tags),
        event.created_at,
      ],
    );
  }
}

async function validateImeta(
  tag: readonly string[],
  communityId: string,
  communityHost: string,
  publicUrl: URL,
  storage: MediaStorage,
): Promise<void> {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  for (const part of tag.slice(1)) {
    const split = part.indexOf(" ");
    const key = split < 0 ? part : part.slice(0, split);
    const value = split < 0 ? "" : part.slice(split + 1);
    if (!ALLOWED_IMETA_KEYS.has(key)) {
      throw new Error(`disallowed imeta key: ${key}`);
    }
    if (SINGLETON_IMETA_KEYS.has(key) && seen.has(key)) {
      throw new Error(`duplicate imeta key: ${key}`);
    }
    seen.add(key);
    values.set(key, value);
  }
  const hash = values.get("x");
  const mime = values.get("m");
  const size = positiveInteger(values.get("size"), "imeta size");
  const url = values.get("url");
  if (!hash || !SHA256.test(hash) || !mime || !MIME.test(mime) || !url) {
    throw new Error("imeta tag must include valid url, m, x, and size");
  }
  const main = localMediaPath(url, communityHost, publicUrl);
  if (main.thumbnail || main.sha256 !== hash) {
    throw new Error("imeta url must identify its x hash, not a thumbnail");
  }
  const expectedPreviewExtension = PREVIEW_MIME_EXTENSIONS.get(mime);
  if (
    expectedPreviewExtension !== undefined &&
    main.ext !== expectedPreviewExtension
  ) {
    throw new Error("imeta url extension does not match m");
  }
  const filename = values.get("filename");
  if (
    filename !== undefined &&
    (filename.length < 1 ||
      filename.length > 255 ||
      /[\/\\\u0000-\u001f\u007f]/.test(filename))
  ) {
    throw new Error("imeta filename is invalid");
  }
  const duration = optionalPositiveNumber(values.get("duration"), "duration");
  const bitrate = values.has("bitrate")
    ? positiveInteger(values.get("bitrate"), "imeta bitrate")
    : undefined;
  void bitrate;
  const imageUrl = values.get("image");
  const thumbUrl = values.get("thumb");
  if (mime !== "video/mp4" && (duration || imageUrl || values.has("bitrate"))) {
    throw new Error("video-only imeta fields require video/mp4");
  }
  const sidecar = await getSidecar(storage, communityId, hash);
  if (
    !sidecar ||
    sidecar.mimeType !== mime ||
    sidecar.size !== size ||
    sidecar.ext !== main.ext ||
    !(await storage.head(blobKey(hash, sidecar.ext)))
  ) {
    throw new Error("imeta metadata does not match a stored tenant blob");
  }
  if (
    duration !== undefined &&
    sidecar.durationSecs !== undefined &&
    Math.abs(duration - sidecar.durationSecs) > 0.1
  ) {
    throw new Error("imeta duration does not match the stored blob");
  }
  if (thumbUrl !== undefined) {
    const thumb = localMediaPath(thumbUrl, communityHost, publicUrl);
    if (
      !thumb.thumbnail ||
      thumb.sha256 !== hash ||
      !(await storage.head(thumbKey(hash)))
    ) {
      throw new Error("imeta thumbnail is missing or invalid");
    }
  }
  if (imageUrl !== undefined) {
    const image = localMediaPath(imageUrl, communityHost, publicUrl);
    const imageMeta = await getSidecar(storage, communityId, image.sha256);
    if (
      image.thumbnail ||
      !imageMeta ||
      imageMeta.ext !== image.ext ||
      !imageMeta.mimeType.startsWith("image/") ||
      !(await storage.head(blobKey(image.sha256, imageMeta.ext)))
    ) {
      throw new Error("imeta poster image is missing or invalid");
    }
  }
}

function localMediaPath(
  value: string,
  communityHost: string,
  publicUrl: URL,
): {
  readonly ext: string;
  readonly sha256: string;
  readonly thumbnail: boolean;
} {
  const scheme = publicUrl.protocol === "wss:" ? "https:" : "http:";
  const parsed = value.startsWith("/")
    ? new URL(value, `${scheme}//${communityHost}`)
    : new URL(value);
  if (
    parsed.protocol !== scheme ||
    parsed.host.toLowerCase() !== communityHost.toLowerCase() ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("imeta URL must be local to the tenant");
  }
  const thumb = /^\/media\/([0-9a-f]{64})\.thumb\.jpg$/.exec(parsed.pathname);
  if (thumb?.[1]) {
    return { ext: "jpg", sha256: thumb[1], thumbnail: true };
  }
  const main = /^\/media\/([0-9a-f]{64})\.([a-z0-9]{1,8})$/.exec(
    parsed.pathname,
  );
  if (!main?.[1] || !main[2] || !SAFE_EXT.test(main[2])) {
    throw new Error("imeta URL must be a local /media/ blob path");
  }
  return { ext: main[2], sha256: main[1], thumbnail: false };
}

function positiveInteger(value: string | undefined, label: string): number {
  if (!value || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} exceeds the safe integer range`);
  }
  return parsed;
}

function optionalPositiveNumber(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`imeta ${label} must be a positive finite number`);
  }
  return parsed;
}
