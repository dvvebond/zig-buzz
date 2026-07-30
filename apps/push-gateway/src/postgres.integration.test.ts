import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresAuthorityStore } from "./postgres.js";

const databaseUrl = process.env.BUZZ_TEST_DATABASE_URL;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 4 })
  : undefined;

describe.skipIf(!pool)("Postgres push authority", () => {
  afterAll(async () => {
    await pool?.end();
  });

  it("atomically enforces replay and quota fences under concurrency", async () => {
    if (!pool) throw new Error("test pool unavailable");
    const store = new PostgresAuthorityStore(pool);
    const installationId = randomUUID();
    const delegationId = randomUUID();
    const relay = randomBytes(32).toString("hex");
    const fingerprint = randomBytes(32);
    const now = Math.floor(Date.now() / 1_000);
    await store.createInstallation({
      appAttestKeyId: randomBytes(32),
      appAttestPublicKey: Buffer.concat([Buffer.from([4]), randomBytes(64)]),
      assertionCounter: 0,
      endpointEpoch: 1,
      expiresAt: now + 3_600,
      id: installationId,
      profile: "buzz-ios-production",
      tokenCiphertext: Buffer.from("token.key"),
      tokenFingerprint: fingerprint,
    });
    await store.upsertDelegation({
      endpointEpoch: 1,
      expiresAt: now + 1_800,
      generation: 1,
      id: delegationId,
      installationId,
      notBefore: now - 1,
      relayPubkey: relay,
      revoked: false,
    });
    const base = {
      delegationId,
      endpointEpoch: 1,
      generation: 1,
      now,
      quotaMaxDeliveries: 1,
      quotaWindowSeconds: 60,
      relayPubkey: relay,
      requestExpiresAt: now + 300,
    };
    const [left, right] = await Promise.allSettled([
      store.authorizeDelivery({
        ...base,
        authEventId: randomBytes(32).toString("hex"),
        requestId: randomUUID(),
      }),
      store.authorizeDelivery({
        ...base,
        authEventId: randomBytes(32).toString("hex"),
        requestId: randomUUID(),
      }),
    ]);
    expect(
      [left, right].filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const quota = await pool.query<{ admitted: string }>(
      "SELECT admitted FROM push_gateway_endpoint_quotas WHERE token_fingerprint=$1",
      [fingerprint],
    );
    expect(Number(quota.rows[0]?.admitted)).toBe(1);

    await pool.query(
      "DELETE FROM push_gateway_delivery_auth_replays WHERE relay_pubkey=$1",
      [Buffer.from(relay, "hex")],
    );
    await pool.query(
      "DELETE FROM push_gateway_delivery_request_replays WHERE relay_pubkey=$1",
      [Buffer.from(relay, "hex")],
    );
    await pool.query(
      "DELETE FROM push_gateway_endpoint_quotas WHERE token_fingerprint=$1",
      [fingerprint],
    );
    await pool.query(
      "DELETE FROM push_gateway_delegations WHERE installation_id=$1",
      [installationId],
    );
    await pool.query("DELETE FROM push_gateway_installations WHERE id=$1", [
      installationId,
    ]);
  });
});
