import { createHash, randomUUID } from "node:crypto";

import { signNostrEvent } from "@buzz/core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryAuthorityStore, type AuthorityStore } from "./authority.js";
import type { DeliveryAttempt, PushTransport } from "./apns.js";
import { GrantKeyring, TokenKeyring } from "./crypto.js";
import { PushGatewayHttp, type PushGatewayState } from "./http.js";
import type { AppProfile } from "./model.js";
import { parseStrictJson } from "./strict-json.js";

const servers: PushGatewayHttp[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("PushGatewayHttp", () => {
  it("admits one NIP-98-authenticated delivery and burns its replay fences", async () => {
    const authority = new MemoryAuthorityStore();
    const relaySecret = generateSecretKey();
    const relayPubkey = getPublicKey(relaySecret);
    const tokenKeys = new TokenKeyring([
      { id: "token", key: Buffer.alloc(32, 4) },
    ]);
    const grantKeys = new GrantKeyring([
      { id: "grant", key: Buffer.alloc(32, 3) },
    ]);
    const installationId = randomUUID();
    const delegationId = randomUUID();
    const endpoint = Buffer.from("aabbccdd", "hex");
    await authority.createInstallation({
      appAttestKeyId: Buffer.from([1]),
      appAttestPublicKey: Buffer.alloc(65, 2),
      assertionCounter: 0,
      endpointEpoch: 1,
      expiresAt: 2_000,
      id: installationId,
      profile: "buzz-ios-production",
      tokenCiphertext: tokenKeys.seal(endpoint),
      tokenFingerprint: Buffer.alloc(32, 9),
    });
    await authority.upsertDelegation({
      endpointEpoch: 1,
      expiresAt: 1_500,
      generation: 1,
      id: delegationId,
      installationId,
      notBefore: 900,
      relayPubkey,
      revoked: false,
    });
    const observed: Array<{
      attempt: DeliveryAttempt;
      endpoint: string;
      profile: AppProfile;
    }> = [];
    const transport: PushTransport = {
      async send(attempt, profile, token) {
        observed.push({ attempt, endpoint: token, profile });
        return { type: "accepted" };
      },
    };
    let publicUrl = "";
    const state = stateFor({
      authority,
      deliveryUrl: "",
      grantKeys,
      tokenKeys,
      transport,
    });
    const server = new PushGatewayHttp(state);
    servers.push(server);
    const address = await server.listen({
      healthHost: "127.0.0.1",
      healthPort: 0,
      publicHost: "127.0.0.1",
      publicPort: 0,
    });
    publicUrl = `${address.publicUrl}/v1/deliveries/apns`;
    Object.defineProperty(state, "deliveryUrl", { value: publicUrl });

    const body = Buffer.from(
      JSON.stringify({
        endpoint_grant: grantKeys.issue({
          app_profile: "buzz-ios-production",
          delegation_id: delegationId,
          endpoint_epoch: 1,
          expires_at: 1_500,
          generation: 1,
          relay_pubkey: relayPubkey,
          v: 1,
        }),
        expires_at: 1_100,
        request_id: randomUUID(),
        v: 1,
      }),
    );
    const authorization = nip98(relaySecret, publicUrl, body, 1_000);
    const first = await fetch(publicUrl, {
      body,
      headers: { authorization, "content-type": "application/json" },
      method: "POST",
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: "accepted" });
    expect(observed).toEqual([
      {
        attempt: {
          expiresAt: 1_100,
          requestId: JSON.parse(body.toString()).request_id as string,
        },
        endpoint: "aabbccdd",
        profile: "buzz-ios-production",
      },
    ]);
    const replay = await fetch(publicUrl, {
      body,
      headers: { authorization, "content-type": "application/json" },
      method: "POST",
    });
    expect(replay.status).toBe(404);
    relaySecret.fill(0);
  });

  it("fails closed on duplicate JSON keys and reports readiness", async () => {
    const state = stateFor({
      authority: new MemoryAuthorityStore(),
      deliveryUrl: "https://push.buzz.xyz/v1/deliveries/apns",
      grantKeys: new GrantKeyring([{ id: "grant", key: Buffer.alloc(32, 3) }]),
      tokenKeys: new TokenKeyring([{ id: "token", key: Buffer.alloc(32, 4) }]),
      transport: {
        async send() {
          return { type: "accepted" };
        },
      },
    });
    const server = new PushGatewayHttp(state);
    servers.push(server);
    const address = await server.listen({
      healthHost: "127.0.0.1",
      healthPort: 0,
      publicHost: "127.0.0.1",
      publicPort: 0,
    });
    const invalid = await fetch(
      `${address.publicUrl}/v1/installations/challenges`,
      { body: '{"v":1,"v":1}', method: "POST" },
    );
    expect(invalid.status).toBe(400);
    const ready = await fetch(`${address.healthUrl}/_readiness`);
    expect(ready.status).toBe(200);
  });
});

describe("strict JSON", () => {
  it("rejects duplicate keys at any nesting depth", () => {
    expect(() => parseStrictJson('{"a":{"b":1,"b":2}}')).toThrow(/duplicate/);
    expect(parseStrictJson('{"a":[true,null,-2.5e3]}')).toEqual({
      a: [true, null, -2_500],
    });
  });
});

function stateFor(input: {
  authority: AuthorityStore;
  deliveryUrl: string;
  grantKeys: GrantKeyring;
  tokenKeys: TokenKeyring;
  transport: PushTransport;
}): PushGatewayState {
  return {
    appAttest: {
      verifyAssertion() {
        return { counter: 1 };
      },
      verifyAttestation() {
        return { keyId: Buffer.alloc(32), publicKey: Buffer.alloc(65) };
      },
    },
    authority: input.authority,
    deliveryUrl: input.deliveryUrl,
    enabledProfiles: new Set(["buzz-ios-production"]),
    endpointQuotaMaxDeliveries: 10,
    endpointQuotaWindowSeconds: 10,
    grantKeyring: input.grantKeys,
    maxGrantLifetimeSeconds: 2_592_000,
    maxInstallationLifetimeSeconds: 7_776_000,
    now: () => 1_000,
    tokenKeyring: input.tokenKeys,
    transport: input.transport,
  };
}

function nip98(
  secret: Uint8Array,
  url: string,
  body: Buffer,
  createdAt: number,
): string {
  const event = signNostrEvent(
    {
      content: "",
      created_at: createdAt,
      kind: 27_235,
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", createHash("sha256").update(body).digest("hex")],
      ],
    },
    secret,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}
