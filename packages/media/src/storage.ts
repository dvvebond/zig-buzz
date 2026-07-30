import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

import { mediaError } from "./error.js";
import type { BlobMeta } from "./types.js";

export type StoredObjectHead = {
  readonly size: number;
  readonly contentType?: string;
};

export type StoredObject = StoredObjectHead & {
  readonly bytes: Uint8Array;
};

export type ObjectPage = {
  readonly objects: readonly { readonly key: string; readonly size: number }[];
  readonly continuationToken?: string;
};

export interface MediaStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  putFile(key: string, path: string, contentType: string): Promise<void>;
  get(
    key: string,
    range?: { readonly start: number; readonly end: number },
  ): Promise<StoredObject>;
  head(key: string): Promise<StoredObjectHead | undefined>;
  delete(key: string): Promise<void>;
  list(
    prefix: string,
    continuationToken?: string,
    signal?: AbortSignal,
  ): Promise<ObjectPage>;
}

const SAFE_KEY = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,1024}$/;

export class FileMediaStorage implements MediaStorage {
  readonly #root: string;

  public constructor(root: string) {
    this.#root = resolve(root);
  }

  public async put(
    key: string,
    bytes: Uint8Array,
    _contentType: string,
  ): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { mode: 0o600 });
  }

  public async putFile(
    key: string,
    path: string,
    contentType: string,
  ): Promise<void> {
    await this.put(key, await readFile(path), contentType);
  }

  public async get(
    key: string,
    range?: { readonly start: number; readonly end: number },
  ): Promise<StoredObject> {
    try {
      const bytes = await readFile(this.path(key));
      const selected = range
        ? bytes.subarray(range.start, range.end + 1)
        : bytes;
      return { bytes: selected, size: bytes.byteLength };
    } catch (error) {
      if (isNotFound(error)) throw mediaError("NOT_FOUND");
      throw mediaError("STORAGE_ERROR", String(error));
    }
  }

  public async head(key: string): Promise<StoredObjectHead | undefined> {
    try {
      const details = await stat(this.path(key));
      return { size: details.size };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw mediaError("STORAGE_ERROR", String(error));
    }
  }

  public async delete(key: string): Promise<void> {
    try {
      await unlink(this.path(key));
    } catch (error) {
      if (!isNotFound(error)) throw mediaError("STORAGE_ERROR", String(error));
    }
  }

  public async list(
    prefix: string,
    continuationToken?: string,
    signal?: AbortSignal,
  ): Promise<ObjectPage> {
    signal?.throwIfAborted();
    const keys = await walk(this.#root);
    signal?.throwIfAborted();
    const start = continuationToken ? Number(continuationToken) : 0;
    const matching = keys.filter((key) => key.startsWith(prefix));
    const page = matching.slice(start, start + 1_000);
    return {
      ...(start + page.length < matching.length
        ? { continuationToken: String(start + page.length) }
        : {}),
      objects: await Promise.all(
        page.map(async (key) => ({
          key,
          size: (await stat(this.path(key))).size,
        })),
      ),
    };
  }

  private path(key: string): string {
    assertStorageKey(key);
    const path = resolve(this.#root, key);
    if (!path.startsWith(`${this.#root}/`)) {
      throw mediaError("STORAGE_ERROR", "invalid object key");
    }
    return path;
  }
}

export class S3MediaStorage implements MediaStorage {
  readonly #client: S3Client;

  public constructor(
    private readonly bucket: string,
    config: S3ClientConfig,
  ) {
    if (!bucket || !/^[A-Za-z0-9._-]{3,255}$/.test(bucket)) {
      throw new Error("invalid media bucket");
    }
    this.#client = new S3Client(config);
  }

  public async put(
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    assertStorageKey(key);
    await this.#client.send(
      new PutObjectCommand({
        Body: bytes,
        Bucket: this.bucket,
        ContentType: contentType,
        Key: key,
      }),
    );
  }

  public async putFile(
    key: string,
    path: string,
    contentType: string,
  ): Promise<void> {
    assertStorageKey(key);
    await this.#client.send(
      new PutObjectCommand({
        Body: createReadStream(path),
        Bucket: this.bucket,
        ContentLength: (await stat(path)).size,
        ContentType: contentType,
        Key: key,
      }),
    );
  }

  public async get(
    key: string,
    range?: { readonly start: number; readonly end: number },
  ): Promise<StoredObject> {
    assertStorageKey(key);
    try {
      const response = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
      );
      if (!response.Body) throw mediaError("NOT_FOUND");
      return {
        bytes: await response.Body.transformToByteArray(),
        ...(response.ContentType ? { contentType: response.ContentType } : {}),
        size:
          range && response.ContentRange
            ? Number(response.ContentRange.split("/")[1])
            : (response.ContentLength ?? 0),
      };
    } catch (error) {
      if (isS3NotFound(error)) throw mediaError("NOT_FOUND");
      throw error;
    }
  }

  public async head(key: string): Promise<StoredObjectHead | undefined> {
    assertStorageKey(key);
    try {
      const response = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        ...(response.ContentType ? { contentType: response.ContentType } : {}),
        size: response.ContentLength ?? 0,
      };
    } catch (error) {
      if (isS3NotFound(error)) return undefined;
      throw error;
    }
  }

  public async delete(key: string): Promise<void> {
    assertStorageKey(key);
    await this.#client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  public async list(
    prefix: string,
    continuationToken?: string,
    signal?: AbortSignal,
  ): Promise<ObjectPage> {
    const response = await this.#client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        Prefix: prefix,
      }),
      signal ? { abortSignal: signal } : undefined,
    );
    return {
      ...(response.NextContinuationToken
        ? { continuationToken: response.NextContinuationToken }
        : {}),
      objects: (response.Contents ?? []).flatMap((item) =>
        item.Key ? [{ key: item.Key, size: item.Size ?? 0 }] : [],
      ),
    };
  }
}

