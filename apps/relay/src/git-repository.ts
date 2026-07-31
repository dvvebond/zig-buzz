import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import {
  canonicalGitManifestBytes,
  DEFAULT_GIT_HEAD,
  gitObjectDigest,
  gitPointerKey,
  isSafeGitRefname,
  parseGitManifest,
  type GitManifest,
} from "./git-manifest.js";
import type {
  GitObjectStore,
  GitPointerPrecondition,
  GitPointerState,
} from "./git-store.js";

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_REF_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/** Resource boundaries for hydration and publication. */
export type GitRepositoryLimits = {
  readonly maxPackBytes: number;
  readonly maxRepoBytes: number;
  readonly operationTimeoutMs: number;
  readonly scratchDirectory?: string;
};

/** Ephemeral bare repository and the exact parent pointer it was built from. */
export type HydratedGitRepository = {
  readonly manifest: GitManifest;
  readonly parent: GitPointerState;
  readonly path: string;
  close(): Promise<void>;
};

/** Successful immutable publication after the pointer CAS fence. */
export type PublishedGitRepository = {
  readonly manifest: GitManifest;
  readonly manifestDigest: string;
};

/** Error used to distinguish a lost writer race from backend failures. */
export class GitPublishConflictError extends Error {
  public constructor() {
    super("push superseded by a concurrent writer");
    this.name = "GitPublishConflictError";
  }
}

/**
 * Seed a newly announced repository with the canonical empty manifest. The
 * strict mode rejects a stale non-empty pointer; tolerant mode preserves it.
 */
export async function ensureGitRepositoryPointer(
  store: GitObjectStore,
  communityId: string,
  owner: string,
  repo: string,
  strict: boolean,
): Promise<{ readonly created: boolean; readonly manifest: GitManifest }> {
  const manifest: GitManifest = {
    head: DEFAULT_GIT_HEAD,
    packs: [],
    parent: null,
    refs: {},
    version: 1,
  };
  const bytes = canonicalGitManifestBytes(manifest);
  const digest = gitObjectDigest(bytes);
  await store.putImmutable(`manifests/${digest}`, bytes);
  const key = gitPointerKey(communityId, owner, repo);
  const existing = await store.getPointer(key);
  if (existing) {
    if (strict && existing.digest !== digest) {
      throw new Error("fresh Git repository has a stale non-empty pointer");
    }
    return { created: false, manifest };
  }
  const created = await store.compareAndSwapPointer(key, digest, {
    type: "create",
  });
  if (created.won) return { created: true, manifest };
  const winner = await store.getPointer(key);
  if (!winner || (strict && winner.digest !== digest)) {
    throw new Error("Git repository pointer creation lost to invalid state");
  }
  return { created: false, manifest };
}

/** Load and cryptographically verify the current manifest without hydration. */
export async function loadGitManifest(
  store: GitObjectStore,
  communityId: string,
  owner: string,
  repo: string,
): Promise<
  | { readonly manifest: GitManifest; readonly pointer: GitPointerState }
  | undefined
> {
  const pointer = await store.getPointer(
    gitPointerKey(communityId, owner, repo),
  );
  if (!pointer) return undefined;
  const bytes = await store.getImmutable(
    `manifests/${pointer.digest}`,
    MAX_MANIFEST_BYTES,
  );
  if (gitObjectDigest(bytes) !== pointer.digest) {
    throw new Error("Git manifest digest mismatch");
  }
  return {
    manifest: parseGitManifest(JSON.parse(bytes.toString("utf8")) as unknown),
    pointer,
  };
}

/**
 * Hydrate a verified object-store manifest into a private ephemeral bare
 * repository. Every pack digest, ref, and HEAD is verified before use.
 */
