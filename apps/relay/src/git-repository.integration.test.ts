import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GitPublishConflictError,
  ensureGitRepositoryPointer,
  hydrateGitRepository,
  publishGitRepository,
  runGit,
} from "./git-repository.js";
import { MemoryGitObjectStore } from "./git-store.js";

const communityId = "019fa90c-55c4-7181-9e58-aa5eb4b51243";
const owner = "a".repeat(64);
const limits = {
  maxPackBytes: 16 * 1024 * 1024,
  maxRepoBytes: 32 * 1024 * 1024,
  operationTimeoutMs: 30_000,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Git repository object publication", () => {
  it("round-trips a real commit through pack + manifest + pointer CAS", async () => {
    const store = new MemoryGitObjectStore();
    await store.probe();
    await ensureGitRepositoryPointer(
      store,
      communityId,
      owner,
      "project",
      true,
    );
    const source = await createSourceRepository("first");
    const writer = await hydrateGitRepository(
      store,
      communityId,
      owner,
      "project",
      limits,
    );
    expect(writer).toBeDefined();
    await runGit(
      [
        `--git-dir=${writer!.path}`,
        "fetch",
        source,
        "refs/heads/main:refs/heads/main",
      ],
      undefined,
      limits.operationTimeoutMs,
      1024 * 1024,
      { GIT_ALLOW_PROTOCOL: "file" },
    );
    const published = await publishGitRepository(
      store,
      communityId,
      owner,
      "project",
      writer!,
      limits,
    );
    await writer!.close();

    expect(published.manifest.refs["refs/heads/main"]).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect(published.manifest.packs).toHaveLength(1);
    const reader = await hydrateGitRepository(
      store,
      communityId,
      owner,
      "project",
      limits,
    );
    const result = await runGit(
      [`--git-dir=${reader!.path}`, "cat-file", "-t", "refs/heads/main"],
      undefined,
      limits.operationTimeoutMs,
      1024,
    );
    expect(result.stdout.toString("utf8").trim()).toBe("commit");
    await reader!.close();
  });

  it("rejects a stale writer after another manifest wins", async () => {
    const store = new MemoryGitObjectStore();
    await ensureGitRepositoryPointer(store, communityId, owner, "race", true);
    const sourceA = await createSourceRepository("winner");
    const sourceB = await createSourceRepository("loser");
    const writerA = await hydrateGitRepository(
      store,
      communityId,
      owner,
      "race",
      limits,
    );
    const writerB = await hydrateGitRepository(
      store,
      communityId,
      owner,
      "race",
      limits,
    );
    for (const [writer, source] of [
      [writerA, sourceA],
      [writerB, sourceB],
    ] as const) {
      await runGit(
        [
          `--git-dir=${writer!.path}`,
          "fetch",
          source,
          "refs/heads/main:refs/heads/main",
        ],
        undefined,
        limits.operationTimeoutMs,
        1024 * 1024,
        { GIT_ALLOW_PROTOCOL: "file" },
      );
    }
    await publishGitRepository(
      store,
      communityId,
      owner,
      "race",
      writerA!,
      limits,
    );
    await expect(
      publishGitRepository(store, communityId, owner, "race", writerB!, limits),
    ).rejects.toBeInstanceOf(GitPublishConflictError);
    await writerA!.close();
    await writerB!.close();
  });
});

async function createSourceRepository(content: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "buzz-git-source-"));
  temporaryDirectories.push(path);
  await runGit(
    ["init", "--initial-branch=main", path],
    undefined,
    30_000,
    1024 * 1024,
  );
  await runGit(
    ["-C", path, "config", "user.name", "Buzz Test"],
    undefined,
    30_000,
    1024,
  );
  await runGit(
    ["-C", path, "config", "user.email", "buzz@example.test"],
    undefined,
    30_000,
    1024,
  );
  await writeFile(join(path, "README.md"), `${content}\n`, "utf8");
  await runGit(["-C", path, "add", "README.md"], undefined, 30_000, 1024);
  await runGit(
    ["-C", path, "commit", "-m", content],
    undefined,
    30_000,
    1024 * 1024,
  );
  return path;
}
