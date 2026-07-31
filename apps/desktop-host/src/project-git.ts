import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { EventTemplate } from "@buzz/sdk";
import { verifyEvent, type Event } from "nostr-tools";

import type { IdentityService } from "./identity.js";
import type { ManagedAgentService } from "./managed-agents.js";
import type { RelayHttpClient } from "./relay-http.js";
import type { WorkspaceService } from "./workspace.js";

const CREDENTIAL_HELPER = fileURLToPath(
  import.meta.resolve("@buzz/git-credential-nostr/cli"),
);
const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const HEX_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const MAX_PATCH_LINES = 2_000;
const MAX_FILES = 250;
const MAX_COMMITS = 50;

type Credential = {
  authTag: [string, string, string, string] | null;
  nsec: string;
};

type Commit = {
  author_email: string;
  author_name: string;
  hash: string;
  short_hash: string;
  subject: string;
  timestamp: number;
};

type RepoDiff = {
  additions: number;
  commit_body: string | null;
  deletions: number;
  files: Array<{
    additions: number;
    deletions: number;
    patch: string;
    path: string;
    truncated: boolean;
  }>;
};

type SyncStatus = {
  ahead_count: number;
  behind_count: number;
  can_pull: boolean;
  can_push: boolean;
  has_uncommitted_changes: boolean;
  has_untracked_files: boolean;
  local_branch: string | null;
  local_branches: string[];
  local_head: string | null;
  local_path: string | null;
  local_short_head: string | null;
  merge_base: string | null;
  pull_block_reason: string | null;
  push_block_reason: string | null;
  remote_branch: string | null;
  remote_head: string | null;
  remote_short_head: string | null;
};

export class ProjectGitService {
  readonly #identity: IdentityService;
  readonly #managedAgents: ManagedAgentService;
  readonly #relay: RelayHttpClient;
  readonly #workspace: Pick<WorkspaceService, "relayHttpUrl">;
  #gitPath: Promise<string> | undefined;

  constructor(input: {
    identity: IdentityService;
    managedAgents: ManagedAgentService;
    relay: RelayHttpClient;
    workspace: Pick<WorkspaceService, "relayHttpUrl">;
  }) {
    this.#identity = input.identity;
    this.#managedAgents = input.managedAgents;
    this.#relay = input.relay;
    this.#workspace = input.workspace;
  }

  async gitIdentity(): Promise<{ email: string | null; name: string | null }> {
    const read = async (key: string): Promise<string | null> => {
      try {
        const git = await (this.#gitPath ??= resolveExecutable("git"));
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const name of [
          "GIT_DIR",
          "GIT_WORK_TREE",
          "GIT_CONFIG_COUNT",
          "NOSTR_PRIVATE_KEY",
          "BUZZ_AUTH_TAG",
        ]) {
          delete env[name];
        }
        return firstLine(
          await runProcess(git, ["config", "--get", key], {
            env,
            stdin: null,
            timeoutMs: 10_000,
          }),
        );
      } catch {
        return null;
      }
    };
    const [name, email] = await Promise.all([
      read("user.name"),
      read("user.email"),
    ]);
    return { email, name };
  }