export async function hydrateGitRepository(
  store: GitObjectStore,
  communityId: string,
  owner: string,
  repo: string,
  limits: GitRepositoryLimits,
): Promise<HydratedGitRepository | undefined> {
  validateLimits(limits);
  const loaded = await loadGitManifest(store, communityId, owner, repo);
  if (!loaded) return undefined;
  const scratch = resolve(limits.scratchDirectory ?? tmpdir());
  await mkdir(scratch, { mode: 0o700, recursive: true });
  const path = await mkdtemp(join(scratch, "buzz-git-"));
  try {
    await runGit(
      ["init", "--bare", "--initial-branch=main", path],
      undefined,
      limits.operationTimeoutMs,
      256 * 1024,
    );
    let hydratedBytes = 0;
    for (const packKey of loaded.manifest.packs) {
      const remaining = limits.maxRepoBytes - hydratedBytes;
      if (remaining <= 0) throw new Error("Git repository exceeds size limit");
      const pack = await store.getImmutable(
        packKey,
        Math.min(limits.maxPackBytes, remaining),
      );
      if (gitObjectDigest(pack) !== packKey.slice("packs/".length)) {
        throw new Error("Git pack digest mismatch");
      }
      hydratedBytes += pack.byteLength;
      await runGit(
        [`--git-dir=${path}`, "index-pack", "--stdin", "--fix-thin"],
        pack,
        limits.operationTimeoutMs,
        256 * 1024,
      );
    }
    for (const [refName, oid] of Object.entries(loaded.manifest.refs)) {
      await runGit(
        [`--git-dir=${path}`, "update-ref", refName, oid],
        undefined,
        limits.operationTimeoutMs,
        256 * 1024,
      );
    }
    await runGit(
      [`--git-dir=${path}`, "symbolic-ref", "HEAD", loaded.manifest.head],
      undefined,
      limits.operationTimeoutMs,
      256 * 1024,
    );
    return {
      close: () => rm(path, { force: true, recursive: true }),
      manifest: loaded.manifest,
      parent: loaded.pointer,
      path,
    };
  } catch (error) {
    await rm(path, { force: true, recursive: true });
    throw error;
  }
}

/**
 * Capture all reachable objects into one immutable pack, publish a canonical
 * manifest, then atomically advance the pointer using the hydration ETag.
 */
export async function publishGitRepository(
  store: GitObjectStore,
  communityId: string,
  owner: string,
  repo: string,
  hydrated: HydratedGitRepository,
  limits: GitRepositoryLimits,
): Promise<PublishedGitRepository> {
  validateLimits(limits);
  const refs = await snapshotRefs(hydrated.path, limits.operationTimeoutMs);
  const head = await symbolicHead(hydrated.path, limits.operationTimeoutMs);
  const packs: string[] = [];
  const oids = Object.values(refs);
  if (oids.length > 0) {
    const pack = await runGit(
      [`--git-dir=${hydrated.path}`, "pack-objects", "--stdout", "--revs"],
      Buffer.from(`${oids.join("\n")}\n`, "utf8"),
      limits.operationTimeoutMs,
      limits.maxPackBytes,
    );
    if (pack.stdout.byteLength > limits.maxRepoBytes) {
      throw new Error("Git repository exceeds configured size");
    }
    const digest = gitObjectDigest(pack.stdout);
    const key = `packs/${digest}`;
    await store.putImmutable(key, pack.stdout);
    packs.push(key);
  }
  const manifest: GitManifest = {
    head,
    packs,
    parent: hydrated.parent.digest,
    refs,
    version: 1,
  };
  const bytes = canonicalGitManifestBytes(manifest);
  const manifestDigest = gitObjectDigest(bytes);
  await store.putImmutable(`manifests/${manifestDigest}`, bytes);
  const precondition: GitPointerPrecondition = {
    etag: hydrated.parent.etag,
    type: "replace",
  };
  const result = await store.compareAndSwapPointer(
    gitPointerKey(communityId, owner, repo),
    manifestDigest,
    precondition,
  );
  if (!result.won) throw new GitPublishConflictError();
  return { manifest, manifestDigest };
}

