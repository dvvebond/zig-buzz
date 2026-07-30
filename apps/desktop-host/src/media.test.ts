import { createHash } from "node:crypto";
import { createServer, type RequestListener } from "node:http";

import { verifyNostrEvent } from "@buzz/core";
import { afterEach, describe, expect, it } from "vitest";
import sharp from "sharp";

import { IdentityService } from "./identity.js";
import { DesktopMediaService } from "./media.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("TypeScript desktop media service", () => {
  it("uploads sanitized bytes with a scoped Blossom authorization", async () => {
    let receivedAuth: Record<string, unknown> | undefined;
    let receivedBody: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const relayHttpUrl = await listen(async (request, response) => {
      if (request.method !== "PUT" || request.url !== "/upload") {
        response.writeHead(404).end();
        return;
      }
      receivedBody = await readRequest(request);
      const encoded = request.headers.authorization?.replace(/^Nostr\s+/, "");
      receivedAuth = JSON.parse(
        Buffer.from(encoded ?? "", "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          sha256: createHash("sha256").update(receivedBody).digest("hex"),
          size: receivedBody.byteLength,
          type: request.headers["content-type"],
          uploaded: 123,
          url: `${relayHttpUrl}/media/${createHash("sha256").update(receivedBody).digest("hex")}.png`,
        }),
      );
    });
    const identity = IdentityService.create(undefined, async () => undefined);
    const media = new DesktopMediaService({ identity, relayHttpUrl });
    const png = await sharp({
      create: {
        background: { alpha: 1, b: 40, g: 20, r: 10 },
        channels: 4,
        height: 2,
        width: 2,
      },
    })
      .png()
      .toBuffer();

    const descriptor = await media.uploadBytes(png, "../avatar.png");
    expect(descriptor.filename).toBe("_avatar.png");
    expect(descriptor.type).toBe("image/png");
    expect(receivedBody.byteLength).toBeGreaterThan(0);
    expect(receivedAuth).toBeDefined();
    expect(verifyNostrEvent(receivedAuth)).toBe(true);
    expect(receivedAuth?.kind).toBe(24_242);
    expect(receivedAuth?.tags).toEqual(
      expect.arrayContaining([
        ["t", "upload"],
        ["x", descriptor.sha256],
      ]),
    );
  });

  it("refuses active content before contacting the relay", async () => {
    let requests = 0;
    const relayHttpUrl = await listen((_request, response) => {
      requests += 1;
      response.writeHead(500).end();
    });
    const identity = IdentityService.create(undefined, async () => undefined);
    const media = new DesktopMediaService({ identity, relayHttpUrl });
    await expect(
      media.uploadBytes(
        Buffer.from("<!doctype html><script>alert(1)</script>"),
      ),
    ).rejects.toThrow(/active web content/);
    expect(requests).toBe(0);
  });

  it("fetches only same-relay media and verifies snapshot integrity", async () => {
    const snapshot = Buffer.from(
      JSON.stringify({
        definition: { name: "Analyst" },
        format: "buzz-agent-snapshot",
        memory: { entries: [], level: "none" },
        profile: { displayName: "Analyst" },
        version: 1,
      }),
    );
    const sha256 = createHash("sha256").update(snapshot).digest("hex");
    const relayHttpUrl = await listen((request, response) => {
      if (request.url !== `/media/${sha256}.agent.json`) {
        response.writeHead(404).end();
        return;
      }
      const encoded = request.headers.authorization?.replace(/^Nostr\s+/, "");
      const auth = JSON.parse(
        Buffer.from(encoded ?? "", "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      if (!verifyNostrEvent(auth)) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, {
        "Content-Length": snapshot.byteLength,
        "Content-Type": "application/octet-stream",
      });
      response.end(snapshot);
    });
    const identity = IdentityService.create(undefined, async () => undefined);
    const media = new DesktopMediaService({ identity, relayHttpUrl });
    await expect(
      media.fetchSnapshot({
        expectedSha256: sha256,
        expectedSize: snapshot.byteLength,
        filename: "analyst.agent.json",
        url: `${relayHttpUrl}/media/${sha256}.agent.json`,
      }),
    ).resolves.toEqual(new Uint8Array(snapshot));
    await expect(
      media.fetchSnapshot({
        expectedSha256: "00".repeat(32),
        expectedSize: snapshot.byteLength,
        filename: "analyst.agent.json",
        url: `${relayHttpUrl}/media/${sha256}.agent.json`,
      }),
    ).rejects.toThrow(/hash/);
    await expect(
      media.fetchMedia(`https://attacker.example/media/${sha256}.png`),
    ).rejects.toThrow(/same-relay/);
  });

  it("refuses authenticated redirect hops", async () => {
    const relayHttpUrl = await listen((_request, response) => {
      response.writeHead(302, {
        Location: "http://127.0.0.1:1/private",
      });
      response.end();
    });
    const identity = IdentityService.create(undefined, async () => undefined);
    const media = new DesktopMediaService({ identity, relayHttpUrl });
    await expect(
      media.fetchMedia(`${relayHttpUrl}/media/${"ab".repeat(32)}.png`),
    ).rejects.toThrow(/refused relay redirect/);
  });
});

async function listen(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  closeCallbacks.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return `http://127.0.0.1:${address.port}`;
}

async function readRequest(
  request: import("node:http").IncomingMessage,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
