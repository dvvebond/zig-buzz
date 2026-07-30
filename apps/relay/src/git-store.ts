import { randomBytes } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

import { gitObjectDigest } from "./git-manifest.js";

/** Opaque version token used for a conditional pointer replacement. */
export type GitStoreEtag = string;

/** Preconditions supported by the mutable repository pointer. */
export type GitPointerPrecondition =
  | { readonly type: "create" }
  | { readonly etag: GitStoreEtag; readonly type: "replace" };

/** Result of one atomic pointer compare-and-swap attempt. */
export type GitPointerCasResult =
  | { readonly etag: GitStoreEtag; readonly won: true }
  | { readonly won: false };

/** A pointer body and the exact version observed alongside it. */
export type GitPointerState = {
  readonly digest: string;
  readonly etag: GitStoreEtag;
};

/**
 * Object-storage contract required by Git publication. Immutable objects are
 * create-only; pointer writes must provide real conditional-write semantics.
 */
export interface GitObjectStore {
  putImmutable(key: string, bytes: Uint8Array): Promise<void>;
  getImmutable(key: string, maximumBytes: number): Promise<Buffer>;
  getPointer(key: string): Promise<GitPointerState | undefined>;
  compareAndSwapPointer(
    key: string,
    digest: string,
    precondition: GitPointerPrecondition,
  ): Promise<GitPointerCasResult>;
  probe(): Promise<void>;
}

/** In-memory, linearizable Git object store for unit and integration tests. */
export class MemoryGitObjectStore implements GitObjectStore {
  readonly #immutable = new Map<string, Buffer>();
  readonly #pointers = new Map<string, GitPointerState>();
  #version = 0;

  public async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    assertStoreKey(key);
    const current = this.#immutable.get(key);
    if (current) {
      if (!current.equals(Buffer.from(bytes))) {
        throw new Error("immutable Git object collision");
      }
      return;
    }
    this.#immutable.set(key, Buffer.from(bytes));
  }

  public async getImmutable(
    key: string,
    maximumBytes: number,
  ): Promise<Buffer> {
    assertStoreKey(key);
    const bytes = this.#immutable.get(key);
    if (!bytes) throw new Error("Git object not found");
    if (bytes.byteLength > maximumBytes) {
      throw new Error("Git object exceeds configured limit");
    }
    return Buffer.from(bytes);
  }

  public async getPointer(key: string): Promise<GitPointerState | undefined> {
    assertPointerKey(key);
    const current = this.#pointers.get(key);
    return current ? { ...current } : undefined;
  }

  public async compareAndSwapPointer(
    key: string,
    digest: string,
    precondition: GitPointerPrecondition,
  ): Promise<GitPointerCasResult> {
    assertPointerKey(key);
    assertDigest(digest);
    const current = this.#pointers.get(key);
    if (
      (precondition.type === "create" && current) ||
      (precondition.type === "replace" && current?.etag !== precondition.etag)
    ) {
      return { won: false };
    }
    const etag = `"memory-${++this.#version}"`;
    this.#pointers.set(key, { digest, etag });
    return { etag, won: true };
  }

  public async probe(): Promise<void> {
    await probeGitObjectStore(this);
  }
}

/**
 * Local development store. Pointer updates are process-linearizable and use
 * atomic rename; production multi-replica deployments must use the S3 store.
 */
export class FileGitObjectStore implements GitObjectStore {
  readonly #root: string;
  readonly #locks = new Map<string, Promise<void>>();

  public constructor(root: string) {
    this.#root = resolve(root);
  }

