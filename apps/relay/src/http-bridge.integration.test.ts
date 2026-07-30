import { createHash } from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";
import { signNostrEvent, unixNow, type NostrEvent } from "@buzz/core";
import { nip98Authorization } from "@buzz/remote-agent-client";
import type { RelayAccessPolicy } from "@buzz/db";
import {
  InMemoryEventBus,
  type RateLimitClaim,
  type RateLimitKind,
} from "@buzz/pubsub";

import { createRelayServer, type RelayServerOptions } from "./server.js";

type TestRelay = ReturnType<typeof createRelayServer>;
const relays: TestRelay[] = [];

class UnavailableAdmissionEventBus extends InMemoryEventBus {
  public override async claimRateLimit(
    _scope: string,
    _principal: string,
    _kind: RateLimitKind,
    _windowSeconds: number,
    _limit: number,
  ): Promise<RateLimitClaim> {
    throw new Error("shared counter unavailable");
  }
}

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("Nostr HTTP bridge", () => {
  it("submits, queries, and exactly counts signed events", async () => {
    const authorSecretKey = generateSecretKey();
    const readerSecretKey = generateSecretKey();
    const { baseUrl, relay } = await startRelay();
    const event = signNostrEvent(
      {
        content: "HTTP bridge compatibility",
        created_at: unixNow(),
        kind: 1,
        tags: [],
      },
      authorSecretKey,
    );

    const submit = await authenticatedPost(
      new URL("/events", baseUrl).toString(),
      JSON.stringify(event),
      authorSecretKey,
    );
    expect(submit.status).toBe(200);
    await expect(submit.json()).resolves.toEqual({
      accepted: true,
      event_id: event.id,
      message: "",
    });

    const filters = JSON.stringify([{ kinds: [1] }]);
    const query = await authenticatedPost(
      new URL("/query", baseUrl).toString(),
      filters,
      readerSecretKey,
    );
    expect(query.status).toBe(200);
    await expect(query.json()).resolves.toEqual([
      JSON.parse(JSON.stringify(event)),
    ]);

    const count = await authenticatedPost(
      new URL("/count", baseUrl).toString(),
      filters,
      readerSecretKey,
    );
    expect(count.status).toBe(200);
    await expect(count.json()).resolves.toEqual({ count: 1 });
    expect(await relay.eventStore.count("localhost", { kinds: [1] })).toBe(1);
  });

  it("binds the request body and identity and filters inaccessible rows", async () => {
    const authorSecretKey = generateSecretKey();
    const otherSecretKey = generateSecretKey();
    const deniedContent = "private";
    const accessPolicy: RelayAccessPolicy = {
      async canConnect() {
        return true;
      },
      async canPublish() {
        return true;
      },
      async canRead(_community, _pubkey, event) {
        return event.content !== deniedContent;
      },
    };
    const { baseUrl } = await startRelay(accessPolicy);
    const publicEvent = signNostrEvent(
      {
        content: "public",
        created_at: unixNow(),
        kind: 1,
        tags: [],
      },
      authorSecretKey,
    );
    const privateEvent = signNostrEvent(
      {
        content: deniedContent,
        created_at: unixNow() - 1,
        kind: 1,
        tags: [],
      },
      authorSecretKey,
    );
    for (const event of [publicEvent, privateEvent]) {
      const response = await authenticatedPost(
        new URL("/events", baseUrl).toString(),
        JSON.stringify(event),
        authorSecretKey,
      );
      expect(response.status).toBe(200);
    }

    const wrongIdentity = await authenticatedPost(
      new URL("/events", baseUrl).toString(),
      JSON.stringify(
        signNostrEvent(
          {
            content: "not owned by HTTP signer",
            created_at: unixNow() - 2,
            kind: 1,
            tags: [],
          },
          authorSecretKey,
        ),
      ),
      otherSecretKey,
    );
    expect(wrongIdentity.status).toBe(400);
    await expect(wrongIdentity.json()).resolves.toEqual({
      error: "SENDER_MISMATCH",
    });

    const filters = JSON.stringify([{ kinds: [1] }]);
    const queryUrl = new URL("/query", baseUrl).toString();
    const authorization = await authorizationFor(
      queryUrl,
      filters,
      otherSecretKey,
    );
    const query = await post(queryUrl, filters, authorization);
    expect(query.status).toBe(200);
    const queried = (await query.json()) as NostrEvent[];
    expect(queried.map((event) => event.id)).toEqual([publicEvent.id]);

    const replay = await post(queryUrl, filters, authorization);
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toEqual({
      error: "REPLAY_DETECTED",
    });

    const count = await authenticatedPost(
      new URL("/count", baseUrl).toString(),
      filters,
      otherSecretKey,
    );
    await expect(count.json()).resolves.toEqual({ count: 1 });
  });

  it("admits an owner-authorized agent without inheriting owner channel roles", async () => {
    const ownerSecret = generateSecretKey();
    const agentSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const agentPubkey = getPublicKey(agentSecret);
    const authTag = ownerAuthTag(ownerSecret, agentPubkey);
    const accessPolicy: RelayAccessPolicy = {
      async canConnect(_community, pubkey, delegatedBy) {
        return pubkey === agentPubkey && delegatedBy === ownerPubkey;
      },
      async canPublish(_community, pubkey, event, delegatedBy) {
        return (
          pubkey === agentPubkey &&
          event.pubkey === agentPubkey &&
          delegatedBy === ownerPubkey &&
          !event.tags.some((tag) => tag[0] === "h")
        );
      },
      async canRead(_community, pubkey, event, delegatedBy) {
        return (
          pubkey === agentPubkey &&
          delegatedBy === ownerPubkey &&
          !event.tags.some((tag) => tag[0] === "h")
        );
      },
    };
    const { baseUrl } = await startRelay(accessPolicy);
    const profile = signNostrEvent(
      {
        content: JSON.stringify({ name: "delegated-agent" }),
        created_at: unixNow(),
        kind: 0,
        tags: [authTag],
      },
      agentSecret,
    );
    const submitted = await authenticatedPost(
      new URL("/events", baseUrl).toString(),
      JSON.stringify(profile),
      agentSecret,
      authTag,
    );
    expect(submitted.status).toBe(200);

    const filters = JSON.stringify([{ authors: [agentPubkey], kinds: [0] }]);
    const queried = await authenticatedPost(
      new URL("/query", baseUrl).toString(),
      filters,
      agentSecret,
      authTag,
    );
    expect(queried.status).toBe(200);
    await expect(queried.json()).resolves.toEqual([
      JSON.parse(JSON.stringify(profile)),
    ]);

    const channelEvent = signNostrEvent(
      {
        content: "must remain agent-scoped",
        created_at: unixNow(),
        kind: 9,
        tags: [["h", "00000000-0000-4000-8000-000000000001"]],
      },
      agentSecret,
    );
    const denied = await authenticatedPost(
      new URL("/events", baseUrl).toString(),
      JSON.stringify(channelEvent),
      agentSecret,
      authTag,
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({
      error: "CAPABILITY_DENIED",
    });

    const forged = [...authTag] as [string, string, string, string];
    forged[3] = "00".repeat(64);
    const rejected = await authenticatedPost(
      new URL("/query", baseUrl).toString(),
      filters,
      agentSecret,
      forged,
    );
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({
      error: "SIGNATURE_INVALID",
    });
  });

  it("enforces the shared per-principal HTTP budget with 429 semantics", async () => {
    const secret = generateSecretKey();
    const { baseUrl } = await startRelay(undefined, {
      rateLimits: { humanApiCallsPerMinute: 1 },
    });
    const filters = JSON.stringify([{ kinds: [1] }]);

    const first = await authenticatedPost(
      new URL("/query", baseUrl).toString(),
      filters,
      secret,
    );
    expect(first.status).toBe(200);
    const rejected = await authenticatedPost(
      new URL("/count", baseUrl).toString(),
      filters,
      secret,
    );
    expect(rejected.status).toBe(429);
    await expect(rejected.json()).resolves.toEqual({
      error: expect.stringMatching(
        /^rate-limited: quota exceeded; retry in \d+s$/,
      ),
    });
  });

  it("fails closed with 503 when shared HTTP admission is unavailable", async () => {
    const secret = generateSecretKey();
    const { baseUrl } = await startRelay(undefined, {
      eventBus: new UnavailableAdmissionEventBus(),
    });
    const response = await authenticatedPost(
      new URL("/query", baseUrl).toString(),
      JSON.stringify([{ kinds: [1] }]),
      secret,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "rate-limited: shared admission unavailable",
    });
  });
});