export function blobKey(sha256: string, ext: string): string {
  assertSha256(sha256);
  if (!/^[A-Za-z0-9]{1,8}$/.test(ext)) {
    throw mediaError("STORAGE_ERROR", "invalid blob extension");
  }
  return `${sha256}.${ext}`;
}

export function thumbKey(sha256: string): string {
  assertSha256(sha256);
  return `${sha256}.thumb.jpg`;
}

export function sidecarKey(communityId: string, sha256: string): string {
  assertUuid(communityId);
  assertSha256(sha256);
  return `_meta/${communityId}/${sha256}.json`;
}

export async function getSidecar(
  storage: MediaStorage,
  communityId: string,
  sha256: string,
): Promise<BlobMeta | undefined> {
  try {
    const object = await storage.get(sidecarKey(communityId, sha256));
    return parseBlobMeta(
      JSON.parse(Buffer.from(object.bytes).toString("utf8")),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "NOT_FOUND"
    ) {
      return undefined;
    }
    throw error;
  }
}

export async function putSidecar(
  storage: MediaStorage,
  communityId: string,
  sha256: string,
  meta: BlobMeta,
): Promise<void> {
  await storage.put(
    sidecarKey(communityId, sha256),
    Buffer.from(JSON.stringify(meta)),
    "application/json",
  );
}

function parseBlobMeta(value: unknown): BlobMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw mediaError("STORAGE_ERROR", "invalid media sidecar");
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.dim !== "string" ||
    typeof item.blurhash !== "string" ||
    typeof item.thumbUrl !== "string" ||
    typeof item.ext !== "string" ||
    typeof item.mimeType !== "string" ||
    typeof item.size !== "number" ||
    typeof item.uploadedAt !== "number"
  ) {
    throw mediaError("STORAGE_ERROR", "invalid media sidecar");
  }
  return item as BlobMeta;
}

function assertStorageKey(key: string): void {
  if (!SAFE_KEY.test(key))
    throw mediaError("STORAGE_ERROR", "invalid object key");
}

function assertSha256(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw mediaError("STORAGE_ERROR", "invalid content hash");
  }
}

function assertUuid(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw mediaError("STORAGE_ERROR", "invalid community identifier");
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isS3NotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("name" in error &&
      (error.name === "NoSuchKey" || error.name === "NotFound")) ||
      ("$metadata" in error &&
        typeof error.$metadata === "object" &&
        error.$metadata !== null &&
        "httpStatusCode" in error.$metadata &&
        error.$metadata.httpStatusCode === 404))
  );
}

async function walk(root: string, current = root): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const results: string[] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) results.push(...(await walk(root, path)));
    else if (entry.isFile()) results.push(path.slice(root.length + 1));
  }
  return results.sort();
}
