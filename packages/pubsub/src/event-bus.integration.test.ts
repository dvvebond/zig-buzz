import { generateSecretKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";
import { signNostrEvent, type NostrEvent } from "@buzz/core";

import { RedisEventBus } from "./event-bus.js";

const redisUrl = process.env.BUZZ_TEST_REDIS_URL;
const buses: RedisEventBus[] = [];

afterEach(async () => {
  await Promise.all(buses.splice(0).map((bus) => bus.close()));
});

describe.skipIf(!redisUrl)("Redis event bus", () => {
  it("fans out across instances without echoing to the publisher", async () => {
    if (!redisUrl) throw new Error("Redis test URL is unavailable");
    const first = new RedisEventBus(redisUrl);
    const second = new RedisEventBus(redisUrl);
    buses.push(first, second);
    let localEcho = 0;
    let resolveReceived: ((event: NostrEvent) => void) | undefined;
    const received = new Promise<NostrEvent>((resolve, reject) => {
      resolveReceived = resolve;
      setTimeout(
        () => reject(new Error("Redis event timed out")),
        5_000,
      ).unref();
    });
    const community = "127.0.0.1:39876";
    await second.subscribe(community, (event) => {
      resolveReceived?.(event);
    });
    await first.subscribe(community, () => {
      localEcho += 1;
    });
    const event = signNostrEvent(
      {
        content: "cross-instance",
        created_at: Math.floor(Date.now() / 1_000),
        kind: 1,
        tags: [],
      },
      generateSecretKey(),
    );
    await first.publish(community, event);
    await expect(received).resolves.toEqual(event);
    expect(localEcho).toBe(0);
  });

  it("propagates connection-control commands across relay instances", async () => {
    if (!redisUrl) throw new Error("Redis test URL is unavailable");
    const first = new RedisEventBus(redisUrl);
    const second = new RedisEventBus(redisUrl);
    buses.push(first, second);
    const communityId = "01864931-8a3f-4d52-8b04-fd790ff574d8";
    let resolveReceived:
      | ((command: { readonly op: string }) => void)
      | undefined;
    const received = new Promise<{ readonly op: string }>((resolve, reject) => {
      resolveReceived = resolve;
      setTimeout(
        () => reject(new Error("Redis control command timed out")),
        5_000,
      ).unref();
    });
    await second.subscribeControl(communityId, (command) => {
      resolveReceived?.(command);
    });
    await first.publishControl(communityId, {
      op: "DisconnectCommunity",
    });
    await expect(received).resolves.toEqual({
      op: "DisconnectCommunity",
    });
  });

  it("atomically rejects a replay claimed by another instance", async () => {
    if (!redisUrl) throw new Error("Redis test URL is unavailable");
    const first = new RedisEventBus(redisUrl);
    const second = new RedisEventBus(redisUrl);
    buses.push(first, second);
    const scope = "01864931-8a3f-4d52-8b04-fd790ff574d8";
    const eventId = Buffer.from(`${Date.now()}-${Math.random()}`, "utf8")
      .toString("hex")
      .padEnd(64, "0")
      .slice(0, 64);
    expect(await first.claimNip98Replay(scope, eventId, 120)).toBe(true);
    expect(await second.claimNip98Replay(scope, eventId, 120)).toBe(false);
  });

  it("shares an atomic admission window across instances", async () => {
    if (!redisUrl) throw new Error("Redis test URL is unavailable");
    const first = new RedisEventBus(redisUrl);
    const second = new RedisEventBus(redisUrl);
    buses.push(first, second);
    const scope = `test-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
    const principal = "ab".repeat(32);
    const [one, two] = await Promise.all([
      first.claimRateLimit(scope, principal, "ws", 5, 1),
      second.claimRateLimit(scope, principal, "ws", 5, 1),
    ]);

    expect(
      [one.current, two.current].sort((left, right) => left - right),
    ).toEqual([1, 2]);
    expect([one.allowed, two.allowed].sort()).toEqual([false, true]);
    expect(one.resetInSeconds).toBeGreaterThan(0);
    expect(two.resetInSeconds).toBeGreaterThan(0);
  });
});
