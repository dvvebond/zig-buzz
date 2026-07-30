import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateSecretKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";
import { KIND_BLOSSOM_AUTH, signNostrEvent, unixNow } from "@buzz/core";
import { DEFAULT_MEDIA_LIMITS, FileMediaStorage } from "@buzz/media";

import { createRelayServer } from "./server.js";

type TestRelay = ReturnType<typeof createRelayServer>;
const relays: TestRelay[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("relay Blossom media HTTP", () => {
  it("authenticates exact bytes, publishes tenant metadata, and serves safe ranges", async () => {
    const root = await mkdtemp(join(tmpdir(), "buzz-relay-media-"));
    directories.push(root);
    const publicUrl = new URL("ws://localhost:1/");
    const relay = createRelayServer({
      community: "localhost",
      host: "127.0.0.1",
      media: {
        communityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        config: {
          ...DEFAULT_MEDIA_LIMITS,
          publicBaseUrl: "http://localhost/media",
          uploadRecordsEnabled: false,
        },
        storage: new FileMediaStorage(root),
      },
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl,
    });
    relays.push(relay);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("test relay did not bind");
    }
    const base = `http://localhost:${address.port}`;
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const secret = generateSecretKey();
    const authorization = blossomAuthorization(secret, sha256, "upload");
    const uploaded = await fetch(`${base}/upload`, {
      body: bytes,
      headers: {
        Authorization: authorization,
        "Content-Type": "application/octet-stream",
        "X-SHA-256": sha256,
      },
      method: "PUT",
    });
    expect(uploaded.status).toBe(200);
    await expect(uploaded.json()).resolves.toMatchObject({
      dim: "1x1",
      sha256,
      type: "image/png",
    });

    const full = await fetch(`${base}/media/${sha256}.png`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-security-policy")).toBe(
      "default-src 'none'",
    );
    expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);

    const ranged = await fetch(`${base}/media/${sha256}`, {
      headers: { Range: "bytes=1-3" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(
      `bytes 1-3/${bytes.byteLength}`,
    );
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(
      bytes.subarray(1, 4),
    );

    expect((await fetch(`${base}/media/${sha256}.jpg`)).status).toBe(404);
    const wrong = await fetch(`${base}/upload`, {
      body: bytes,
      headers: {
        Authorization: blossomAuthorization(secret, "b".repeat(64), "upload"),
        "X-SHA-256": "b".repeat(64),
      },
      method: "PUT",
    });
    expect(wrong.status).toBe(403);
  });
});

function blossomAuthorization(
  secret: Uint8Array,
  sha256: string,
  verb: "upload" | "get",
): string {
  const now = unixNow();
  const event = signNostrEvent(
    {
      content: `${verb} media`,
      created_at: now,
      kind: KIND_BLOSSOM_AUTH,
      tags: [
        ["t", verb],
        ["expiration", String(now + 300)],
        ["server", "localhost"],
        ["x", sha256],
      ],
    },
    secret,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}
