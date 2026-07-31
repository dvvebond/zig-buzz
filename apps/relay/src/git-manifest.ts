import { createHash } from "node:crypto";

export const GIT_MANIFEST_VERSION = 1 as const;
export const MAX_GIT_MANIFEST_PACKS = 128;
export const MAX_GIT_MANIFEST_REFS = 10_000;
export const DEFAULT_GIT_HEAD = "refs/heads/main";

/**
 * Canonical, content-addressed repository state. Property order is part of the
 * wire format and intentionally matches the original Rust implementation.
 */
export type GitManifest = {
  readonly version: typeof GIT_MANIFEST_VERSION;
  readonly head: string;
  readonly refs: Readonly<Record<string, string>>;
  readonly packs: readonly string[];
  readonly parent: string | null;
};

/** Reject ref names that could escape a bare repository or confuse Git. */
export function isSafeGitRefname(value: string): boolean {
  return (
    value.startsWith("refs/") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith("/") &&
    /^[A-Za-z0-9_./-]+$/.test(value)
  );
}

/** Accept the SHA-1 object ids used today and SHA-256 Git object ids. */
export function isGitObjectId(value: string): boolean {
  return (
    (value.length === 40 || value.length === 64) && /^[0-9a-f]+$/.test(value)
  );
}

/** Validate a canonical content-addressed Git pack key. */
export function isGitPackKey(value: string): boolean {
  return /^packs\/[0-9a-f]{64}$/.test(value);
}

/**
 * Validate and normalize an untrusted manifest. Unknown fields and malformed
 * values are rejected rather than silently becoming published repository state.
 */
export function parseGitManifest(value: unknown): GitManifest {
  if (!isRecord(value)) throw new Error("Git manifest must be an object");
  const keys = Object.keys(value).sort();
  const expected = ["head", "packs", "parent", "refs", "version"];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    throw new Error("Git manifest fields are invalid");
  }
  if (value.version !== GIT_MANIFEST_VERSION) {
    throw new Error("unsupported Git manifest version");
  }
  if (typeof value.head !== "string" || !isSafeGitRefname(value.head)) {
    throw new Error("Git manifest HEAD is invalid");
  }
  if (
    value.parent !== null &&
    (typeof value.parent !== "string" || !/^[0-9a-f]{64}$/.test(value.parent))
  ) {
    throw new Error("Git manifest parent is invalid");
  }
  if (
    !Array.isArray(value.packs) ||
    value.packs.length > MAX_GIT_MANIFEST_PACKS ||
    value.packs.some((key) => typeof key !== "string" || !isGitPackKey(key))
  ) {
    throw new Error("Git manifest pack set is invalid");
  }
  if (
    value.packs.some(
      (key, index) => index > 0 && key <= (value.packs as string[])[index - 1]!,
    )
  ) {
    throw new Error("Git manifest pack set must be sorted and unique");
  }
  if (!isRecord(value.refs)) {
    throw new Error("Git manifest refs are invalid");
  }
  const refEntries = Object.entries(value.refs);
  if (refEntries.length > MAX_GIT_MANIFEST_REFS) {
    throw new Error("Git manifest contains too many refs");
  }
  let previous = "";
  const refs: Record<string, string> = {};
  for (const [name, oid] of refEntries) {
    if (
      name <= previous ||
      !isSafeGitRefname(name) ||
      typeof oid !== "string" ||
      !isGitObjectId(oid)
    ) {
      throw new Error("Git manifest ref is invalid");
    }
    previous = name;
    refs[name] = oid;
  }
  return {
    head: value.head,
    packs: [...value.packs],
    parent: value.parent,
    refs,
    version: GIT_MANIFEST_VERSION,
  };
}

/** Serialize a validated manifest with deterministic field and map ordering. */
export function canonicalGitManifestBytes(manifest: GitManifest): Buffer {
  const refs = Object.fromEntries(
    Object.entries(manifest.refs).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const normalized = parseGitManifest({
    version: manifest.version,
    head: manifest.head,
    refs,
    packs: [...manifest.packs].sort(),
    parent: manifest.parent,
  });
  return Buffer.from(
    JSON.stringify({
      version: normalized.version,
      head: normalized.head,
      refs: normalized.refs,
      packs: normalized.packs,
      parent: normalized.parent,
    }),
    "utf8",
  );
}

/** Return the lowercase SHA-256 digest used as a manifest or pack key. */
export function gitObjectDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Build the tenant-scoped mutable pointer key for a repository. */
export function gitPointerKey(
  communityId: string,
  owner: string,
  repo: string,
): string {
  if (!isUuid(communityId)) throw new Error("invalid Git community id");
  if (!/^[0-9a-f]{64}$/.test(owner)) throw new Error("invalid Git owner");
  const canonicalRepo = validateGitRepoName(repo);
  return `repos/${communityId}/${owner}/${canonicalRepo}/pointer`;
}

/** Normalize and validate a repository URL segment. */
export function validateGitRepoName(value: string): string {
  const repo = value.endsWith(".git") ? value.slice(0, -4) : value;
  if (
    repo.length < 1 ||
    repo.length > 64 ||
    repo.startsWith(".") ||
    repo.includes("..") ||
    !/^[A-Za-z0-9._-]+$/.test(repo)
  ) {
    throw new Error("invalid Git repository name");
  }
  return repo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