async function startRelay(
  accessPolicy?: RelayAccessPolicy,
  options: Pick<RelayServerOptions, "eventBus" | "rateLimits"> = {},
): Promise<{ readonly baseUrl: URL; readonly relay: TestRelay }> {
  const publicUrl = new URL("ws://localhost:1/");
  const relay = createRelayServer({
    ...(accessPolicy ? { accessPolicy } : {}),
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
  const baseUrl = new URL(publicUrl);
  baseUrl.protocol = "http:";
  return { baseUrl, relay };
}

async function authenticatedPost(
  url: string,
  body: string,
  secretKey: Uint8Array,
  ownerAuthTag?: readonly [string, string, string, string],
): Promise<Response> {
  return post(
    url,
    body,
    await authorizationFor(url, body, secretKey, ownerAuthTag),
  );
}

async function authorizationFor(
  url: string,
  body: string,
  secretKey: Uint8Array,
  ownerAuthTag?: readonly [string, string, string, string],
): Promise<string> {
  return nip98Authorization({
    body: new TextEncoder().encode(body),
    method: "POST",
    ...(ownerAuthTag ? { ownerAuthTag } : {}),
    ownerSecretKey: secretKey,
    url,
  });
}

function ownerAuthTag(
  ownerSecret: Uint8Array,
  agentPubkey: string,
): [string, string, string, string] {
  const ownerPubkey = getPublicKey(ownerSecret);
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${agentPubkey}:`)
    .digest();
  return [
    "auth",
    ownerPubkey,
    "",
    Buffer.from(schnorr.sign(digest, ownerSecret)).toString("hex"),
  ];
}

function post(
  url: string,
  body: string,
  authorization: string,
): Promise<Response> {
  return fetch(url, {
    body,
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    method: "POST",
    redirect: "error",
  });
}
