import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { IdentityService } from "./identity.js";
import { LocalEntityService } from "./local-entities.js";
import { ManagedAgentService } from "./managed-agents.js";
import { ProjectGitService } from "./project-git.js";
import { RelayHttpClient } from "./relay-http.js";

const run = promisify(execFile);

describe("ProjectGitService", () => {
  it("lists, snapshots, and diffs a bounded local checkout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "buzz-project-root-"));
    const repository = path.join(root, "demo");
    await mkdir(repository);
    await git(repository, ["init"]);
    await git(repository, ["config", "user.name", "Buzz Test"]);
    await git(repository, ["config", "user.email", "test@example.com"]);
    await writeFile(path.join(repository, "README.md"), "hello\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "Initial"]);
    const commit = (await git(repository, ["rev-parse", "HEAD"])).trim();

    const service = makeService();
    const canonicalRepository = await realpath(repository);
    await expect(service.listLocal({ reposDir: root })).resolves.toEqual([
      { name: "demo", path: canonicalRepository },
    ]);
    const snapshot = await service.localSnapshot({
      projectDtag: "demo",
      reposDir: root,
    });
    expect(snapshot).toMatchObject({
      path: canonicalRepository,
      snapshot: {
        files: [
          {
            path: "README.md",
            preview_content: "hello\n",
          },
        ],
        latest_commit: {
          hash: commit,
          subject: "Initial",
        },
      },
    });
    const diff = await service.localDiff({
      projectDtag: "demo",
      reposDir: root,
      targetCommit: commit,
    });
    expect(diff).toMatchObject({
      additions: 1,
      deletions: 0,
      files: [{ additions: 1, path: "README.md" }],
    });
  });

  it("rejects off-relay URLs and branch option injection before invoking git", async () => {
    const owner = "a".repeat(64);
    const service = makeService();
    await expect(
      service.remoteSnapshot({
        cloneUrl: `https://evil.example/git/${owner}/repo`,
      }),
    ).rejects.toThrow(/active workspace relay/);
    await expect(
      service.createRemoteBranch({
        cloneUrl: `http://127.0.0.1:3000/git/${owner}/repo`,
        expectedCommit: "b".repeat(40),
        newBranch: "--upload-pack=/tmp/evil",
        sourceBranch: "main",
      }),
    ).rejects.toThrow(/newBranch is invalid/);
  });
});

function makeService(): ProjectGitService {
  const identity = IdentityService.create(undefined, async () => undefined);
  const managedAgents = new ManagedAgentService({
    dataDirectory: path.join(os.tmpdir(), "buzz-project-agent-test"),
    defaultRelayUrl: "ws://127.0.0.1:3000",
    identity,
    localEntities: new LocalEntityService(identity),
  });
  return new ProjectGitService({
    identity,
    managedAgents,
    relay: new RelayHttpClient({
      baseUrl: "http://127.0.0.1:3000",
      sign: (input) => identity.sign(input),
    }),
    workspace: {
      relayHttpUrl: () => "http://127.0.0.1:3000/",
    },
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await run("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  return result.stdout;
}
