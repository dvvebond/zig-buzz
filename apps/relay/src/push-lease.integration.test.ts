import { randomUUID } from "node:crypto";

import { KIND_PUSH_LEASE, signNostrEvent } from "@buzz/core";
import { nip44 } from "nostr-tools";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PushLeaseService } from "./push-lease.js";

const databaseUrl =
  process.env.BUZZ_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("Postgres push lease acceptance", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const communityId = randomUUID();
  const communityHost = `push-${communityId}.example`;
  const relaySecret = generateSecretKey();
  const authorSecret = generateSecretKey();
  let service: PushLeaseService;

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO communities (id, host) VALUES ($1::uuid, $2)",
      [communityId, communityHost],
    );
    service = new PushLeaseService({
      communityHost,
      communityId,
      executorKeyId: "relay-v1",
      pool,
      publicUrl: new URL(`wss://${communityHost}/`),
      pushConfigured: true,
      relaySecretKey: relaySecret,
    });
  });

  afterAll(async () => {
    await pool.query(
      "DELETE FROM push_wake_outbox WHERE community_id = $1::uuid",
      [communityId],
    );
    await pool.query(
      "DELETE FROM push_match_queue WHERE community_id = $1::uuid",
      [communityId],
    );
    await pool.query("DELETE FROM push_leases WHERE community_id = $1::uuid", [
      communityId,
    ]);
    await pool.query("DELETE FROM events WHERE community_id = $1::uuid", [
      communityId,
    ]);
    await pool.query("DELETE FROM communities WHERE id = $1::uuid", [
      communityId,
    ]);
    await pool.end();
  });

  it("atomically applies event ordering and generation fencing", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const first = leaseEvent(1, true, now);
    await expect(service.accept(first, now)).resolves.toBe("accepted");
    const stored = await pool.query<{
      readonly active: boolean;
      readonly event_id: string;
      readonly generation: string;
    }>(
      `SELECT l.active, l.generation::text,
              encode(l.source_event_id, 'hex') AS event_id
       FROM push_leases l
       WHERE l.community_id = $1::uuid
         AND l.author = decode($2, 'hex')
         AND l.installation_id = 'installation-1'`,
      [communityId, getPublicKey(authorSecret)],
    );
    expect(stored.rows[0]).toEqual({
      active: true,
      event_id: first.id,
      generation: "1",
    });
    await expect(service.accept(first, now)).resolves.toBe("stale_event");

    const staleGeneration = leaseEvent(1, false, now + 1);
    await expect(service.accept(staleGeneration, now)).resolves.toBe(
      "stale_generation",
    );
    const revoke = leaseEvent(2, false, now + 2);
    await expect(service.accept(revoke, now)).resolves.toBe("accepted");
    const effective = await pool.query<{
      readonly active: boolean;
      readonly generation: string;
      readonly live_events: string;
    }>(
      `SELECT l.active, l.generation::text,
              (
                SELECT count(*)::text
                FROM events e
                WHERE e.community_id = l.community_id
                  AND e.kind = $3
                  AND e.pubkey = l.author
                  AND e.d_tag = l.installation_id
                  AND e.deleted_at IS NULL
              ) AS live_events
       FROM push_leases l
       WHERE l.community_id = $1::uuid
         AND l.author = decode($2, 'hex')
         AND l.installation_id = 'installation-1'`,
      [communityId, getPublicKey(authorSecret), KIND_PUSH_LEASE],
    );
    expect(effective.rows[0]).toEqual({
      active: false,
      generation: "2",
      live_events: "1",
    });
  });

  function leaseEvent(generation: number, active: boolean, createdAt: number) {
    const author = getPublicKey(authorSecret);
    const plaintext = active
      ? {
          active,
          app_profile: "buzz-ios-sandbox",
          endpoint: `grant-${generation}`,
          generation,
          origin: `wss://${communityHost}`,
          subscriptions: [
            {
              class: "default",
              filter: { "#p": [author], kinds: [9] },
            },
          ],
          transport: "apns",
          v: 1,
        }
      : {
          active,
          generation,
          origin: `wss://${communityHost}`,
          v: 1,
        };
    const key = nip44.v2.utils.getConversationKey(
      authorSecret,
      getPublicKey(relaySecret),
    );
    return signNostrEvent(
      {
        content: nip44.v2.encrypt(JSON.stringify(plaintext), key),
        created_at: createdAt,
        kind: KIND_PUSH_LEASE,
        tags: [
          ["d", "installation-1"],
          ["expiration", String(createdAt + 3_600)],
          ["exec", "relay-v1"],
        ],
      },
      authorSecret,
    );
  }
});