/**
 * Install the fixed fail-closed pre-receive hook in a hydrated repository.
 * Return the exact runtime bindings so Git never resolves Node through an
 * operator-controlled PATH or a toolchain bootstrap shim.
 */
export async function installGitPolicyHook(
  path: string,
): Promise<Readonly<Record<string, string>>> {
  const hooks = join(path, "hooks");
  await mkdir(hooks, { mode: 0o700, recursive: true });
  const script = join(hooks, "pre-receive.cjs");
  await writeFile(script, PRE_RECEIVE_SCRIPT, { mode: 0o600 });
  const hook = join(hooks, "pre-receive");
  await writeFile(hook, PRE_RECEIVE_RUNNER, { mode: 0o700 });
  await chmod(hook, 0o700);
  return {
    BUZZ_HOOK_SCRIPT: script,
    BUZZ_NODE_EXECUTABLE: process.execPath,
  };
}

/** Execute a Git subprocess with a bounded output buffer and hardened env. */
export async function runGit(
  args: readonly string[],
  input: Uint8Array | undefined,
  timeoutMs: number,
  maximumOutputBytes: number,
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<{ readonly stderr: Buffer; readonly stdout: Buffer }> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(maximumOutputBytes) ||
    maximumOutputBytes < 1
  ) {
    throw new Error("invalid Git subprocess bounds");
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("git", [...args], {
      env: hardenedGitEnvironment(extraEnvironment),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectPromise(error);
      else
        resolvePromise({
          stderr: Buffer.concat(stderr),
          stdout: Buffer.concat(stdout),
        });
    };
    const overflow = (stream: "stdout" | "stderr"): void => {
      child.kill("SIGKILL");
      finish(new Error(`Git ${stream} exceeded configured limit`));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maximumOutputBytes) overflow("stdout");
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 1024 * 1024) overflow("stderr");
      else stderr.push(Buffer.from(chunk));
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          new Error(
            `Git exited ${code ?? signal ?? "unknown"}: ${Buffer.concat(stderr)
              .toString("utf8")
              .slice(0, 8_192)}`,
          ),
        );
      } else finish();
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Git operation timed out"));
    }, timeoutMs);
    timeout.unref();
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Build the minimal, deterministic environment shared by all Git children. */
export function hardenedGitEnvironment(
  extraEnvironment: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_PROTOCOL_FROM_USER: "0",
    HOME: "/nonexistent",
    LANG: "C",
    LC_ALL: "C",
    ...extraEnvironment,
  };
}