  async listLocal(
    args: Record<string, unknown>,
  ): Promise<Array<{ name: string; path: string }>> {
    const roots = await this.#repositoryRoots(args.reposDir, false);
    const seen = new Set<string>();
    const result: Array<{ name: string; path: string }> = [];
    for (const root of roots) {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const candidate = await realpath(path.join(root, entry.name)).catch(
          () => null,
        );
        if (
          !candidate ||
          !inside(root, candidate) ||
          seen.has(candidate) ||
          !(await isGitWorktree(candidate))
        ) {
          continue;
        }
        seen.add(candidate);
        result.push({ name: entry.name, path: candidate });
      }
    }
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  async clone(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cloneUrl = this.#cloneUrl(args.cloneUrl);
    const projectDtag = requireText(args.projectDtag, "projectDtag", 256);
    const branch = optionalBranch(args.defaultBranch, "defaultBranch");
    const existing = await this.#findLocal(
      args.reposDir,
      projectDtag,
      cloneUrl,
    );
    if (existing) {
      return {
        cloned: false,
        message: "Repository is already cloned.",
        path: existing,
      };
    }
    const root = (await this.#repositoryRoots(args.reposDir, true))[0];
    if (!root) throw new Error("reposDir is not accessible");
    const directoryName = repositoryCandidates(projectDtag, cloneUrl)[0];
    if (!directoryName) {
      throw new Error("could not derive a repository directory name");
    }
    const destination = path.join(root, directoryName);
    if (await exists(destination)) {
      throw new Error(
        `${destination} already exists but is not this git checkout`,
      );
    }
    const cloneArgs = ["clone"];
    if (branch) cloneArgs.push("--branch", branch);
    cloneArgs.push("--end-of-options", cloneUrl, destination);
    try {
      await this.#git(cloneArgs, undefined, this.#viewerCredential(), true);
    } catch (error) {
      if (!branch) throw error;
      await this.#git(
        ["clone", "--end-of-options", cloneUrl, destination],
        undefined,
        this.#viewerCredential(),
        true,
      );
    }
    if (branch && !(await this.#hasRef(destination, "HEAD"))) {
      await this.#git(
        ["symbolic-ref", "HEAD", `refs/heads/${branch}`],
        destination,
      );
    }
    return {
      cloned: true,
      message: `Cloned repository to ${destination}.`,
      path: destination,
    };
  }

  async localSnapshot(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const projectDtag = requireText(args.projectDtag, "projectDtag", 256);
    const cloneUrl =
      args.cloneUrl === undefined ||
      args.cloneUrl === null ||
      args.cloneUrl === ""
        ? null
        : this.#cloneUrl(args.cloneUrl);
    const repository = await this.#findLocal(
      args.reposDir,
      projectDtag,
      cloneUrl,
    );
    if (!repository) return null;
    return {
      path: repository,
      snapshot: await this.#snapshot(
        repository,
        optionalBranch(args.defaultBranch, "defaultBranch"),
        optionalBranch(args.baseBranch, "baseBranch"),
      ),
    };
  }

  async remoteSnapshot(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const cloneUrl = this.#cloneUrl(args.cloneUrl);
    return this.#withRemoteCheckout(
      cloneUrl,
      {
        branch: optionalBranch(args.defaultBranch, "defaultBranch"),
        targetCommit: optionalCommit(args.targetCommit, "targetCommit"),
        targetRef: optionalTargetRef(args.targetRef),
      },
      (repository) =>
        this.#snapshot(
          repository,
          optionalBranch(args.defaultBranch, "defaultBranch"),
          optionalBranch(args.baseBranch, "baseBranch"),
        ),
    );
  }

  async localDiff(args: Record<string, unknown>): Promise<RepoDiff | null> {
    const projectDtag = requireText(args.projectDtag, "projectDtag", 256);
    const cloneUrl =
      args.cloneUrl === undefined ||
      args.cloneUrl === null ||
      args.cloneUrl === ""
        ? null
        : this.#cloneUrl(args.cloneUrl);
    const repository = await this.#findLocal(
      args.reposDir,
      projectDtag,
      cloneUrl,
    );
    if (!repository) return null;
    const baseBranch = optionalBranch(args.baseBranch, "baseBranch");
    const targetBranch = optionalBranch(args.defaultBranch, "defaultBranch");
    const baseCommit = optionalCommit(args.baseCommit, "baseCommit");
    const targetCommit = optionalCommit(args.targetCommit, "targetCommit");
    const target = await this.#localTarget(
      repository,
      targetBranch,
      targetCommit,
    );
    let range: string;
    if (baseCommit && (await this.#hasRef(repository, baseCommit))) {
      range = await this.#comparisonRange(repository, baseCommit, target);
    } else if (baseBranch) {
      const base = (await this.#hasRef(repository, `origin/${baseBranch}`))
        ? `origin/${baseBranch}`
        : (await this.#hasRef(repository, baseBranch))
          ? baseBranch
          : null;
      range = base
        ? await this.#comparisonRange(repository, base, target)
        : `${await this.#emptyTree(repository)}..${target}`;
    } else if (targetCommit) {
      range = await this.#commitRange(repository, targetCommit);
    } else {
      range = `${await this.#emptyTree(repository)}..${target}`;
    }
    return this.#diff(
      repository,
      range,
      !baseBranch && !baseCommit ? targetCommit : null,
    );
  }

  async remoteDiff(args: Record<string, unknown>): Promise<RepoDiff> {
    const cloneUrl = this.#cloneUrl(args.cloneUrl);
    const branch = optionalBranch(args.defaultBranch, "defaultBranch");
    const baseBranch = optionalBranch(args.baseBranch, "baseBranch");
    const targetRef = optionalTargetRef(args.targetRef);
    const targetCommit = optionalCommit(args.targetCommit, "targetCommit");
    return this.#withRemoteCheckout(
      cloneUrl,
      { branch, targetCommit, targetRef },
      async (repository) => {
        let range: string;
        if (!targetRef && !baseBranch && targetCommit) {
          range = await this.#commitRange(repository, targetCommit);
        } else if (baseBranch) {
          const refspec = `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`;
          await this.#git(
            ["fetch", "--depth=100", "--end-of-options", "origin", refspec],
            repository,
            this.#viewerCredential(),
            true,
          );
          range = await this.#comparisonRange(
            repository,
            `origin/${baseBranch}`,
            "HEAD",
          );
        } else {
          range = `${await this.#emptyTree(repository)}..HEAD`;
        }
        return this.#diff(
          repository,
          range,
          !targetRef && !baseBranch ? targetCommit : null,
        );
      },
    );
  }

  async syncStatus(args: Record<string, unknown>): Promise<SyncStatus> {
    const cloneUrl = this.#cloneUrl(args.cloneUrl);
    const branch = optionalBranch(args.branchName, "branchName");
    const baseBranch = optionalBranch(args.baseBranch, "baseBranch");
    const projectDtag = requireText(args.projectDtag, "projectDtag", 256);
    const repository = await this.#findLocal(
      args.reposDir,
      projectDtag,
      cloneUrl,
    );
    if (!repository) return missingSyncStatus(branch);
    return this.#compare(repository, cloneUrl, branch, baseBranch);
  }

  async push(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cloneUrl = this.#cloneUrl(args.cloneUrl);
    const repository = await this.#requireLocal(args, cloneUrl);
    const status = await this.#compare(
      repository,
      cloneUrl,
      optionalBranch(args.branchName, "branchName"),
      optionalBranch(args.baseBranch, "baseBranch"),
    );
    if (!status.can_push) {
      throw new Error(
        status.push_block_reason ?? "local checkout cannot be pushed",
      );
    }
    const branch = status.remote_branch;
    const commit = status.local_head;
    if (!branch || !commit)
      throw new Error("no branch or commit selected for push");
    if (status.local_branch !== branch && status.remote_head === null) {
      await this.#git(["branch", "-M", "--", branch], repository);
    }
    await this.#git(
      ["push", "--end-of-options", "origin", `HEAD:${branch}`],
      repository,
      this.#viewerCredential(),
      true,
    );
    return {
      branch,
      commit,
      merge_base: status.merge_base,
      message: `Pushed ${branch} to remote.`,
      pushed: true,
    };
  }

  async pull(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cloneUrl = this.#cloneUrl(args.cloneUrl);
    const repository = await this.#requireLocal(args, cloneUrl);
    const status = await this.#compare(
      repository,
      cloneUrl,
      optionalBranch(args.branchName, "branchName"),
      null,
    );
    if (!status.can_pull) {
      throw new Error(
        status.pull_block_reason ?? "local checkout cannot be pulled",
      );
    }
    const branch = status.remote_branch;
    if (!branch) throw new Error("no branch selected for pull");
    await this.#git(
      ["pull", "--ff-only", "--end-of-options", "origin", branch],
      repository,
      this.#viewerCredential(),
      true,
    );
    return { message: `Pulled ${branch} from remote.`, pulled: true };
  }

  async createRemoteBranch(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const cloneUrl = this.#cloneUrl(args.cloneUrl);
    const sourceBranch = requireBranch(args.sourceBranch, "sourceBranch");
    const expectedCommit = requireCommit(args.expectedCommit, "expectedCommit");
    const newBranch = requireBranch(args.newBranch, "newBranch");
    if (newBranch === sourceBranch) {
      throw new Error("the new branch must have a different name");
    }
    return this.#withTemporaryDirectory(async (directory) => {
      const repository = path.join(directory, "repo.git");
      await this.#git(["init", "--bare", "--", repository]);
      await this.#git(["remote", "add", "--", "origin", cloneUrl], repository);
      await this.#git(
        [
          "fetch",
          "--quiet",
          "--depth=1",
          "--no-tags",
          "--end-of-options",
          "origin",
          `refs/heads/${sourceBranch}`,
        ],
        repository,
        this.#viewerCredential(),
        true,
      );
      const sourceCommit = requireResolvedCommit(
        firstLine(await this.#git(["rev-parse", "FETCH_HEAD"], repository)),
      );
      if (sourceCommit !== expectedCommit) {
        throw new Error(
          "the source branch changed; refresh before creating a branch",
        );
      }
      await this.#git(
        [
          "push",
          `--force-with-lease=refs/heads/${newBranch}:`,
          "--end-of-options",
          "origin",
          `${sourceCommit}:refs/heads/${newBranch}`,
        ],
        repository,
        this.#viewerCredential(),
        true,
      );
      return {
        branch: newBranch,
        commit: sourceCommit,
        message: `Created branch ${newBranch} from ${sourceBranch}.`,
      };
    });
  }

  async deleteRemoteBranch(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const cloneUrl = this.#cloneUrl(args.cloneUrl);
    const branch = requireBranch(args.branch, "branch");
    const expectedCommit = requireCommit(args.expectedCommit, "expectedCommit");
    const head = await this.#git(
      [
        "ls-remote",
        "--symref",
        "--exit-code",
        "--end-of-options",
        cloneUrl,
        "HEAD",
      ],
      undefined,
      this.#viewerCredential(),
      true,
    );
    if (remoteHeadBranch(head) === branch) {
      throw new Error("the repository's default branch cannot be deleted");
    }
    return this.#withTemporaryDirectory(async (directory) => {
      const repository = path.join(directory, "repo.git");
      await this.#git(["init", "--bare", "--", repository]);
      await this.#git(["remote", "add", "--", "origin", cloneUrl], repository);
      await this.#git(
        [
          "push",
          `--force-with-lease=refs/heads/${branch}:${expectedCommit}`,
          "--end-of-options",
          "origin",
          `:refs/heads/${branch}`,
        ],
        repository,
        this.#viewerCredential(),
        true,
      );
      return {
        branch,
        commit: expectedCommit,
        message: `Deleted branch ${branch}.`,
      };
    });
  }

  async openTerminal(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const cloneUrl =
      args.cloneUrl === undefined ||
      args.cloneUrl === null ||
      args.cloneUrl === ""
        ? null
        : this.#cloneUrl(args.cloneUrl);
    const projectDtag = requireText(args.projectDtag, "projectDtag", 256);
    let repository = await this.#findLocal(
      args.reposDir,
      projectDtag,
      cloneUrl,
    );
    let cloned = false;
    if (!repository) {
      if (!cloneUrl)
        throw new Error("no local checkout and no clone URL available");
      const result = await this.clone({
        cloneUrl,
        defaultBranch: args.defaultBranch,
        projectDtag,
        reposDir: args.reposDir,
      });
      repository = requireText(result.path, "clone path", 8_192);
      cloned = result.cloned === true;
    }
    await launchTerminal(repository);
    return { cloned, path: repository };
  }

  async openMergeRecovery(
    argsValue: unknown,
  ): Promise<Record<string, unknown>> {
    const args = requireObject(argsValue, "input");
    const targetCloneUrl = this.#cloneUrl(args.targetCloneUrl);
    const sourceCloneUrl = this.#cloneUrl(args.sourceCloneUrl);
    const targetBranch = requireBranch(args.targetBranch, "targetBranch");
    const sourceBranch = requireBranch(args.sourceBranch, "sourceBranch");
    const expectedCommit = requireCommit(args.expectedCommit, "expectedCommit");
    const projectDtag = requireText(args.projectDtag, "projectDtag", 256);
    let repository = await this.#findLocal(
      args.reposDir,
      projectDtag,
      targetCloneUrl,
    );
    let cloned = false;
    if (!repository) {
      const result = await this.clone({
        cloneUrl: targetCloneUrl,
        defaultBranch: targetBranch,
        projectDtag,
        reposDir: args.reposDir,
      });
      repository = requireText(result.path, "clone path", 8_192);
      cloned = result.cloned === true;
    }
    await this.#git(
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--end-of-options",
        targetCloneUrl,
        targetBranch,
      ],
      repository,
      this.#viewerCredential(),
      true,
    );
    const targetHead = requireResolvedCommit(
      firstLine(await this.#git(["rev-parse", "FETCH_HEAD"], repository)),
    );
    const targetRef = `refs/buzz/merge-recovery-target/${targetHead}`;
    await this.#git(["update-ref", targetRef, targetHead], repository);
    await this.#git(
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--end-of-options",
        sourceCloneUrl,
        sourceBranch,
      ],
      repository,
      this.#viewerCredential(),
      true,
    );
    const sourceHead = requireResolvedCommit(
      firstLine(await this.#git(["rev-parse", "FETCH_HEAD"], repository)),
    );
    if (sourceHead !== expectedCommit) {
      throw new Error(
        "the pull request branch changed; refresh before recovery",
      );
    }
    const recoveryRef = `refs/buzz/merge-recovery/${expectedCommit}`;
    await this.#git(["update-ref", recoveryRef, expectedCommit], repository);
    await launchTerminal(repository);
    return { cloned, path: repository, recoveryRef, targetRef };
  }

  async signStatus(inputValue: unknown): Promise<void> {
    const input = requireObject(inputValue, "input");
    const owner = requirePubkey(input.targetOwner, "targetOwner");
    const repository = requireRepoAddress(input.repoAddress, owner);
    const pullRequestId = requirePubkey(input.pullRequestId, "pullRequestId");
    const author = requirePubkey(input.pullRequestAuthor, "pullRequestAuthor");
    const status = input.status;
    const kind =
      status === "open"
        ? 1_630
        : status === "closed"
          ? 1_632
          : status === "draft"
            ? 1_633
            : null;
    if (kind === null) throw new Error("invalid pull request lifecycle status");
    const tags = statusTags(repository, pullRequestId, owner, author);
    await this.#publishOwner(owner, {
      content: "",
      kind,
      tags,
    });
  }

  async signReviewRequest(inputValue: unknown): Promise<void> {
    const input = requireObject(inputValue, "input");
    const owner = requirePubkey(input.targetOwner, "targetOwner");
    const repository = requireRepoAddress(input.repoAddress, owner);
    const pullRequestId = requirePubkey(input.pullRequestId, "pullRequestId");
    if (
      !Array.isArray(input.reviewers) ||
      input.reviewers.length < 1 ||
      input.reviewers.length > 50
    ) {
      throw new Error("select between 1 and 50 reviewers");
    }
    const reviewers = [
      ...new Set(
        input.reviewers.map((item) => requirePubkey(item, "reviewer")),
      ),
    ].sort();
    const label = requireText(input.reviewerLabel, "reviewerLabel", 512);
    if ([...label].length > 128)
      throw new Error("reviewerLabel exceeds 128 characters");
    await this.#publishOwner(owner, {
      content: `Requested a review from ${label}`,
      kind: 1,
      tags: [
        ["e", pullRequestId, "", "root"],
        ["a", repository],
        ...reviewers.map((reviewer) => ["p", reviewer]),
        ["t", "review-request"],
      ],
    });
  }

  async publishMergedStatus(inputValue: unknown): Promise<void> {
    const input = requireObject(inputValue, "input");
    const owner = requirePubkey(input.targetOwner, "targetOwner");
    const raw = requireText(input.statusEvent, "statusEvent", 1024 * 1024);
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Event).kind !== 1_631 ||
      (parsed as Event).pubkey !== owner ||
      !verifyEvent(parsed as Event)
    ) {
      throw new Error("invalid merged pull request status event");
    }
    if (owner === this.#identity.info().pubkey) {
      await this.#relay.publish(parsed as Event);
    } else {
      await this.#managedAgents.publishSignedAsAgent(owner, parsed as Event);
    }
  }

  async merge(inputValue: unknown): Promise<Record<string, unknown>> {
    const input = requireObject(inputValue, "input");
    const targetCloneUrl = this.#cloneUrl(input.targetCloneUrl);
    const sourceCloneUrl = this.#cloneUrl(input.sourceCloneUrl);
    const owner = requirePubkey(input.targetOwner, "targetOwner");
    if (cloneUrlOwner(targetCloneUrl) !== owner) {
      throw new Error("target clone URL does not match the repository owner");
    }
    const repositoryAddress = requireRepoAddress(input.repoAddress, owner);
    const pullRequestId = requirePubkey(input.pullRequestId, "pullRequestId");
    const pullRequestAuthor = requirePubkey(
      input.pullRequestAuthor,
      "pullRequestAuthor",
    );
    const targetBranch = requireBranch(input.targetBranch, "targetBranch");
    const sourceBranch = requireBranch(input.sourceBranch, "sourceBranch");
    const expectedCommit = requireCommit(
      input.expectedCommit,
      "expectedCommit",
    );
    if (
      normalizeCloneUrl(targetCloneUrl) === normalizeCloneUrl(sourceCloneUrl) &&
      targetBranch === sourceBranch
    ) {
      throw new Error("source and target branches must be different");
    }
    const credential = this.#ownerCredential(owner);
    const gitResult = await this.#withTemporaryDirectory(async (directory) => {
      const checkout = path.join(directory, "repo");
      await this.#git(
        [
          "clone",
          "--filter=blob:none",
          "--no-tags",
          "--branch",
          targetBranch,
          "--single-branch",
          "--end-of-options",
          targetCloneUrl,
          checkout,
        ],
        undefined,
        credential,
        true,
      );
      await this.#git(
        ["fetch", "--quiet", "--end-of-options", sourceCloneUrl, sourceBranch],
        checkout,
        credential,
        true,
      );
      const sourceHead = requireResolvedCommit(
        firstLine(await this.#git(["rev-parse", "FETCH_HEAD"], checkout)),
      );
      if (sourceHead !== expectedCommit) {
        throw structuredError(
          "branch_changed",
          "The pull request branch changed. Refresh before merging.",
        );
      }
      try {
        await this.#git(
          [
            "-c",
            "user.name=Buzz User",
            "-c",
            `user.email=${owner}@users.noreply.buzz`,
            "merge",
            "--no-edit",
            "--end-of-options",
            expectedCommit,
          ],
          checkout,
          credential,
          true,
        );
      } catch (error) {
        const conflicts = await this.#git(
          ["diff", "--name-only", "--diff-filter=U"],
          checkout,
        ).catch(() => "");
        if (conflicts.trim()) {
          throw structuredError(
            "merge_conflict",
            "Pull request has merge conflicts.",
            {
              action: "open_terminal",
              sourceBranch,
              targetBranch,
            },
          );
        }
        throw structuredError(
          "merge_failed",
          `Pull request merge failed: ${safeError(error)}`,
        );
      }
      const mergeCommit = requireResolvedCommit(
        firstLine(await this.#git(["rev-parse", "HEAD"], checkout)),
      );
      await this.#git(
        ["push", "--end-of-options", "origin", `HEAD:${targetBranch}`],
        checkout,
        credential,
        true,
      );
      return {
        mergeCommit,
        message: `Merged ${sourceBranch} into ${targetBranch}.`,
      };
    });
    const template: EventTemplate = {
      content: "",
      kind: 1_631,
      tags: [
        ...statusTags(
          repositoryAddress,
          pullRequestId,
          owner,
          pullRequestAuthor,
        ),
        ["merge-commit", gitResult.mergeCommit],
        ["r", gitResult.mergeCommit],
      ],
    };
    const event = this.#signOwner(owner, template);
    let publicationError: string | null = null;
    try {
      if (owner === this.#identity.info().pubkey)
        await this.#relay.publish(event);
      else await this.#managedAgents.publishSignedAsAgent(owner, event);
    } catch (error) {
      publicationError = safeError(error);
    }
    return {
      merge_commit: gitResult.mergeCommit,
      message: gitResult.message,
      status_event: JSON.stringify(event),
      status_publication_error: publicationError,
    };
  }

  async #snapshot(
    repository: string,
    branch: string | null,
    baseBranch: string | null,
  ): Promise<Record<string, unknown>> {
    const latest = parseCommit(
      firstLine(
        await this.#git(
          ["log", "-1", "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%s"],
          repository,
        ).catch(() => ""),
      ),
    );
    const activityRef =
      branch &&
      baseBranch &&
      branch !== baseBranch &&
      (await this.#hasRef(repository, `origin/${baseBranch}`))
        ? `origin/${baseBranch}..HEAD`
        : "HEAD";
    const commitOutput = latest
      ? await this.#git(
          [
            "log",
            `--max-count=${MAX_COMMITS}`,
            "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%s",
            activityRef,
          ],
          repository,
        ).catch(() => "")
      : "";
    const commits = commitOutput
      .split(/\r?\n/)
      .map(parseCommit)
      .filter((item): item is Commit => item !== null)
      .slice(0, MAX_COMMITS);
    const contributors = aggregateContributors(
      latest
        ? await this.#git(
            ["log", "--format=%an%x00%ae%x00%at", activityRef],
            repository,
          ).catch(() => "")
        : "",
    );
    const latestByPath = latest
      ? parseLatestByPath(
          await this.#git(
            [
              "log",
              "--format=%x1e%H%x00%h%x00%an%x00%ae%x00%at%x00%s",
              "--name-only",
              "--diff-filter=ACMRT",
              "--",
            ],
            repository,
          ).catch(() => ""),
        )
      : new Map<string, Commit>();
    const tracked = await this.#git(
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      repository,
    ).catch(() => "");
    const root = await realpath(repository);
    const files = [];
    for (const relative of tracked
      .split("\0")
      .filter(Boolean)
      .slice(0, MAX_FILES)) {
      const absolute = await realpath(path.join(root, relative)).catch(
        () => null,
      );
      if (!absolute || !inside(root, absolute)) continue;
      const metadata = await stat(absolute).catch(() => null);
      if (!metadata?.isFile()) continue;
      const latestCommit = latestByPath.get(relative) ?? null;
      files.push({
        kind: "blob",
        last_changed_at:
          latestCommit?.timestamp ?? Math.floor(metadata.mtimeMs / 1_000),
        latest_commit: latestCommit,
        path: relative,
        preview_content: await preview(absolute, metadata.size),
        size: metadata.size,
      });
    }
    return {
      commits,
      contributors,
      files,
      latest_commit: latest,
    };
  }

  async #diff(
    repository: string,
    range: string,
    targetCommit: string | null,
  ): Promise<RepoDiff> {
    const commitBody = targetCommit
      ? (
          await this.#git(
            [
              "show",
              "--no-patch",
              "--format=%b",
              "--end-of-options",
              targetCommit,
            ],
            repository,
          )
        ).trimEnd() || null
      : null;
    const numstat = await this.#git(["diff", "--numstat", range], repository);
    const files = [];
    for (const line of numstat
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(0, MAX_FILES)) {
      const [addRaw, deleteRaw, ...pathParts] = line.split("\t");
      const filePath = pathParts.join("\t");
      if (!filePath) continue;
      const additions = parseCount(addRaw);
      const deletions = parseCount(deleteRaw);
      const rawPatch = await this.#git(
        [
          "diff",
          "--no-ext-diff",
          "--find-renames",
          "--find-copies",
          "--unified=80",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          range,
          "--",
          filePath,
        ],
        repository,
      ).catch(() => "");
      const lines = rawPatch.split("\n");
      const truncated = lines.length > MAX_PATCH_LINES;
      files.push({
        additions,
        deletions,
        patch: truncated
          ? lines.slice(0, MAX_PATCH_LINES).join("\n")
          : rawPatch,
        path: filePath,
        truncated,
      });
    }
    return {
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      commit_body: commitBody,
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      files,
    };
  }

  async #compare(
    repository: string,
    cloneUrl: string,
    requestedBranch: string | null,
    baseBranch: string | null,
  ): Promise<SyncStatus> {
    const localBranch = firstLine(
      await this.#git(["branch", "--show-current"], repository).catch(() => ""),
    );
    const branch =
      requestedBranch ??
      (localBranch ? requireBranch(localBranch, "local branch") : "main");
    const currentOrigin = firstLine(
      await this.#git(["remote", "get-url", "origin"], repository).catch(
        () => "",
      ),
    );
    if (
      normalizeCloneUrl(currentOrigin ?? "") !== normalizeCloneUrl(cloneUrl)
    ) {
      await this.#git(["remote", "set-url", "origin", cloneUrl], repository);
    }
    const fetchBranches = [
      branch,
      ...(baseBranch && baseBranch !== branch ? [baseBranch] : []),
    ];
    await this.#git(
      [
        "fetch",
        "--quiet",
        "--depth=100",
        "--end-of-options",
        "origin",
        ...fetchBranches,
      ],
      repository,
      this.#viewerCredential(),
      true,
    ).catch(() => "");
    const localBranches = (
      await this.#git(
        [
          "for-each-ref",
          "--count=200",
          "--format=%(refname:short)",
          "refs/heads/",
        ],
        repository,
      ).catch(() => "")
    )
      .split(/\r?\n/)
      .flatMap((item) => {
        try {
          return item ? [requireBranch(item, "local branch")] : [];
        } catch {
          return [];
        }
      });
    const localHead = firstLine(
      await this.#git(["rev-parse", "HEAD"], repository).catch(() => ""),
    );
    const remoteHead = firstLine(
      await this.#git(
        ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
        repository,
      ).catch(() => ""),
    );
    const remoteHasBranches =
      (
        await this.#git(
          ["ls-remote", "--heads", "--end-of-options", "origin"],
          repository,
          this.#viewerCredential(),
          true,
        ).catch(() => "__lookup_failed__")
      ).trim() !== "";
    const firstPublish = remoteHead === null && !remoteHasBranches;
    const statusText = await this.#git(
      ["status", "--porcelain"],
      repository,
    ).catch(() => "");
    const hasUntracked = statusText
      .split(/\r?\n/)
      .some((line) => line.startsWith("??"));
    const hasChanges = statusText
      .split(/\r?\n/)
      .some((line) => line.trim() && !line.startsWith("??"));
    const ahead = remoteHead
      ? parseCount(
          await this.#git(
            ["rev-list", "--count", `origin/${branch}..HEAD`],
            repository,
          ).catch(() => "0"),
        )
      : localHead
        ? 1
        : 0;
    const behind = remoteHead
      ? parseCount(
          await this.#git(
            ["rev-list", "--count", `HEAD..origin/${branch}`],
            repository,
          ).catch(() => "0"),
        )
      : 0;
    const mergeBase =
      baseBranch && (await this.#hasRef(repository, `origin/${baseBranch}`))
        ? firstLine(
            await this.#git(
              ["merge-base", "HEAD", `origin/${baseBranch}`],
              repository,
            ).catch(() => ""),
          )
        : null;
    const pushBlock = !localHead
      ? "No local commits to push."
      : localBranch !== branch && !firstPublish
        ? `Local checkout is on a different branch than ${branch}.`
        : hasChanges || hasUntracked
          ? "Commit or discard local changes before pushing."
          : behind > 0
            ? "Pull or reconcile remote commits before pushing."
            : ahead === 0
              ? "Local branch is already pushed."
              : null;
    const pullBlock = !localHead
      ? "No local commits yet — clone instead of pulling."
      : !remoteHead
        ? "Remote branch not found."
        : behind === 0
          ? "Local branch is up to date."
          : localBranch !== branch
            ? `Local checkout is on a different branch than ${branch}.`
            : hasChanges
              ? "Commit or stash local changes before pulling."
              : ahead > 0
                ? "Local and remote have diverged — reconcile in a terminal."
                : null;
    return {
      ahead_count: ahead,
      behind_count: behind,
      can_pull: pullBlock === null,
      can_push: pushBlock === null,
      has_uncommitted_changes: hasChanges,
      has_untracked_files: hasUntracked,
      local_branch: localBranch,
      local_branches: localBranches,
      local_head: localHead,
      local_path: repository,
      local_short_head: localHead?.slice(0, 7) ?? null,
      merge_base: mergeBase,
      pull_block_reason: pullBlock,
      push_block_reason: pushBlock,
      remote_branch: branch,
      remote_head: remoteHead,
      remote_short_head: remoteHead?.slice(0, 7) ?? null,
    };
  }

  async #withRemoteCheckout<T>(
    cloneUrl: string,
    input: {
      branch: string | null;
      targetCommit: string | null;
      targetRef: string | null;
    },
    use: (repository: string) => Promise<T>,
  ): Promise<T> {
    return this.#withTemporaryDirectory(async (directory) => {
      const repository = path.join(directory, "repo");
      await this.#git(
        [
          "clone",
          "--filter=blob:none",
          "--no-checkout",
          "--end-of-options",
          cloneUrl,
          repository,
        ],
        undefined,
        this.#viewerCredential(),
        true,
      );
      const target = input.targetRef ?? input.targetCommit;
      if (target) {
        await this.#git(
          ["fetch", "--depth=100", "--end-of-options", "origin", target],
          repository,
          this.#viewerCredential(),
          true,
        );
        const fetched = requireResolvedCommit(
          firstLine(await this.#git(["rev-parse", "FETCH_HEAD"], repository)),
        );
        if (input.targetCommit && fetched !== input.targetCommit) {
          throw new Error(
            "the requested repository ref changed; refresh and retry",
          );
        }
        await this.#git(["checkout", "--detach", "FETCH_HEAD"], repository);
      } else if (input.branch) {
        const refspec = `refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`;
        await this.#git(
          ["fetch", "--depth=100", "--end-of-options", "origin", refspec],
          repository,
          this.#viewerCredential(),
          true,
        );
        await this.#git(
          ["checkout", "--detach", `origin/${input.branch}`],
          repository,
        );
      } else {
        await this.#git(
          ["fetch", "--depth=100", "--end-of-options", "origin", "HEAD"],
          repository,
          this.#viewerCredential(),
          true,
        );
        await this.#git(["checkout", "--detach", "FETCH_HEAD"], repository);
      }
      return use(repository);
    });
  }

  async #withTemporaryDirectory<T>(
    use: (directory: string) => Promise<T>,
  ): Promise<T> {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "buzz-project-git-"),
    );
    try {
      return await use(directory);
    } finally {
      await rm(directory, { force: true, recursive: true }).catch(
        () => undefined,
      );
    }
  }

  async #repositoryRoots(
    value: unknown,
    createDefault: boolean,
  ): Promise<string[]> {
    const explicit =
      typeof value === "string" && value.trim()
        ? value.trim()
        : this.#identity.setting<string | null>("workspace.repos_dir", null);
    const candidates = explicit
      ? [explicit]
      : [path.join(os.homedir(), ".buzz", "REPOS")];
    const roots: string[] = [];
    for (const candidate of candidates) {
      if (!path.isAbsolute(candidate)) {
        if (explicit) throw new Error("reposDir must be an absolute path");
        continue;
      }
      if (createDefault && !explicit) {
        await mkdir(candidate, { mode: 0o700, recursive: true });
      }
      const resolved = await realpath(candidate).catch(() => null);
      if (!resolved) {
        if (explicit) throw new Error("reposDir is not accessible");
        continue;
      }
      const metadata = await stat(resolved);
      if (!metadata.isDirectory())
        throw new Error("reposDir is not a directory");
      roots.push(resolved);
    }
    if (roots.length === 0) throw new Error("reposDir is not accessible");
    return roots;
  }

  async #findLocal(
    reposDir: unknown,
    projectDtag: string,
    cloneUrl: string | null,
  ): Promise<string | null> {
    const roots = await this.#repositoryRoots(reposDir, false).catch(() => []);
    for (const root of roots) {
      for (const candidate of repositoryCandidates(projectDtag, cloneUrl)) {
        const resolved = await realpath(path.join(root, candidate)).catch(
          () => null,
        );
        if (
          !resolved ||
          !inside(root, resolved) ||
          !(await isGitWorktree(resolved))
        ) {
          continue;
        }
        if (cloneUrl) {
          const origin = firstLine(
            await this.#git(["remote", "get-url", "origin"], resolved).catch(
              () => "",
            ),
          );
          if (normalizeCloneUrl(origin ?? "") !== normalizeCloneUrl(cloneUrl)) {
            continue;
          }
        }
        return resolved;
      }
    }
    return null;
  }

  async #requireLocal(
    args: Record<string, unknown>,
    cloneUrl: string,
  ): Promise<string> {
    const repository = await this.#findLocal(
      args.reposDir,
      requireText(args.projectDtag, "projectDtag", 256),
      cloneUrl,
    );
    if (!repository) throw new Error("No local checkout found.");
    return repository;
  }

  async #localTarget(
    repository: string,
    branch: string | null,
    commit: string | null,
  ): Promise<string> {
    if (commit && (await this.#hasRef(repository, commit))) return commit;
    if (branch && (await this.#hasRef(repository, branch))) return branch;
    if (branch && (await this.#hasRef(repository, `origin/${branch}`))) {
      return `origin/${branch}`;
    }
    return "HEAD";
  }

  async #comparisonRange(
    repository: string,
    base: string,
    target: string,
  ): Promise<string> {
    const hasBase = await this.#git(["merge-base", base, target], repository)
      .then(() => true)
      .catch(() => false);
    return `${base}${hasBase ? "..." : ".."}${target}`;
  }

  async #commitRange(repository: string, commit: string): Promise<string> {
    if (!(await this.#hasRef(repository, `${commit}^{commit}`))) {
      throw new Error(`commit ${commit} was not found in repository history`);
    }
    if (await this.#hasRef(repository, `${commit}^`))
      return `${commit}^..${commit}`;
    return `${await this.#emptyTree(repository)}..${commit}`;
  }

  async #emptyTree(repository: string): Promise<string> {
    return requireResolvedCommit(
      firstLine(await this.#git(["mktree"], repository, undefined, false, "")),
    );
  }

  async #hasRef(repository: string, ref: string): Promise<boolean> {
    return this.#git(["rev-parse", "--verify", "--quiet", ref], repository)
      .then(() => true)
      .catch(() => false);
  }

  #cloneUrl(value: unknown): string {
    const raw = requireText(value, "cloneUrl", 4_096);
    let clone: URL;
    let relay: URL;
    try {
      clone = new URL(raw);
      relay = new URL(this.#workspace.relayHttpUrl());
    } catch {
      throw new Error("invalid clone URL");
    }
    if (
      !["http:", "https:"].includes(clone.protocol) ||
      clone.username ||
      clone.password ||
      clone.search ||
      clone.hash
    ) {
      throw new Error("clone URL must use http or https without credentials");
    }
    const segments = clone.pathname.split("/").filter(Boolean);
    const gitIndex = segments.lastIndexOf("git");
    if (
      gitIndex < 0 ||
      segments.length !== gitIndex + 3 ||
      !HEX_PUBKEY.test(segments[gitIndex + 1] ?? "") ||
      !(segments[gitIndex + 2] ?? "")
    ) {
      throw new Error("clone URL must point at a Buzz git repository");
    }
    if (
      clone.protocol !== relay.protocol ||
      clone.hostname !== relay.hostname ||
      clone.port !== relay.port
    ) {
      throw new Error("clone URL must use the active workspace relay");
    }
    const relayPath = relay.pathname.replace(/\/+$/, "");
    if (relayPath && !clone.pathname.startsWith(`${relayPath}/`)) {
      throw new Error("clone URL must use the active workspace relay path");
    }
    return clone.toString();
  }

  #viewerCredential(): Credential {
    return { authTag: null, nsec: this.#identity.nsec() };
  }

  #ownerCredential(owner: string): Credential {
    if (owner === this.#identity.info().pubkey) return this.#viewerCredential();
    const credential = this.#managedAgents.signingCredential(owner);
    if (!credential) {
      throw new Error(
        "only the repository owner or owner of its managed agent can perform this action",
      );
    }
    return { authTag: credential.authTag, nsec: credential.nsec };
  }

  #signOwner(owner: string, template: EventTemplate): Event {
    if (owner === this.#identity.info().pubkey) {
      return this.#identity.sign({
        content: template.content,
        kind: template.kind,
        tags: template.tags,
      });
    }
    return this.#managedAgents.signAsAgent(owner, template);
  }

  async #publishOwner(owner: string, template: EventTemplate): Promise<Event> {
    if (owner === this.#identity.info().pubkey) {
      const event = this.#signOwner(owner, template);
      await this.#relay.publish(event);
      return event;
    }
    return this.#managedAgents.publishAsAgent(owner, template);
  }

  async #git(
    args: readonly string[],
    cwd?: string,
    credential?: Credential,
    remote = false,
    stdin: string | null = null,
  ): Promise<string> {
    const git = await (this.#gitPath ??= resolveExecutable("git"));
    return runGit(git, args, {
      ...(credential ? { credential } : {}),
      ...(cwd ? { cwd } : {}),
      remote,
      stdin,
    });
  }
}

