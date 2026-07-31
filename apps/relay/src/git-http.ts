import type { IncomingMessage, ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import {
  KIND_GIT_REPO_ANNOUNCEMENT,
  unixNow,
  type NostrEvent,
} from "@buzz/core";
import type { RelayAccessPolicy } from "@buzz/db";
import { RemoteProtocolError } from "@buzz/remote-agent-protocol";
import type { Pool, PoolClient } from "pg";

import { authenticateGitNip98 } from "./nip98.js";
import {
  GitPublishConflictError,
  ensureGitRepositoryPointer,
  hardenedGitEnvironment,
  hydrateGitRepository,
  installGitPolicyHook,
  publishGitRepository,
  runGit,
  type GitRepositoryLimits,
} from "./git-repository.js";
import type { GitObjectStore } from "./git-store.js";
import {
  evaluateGitPush,
  parseGitProtectionRules,
  validateGitPolicyRequest,
  verifyGitPolicyRequest,
  type GitPolicyRequest,
  type GitRole,
} from "./git-policy.js";
import { validateGitRepoName } from "./git-manifest.js";

const INFO_REFS_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const RECEIVE_PACK_MAX_OUTPUT_BYTES = 1024 * 1024;
const UPLOAD_PACK_MAX_INPUT_BYTES = 64 * 1024 * 1024;

/** Ref-state data emitted only after an object-store commit has succeeded. */
export type GitRefState = {
  readonly actorPubkey: string;
  readonly head: string;
  readonly refs: Readonly<Record<string, string>>;
  readonly repoId: string;
};

/** Complete tenant-bound Git Smart HTTP service configuration. */
export type RelayGitHttpOptions = {
  readonly accessPolicy: RelayAccessPolicy;
  readonly community: string;
  readonly communityId: string;
  readonly hookSecret: Uint8Array;
  readonly limits: GitRepositoryLimits;
  readonly maxConcurrentOperations: number;
  readonly maxRepositoriesPerOwner: number;
  /** Deployment-wide gate shared by every dynamically resolved tenant. */
  readonly operationGate?: GitOperationGate;
  readonly onRefState: (state: GitRefState) => Promise<void>;
  readonly pool: Pool;
  readonly publicUrl: URL;
  readonly store: GitObjectStore;
  /** Optional deployment-wide one-shot object-store conformance probe. */
  readonly storeReadiness?: () => Promise<void>;
};

type RepositoryAnnouncement = {
  readonly channelId: string;
  readonly tags: readonly (readonly string[])[];
};

/**
 * Tenant-bound Git Smart HTTP handler backed by immutable packs/manifests and
 * a conditional repository pointer.
 */
export class RelayGitHttp {
  readonly #operationGate: GitOperationGate;

  public constructor(private readonly options: RelayGitHttpOptions) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        options.communityId,
      ) ||
      options.hookSecret.byteLength < 32 ||
      !Number.isSafeInteger(options.maxRepositoriesPerOwner) ||
      options.maxRepositoriesPerOwner < 1
    ) {
      throw new Error("invalid Git HTTP configuration");
    }
    this.#operationGate =
      options.operationGate ??
      new GitOperationGate(options.maxConcurrentOperations);
  }

  /** Verify conditional-write semantics before accepting Git traffic. */
  public async ready(): Promise<void> {
    await (this.options.storeReadiness?.() ?? this.options.store.probe());
  }

  /**
   * Handle the loopback-only pre-receive policy callback. This must run before
   * public Host routing because the hook deliberately addresses 127.0.0.1.
   */
  public async handleInternal(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (request.url !== "/internal/git/policy") return false;
    if (
      request.method !== "POST" ||
      !isLoopback(request.socket.remoteAddress)
    ) {
      text(response, 404, "not found");
      return true;
    }
    try {
      const body = await readBoundedBody(request, 256 * 1024);
      const policy = validateGitPolicyRequest(
        JSON.parse(body.toString("utf8")) as unknown,
      );
      await this.authorizePolicy(policy);
      json(response, 200, { allowed: true, denials: [] });
    } catch (error) {
      json(response, 403, {
        allowed: false,
        denials: [
          {
            reason: safeErrorMessage(error),
            ref_name: "*",
          },
        ],
      });
    }
    return true;
  }

  /** Handle one authenticated public Git Smart HTTP request. */
  public async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const parsed = parseGitPath(request.url);
    if (!parsed) return false;
    if (!/^[0-9a-f]{64}$/.test(parsed.owner)) {
      text(response, 400, "invalid owner");
      return true;
    }
    let repoId: string;
    try {
      repoId = validateGitRepoName(parsed.repo);
    } catch {
      text(response, 400, "invalid repository");
      return true;
    }
    try {
      const identity = authenticateGitNip98({
        authorizationHeader: request.headers.authorization,
        now: unixNow(),
        repositoryUrl: this.repositoryPublicUrl(parsed.owner, parsed.repo),
      });
      if (
        !(await this.options.accessPolicy.canConnect(
          this.options.community,
          identity.pubkey,
          identity.ownerPubkey,
        ))
      ) {
        throw new GitHttpError(403, "restricted: not a relay member");
      }
      await this.authorizeRead(parsed.owner, repoId, identity.pubkey);
      const release = this.#operationGate.tryAcquire();
      if (!release) {
        response.setHeader("Retry-After", "1");
        throw new GitHttpError(503, "Git service is busy");
      }
      try {
        if (parsed.operation === "info-refs" && request.method === "GET") {
          await this.infoRefs(request, response, parsed.owner, parsed.repo);
        } else if (
          parsed.operation === "upload-pack" &&
          request.method === "POST"
        ) {
          await this.uploadPack(request, response, parsed.owner, parsed.repo);
        } else if (
          parsed.operation === "receive-pack" &&
          request.method === "POST"
        ) {
          await this.receivePack(
            request,
            response,
            parsed.owner,
            parsed.repo,
            repoId,
            identity.pubkey,
          );
        } else {
          throw new GitHttpError(405, "method not allowed");
        }
      } finally {
        release();
      }
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
      } else {
        const status =
          error instanceof GitHttpError
            ? error.status
            : error instanceof RemoteProtocolError
              ? error.code === "CAPABILITY_DENIED"
                ? 403
                : 401
              : 500;
        if (status === 401) {
          response.setHeader(
            "WWW-Authenticate",
            `Nostr realm="buzz", method="${request.method ?? "GET"}"`,
          );
        }
        text(
          response,
          status,
          status === 500 ? "Git backend error" : safeErrorMessage(error),
        );
      }
    }
    return true;
  }

  /** Validate a repository announcement before it reaches durable storage. */
  public validateAnnouncement(event: NostrEvent): void {
    if (event.kind !== KIND_GIT_REPO_ANNOUNCEMENT) return;
    validateGitRepoName(exactTag(event, "d"));
    const channelId = firstTag(event, "buzz-channel");
    if (!channelId || !isUuid(channelId)) {
      throw new Error("Git repository announcement needs a channel binding");
    }
    parseGitProtectionRules(event.tags);
  }

  /**
   * Apply the repository-name reservation and pointer seed after a kind:30617
   * event commits. Fresh announcements emit one empty kind:30618 state.
   */
  public async onEventStored(event: NostrEvent): Promise<void> {
    if (event.kind !== KIND_GIT_REPO_ANNOUNCEMENT) return;
    this.validateAnnouncement(event);
    const repoId = validateGitRepoName(exactTag(event, "d"));
    const fresh = await this.reserveRepositoryName(event.pubkey, repoId);
    try {
      await ensureGitRepositoryPointer(
        this.options.store,
        this.options.communityId,
        event.pubkey,
        repoId,
        fresh,
      );
    } catch (error) {
      if (fresh) await this.releaseRepositoryName(event.pubkey, repoId);
      throw error;
    }
    if (fresh) {
      await this.options
        .onRefState({
          actorPubkey: event.pubkey,
          head: "refs/heads/main",
          refs: {},
          repoId,
        })
        .catch(() => undefined);
    }
  }

  private async infoRefs(
    request: IncomingMessage,
    response: ServerResponse,
    owner: string,
    repo: string,
  ): Promise<void> {
    const url = new URL(request.url ?? "", "http://localhost");
    const service = url.searchParams.get("service");
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      throw new GitHttpError(400, "invalid Git service");
    }
    const hydrated = await hydrateGitRepository(
      this.options.store,
      this.options.communityId,
      owner,
      repo,
      this.options.limits,
    );
    if (!hydrated) throw new GitHttpError(404, "repository not found");
    try {
      const subcommand = service.slice("git-".length);
      const output = await runGit(
        [subcommand, "--stateless-rpc", "--advertise-refs", hydrated.path],
        undefined,
        this.options.limits.operationTimeoutMs,
        INFO_REFS_MAX_OUTPUT_BYTES,
      );
      const serviceLine = Buffer.from(`# service=${service}\n`, "utf8");
      const prefix = Buffer.from(
        `${(serviceLine.byteLength + 4).toString(16).padStart(4, "0")}`,
        "ascii",
      );
      response.statusCode = 200;
      response.setHeader(
        "Content-Type",
        `application/x-${service}-advertisement`,
      );
      response.setHeader("Cache-Control", "no-cache");
      response.end(
        Buffer.concat([
          prefix,
          serviceLine,
          Buffer.from("0000"),
          output.stdout,
        ]),
      );
    } finally {
      await hydrated.close();
    }
  }

  private async uploadPack(
    request: IncomingMessage,
    response: ServerResponse,
    owner: string,
    repo: string,
  ): Promise<void> {
    requireContentType(request, "application/x-git-upload-pack-request");
    rejectOversizedContentLength(request, UPLOAD_PACK_MAX_INPUT_BYTES);
    const hydrated = await hydrateGitRepository(
      this.options.store,
      this.options.communityId,
      owner,
      repo,
      this.options.limits,
    );
    if (!hydrated) throw new GitHttpError(404, "repository not found");
    try {
      response.statusCode = 200;
      response.setHeader(
        "Content-Type",
        "application/x-git-upload-pack-result",
      );
      response.setHeader("Cache-Control", "no-cache");
      await streamGitHttpResponse({
        args: ["upload-pack", "--stateless-rpc", hydrated.path],
        maximumInputBytes: UPLOAD_PACK_MAX_INPUT_BYTES,
        maximumOutputBytes: this.options.limits.maxRepoBytes,
        request,
        response,
        timeoutMs: this.options.limits.operationTimeoutMs,
      });
    } finally {
      await hydrated.close();
    }
  }

  private async receivePack(
    request: IncomingMessage,
    response: ServerResponse,
    owner: string,
    repo: string,
    repoId: string,
    pusher: string,
  ): Promise<void> {
    requireContentType(request, "application/x-git-receive-pack-request");
    rejectOversizedContentLength(request, this.options.limits.maxPackBytes);
    const hydrated = await hydrateGitRepository(
      this.options.store,
      this.options.communityId,
      owner,
      repo,
      this.options.limits,
    );
    if (!hydrated) throw new GitHttpError(404, "repository not found");
    try {
      const hookEnvironment = await installGitPolicyHook(hydrated.path);
      const hookPort = request.socket.localPort;
      if (!hookPort) throw new Error("Git policy callback port unavailable");
      const output = await runGitHttpBuffered({
        args: ["receive-pack", "--stateless-rpc", hydrated.path],
        environment: {
          ...hookEnvironment,
          BUZZ_COMMUNITY_ID: this.options.communityId,
          BUZZ_HOOK_SECRET: Buffer.from(this.options.hookSecret).toString(
            "hex",
          ),
          BUZZ_HOOK_URL: `http://127.0.0.1:${hookPort}/internal/git/policy`,
          BUZZ_PUSHER_PUBKEY: pusher,
          BUZZ_REPO_ID: repoId,
          BUZZ_REPO_OWNER: owner,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "core.hooksPath",
          GIT_CONFIG_VALUE_0: `${hydrated.path}/hooks`,
        },
        maximumInputBytes: this.options.limits.maxPackBytes,
        maximumOutputBytes: RECEIVE_PACK_MAX_OUTPUT_BYTES,
        request,
        timeoutMs: this.options.limits.operationTimeoutMs,
      });
      if (!receivePackRejected(output.stdout)) {
        let published;
        try {
          published = await publishGitRepository(
            this.options.store,
            this.options.communityId,
            owner,
            repo,
            hydrated,
            this.options.limits,
          );
        } catch (error) {
          if (error instanceof GitPublishConflictError) {
            throw new GitHttpError(
              409,
              "push superseded by a concurrent writer; pull and retry",
            );
          }
          throw error;
        }
        if (published.manifestDigest !== hydrated.parent.digest) {
          await this.options
            .onRefState({
              actorPubkey: pusher,
              head: published.manifest.head,
              refs: published.manifest.refs,
              repoId,
            })
            .catch(() => undefined);
        }
      }
      response.statusCode = 200;
      response.setHeader(
        "Content-Type",
        "application/x-git-receive-pack-result",
      );
      response.setHeader("Cache-Control", "no-cache");
      response.end(output.stdout);
    } finally {
      await hydrated.close();
    }
  }

  private async authorizeRead(
    owner: string,
    repoId: string,
    caller: string,
  ): Promise<void> {
    const announcement = await this.loadAnnouncement(owner, repoId);
    if (!announcement) throw new GitHttpError(404, "repository not found");
    const membership = await this.options.pool.query(
      `SELECT 1
       FROM channel_members
       WHERE community_id = $1::uuid
         AND channel_id = $2::uuid
         AND pubkey = decode($3, 'hex')
         AND removed_at IS NULL
         AND role::text = ANY($4::text[])
       LIMIT 1`,
      [
        this.options.communityId,
        announcement.channelId,
        caller,
        ["owner", "admin", "member", "guest", "bot"],
      ],
    );
    if (membership.rowCount !== 1) {
      throw new GitHttpError(404, "repository not found");
    }
  }

  private async authorizePolicy(policy: GitPolicyRequest): Promise<void> {
    if (
      policy.community_id !== this.options.communityId ||
      !verifyGitPolicyRequest(this.options.hookSecret, policy)
    ) {
      throw new Error("Git policy authentication failed");
    }
    const now = unixNow();
    if (policy.timestamp < now - 30 || policy.timestamp > now + 5) {
      throw new Error("Git policy callback expired");
    }
    const announcement = await this.loadAnnouncement(
      policy.repo_owner,
      policy.repo_id,
    );
    if (!announcement) throw new Error("repository not found");
    const channel = await this.options.pool.query<{
      readonly archived: boolean;
    }>(
      `SELECT archived_at IS NOT NULL AS archived
       FROM channels
       WHERE community_id = $1::uuid
         AND id = $2::uuid
         AND deleted_at IS NULL
       LIMIT 1`,
      [this.options.communityId, announcement.channelId],
    );
    if (!channel.rows[0] || channel.rows[0].archived) {
      throw new Error("channel is archived or unavailable");
    }
    const role = await this.resolvePusherRole(
      policy.repo_owner,
      policy.pusher_pubkey,
      announcement.channelId,
    );
    const rules = parseGitProtectionRules(announcement.tags);
    const denials = evaluateGitPush(policy.ref_updates, role, rules);
    if (denials.length > 0) {
      throw new Error(
        denials
          .map((denial) => `${denial.ref_name}: ${denial.reason}`)
          .join("\n"),
      );
    }
  }

  private async loadAnnouncement(
    owner: string,
    repoId: string,
  ): Promise<RepositoryAnnouncement | undefined> {
    const result = await this.options.pool.query<{
      readonly tags: unknown;
    }>(
      `SELECT tags
       FROM events
       WHERE community_id = $1::uuid
         AND kind = $2
         AND pubkey = decode($3, 'hex')
         AND d_tag = $4
         AND channel_id IS NULL
         AND deleted_at IS NULL
       ORDER BY created_at DESC, id ASC
       LIMIT 1`,
      [this.options.communityId, KIND_GIT_REPO_ANNOUNCEMENT, owner, repoId],
    );
    const tags = parseTags(result.rows[0]?.tags);
    if (!tags) return undefined;
    const channelId = tags.find((tag) => tag[0] === "buzz-channel")?.[1];
    return channelId && isUuid(channelId) ? { channelId, tags } : undefined;
  }

  private async resolvePusherRole(
    repoOwner: string,
    pusher: string,
    channelId: string,
  ): Promise<GitRole> {
    if (repoOwner === pusher) return "owner";
    const managedOwner = await this.options.pool.query(
      `SELECT 1
       FROM users
       WHERE community_id = $1::uuid
         AND pubkey = decode($2, 'hex')
         AND agent_owner_pubkey = decode($3, 'hex')
         AND deactivated_at IS NULL
       LIMIT 1`,
      [this.options.communityId, repoOwner, pusher],
    );
    if (managedOwner.rowCount === 1) return "owner";
    const result = await this.options.pool.query<{ readonly role: GitRole }>(
      `SELECT role::text AS role
       FROM channel_members
       WHERE community_id = $1::uuid
         AND channel_id = $2::uuid
         AND pubkey = decode($3, 'hex')
         AND removed_at IS NULL
       LIMIT 1`,
      [this.options.communityId, channelId, pusher],
    );
    const role = result.rows[0]?.role;
    if (
      role !== "owner" &&
      role !== "admin" &&
      role !== "member" &&
      role !== "guest" &&
      role !== "bot"
    ) {
      throw new Error("pusher is not a channel member");
    }
    return role;
  }

  private async reserveRepositoryName(
    owner: string,
    repoId: string,
  ): Promise<boolean> {
    const client = await this.options.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${this.options.communityId}:${owner}`],
      );
      const existing = await client.query<{ readonly owner: string }>(
        `SELECT owner_pubkey AS owner
         FROM git_repo_names
         WHERE community_id = $1::uuid AND repo_id = $2
         FOR UPDATE`,
        [this.options.communityId, repoId],
      );
      const heldBy = existing.rows[0]?.owner;
      if (heldBy) {
        if (heldBy !== owner) throw new Error("Git repository name is taken");
        await client.query("COMMIT");
        return false;
      }
      const count = await client.query<{ readonly count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM git_repo_names
         WHERE community_id = $1::uuid AND owner_pubkey = $2`,
        [this.options.communityId, owner],
      );
      if (
        Number(count.rows[0]?.count ?? "0") >=
        this.options.maxRepositoriesPerOwner
      ) {
        throw new Error("Git repository quota exceeded");
      }
      const inserted = await client.query<{ readonly owner: string }>(
        `INSERT INTO git_repo_names (community_id, repo_id, owner_pubkey)
         VALUES ($1::uuid, $2, $3)
         ON CONFLICT (community_id, repo_id) DO NOTHING
         RETURNING owner_pubkey AS owner`,
        [this.options.communityId, repoId, owner],
      );
      if (inserted.rowCount !== 1) {
        const winner = await client.query<{ readonly owner: string }>(
          `SELECT owner_pubkey AS owner
           FROM git_repo_names
           WHERE community_id = $1::uuid AND repo_id = $2`,
          [this.options.communityId, repoId],
        );
        if (winner.rows[0]?.owner !== owner) {
          throw new Error("Git repository name is taken");
        }
        await client.query("COMMIT");
        return false;
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  private async releaseRepositoryName(
    owner: string,
    repoId: string,
  ): Promise<void> {
    await this.options.pool.query(
      `DELETE FROM git_repo_names
       WHERE community_id = $1::uuid
         AND repo_id = $2
         AND owner_pubkey = $3`,
      [this.options.communityId, repoId, owner],
    );
  }

  private repositoryPublicUrl(owner: string, repo: string): string {
    const base = new URL(this.options.publicUrl);
    base.protocol = base.protocol === "wss:" ? "https:" : "http:";
    base.pathname = `/git/${owner}/${repo}`;
    base.search = "";
    base.hash = "";
    return base.toString();
  }
}

class GitHttpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Non-blocking deployment-wide bound for expensive Git subprocesses. */
export class GitOperationGate {
  #available: number;

  public constructor(permits: number) {
    if (!Number.isSafeInteger(permits) || permits < 1) {
      throw new Error("Git concurrency must be a positive integer");
    }
    this.#available = permits;
  }

  public tryAcquire(): (() => void) | undefined {
    if (this.#available < 1) return undefined;
    this.#available -= 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#available += 1;
    };
  }
}

function parseGitPath(value: string | undefined):
  | {
      readonly operation: "info-refs" | "receive-pack" | "upload-pack";
      readonly owner: string;
      readonly repo: string;
    }
  | undefined {
  if (!value) return undefined;
  const url = new URL(value, "http://localhost");
  let match = /^\/git\/([^/]+)\/([^/]+)\/info\/refs$/.exec(url.pathname);
  if (match?.[1] && match[2]) {
    return { operation: "info-refs", owner: match[1], repo: match[2] };
  }
  match = /^\/git\/([^/]+)\/([^/]+)\/git-(upload|receive)-pack$/.exec(
    url.pathname,
  );
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return {
    operation: match[3] === "upload" ? "upload-pack" : "receive-pack",
    owner: match[1],
    repo: match[2],
  };
}

function receivePackRejected(bytes: Buffer): boolean {
  let offset = 0;
  while (offset + 4 <= bytes.byteLength) {
    const encodedLength = bytes.subarray(offset, offset + 4).toString("ascii");
    if (!/^[0-9a-f]{4}$/i.test(encodedLength)) return true;
    const length = Number.parseInt(encodedLength, 16);
    offset += 4;
    if (length === 0) continue;
    if (length < 4 || offset + length - 4 > bytes.byteLength) return true;
    let payload = bytes.subarray(offset, offset + length - 4);
    offset += length - 4;
    if (payload[0] === 1 || payload[0] === 2 || payload[0] === 3) {
      payload = payload.subarray(1);
    }
    if (payload.toString("utf8").startsWith("ng ")) return true;
  }
  return offset !== bytes.byteLength;
}

