import { describe, expect, it } from "vitest";

import {
  AuthorityError,
  MemoryAuthorityStore,
  type DeliveryPermit,
} from "./authority.js";

describe("MemoryAuthorityStore", () => {
  it("serializes generations, endpoint epochs, replay fences, and quota", async () => {
    const store = await populatedStore();
    const permit = await authorize(store, "22".repeat(32), crypto.randomUUID());
    await expect(
      authorize(store, "22".repeat(32), crypto.randomUUID()),
    ).rejects.toMatchObject({ reason: "rejected" });
    await expect(
      authorize(store, "33".repeat(32), permit.requestId),
    ).rejects.toMatchObject({ reason: "rejected" });
    await store.finishDelivery(permit, "retryable");
    await authorize(store, "33".repeat(32), permit.requestId);
  });

  it("keeps terminal request ids burned and refuses stale mutation", async () => {
    const store = await populatedStore();
    const requestId = crypto.randomUUID();
    const permit = await authorize(store, "22".repeat(32), requestId);
    await store.finishDelivery(permit, "terminal");
    await expect(
      authorize(store, "33".repeat(32), requestId),
    ).rejects.toBeInstanceOf(AuthorityError);
    await expect(
      store.revokeDelegation(INSTALLATION_ID, RELAY, 1),
    ).rejects.toBeInstanceOf(AuthorityError);
  });
});

const INSTALLATION_ID = "00000000-0000-0000-0000-000000000001";
const DELEGATION_ID = "00000000-0000-0000-0000-000000000002";
const RELAY = "11".repeat(32);

async function populatedStore(): Promise<MemoryAuthorityStore> {
  const store = new MemoryAuthorityStore();
  await store.createInstallation({
    appAttestKeyId: Buffer.from([1]),
    appAttestPublicKey: Buffer.alloc(65, 2),
    assertionCounter: 0,
    endpointEpoch: 1,
    expiresAt: 2_000,
    id: INSTALLATION_ID,
    profile: "buzz-ios-production",
    tokenCiphertext: Buffer.from([3]),
    tokenFingerprint: Buffer.alloc(32, 4),
  });
  await store.upsertDelegation({
    endpointEpoch: 1,
    expiresAt: 1_500,
    generation: 1,
    id: DELEGATION_ID,
    installationId: INSTALLATION_ID,
    notBefore: 900,
    relayPubkey: RELAY,
    revoked: false,
  });
  return store;
}

async function authorize(
  store: MemoryAuthorityStore,
  authEventId: string,
  requestId: string,
): Promise<DeliveryPermit> {
  return store.authorizeDelivery({
    authEventId,
    delegationId: DELEGATION_ID,
    endpointEpoch: 1,
    generation: 1,
    now: 1_000,
    quotaMaxDeliveries: 10,
    quotaWindowSeconds: 60,
    relayPubkey: RELAY,
    requestExpiresAt: 1_100,
    requestId,
  });
}
