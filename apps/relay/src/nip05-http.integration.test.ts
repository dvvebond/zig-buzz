import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRelayServer } from "./server.js";

type TestRelay = ReturnType<typeof createRelayServer>;
const relays: TestRelay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("NIP-05 discovery", () => {
  it("resolves a tenant-local handle and advertises the bound relay", async () => {
    const pubkey = "ab".repeat(32);
    const query = vi.fn(async (_sql: string, values?: unknown[]) => ({
      rows:
        values?.[0] === "localhost" && values?.[1] === "alice@localhost"
          ? [{ pubkey }]
          : [],
    }));
    const { baseUrl } = await startRelay({
      pool: { query } as unknown as Pool,
    });

    const response = await fetch(
      `${baseUrl}/.well-known/nostr.json?name=Alice`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("vary")).toBe("Host");
    await expect(response.json()).resolves.toEqual({
      names: { alice: pubkey },
      relays: { [pubkey]: [baseUrl.replace("http:", "ws:")] },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[1]).toEqual(["localhost", "alice@localhost"]);
  });

  it("returns a non-enumerating empty document for missing or invalid names", async () => {
    const query = vi.fn(async () => ({
      rows: [{ pubkey: "not-a-pubkey" }],
    }));
    const { baseUrl } = await startRelay({
      pool: { query } as unknown as Pool,
    });

    for (const suffix of ["", "?name=", "?name=bad%40other.example"]) {
      const response = await fetch(
        `${baseUrl}/.well-known/nostr.json${suffix}`,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        names: {},
        relays: {},
      });
    }
    expect(query).not.toHaveBeenCalled();
  });
});

async function startRelay(
  options: Partial<Parameters<typeof createRelayServer>[0]>,
): Promise<{ baseUrl: string; relay: TestRelay }> {
  const publicUrl = new URL("ws://localhost:1/");
  const relay = createRelayServer({
    community: "localhost",
    host: "127.0.0.1",
    ownerPubkeys: new Set(),
    port: 0,
    publicUrl,
    ...options,
  });
  relays.push(relay);
  await relay.listen();
  const address = relay.address();
  if (!address || typeof address === "string") {
    throw new Error("test relay did not bind a TCP port");
  }
  publicUrl.port = String(address.port);
  return {
    baseUrl: `http://localhost:${address.port}`,
    relay,
  };
}
