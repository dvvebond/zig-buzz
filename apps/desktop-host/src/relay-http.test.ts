import { verifyEvent, type Event } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { IdentityService } from "./identity.js";
import { RelayHttpClient } from "./relay-http.js";

describe("RelayHttpClient", () => {
  it("creates unique, body-bound NIP-98 authorization for repeated queries", async () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    const authEvents: Event[] = [];
    const mockFetch: typeof fetch = async (_input, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (!authorization?.startsWith("Nostr ")) {
        throw new Error("missing authorization");
      }
      const event = JSON.parse(
        Buffer.from(authorization.slice(6), "base64").toString("utf8"),
      ) as Event;
      authEvents.push(event);
      return new Response("[]", {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    };
    const relay = new RelayHttpClient({
      baseUrl: "https://relay.example",
      fetch: mockFetch,
      sign: (input) => identity.sign(input),
    });

    await relay.query([{ kinds: [0] }]);
    await relay.query([{ kinds: [0] }]);

    expect(authEvents).toHaveLength(2);
    expect(authEvents[0]?.id).not.toBe(authEvents[1]?.id);
    expect(authEvents.every((event) => verifyEvent(event))).toBe(true);
    expect(authEvents[0]?.tags).toContainEqual([
      "u",
      "https://relay.example/query",
    ]);
    expect(authEvents[0]?.tags).toContainEqual(["method", "POST"]);
    expect(
      authEvents[0]?.tags.find((tag) => tag[0] === "payload")?.[1],
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses plaintext remote relay endpoints", () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    expect(
      () =>
        new RelayHttpClient({
          baseUrl: "http://relay.example",
          sign: (input) => identity.sign(input),
        }),
    ).toThrow(/must use TLS/);
  });

  it("switches future requests to a newly validated relay", async () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    const urls: string[] = [];
    const relay = new RelayHttpClient({
      baseUrl: "https://one.example",
      fetch: async (input) => {
        urls.push(String(input));
        return new Response("[]", { status: 200 });
      },
      sign: (input) => identity.sign(input),
    });
    await relay.query([{ kinds: [0] }]);
    relay.setBaseUrl("https://two.example");
    await relay.query([{ kinds: [1] }]);
    expect(urls).toEqual([
      "https://one.example/query",
      "https://two.example/query",
    ]);
    expect(() => relay.setBaseUrl("http://attacker.example")).toThrow(
      /must use TLS/,
    );
  });

  it("copies the managed agent owner credential into every NIP-98 event", async () => {
    const owner = IdentityService.create(undefined, async () => undefined);
    const agent = IdentityService.create(undefined, async () => undefined);
    const authTag = owner.ownerAuthTag(agent.info().pubkey);
    const authEvents: Event[] = [];
    const relay = new RelayHttpClient({
      authTag,
      baseUrl: "https://relay.example",
      fetch: async (_input, init) => {
        const authorization = new Headers(init?.headers).get("authorization");
        if (!authorization?.startsWith("Nostr ")) {
          throw new Error("missing authorization");
        }
        authEvents.push(
          JSON.parse(
            Buffer.from(authorization.slice(6), "base64").toString("utf8"),
          ) as Event,
        );
        return new Response("[]", { status: 200 });
      },
      sign: (input) => agent.sign(input),
    });
    await relay.query([{ kinds: [0] }]);
    expect(authEvents[0]?.tags).toContainEqual(authTag);
  });
});