async function runGit(
  git: string,
  args: readonly string[],
  options: {
    credential?: Credential;
    cwd?: string;
    remote: boolean;
    stdin: string | null;
  },
): Promise<string> {
  const entries: Array<[string, string]> = [
    ["credential.helper", ""],
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["protocol.allow", "never"],
    ["protocol.http.allow", "always"],
    ["protocol.https.allow", "always"],
    ["protocol.file.allow", "never"],
    ["protocol.ext.allow", "never"],
  ];
  if (options.remote && options.credential) {
    entries.push([
      "credential.helper",
      `!${shellQuote(process.execPath)} ${shellQuote(CREDENTIAL_HELPER)}`,
    ]);
    entries.push(["credential.useHttpPath", "true"]);
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_SSH_COMMAND",
    "GIT_EXTERNAL_DIFF",
    "NOSTR_PRIVATE_KEY",
    "BUZZ_AUTH_TAG",
  ]) {
    delete env[name];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  if (options.remote && options.credential) {
    env.NOSTR_PRIVATE_KEY = options.credential.nsec;
    if (options.credential.authTag) {
      env.BUZZ_AUTH_TAG = JSON.stringify(options.credential.authTag);
    }
  }
  return runProcess(git, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env,
    stdin: options.stdin,
    timeoutMs: options.remote ? 300_000 : 60_000,
  });
}

