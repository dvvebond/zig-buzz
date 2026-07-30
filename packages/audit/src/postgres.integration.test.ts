import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditIntegrityError } from "./types.js";
import { AuditService } from "./service.js";

const databaseUrl = process.env.BUZZ_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;

integrationDescribe("Postgres audit chain", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const communityA = randomUUID();
  const communityB = randomUUID();

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO communities (id, host) VALUES ($1, $2), ($3, $4)`,
      [
        communityA,
        `audit-a-${communityA}.test`,
        communityB,
        `audit-b-${communityB}.test`,
      ],
    );
  });

  afterAll(async () => {
    await pool.query(
      "DELETE FROM audit_log WHERE community_id = ANY($1::uuid[])",
      [[communityA, communityB]],
    );
    await pool.query("DELETE FROM communities WHERE id = ANY($1::uuid[])", [
      [communityA, communityB],
    ]);
    await pool.end();
  });

  it("serializes each tenant independently and detects tampering", async () => {
    const service = new AuditService(pool);
    const first = await service.log({
      action: "event_created",
      actorPubkey: new Uint8Array(32).fill(0xab),
      communityId: communityA,
      detail: { nested: { z: 1, a: 2 } },
      objectId: "event-a",
    });
    const second = await service.log({
      action: "channel_created",
      communityId: communityA,
      detail: null,
      objectId: "channel-a",
    });
    const otherTenant = await service.log({
      action: "event_created",
      communityId: communityB,
      detail: { tenant: "b" },
    });
    expect(first.seq).toBe(1n);
    expect(second.seq).toBe(2n);
    expect(second.prevHash).toEqual(first.hash);
    expect(otherTenant.seq).toBe(1n);
    await expect(service.verifyChain(communityA, 1n, 2n)).resolves.toBe(true);

    await pool.query(
      `UPDATE audit_log SET detail = '{"tampered":true}'::jsonb
       WHERE community_id = $1 AND seq = 2`,
      [communityA],
    );
    await expect(service.verifyChain(communityA, 1n, 2n)).rejects.toEqual(
      expect.objectContaining<Partial<AuditIntegrityError>>({
        code: "HASH_MISMATCH",
        seq: 2n,
      }),
    );
  });
});
