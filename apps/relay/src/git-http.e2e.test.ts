import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpenRelayAccessPolicy } from "@buzz/db";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { RelayGitHttp } from "./git-http.js";
import { ensureGitRepositoryPointer, runGit } from "./git-repository.js";
import { MemoryGitObjectStore } from "./git-store.js";

const communityId = "019fa90c-55c4-7181-9e58-aa5eb4b51243";
const channelId = "019fa90c-55c4-7181-9e58-aa5eb4b51244";
const temporaryDirectories: string[] = [];
let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Git Smart HTTP end to end", () => {
  it("accepts a real push and serves the committed state to a fresh clone", async () => {
    const secretKey = generateSecretKey();
    const owner = getPublicKey(secretKey);
    const store = new MemoryGitObjectStore();
    await ensureGitRepositoryPointer(
      store,
      communityId,
      owner,
      "project",
      true,
    );
    const refStates: string[] = [];
    let gitHttp: RelayGitHttp | undefined;
    server = createServer((request, response) => {
      void (async () => {
        if (await gitHttp?.handleInternal(request, response)) return;
        if (await gitHttp?.handle(request, response)) return;
        response.statusCode = 404;
        response.end("not found");
      })();
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    gitHttp = new RelayGitHttp({
      accessPolicy: new OpenRelayAccessPolicy(),
      community: `127.0.0.1:${address.port}`,
      communityId,
      hookSecret: Buffer.alloc(32, 9),
      limits: {
        maxPackBytes: 16 * 1024 * 1024,
        maxRepoBytes: 32 * 1024 * 1024,
        operationTimeoutMs: 30_000,
      },
      maxConcurrentOperations: 4,
      maxRepositoriesPerOwner: 100,
      onRefState: async (state) => {
        refStates.push(state.refs["refs/heads/main"] ?? "");
      },
      pool: fakeGitPool(owner) as Pool,
      publicUrl: new URL(`${baseUrl}/`),
      store,
    });
    const challenge = await fetch(
      `${baseUrl}/git/${owner}/project.git/info/refs?service=git-upload-pack`,
    );
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe(
      'Nostr realm="buzz", method="GET"',
    );

    const working = await makeTemporaryDirectory("buzz-git-clone-");
    await authenticatedGit(secretKey, `${baseUrl}/git/${owner}/project.git`, [
      "clone",
      `${baseUrl}/git/${owner}/project.git`,
      working,
    ]);
    await runGit(
      ["-C", working, "config", "user.name", "Buzz E2E"],
      undefined,
      30_000,
      1024,
    );
    await runGit(
      ["-C", working, "config", "user.email", "buzz@example.test"],
      undefined,
      30_000,
      1024,
    );
    await runGit(
      ["-C", working, "checkout", "-b", "main"],
      undefined,
      30_000,
      1024 * 1024,
    );
    await writeFile(join(working, "README.md"), "real smart-http push\n");
    await runGit(["-C", working, "add", "README.md"], undefined, 30_000, 1024);
    await runGit(
      ["-C", working, "commit", "-m", "initial"],
      undefined,
      30_000,
      1024 * 1024,
    );
    await authenticatedGit(secretKey, `${baseUrl}/git/${owner}/project.git`, [
      "-C",
      working,
      "push",
      "origin",
      "main",
    ]);

    const fresh = await makeTemporaryDirectory("buzz-git-fresh-");
    await authenticatedGit(secretKey, `${baseUrl}/git/${owner}/project.git`, [
      "clone",
      `${baseUrl}/git/${owner}/project.git`,
      fresh,
    ]);
    expect(await readFile(join(fresh, "README.md"), "utf8")).toBe(
      "real smart-http push\n",
    );
    expect(refStates).toHaveLength(1);
    expect(refStates[0]).toMatch(/^[0-9a-f]{40}$/);
  }, 60_000);
});

async function authenticatedGit(
  secretKey: Uint8Array,
  repositoryUrl: string,
  args: readonly string[],
): Promise<void> {
  const event = finalizeEvent(
    {
      content: "",
      created_at: Math.floor(Date.now() / 1_000),
      kind: 27_235,
      tags: [
        ["u", repositoryUrl],
        ["method", "GET"],
      ],
    },
    secretKey,
  );
  const credential = Buffer.from(JSON.stringify(event), "utf8").toString(
    "base64",
  );
  await runGit(
    ["-c", `http.extraHeader=Authorization: Nostr ${credential}`, ...args],
    undefined,
    30_000,
    32 * 1024 * 1024,
  );
}

function fakeGitPool(owner: string): Pick<Pool, "query"> {
  return {
    query: (async (sql: string) => {
      if (sql.includes("FROM events")) {
        return {
          rowCount: 1,
          rows: [
            {
              tags: [
                ["d", "project"],
                ["buzz-channel", channelId],
              ],
            },
          ],
        };
      }
      if (sql.includes("FROM channels")) {
        return { rowCount: 1, rows: [{ archived: false }] };
      }
      if (sql.includes("FROM users")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("role::text AS role")) {
        return { rowCount: 1, rows: [{ role: "member" }] };
      }
      if (sql.includes("FROM channel_members")) {
        return { rowCount: 1, rows: [{ owner }] };
      }
      throw new Error(`unexpected Git test SQL: ${sql}`);
    }) as Pool["query"],
  };
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}
