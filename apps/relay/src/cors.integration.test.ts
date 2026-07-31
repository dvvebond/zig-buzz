import { afterEach, describe, expect, it } from "vitest";

import { createRelayServer } from "./server.js";

const relays: Array<ReturnType<typeof createRelayServer>> = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("relay CORS boundary", () => {
  it("answers an allowed preflight and rejects an unlisted origin", async () => {
    const relay = createRelayServer({
      community: "localhost",
      corsOrigins: ["https://app.example"],
      host: "127.0.0.1",
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl: new URL("ws://localhost/"),
    });
    relays.push(relay);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("relay did not bind a TCP port");
    }
    const url = `http://127.0.0.1:${address.port}/events`;
    const allowed = await fetch(url, {
      headers: {
        "Access-Control-Request-Headers": "authorization, content-type",
        "Access-Control-Request-Method": "POST",
        Origin: "https://app.example",
      },
      method: "OPTIONS",
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
    expect(allowed.headers.get("vary")).toContain("Origin");

    const denied = await fetch(url, {
      headers: {
        "Access-Control-Request-Method": "POST",
        Origin: "https://evil.example",
      },
      method: "OPTIONS",
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("preserves permissive development CORS when no list is configured", async () => {
    const relay = createRelayServer({
      community: "localhost",
      host: "127.0.0.1",
      ownerPubkeys: new Set(),
      port: 0,
      publicUrl: new URL("ws://localhost/"),
    });
    relays.push(relay);
    await relay.listen();
    const address = relay.address();
    if (!address || typeof address === "string") {
      throw new Error("relay did not bind a TCP port");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});
