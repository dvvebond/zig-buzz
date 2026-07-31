import { describe, expect, it, vi } from "vitest";

import { ChannelReaper } from "./channel-reaper.js";

describe("ChannelReaper", () => {
  it("runs the row-claim callback and publishes every archived outcome", async () => {
    const outcome = {
      channelId: "0d01437f-2977-45f4-a811-cb13c36ba389",
      community: "one.example",
      communityId: "1f8eeb8f-0ef3-4280-8854-2d6420f05f80",
      derivedEvents: [],
    };
    const reap = vi.fn(async () => [outcome]);
    const archived = vi.fn(async () => undefined);
    const reaper = new ChannelReaper(reap, archived, {
      batchLimit: 25,
      intervalMs: 100,
    });

    await expect(reaper.tick()).resolves.toBe(1);
    expect(reap).toHaveBeenCalledWith(25);
    expect(archived).toHaveBeenCalledWith(outcome);
  });

  it("coalesces overlapping ticks into one database sweep", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reap = vi.fn(async () => {
      await blocked;
      return [];
    });
    const reaper = new ChannelReaper(reap, async () => undefined);
    const first = reaper.tick();
    const second = reaper.tick();
    release?.();

    await expect(Promise.all([first, second])).resolves.toEqual([0, 0]);
    expect(reap).toHaveBeenCalledOnce();
  });
});