async function runGitHttpBuffered(input: {
  readonly args: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly maximumInputBytes: number;
  readonly maximumOutputBytes: number;
  readonly request: IncomingMessage;
  readonly timeoutMs: number;
}): Promise<{ readonly stderr: Buffer; readonly stdout: Buffer }> {
  const child = spawn("git", [...input.args], {
    env: hardenedGitEnvironment(input.environment),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > input.maximumOutputBytes) {
      child.kill("SIGKILL");
    } else {
      stdout.push(Buffer.from(chunk));
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > 1024 * 1024) {
      child.kill("SIGKILL");
    } else {
      stderr.push(Buffer.from(chunk));
    }
  });
  try {
    const [status] = await Promise.all([
      waitForGitChild(child, input.timeoutMs),
      pipeGitRequest(input.request, child.stdin, input.maximumInputBytes),
    ]);
    if (stdoutBytes > input.maximumOutputBytes || stderrBytes > 1024 * 1024) {
      throw new Error("Git subprocess output exceeded configured limit");
    }
    if (status !== 0) {
      throw new Error(
        `Git exited ${status}: ${Buffer.concat(stderr)
          .toString("utf8")
          .slice(0, 8_192)}`,
      );
    }
    return {
      stderr: Buffer.concat(stderr),
      stdout: Buffer.concat(stdout),
    };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

async function streamGitHttpResponse(input: {
  readonly args: readonly string[];
  readonly maximumInputBytes: number;
  readonly maximumOutputBytes: number;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly timeoutMs: number;
}): Promise<void> {
  const child = spawn("git", [...input.args], {
    env: hardenedGitEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > 1024 * 1024) child.kill("SIGKILL");
    else stderr.push(Buffer.from(chunk));
  });
  try {
    const [status] = await Promise.all([
      waitForGitChild(child, input.timeoutMs),
      pipeGitRequest(input.request, child.stdin, input.maximumInputBytes),
      pipeline(
        child.stdout,
        byteLimit(input.maximumOutputBytes),
        input.response,
      ),
    ]);
    if (status !== 0 || stderrBytes > 1024 * 1024) {
      throw new Error(
        `Git upload-pack failed: ${Buffer.concat(stderr)
          .toString("utf8")
          .slice(0, 8_192)}`,
      );
    }
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

async function pipeGitRequest(
  request: IncomingMessage,
  target: NodeJS.WritableStream,
  maximumBytes: number,
): Promise<void> {
  const encoding = request.headers["content-encoding"]?.toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") {
    await pipeline(
      request,
      byteLimit(maximumBytes),
      createGunzip(),
      byteLimit(maximumBytes),
      target,
    );
    return;
  }
  await pipeline(request, byteLimit(maximumBytes), target);
}

function byteLimit(maximumBytes: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      if (total > maximumBytes) {
        callback(
          new GitHttpError(
            413,
            "Git request or response exceeds configured limit",
          ),
        );
      } else {
        callback(null, chunk);
      }
    },
  });
}