  public async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const current = await readFile(path);
      if (!current.equals(Buffer.from(bytes))) {
        throw new Error("immutable Git object collision");
      }
    }
  }

  public async getImmutable(
    key: string,
    maximumBytes: number,
  ): Promise<Buffer> {
    const path = this.path(key);
    const details = await stat(path);
    if (details.size > maximumBytes) {
      throw new Error("Git object exceeds configured limit");
    }
    return readFile(path);
  }

  public async getPointer(key: string): Promise<GitPointerState | undefined> {
    try {
      const bytes = await readFile(this.path(key));
      const digest = bytes.toString("utf8").trim();
      assertDigest(digest);
      return { digest, etag: gitObjectDigest(bytes) };
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  public async compareAndSwapPointer(
    key: string,
    digest: string,
    precondition: GitPointerPrecondition,
  ): Promise<GitPointerCasResult> {
    assertDigest(digest);
    return this.withLock(key, async () => {
      const current = await this.getPointer(key);
      if (
        (precondition.type === "create" && current) ||
        (precondition.type === "replace" && current?.etag !== precondition.etag)
      ) {
        return { won: false };
      }
      const path = this.path(key);
      await mkdir(dirname(path), { mode: 0o700, recursive: true });
      const bytes = Buffer.from(digest, "utf8");
      const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      try {
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      return { etag: gitObjectDigest(bytes), won: true };
    });
  }

  public async probe(): Promise<void> {
    await probeGitObjectStore(this);
  }

  private path(key: string): string {
    assertStoreKey(key);
    const path = resolve(this.#root, key);
    if (!path.startsWith(`${this.#root}/`)) {
      throw new Error("Git object key escapes storage root");
    }
    return path;
  }

  private async withLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const queued = previous.then(() => next);
    this.#locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }
}

/** S3-compatible store with native If-None-Match/If-Match pointer CAS. */
export class S3GitObjectStore implements GitObjectStore {
  readonly #client: S3Client;

  public constructor(
    private readonly bucket: string,
    config: S3ClientConfig,
  ) {
    if (!/^[A-Za-z0-9._-]{3,255}$/.test(bucket)) {
      throw new Error("invalid Git object bucket");
    }
    this.#client = new S3Client(config);
  }

  public async putImmutable(key: string, bytes: Uint8Array): Promise<void> {
    assertImmutableKey(key);
    try {
      await this.#client.send(
        new PutObjectCommand({
          Body: bytes,
          Bucket: this.bucket,
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
          Key: key,
        }),
      );
    } catch (error) {
      if (!isS3Precondition(error)) throw error;
      const current = await this.getImmutable(key, bytes.byteLength + 1);
      if (!current.equals(Buffer.from(bytes))) {
        throw new Error("immutable Git object collision");
      }
    }
  }

  public async getImmutable(
    key: string,
    maximumBytes: number,
  ): Promise<Buffer> {
    assertImmutableKey(key);
    const response = await this.#client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) throw new Error("Git object not found");
    if (
      response.ContentLength !== undefined &&
      response.ContentLength > maximumBytes
    ) {
      throw new Error("Git object exceeds configured limit");
    }
    const bytes = Buffer.from(await response.Body.transformToByteArray());
    if (bytes.byteLength > maximumBytes) {
      throw new Error("Git object exceeds configured limit");
    }
    return bytes;
  }

  public async getPointer(key: string): Promise<GitPointerState | undefined> {
    assertPointerKey(key);
    try {
      const response = await this.#client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body || !response.ETag) {
        throw new Error("Git pointer response is incomplete");
      }
      const digest = Buffer.from(await response.Body.transformToByteArray())
        .toString("utf8")
        .trim();
      assertDigest(digest);
      return { digest, etag: response.ETag };
    } catch (error) {
      if (isS3NotFound(error)) return undefined;
      throw error;
    }
  }

  public async compareAndSwapPointer(
    key: string,
    digest: string,
    precondition: GitPointerPrecondition,
  ): Promise<GitPointerCasResult> {
    assertPointerKey(key);
    assertDigest(digest);
    try {
      const response = await this.#client.send(
        new PutObjectCommand({
          Body: Buffer.from(digest, "utf8"),
          Bucket: this.bucket,
          ContentType: "text/plain; charset=utf-8",
          ...(precondition.type === "create"
            ? { IfNoneMatch: "*" }
            : { IfMatch: precondition.etag }),
          Key: key,
        }),
      );
      if (!response.ETag) throw new Error("Git pointer CAS omitted ETag");
      return { etag: response.ETag, won: true };
    } catch (error) {
      if (isS3Precondition(error)) return { won: false };
      throw error;
    }
  }

  public async probe(): Promise<void> {
    await probeGitObjectStore(this);
  }
}

/**
 * Fail-fast backend conformance check. It proves create-only immutable writes,
 * create CAS, stale-ETag rejection, and successful current-ETag replacement.
 */
export async function probeGitObjectStore(
  store: GitObjectStore,
): Promise<void> {
  const nonce = randomBytes(24).toString("hex");
  const object = Buffer.from(`buzz-git-probe:${nonce}`, "utf8");
  const digest = gitObjectDigest(object);
  const immutableKey = `packs/${digest}`;
  const pointerKey = `repos/00000000-0000-4000-8000-000000000000/${"0".repeat(
    64,
  )}/probe-${nonce}/pointer`;
  await store.putImmutable(immutableKey, object);
  const fetched = await store.getImmutable(immutableKey, object.byteLength);
  if (!fetched.equals(object)) throw new Error("Git store probe read mismatch");
  const created = await store.compareAndSwapPointer(pointerKey, digest, {
    type: "create",
  });
  if (!created.won) throw new Error("Git store probe create CAS lost");
  const duplicate = await store.compareAndSwapPointer(pointerKey, digest, {
    type: "create",
  });
  if (duplicate.won) throw new Error("Git store ignores create precondition");
  const stale = await store.compareAndSwapPointer(pointerKey, digest, {
    etag: '"definitely-stale"',
    type: "replace",
  });
  if (stale.won) throw new Error("Git store ignores stale ETag");
  const replaced = await store.compareAndSwapPointer(pointerKey, digest, {
    etag: created.etag,
    type: "replace",
  });
  if (!replaced.won) throw new Error("Git store current-ETag CAS failed");
}

function assertStoreKey(key: string): void {
  if (
    key.length < 1 ||
    key.length > 1_024 ||
    key.startsWith("/") ||
    key.includes("\0") ||
    key.split("/").includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(key)
  ) {
    throw new Error("invalid Git object key");
  }
}

function assertImmutableKey(key: string): void {
  assertStoreKey(key);
  if (!/^(?:packs|manifests)\/[0-9a-f]{64}$/.test(key)) {
    throw new Error("invalid immutable Git object key");
  }
}

function assertPointerKey(key: string): void {
  assertStoreKey(key);
  if (
    !/^repos\/[0-9a-f-]{36}\/[0-9a-f]{64}\/[A-Za-z0-9._-]{1,64}\/pointer$/.test(
      key,
    )
  ) {
    throw new Error("invalid Git pointer key");
  }
}

function assertDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("invalid Git object digest");
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
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

function isS3Precondition(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("name" in error && error.name === "PreconditionFailed") ||
      ("$metadata" in error &&
        typeof error.$metadata === "object" &&
        error.$metadata !== null &&
        "httpStatusCode" in error.$metadata &&
        error.$metadata.httpStatusCode === 412))
  );
}
