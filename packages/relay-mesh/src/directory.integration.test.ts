import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RedisSessionDirectory,
  fencedHeader,
  type RuntimeId,
} from "./index.js";

const redisUrl = process.env.BUZZ_TEST_REDIS_URL;

describe.skipIf(!redisUrl)("RedisSessionDirectory", () => {
  it("atomically fences ownership, renewal, release and takeover", async () => {
    if (!redisUrl) throw new Error("Redis test URL is unavailable");
    const directory = new RedisSessionDirectory(redisUrl, 120);
    const community = randomUUID();
    const session = randomUUID();
    const ownerA = "11".repeat(32) as RuntimeId;
    const ownerB = "22".repeat(32) as RuntimeId;
    try {
      const acquired = await directory.acquire(
        community,
        session,
        ownerA,
        "reliable_stream",
      );
      expect(acquired.status).toBe("acquired");
      expect(acquired.lease.generation).toBe("1");
      expect(
        await directory.acquire(community, session, ownerB, "reliable_stream"),
      ).toMatchObject({ status: "exists", lease: { ownerRuntimeId: ownerA } });
      expect(
        await directory.validateFence(fencedHeader(acquired.lease)),
      ).toMatchObject({ ok: true });
      expect(
        await directory.validateFence({
          ...fencedHeader(acquired.lease),
          ownerRuntimeId: ownerB,
        }),
      ).toMatchObject({ ok: false, reason: "owner_mismatch" });
      expect(await directory.renew(acquired.lease)).toMatchObject({
        status: "renewed",
      });
      expect(await directory.release(acquired.lease)).toMatchObject({
        status: "released",
      });
      const takeover = await directory.takeover(
        community,
        session,
        ownerB,
        "reliable_stream",
      );
      expect(takeover).toMatchObject({
        status: "acquired",
        lease: { generation: "2", ownerRuntimeId: ownerB },
      });
      expect(
        await directory.validateFence(fencedHeader(acquired.lease)),
      ).toMatchObject({ ok: false, reason: "stale_generation" });
    } finally {
      await directory.close();
    }
  });
});