function waitForGitChild(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Git operation timed out"));
    }, timeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function rejectOversizedContentLength(
  request: IncomingMessage,
  maximumBytes: number,
): void {
  const raw = request.headers["content-length"];
  if (raw === undefined) return;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new GitHttpError(400, "invalid Git Content-Length");
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length > maximumBytes) {
    throw new GitHttpError(413, "Git request body exceeds configured limit");
  }
}

async function readBoundedBody(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Buffer> {
  const length = Number(request.headers["content-length"]);
  if (Number.isFinite(length) && length > maximumBytes) {
    throw new GitHttpError(413, "Git request body exceeds configured limit");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) {
      throw new GitHttpError(413, "Git request body exceeds configured limit");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function requireContentType(request: IncomingMessage, expected: string): void {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== expected) {
    throw new GitHttpError(415, "unsupported Git content type");
  }
}

function parseTags(value: unknown): readonly (readonly string[])[] | undefined {
  if (
    !Array.isArray(value) ||
    value.some(
      (tag) =>
        !Array.isArray(tag) || tag.some((part) => typeof part !== "string"),
    )
  ) {
    return undefined;
  }
  return value as string[][];
}

function exactTag(event: NostrEvent, name: string): string {
  const matches = event.tags.filter((tag) => tag[0] === name);
  if (matches.length !== 1 || matches[0]?.length !== 2 || !matches[0][1]) {
    throw new Error(`Git announcement requires exactly one ${name} tag`);
  }
  return matches[0][1];
}

function firstTag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isLoopback(value: string | undefined): boolean {
  return (
    value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1"
  );
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 8_192) : "denied";
}

function text(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(body);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}