async function snapshotRefs(
  path: string,
  timeoutMs: number,
): Promise<Readonly<Record<string, string>>> {
  const result = await runGit(
    [
      `--git-dir=${path}`,
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
    ],
    undefined,
    timeoutMs,
    MAX_REF_SNAPSHOT_BYTES,
  );
  const refs: Record<string, string> = {};
  const lines = result.stdout.toString("utf8").split("\n").filter(Boolean);
  if (lines.length > 10_000)
    throw new Error("Git repository has too many refs");
  for (const line of lines) {
    const separator = line.indexOf("\0");
    const name = line.slice(0, separator);
    const oid = line.slice(separator + 1);
    if (
      separator < 1 ||
      !isSafeGitRefname(name) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)
    ) {
      throw new Error("Git produced an invalid ref snapshot");
    }
    refs[name] = oid;
  }
  return Object.fromEntries(
    Object.entries(refs).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function symbolicHead(path: string, timeoutMs: number): Promise<string> {
  try {
    const result = await runGit(
      [`--git-dir=${path}`, "symbolic-ref", "HEAD"],
      undefined,
      timeoutMs,
      4_096,
    );
    const value = result.stdout.toString("utf8").trim();
    if (!isSafeGitRefname(value)) throw new Error("invalid Git HEAD");
    return value;
  } catch {
    return DEFAULT_GIT_HEAD;
  }
}

function validateLimits(limits: GitRepositoryLimits): void {
  for (const value of [
    limits.maxPackBytes,
    limits.maxRepoBytes,
    limits.operationTimeoutMs,
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error("Git repository limits must be positive integers");
    }
  }
  if (limits.maxPackBytes > limits.maxRepoBytes) {
    throw new Error("Git pack limit cannot exceed repository limit");
  }
}

// Git invokes this minimal fixed runner directly. Quoted environment expansion
// keeps executable and script paths safe even when their directories contain
// spaces, and avoids resolving Node through PATH.
const PRE_RECEIVE_RUNNER = `#!/bin/sh
set -eu
exec "$BUZZ_NODE_EXECUTABLE" "$BUZZ_HOOK_SCRIPT"
`;

// All variable values are relay-generated fixed-shape strings and passed
// through environment, never interpolated into this source.
const PRE_RECEIVE_SCRIPT = `"use strict";
const crypto = require("node:crypto");
const cp = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const required = ["BUZZ_HOOK_URL","BUZZ_HOOK_SECRET","BUZZ_REPO_ID","BUZZ_REPO_OWNER","BUZZ_COMMUNITY_ID","BUZZ_PUSHER_PUBKEY"];
for (const key of required) if (!process.env[key]) process.exit(1);
const lines = fs.readFileSync(0, "utf8").split("\\n").filter(Boolean);
if (lines.length < 1 || lines.length > 500) process.exit(1);
const zero = "0".repeat(40);
const ref_updates = lines.map((line) => {
  const parts = line.split(" ");
  if (parts.length !== 3) process.exit(1);
  const [old_oid, new_oid, ref_name] = parts;
  let is_ancestor = false;
  if (old_oid !== zero && new_oid !== zero) {
    const result = cp.spawnSync("git", ["merge-base", "--is-ancestor", old_oid, new_oid], { stdio: "ignore", timeout: 5000 });
    is_ancestor = result.status === 0;
  }
  return { old_oid, new_oid, ref_name, is_ancestor };
});
const timestamp = Math.floor(Date.now() / 1000);
const base = {
  repo_id: process.env.BUZZ_REPO_ID,
  repo_owner: process.env.BUZZ_REPO_OWNER,
  community_id: process.env.BUZZ_COMMUNITY_ID,
  pusher_pubkey: process.env.BUZZ_PUSHER_PUBKEY,
  ref_updates,
  timestamp
};
let payload = Buffer.byteLength(base.repo_id) + ":" + base.repo_id + "|" + base.repo_owner + "|" + base.community_id + "|" + base.pusher_pubkey + "|";
for (const update of [...ref_updates].sort((a,b) => Buffer.from(a.ref_name).compare(Buffer.from(b.ref_name)))) {
  payload += update.old_oid + update.new_oid + Buffer.byteLength(update.ref_name) + ":" + update.ref_name + (update.is_ancestor ? "1" : "0");
}
payload += "|" + timestamp;
const signature = crypto.createHmac("sha256", Buffer.from(process.env.BUZZ_HOOK_SECRET, "hex")).update(payload).digest("hex");
const body = Buffer.from(JSON.stringify({ ...base, signature }));
const url = new URL(process.env.BUZZ_HOOK_URL);
const request = http.request({
  hostname: "127.0.0.1",
  port: url.port,
  path: url.pathname,
  method: "POST",
  headers: { "content-type": "application/json", "content-length": body.length },
  timeout: 10000,
}, (response) => {
  const chunks = [];
  response.on("data", (chunk) => chunks.push(chunk));
  response.on("end", () => {
    if (response.statusCode !== 200) {
      process.stderr.write("push denied by Buzz policy\\n" + Buffer.concat(chunks).toString("utf8").slice(0, 8192));
      process.exit(1);
    }
  });
});
request.on("timeout", () => request.destroy(new Error("timeout")));
request.on("error", () => process.exit(1));
request.end(body);
`;
