import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRemoteEnvelope,
  type AckPayload,
  type EnrollmentPayload,
} from "@buzz/remote-agent-protocol";

import { PostgresRemoteRegistry } from "./postgres-remote-registry.js";

const databaseUrl = process.env.BUZZ_TEST_DATABASE_URL;
const NOW = 1_785_250_000;
const community = `brap-${randomUUID()}.example`;
const pool = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 4 })
  : undefined;

describe.skipIf(!pool)("Postgres remote worker registry", () => {
  beforeAll(async () => {
    await pool?.query("INSERT INTO communities (host) VALUES ($1)", [
      community,
    ]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("allows only one concurrent token consumer and durably revokes it", async () => {
    if (!pool) throw new Error("test pool is unavailable");
    const registry = new PostgresRemoteRegistry(pool);
    const ownerSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(ownerSecret);
    const workers = [generateSecretKey(), generateSecretKey()];
    const minted = await registry.mint({
      capabilities: ["deploy", "status", "revoke"],
      community,
      now: NOW,
      ownerPubkey,
    });
    const enrollmentAttempts = workers.map((secret) => {
      const workerPubkey = getPublicKey(secret);
      const event = enrollmentEvent({
        enrollmentId: minted.record.id,
        ownerPubkey,
        secret,
        workerPubkey,
      });
      return registry.redeem({
        authenticatedPubkey: workerPubkey,
        community,
        event,
        now: NOW,
        token: minted.token,
      });
    });

    const results = await Promise.allSettled(enrollmentAttempts);
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<(typeof enrollmentAttempts)[number]>
      > => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "ENROLLMENT_USED" });

    const binding = fulfilled[0]?.value.binding;
    if (!binding) throw new Error("winning binding is unavailable");
    const approvalEvent = approval({
      enrollmentId: binding.enrollmentId,
      ownerSecret,
      workerPubkey: binding.workerPubkey,
    });
    await registry.approve({
      authenticatedOwnerPubkey: ownerPubkey,
      community,
      enrollmentId: binding.enrollmentId,
      event: approvalEvent,
      now: NOW + 1,
      workerPubkey: binding.workerPubkey,
    });
    await expect(
      registry.authorizedWorker(binding.workerPubkey, community),
    ).resolves.toMatchObject({ approvedAt: NOW + 1 });

    await registry.revoke({
      authenticatedOwnerPubkey: ownerPubkey,
      community,
      now: NOW + 2,
      workerPubkey: binding.workerPubkey,
    });
    await expect(
      registry.authorizedWorker(binding.workerPubkey, community),
    ).resolves.toBeUndefined();
    await expect(
      registry.redeem({
        authenticatedPubkey: binding.workerPubkey,
        community,
        event: enrollmentEvent({
          enrollmentId: binding.enrollmentId,
          ownerPubkey,
          secret:
            workers.find(
              (candidate) => getPublicKey(candidate) === binding.workerPubkey,
            ) ?? requiredFirstWorker(workers),
          workerPubkey: binding.workerPubkey,
        }),
        now: NOW + 3,
        token: minted.token,
      }),
    ).rejects.toMatchObject({ code: "ENROLLMENT_USED" });
  });
});

function requiredFirstWorker(workers: readonly Uint8Array[]): Uint8Array {
  const first = workers[0];
  if (!first) throw new Error("test worker list is empty");
  return first;
}

function enrollmentEvent(input: {
  readonly enrollmentId: string;
  readonly ownerPubkey: string;
  readonly secret: Uint8Array;
  readonly workerPubkey: string;
}) {
  const payload: EnrollmentPayload = {
    body: {
      capabilities: ["deploy", "status", "revoke"],
      challenge: randomBytes(32).toString("hex"),
      community,
      enrollmentId: input.enrollmentId,
      ownerPubkey: input.ownerPubkey,
      workerName: "postgres-worker",
      workerPubkey: input.workerPubkey,
      workerVersion: "0.1.0",
    },
    deploymentId: input.enrollmentId,
    expiresAt: NOW + 30,
    issuedAt: NOW,
    messageId: randomUUID(),
    sequence: 0,
    sessionId: randomBytes(16).toString("hex"),
    type: "enrollment",
    version: 1,
  };
  return createRemoteEnvelope({
    payload,
    recipientPubkey: input.ownerPubkey,
    senderSecretKey: input.secret,
    workerPubkey: input.workerPubkey,
  });
}

function approval(input: {
  readonly enrollmentId: string;
  readonly ownerSecret: Uint8Array;
  readonly workerPubkey: string;
}) {
  const payload: AckPayload = {
    body: {
      commandMessageId: randomUUID(),
      outcome: "completed",
    },
    deploymentId: input.enrollmentId,
    expiresAt: NOW + 30,
    issuedAt: NOW,
    messageId: randomUUID(),
    sequence: 0,
    sessionId: randomBytes(16).toString("hex"),
    type: "ack",
    version: 1,
  };
  return createRemoteEnvelope({
    payload,
    recipientPubkey: input.workerPubkey,
    senderSecretKey: input.ownerSecret,
    workerPubkey: input.workerPubkey,
  });
}
