import { createHash, createHmac, randomUUID } from "node:crypto";

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";

import {
  KIND_HTTP_AUTH,
  KIND_NIP43_MEMBER_ADDED,
  signNostrEvent,
  unixNow,
} from "@buzz/core";

import { createRelayServer } from "./server.js";

type TestRelay = ReturnType<typeof createRelayServer>;
const relays: TestRelay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("relay invite HTTP API", () => {
  it("mints and atomically consumes authenticated, use-limited invites", async () => {
    const ownerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const relaySecret = generateSecretKey();
    const { baseUrl, relay } = await startRelay({
      ownerPubkeys: new Set([ownerPubkey]),
      relaySecretKey: relaySecret,
    });

    const policy = await fetch(`${baseUrl}/api/join-policy`);
    expect(policy.status).toBe(200);
    await expect(policy.json()).resolves.toEqual({});

    const mintBody = Buffer.from(
      JSON.stringify({ max_uses: 1, ttl_secs: 60 }),
      "utf8",
    );
    const mintedResponse = await authenticatedFetch(
      `${baseUrl}/api/invites`,
      ownerSecret,
      mintBody,
    );
    expect(mintedResponse.status).toBe(201);
    const minted = (await mintedResponse.json()) as {
      code: string;
      expires_at: number;
      max_uses: number;
      url: string;
      uses_remaining: number;
    };
    expect(minted).toMatchObject({
      max_uses: 1,
      uses_remaining: 1,
    });
    expect(minted.code).toMatch(/^v2\.[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(minted.code.slice(3), "base64url")).toHaveLength(32);
    expect(minted.url).toBe(`${baseUrl}/invite/${minted.code}`);
    expect(minted.expires_at).toBeGreaterThanOrEqual(unixNow() + 59);

    const joiningSecret = generateSecretKey();
    const joiningPubkey = getPublicKey(joiningSecret);
    const claimBody = Buffer.from(
      JSON.stringify({ code: minted.code }),
      "utf8",
    );
    const claimed = await authenticatedFetch(
      `${baseUrl}/api/invites/claim`,
      joiningSecret,
      claimBody,
    );
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toEqual({
      community_id: "localhost",
      host: "localhost",
      role: "member",
      status: "joined",
    });

    const repeated = await authenticatedFetch(
      `${baseUrl}/api/invites/claim`,
      joiningSecret,
      claimBody,
    );
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({
      status: "already_member",
    });

    const exhausted = await authenticatedFetch(
      `${baseUrl}/api/invites/claim`,
      generateSecretKey(),
      claimBody,
    );
    expect(exhausted.status).toBe(403);
    await expect(exhausted.json()).resolves.toEqual({
      error: "invite_exhausted",
    });

    const unauthorized = await authenticatedFetch(
      `${baseUrl}/api/invites`,
      generateSecretKey(),
      Buffer.from("{}", "utf8"),
    );
    expect(unauthorized.status).toBe(403);
    await expect(unauthorized.json()).resolves.toEqual({
      error: "only relay owners and admins can create invites",
    });

    const deltas = await relay.eventStore.query("localhost", {
      "#p": [joiningPubkey],
      kinds: [KIND_NIP43_MEMBER_ADDED],
    });
    expect(deltas).toHaveLength(1);
  });

  it("requires a code-bound, Rust-compatible policy receipt", async () => {
    const ownerSecret = generateSecretKey();
    const relaySecret = generateSecretKey();
    const version = createHash("sha256")
      .update("# Terms", "utf8")
      .update(Buffer.from([0]))
      .update("Privacy <script>alert(1)</script>", "utf8")
      .update(Buffer.from([0, 1]))
      .digest("hex");
    const { baseUrl } = await startRelay({
      joinPolicy: {
        ageAttestationRequired: true,
        privacyMarkdown: "Privacy <script>alert(1)</script>",
        termsMarkdown: "# Terms",
        version,
      },
      ownerPubkeys: new Set([getPublicKey(ownerSecret)]),
      relaySecretKey: relaySecret,
    });

    const policyResponse = await fetch(`${baseUrl}/api/join-policy`);
    await expect(policyResponse.json()).resolves.toEqual({
      policy: {
        age_attestation_required: true,
        privacy_markdown: "Privacy <script>alert(1)</script>",
        terms_markdown: "# Terms",
        version,
      },
    });
    const privacy = await (
      await fetch(`${baseUrl}/api/join-policy/privacy`)
    ).text();
    expect(privacy).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(privacy).not.toContain("<script>alert(1)</script>");

    const mintBody = Buffer.from("{}", "utf8");
    const minted = (await (
      await authenticatedFetch(`${baseUrl}/api/invites`, ownerSecret, mintBody)
    ).json()) as { code: string };
    const acceptanceUrl = `${baseUrl}/api/invites/accept-policy`;
    const rejectedAcceptance = await fetch(acceptanceUrl, {
      body: JSON.stringify({
        age_confirmed: false,
        code: minted.code,
        policy_version: version,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(rejectedAcceptance.status).toBe(400);
    await expect(rejectedAcceptance.json()).resolves.toEqual({
      error: "join_policy_not_accepted",
    });

    const accepted = await fetch(acceptanceUrl, {
      body: JSON.stringify({
        age_confirmed: true,
        code: minted.code,
        policy_version: version,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(accepted.status).toBe(200);
    const { receipt } = (await accepted.json()) as { receipt: string };
    verifyRustCompatibleReceipt(receipt, relaySecret, minted.code, version);

    const joiningSecret = generateSecretKey();
    const withoutReceipt = Buffer.from(
      JSON.stringify({ code: minted.code }),
      "utf8",
    );
    const denied = await authenticatedFetch(
      `${baseUrl}/api/invites/claim`,
      joiningSecret,
      withoutReceipt,
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({
      error: "join_policy_required",
    });

    const withReceipt = Buffer.from(
      JSON.stringify({
        code: minted.code,
        policy_receipt: receipt,
      }),
      "utf8",
    );
    const joined = await authenticatedFetch(
      `${baseUrl}/api/invites/claim`,
      joiningSecret,
      withReceipt,
    );
    expect(joined.status).toBe(200);
    await expect(joined.json()).resolves.toMatchObject({
      status: "joined",
    });

    const tampered = Buffer.from(
      JSON.stringify({
        code: `v2.${"A".repeat(43)}`,
        policy_receipt: receipt,
      }),
      "utf8",
    );
    const tamperedResponse = await authenticatedFetch(
      `${baseUrl}/api/invites/claim`,
      generateSecretKey(),
      tampered,
    );
    expect(tamperedResponse.status).toBe(403);
    await expect(tamperedResponse.json()).resolves.toEqual({
      error: "join_policy_required",
    });
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

async function authenticatedFetch(
  url: string,
  secret: Uint8Array,
  body: Buffer,
): Promise<Response> {
  const event = signNostrEvent(
    {
      content: "",
      created_at: unixNow(),
      kind: KIND_HTTP_AUTH,
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", createHash("sha256").update(body).digest("hex")],
        ["nonce", randomUUID()],
      ],
    },
    secret,
  );
  return fetch(url, {
    body,
    headers: {
      Authorization: `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
}

function verifyRustCompatibleReceipt(
  receipt: string,
  relaySecret: Uint8Array,
  code: string,
  version: string,
): void {
  const [payloadEncoded, signatureEncoded] = receipt.split(".");
  expect(payloadEncoded).toBeTruthy();
  expect(signatureEncoded).toBeTruthy();
  const payload = Buffer.from(payloadEncoded as string, "base64url");
  const evidence = JSON.parse(payload.toString("utf8")) as {
    c: string;
    e: number;
    v: string;
  };
  expect(evidence).toMatchObject({
    c: createHash("sha256").update(code, "utf8").digest("hex"),
    v: version,
  });
  expect(evidence.e).toBeGreaterThan(unixNow());
  const key = createHash("sha256")
    .update(relaySecret)
    .update("buzz-invite-v1", "utf8")
    .digest();
  const expected = createHmac("sha256", key)
    .update(payload)
    .digest("base64url");
  expect(signatureEncoded).toBe(expected);
}
