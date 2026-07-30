import { generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";
import { signNostrEvent } from "@buzz/core";

import { InMemoryEventBus } from "./event-bus.js";

describe("event bus", () => {
  it("fans signed events out only inside their community", async () => {
    const bus = new InMemoryEventBus();
    const one = vi.fn();
    const two = vi.fn();
    const unsubscribe = await bus.subscribe("one.example", one);
    await bus.subscribe("two.example", two);
    const event = signNostrEvent(
      {
        content: "hello",
        created_at: 100,
        kind: 1,
        tags: [],
      },
      generateSecretKey(),
    );
    await bus.publish("one.example", event);
    expect(one).toHaveBeenCalledWith(event);
    expect(two).not.toHaveBeenCalled();
    await unsubscribe();
    await bus.publish("one.example", event);
    expect(one).toHaveBeenCalledOnce();
  });

  it("rejects a mutated event", async () => {
    const bus = new InMemoryEventBus();
    const event = signNostrEvent(
      {
        content: "hello",
        created_at: 100,
        kind: 1,
        tags: [],
      },
      generateSecretKey(),
    );
    await expect(
      bus.publish("one.example", { ...event, content: "mutated" }),
    ).rejects.toThrow(/invalid/);
  });

  it("scopes Rust-compatible connection controls by community ID", async () => {
    const bus = new InMemoryEventBus();
    const one = vi.fn();
    const two = vi.fn();
    const communityOne = "eb502388-39b6-4b25-8fd8-dd530e9e54df";
    const communityTwo = "a7ddebf5-b4a3-4954-b4bd-4d882bd37837";
    await bus.subscribeControl(communityOne, one);
    await bus.subscribeControl(communityTwo, two);
    await bus.publishControl(communityOne, {
      event_id: "a".repeat(64),
      op: "DisconnectPubkey",
      pubkey: [...Buffer.from("b".repeat(64), "hex")],
      reason: "blocked",
    });
    expect(one).toHaveBeenCalledWith({
      event_id: "a".repeat(64),
      op: "DisconnectPubkey",
      pubkey: Array(32).fill(0xbb),
      reason: "blocked",
    });
    expect(two).not.toHaveBeenCalled();
    const channelId = "77c448da-a6c3-4a96-a343-3693ec7e4278";
    await bus.publishControl(communityOne, {
      channel_id: channelId,
      event_id: "e".repeat(64),
      op: "RevokeChannelAccess",
      pubkey: [...Buffer.from("f".repeat(64), "hex")],
    });
    expect(one).toHaveBeenLastCalledWith({
      channel_id: channelId,
      event_id: "e".repeat(64),
      op: "RevokeChannelAccess",
      pubkey: Array(32).fill(0xff),
    });
    await bus.publishControl(communityOne, {
      channel_id: channelId,
      event_id: "9".repeat(64),
      mode: "non_members",
      op: "RevalidateChannelAccess",
    });
    expect(one).toHaveBeenLastCalledWith({
      channel_id: channelId,
      event_id: "9".repeat(64),
      mode: "non_members",
      op: "RevalidateChannelAccess",
    });
    await expect(
      bus.publishControl(communityOne, {
        event_id: "invalid",
        op: "DisconnectPubkey",
        pubkey: [],
        reason: "blocked",
      }),
    ).rejects.toThrow(/invalid/);
  });

  it("atomically scopes NIP-98 replay claims", async () => {
    const bus = new InMemoryEventBus();
    const eventId = "d".repeat(64);
    expect(
      await bus.claimNip98Replay(
        "eb502388-39b6-4b25-8fd8-dd530e9e54df",
        eventId,
        30,
      ),
    ).toBe(true);
    expect(
      await bus.claimNip98Replay(
        "eb502388-39b6-4b25-8fd8-dd530e9e54df",
        eventId,
        30,
      ),
    ).toBe(false);
    expect(
      await bus.claimNip98Replay(
        "a7ddebf5-b4a3-4954-b4bd-4d882bd37837",
        eventId,
        30,
      ),
    ).toBe(true);
  });

  it("atomically scopes fixed-window admission by tenant, principal, and kind", async () => {
    const bus = new InMemoryEventBus();
    const principal = "ab".repeat(32);
    const first = await bus.claimRateLimit(
      "one.example",
      principal,
      "ws",
      5,
      2,
    );
    const second = await bus.claimRateLimit(
      "one.example",
      principal,
      "ws",
      5,
      2,
    );
    const rejected = await bus.claimRateLimit(
      "one.example",
      principal,
      "ws",
      5,
      2,
    );
    const otherTenant = await bus.claimRateLimit(
      "two.example",
      principal,
      "ws",
      5,
      2,
    );
    const otherKind = await bus.claimRateLimit(
      "one.example",
      principal,
      "msg",
      60,
      1,
    );
    const localAuthority = await bus.claimRateLimit(
      "127.0.0.1:39876",
      principal,
      "ws",
      5,
      2,
    );

    expect(first).toMatchObject({ allowed: true, current: 1, limit: 2 });
    expect(second).toMatchObject({ allowed: true, current: 2, limit: 2 });
    expect(rejected).toMatchObject({ allowed: false, current: 3, limit: 2 });
    expect(rejected.resetInSeconds).toBeGreaterThan(0);
    expect(otherTenant).toMatchObject({ allowed: true, current: 1 });
    expect(otherKind).toMatchObject({ allowed: true, current: 1 });
    expect(localAuthority).toMatchObject({ allowed: true, current: 1 });
  });

  it("rejects malformed admission keys and budgets", async () => {
    const bus = new InMemoryEventBus();
    await expect(
      bus.claimRateLimit("../other", "ab".repeat(32), "ws", 5, 10),
    ).rejects.toThrow(/invalid/);
    await expect(
      bus.claimRateLimit("one.example", "not-a-pubkey", "ws", 5, 10),
    ).rejects.toThrow(/invalid/);
    await expect(
      bus.claimRateLimit("one.example", "ab".repeat(32), "ws", 0, 10),
    ).rejects.toThrow(/invalid/);
  });

  it("keeps presence tenant-scoped and clears only the selected tenant", async () => {
    const bus = new InMemoryEventBus();
    const pubkey = "ab".repeat(32);
    await bus.setPresence("one.example", pubkey, "online");
    await bus.setPresence("two.example", pubkey, "away");

    await expect(bus.getPresenceBulk("one.example", [pubkey])).resolves.toEqual(
      new Map([[pubkey, "online"]]),
    );
    await bus.clearPresence("one.example", pubkey);
    await expect(bus.getPresenceBulk("one.example", [pubkey])).resolves.toEqual(
      new Map(),
    );
    await expect(bus.getPresenceBulk("two.example", [pubkey])).resolves.toEqual(
      new Map([[pubkey, "away"]]),
    );
  });
});
