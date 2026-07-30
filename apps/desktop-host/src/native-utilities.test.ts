import { createServer, type RequestListener } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  fetchJoinPolicy,
  fetchRelaySelf,
  fetchWorkspaceIcon,
  relayRequiresMembership,
} from "./native-utilities.js";

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

describe("desktop native network utilities", () => {
  it("reads the NIP-11 self field and NIP-43 capability", async () => {
    const relaySelf = "ab".repeat(32);
    const url = await listen((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/nostr+json",
      });
      response.end(
        JSON.stringify({
          self: relaySelf.toUpperCase(),
          supported_nips: [1, 43],
        }),
      );
    });

    expect(await fetchRelaySelf(url.replace(/^ws/, "http"))).toBe(relaySelf);
    expect(await relayRequiresMembership(url.replace(/^ws/, "http"))).toBe(
      true,
    );
  });

  it("does not trust the legacy pubkey field as relay self", async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/nostr+json",
      });
      response.end(JSON.stringify({ pubkey: "ab".repeat(32) }));
    });
    expect(await fetchRelaySelf(url.replace(/^ws/, "http"))).toBeNull();
  });

  it("fetches an optional bounded join policy without following redirects", async () => {
    const url = await listen((request, response) => {
      if (request.url === "/api/join-policy") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ policy: { version: "v1" } }));
        return;
      }
      response.writeHead(404).end();
    });
    await expect(fetchJoinPolicy(url)).resolves.toEqual({ version: "v1" });

    const redirect = await listen((_request, response) => {
      response.writeHead(307, { Location: "http://127.0.0.1:1/private" });
      response.end();
    });
    await expect(fetchJoinPolicy(redirect)).rejects.toThrow("HTTP 307");
  });

  it("rejects insecure remote relay URLs before a request is sent", async () => {
    await expect(fetchJoinPolicy("ws://relay.example")).rejects.toThrow(
      "remote relay URL must use wss://",
    );
    await expect(
      fetchJoinPolicy("wss://user:secret@relay.example"),
    ).rejects.toThrow("must not contain credentials");
  });

  it("only exposes safe workspace icon URL schemes", async () => {
    const safe = await listen((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/nostr+json",
      });
      response.end(JSON.stringify({ icon: "https://cdn.example/icon.png" }));
    });
    await expect(fetchWorkspaceIcon(safe)).resolves.toBe(
      "https://cdn.example/icon.png",
    );

    const active = await listen((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/nostr+json",
      });
      response.end(JSON.stringify({ icon: "javascript:alert(1)" }));
    });
    await expect(fetchWorkspaceIcon(active)).resolves.toBeNull();
  });

  it("rejects a chunked oversized NIP-11 document", async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/nostr+json",
        "Transfer-Encoding": "chunked",
      });
      response.write('{"self":"');
      response.write("a".repeat(256 * 1024));
      response.end('"}');
    });
    await expect(
      relayRequiresMembership(url.replace(/^ws/, "http")),
    ).rejects.toThrow("exceeds 262144 bytes");
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
  return `ws://127.0.0.1:${address.port}`;
}