async function runProcess(
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    stdin: string | null;
    timeoutMs: number;
  },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      detached: process.platform !== "win32",
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    const capture = (target: Buffer[], chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > MAX_GIT_OUTPUT) {
        overflow = true;
        killChild(child);
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", reject);
    const timer = setTimeout(() => killChild(child), options.timeoutMs);
    timer.unref();
    child.once("close", (code) => {
      clearTimeout(timer);
      if (overflow) {
        reject(new Error("git output exceeded the 16 MiB limit"));
        return;
      }
      const errorText = Buffer.concat(stderr)
        .toString("utf8")
        .trim()
        .replaceAll(/(?:nsec1|brap1_)[A-Za-z0-9_-]+/g, "[REDACTED]");
      if (code !== 0) {
        reject(
          new Error(
            errorText
              ? `git ${args[0] ?? ""} failed: ${errorText}`
              : `git ${args[0] ?? ""} exited with code ${code ?? -1}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
    child.stdin.end(options.stdin ?? undefined);
  });
}

function killChild(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child.
    }
  }
  child.kill("SIGKILL");
}

async function resolveExecutable(command: string): Promise<string> {
  for (const directory of (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)) {
    for (const name of process.platform === "win32"
      ? [command, `${command}.exe`, `${command}.cmd`]
      : [command]) {
      const candidate = path.join(directory, name);
      try {
        const metadata = await stat(candidate);
        if (metadata.isFile()) return await realpath(candidate);
      } catch {
        // Keep searching.
      }
    }
  }
  throw new Error(`${command} was not found on PATH`);
}

function repositoryCandidates(
  projectDtag: string,
  cloneUrl: string | null,
): string[] {
  const candidates: string[] = [];
  if (cloneUrl) {
    const parts = new URL(cloneUrl).pathname.split("/").filter(Boolean);
    const owner = safeDirectoryName(parts.at(-2) ?? "");
    const repository = safeDirectoryName(
      (parts.at(-1) ?? "").replace(/\.git$/, ""),
    );
    if (owner && repository) candidates.push(`${owner}--${repository}`);
  }
  const dtag = safeDirectoryName(projectDtag);
  if (dtag && !candidates.includes(dtag)) candidates.push(dtag);
  if (cloneUrl) {
    const repository = safeDirectoryName(
      (
        new URL(cloneUrl).pathname.split("/").filter(Boolean).at(-1) ?? ""
      ).replace(/\.git$/, ""),
    );
    if (repository && !candidates.includes(repository))
      candidates.push(repository);
  }
  return candidates;
}

function safeDirectoryName(value: string): string | null {
  const trimmed = value.trim().replace(/\.git$/, "");
  return !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    Buffer.byteLength(trimmed, "utf8") > 255
    ? null
    : trimmed;
}

async function isGitWorktree(directory: string): Promise<boolean> {
  return stat(path.join(directory, ".git"))
    .then((metadata) => metadata.isDirectory() || metadata.isFile())
    .catch(() => false);
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function exists(value: string): Promise<boolean> {
  return stat(value)
    .then(() => true)
    .catch(() => false);
}

function normalizeCloneUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

function cloneUrlOwner(value: string): string | null {
  const parts = new URL(value).pathname.split("/").filter(Boolean);
  const git = parts.lastIndexOf("git");
  return git >= 0 && parts.length === git + 3
    ? (parts[git + 1]?.toLowerCase() ?? null)
    : null;
}

function requireBranch(value: unknown, name: string): string {
  const raw = requireText(value, name, 1_024);
  if (raw.startsWith("refs/") && !raw.startsWith("refs/heads/")) {
    throw new Error(`${name} is invalid`);
  }
  const branch = raw.startsWith("refs/heads/") ? raw.slice(11) : raw;
  if (
    !branch ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.split("/").some((component) => component.startsWith(".")) ||
    !/^[A-Za-z0-9/_.-]+$/.test(branch)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return branch;
}

function optionalBranch(value: unknown, name: string): string | null {
  return value === undefined || value === null || value === ""
    ? null
    : requireBranch(value, name);
}

function requireCommit(value: unknown, name: string): string {
  const commit = requireText(value, name, 128).toLowerCase();
  if (!HEX_COMMIT.test(commit)) throw new Error(`${name} is invalid`);
  return commit;
}

function optionalCommit(value: unknown, name: string): string | null {
  return value === undefined || value === null || value === ""
    ? null
    : requireCommit(value, name);
}

function optionalTargetRef(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const raw = requireText(value, "targetRef", 1_024);
  for (const prefix of ["refs/tags/", "refs/nostr/"]) {
    if (raw.startsWith(prefix)) {
      const suffix = requireBranch(raw.slice(prefix.length), "targetRef");
      return `${prefix}${suffix}`;
    }
  }
  throw new Error("targetRef must be a tag or Nostr repository ref");
}

function requireResolvedCommit(value: string | null): string {
  if (!value) throw new Error("could not resolve repository commit");
  const normalized = value.toLowerCase();
  if (!HEX_COMMIT.test(normalized)) {
    throw new Error("git returned an invalid commit ID");
  }
  return normalized;
}

function parseCommit(value: string | null): Commit | null {
  if (!value) return null;
  const [hash, shortHash, authorName, authorEmail, timestampRaw, ...subject] =
    value.split("\0");
  const timestamp = Number(timestampRaw);
  if (
    !hash ||
    !shortHash ||
    authorName === undefined ||
    authorEmail === undefined ||
    !Number.isSafeInteger(timestamp)
  ) {
    return null;
  }
  return {
    author_email: authorEmail,
    author_name: authorName,
    hash,
    short_hash: shortHash,
    subject: subject.join("\0"),
    timestamp,
  };
}

function parseLatestByPath(output: string): Map<string, Commit> {
  const result = new Map<string, Commit>();
  for (const block of output.split("\x1e").filter(Boolean)) {
    const [header, ...paths] = block.replace(/^\r?\n/, "").split(/\r?\n/);
    const commit = parseCommit(header ?? null);
    if (!commit) continue;
    for (const file of paths.map((item) => item.trim()).filter(Boolean)) {
      if (!result.has(file)) result.set(file, commit);
    }
  }
  return result;
}

function aggregateContributors(output: string): Array<Record<string, unknown>> {
  const values = new Map<
    string,
    {
      commit_count: number;
      email: string;
      last_commit_at: number;
      name: string;
    }
  >();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [name = "", email = "", rawTimestamp = "0"] = line.split("\0");
    if (!name && !email) continue;
    const key = (email || name).toLowerCase();
    const timestamp = Number(rawTimestamp) || 0;
    const existing = values.get(key);
    if (existing) {
      existing.commit_count += 1;
      existing.last_commit_at = Math.max(existing.last_commit_at, timestamp);
    } else {
      values.set(key, {
        commit_count: 1,
        email,
        last_commit_at: timestamp,
        name,
      });
    }
  }
  return [...values.values()]
    .sort(
      (left, right) =>
        right.commit_count - left.commit_count ||
        right.last_commit_at - left.last_commit_at ||
        left.name.localeCompare(right.name),
    )
    .slice(0, 50);
}

async function preview(file: string, size: number): Promise<string | null> {
  if (size > 64 * 1024) return null;
  const bytes = await readFile(file).catch(() => null);
  if (!bytes || bytes.includes(0)) return null;
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

function firstLine(value: string): string | null {
  return value.split(/\r?\n/, 1)[0]?.trim() || null;
}

function parseCount(value: string | undefined): number {
  const parsed = Number(value?.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function remoteHeadBranch(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^ref: refs\/heads\/(.+)\tHEAD$/.exec(line);
    if (!match?.[1]) continue;
    try {
      return requireBranch(match[1], "remote HEAD");
    } catch {
      return null;
    }
  }
  return null;
}

function missingSyncStatus(branch: string | null): SyncStatus {
  return {
    ahead_count: 0,
    behind_count: 0,
    can_pull: false,
    can_push: false,
    has_uncommitted_changes: false,
    has_untracked_files: false,
    local_branch: null,
    local_branches: [],
    local_head: null,
    local_path: null,
    local_short_head: null,
    merge_base: null,
    pull_block_reason: "No local checkout found.",
    push_block_reason: "No local checkout found.",
    remote_branch: branch,
    remote_head: null,
    remote_short_head: null,
  };
}

function statusTags(
  repository: string,
  pullRequestId: string,
  owner: string,
  author: string,
): string[][] {
  return [
    ["e", pullRequestId, "", "root"],
    ["a", repository],
    ["p", owner],
    ...(author === owner ? [] : [["p", author]]),
  ];
}

function requireRepoAddress(value: unknown, owner: string): string {
  const address = requireText(value, "repoAddress", 4_096);
  if (!address.startsWith(`30617:${owner}:`) || address === `30617:${owner}:`) {
    throw new Error("repository address does not match the repository owner");
  }
  return address;
}

function requirePubkey(value: unknown, name: string): string {
  const pubkey = requireText(value, name, 128).toLowerCase();
  if (!HEX_PUBKEY.test(pubkey))
    throw new Error(`${name} must be 64 hexadecimal characters`);
  return pubkey;
}

function requireText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  const text = value.trim();
  if (Buffer.byteLength(text, "utf8") > maxBytes || text.includes("\0")) {
    throw new Error(`${name} exceeds its size limit`);
  }
  return text;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function launchTerminal(directory: string): Promise<void> {
  const root = await realpath(directory);
  if (process.platform === "darwin") {
    await runLauncher("/usr/bin/open", ["-a", "Terminal", root]);
    return;
  }
  if (process.platform === "win32") {
    await runLauncher(
      "cmd.exe",
      ["/d", "/s", "/c", "start", "", "cmd.exe"],
      root,
    );
    return;
  }
  for (const candidate of [
    "x-terminal-emulator",
    "gnome-terminal",
    "konsole",
    "xterm",
  ]) {
    try {
      await runLauncher(candidate, [], root);
      return;
    } catch {
      // Try the next known terminal.
    }
  }
  throw new Error("no terminal emulator found");
}

async function runLauncher(
  executable: string,
  args: readonly string[],
  cwd?: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      ...(cwd ? { cwd } : {}),
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function structuredError(
  code: string,
  message: string,
  recovery: Record<string, unknown> | null = null,
): Error {
  return new Error(JSON.stringify({ code, message, recovery }));
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .slice(0, 8_192)
    .replaceAll(/(?:nsec1|brap1_)[A-Za-z0-9_-]+/g, "[REDACTED]");
}
