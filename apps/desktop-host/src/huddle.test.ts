import { verifyEvent, type Event } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { DesktopEventBus } from "./event-bus.js";
import { HuddleService } from "./huddle.js";
import { IdentityService } from "./identity.js";

const PARENT = "00000000-0000-4000-8000-000000000001";
const AGENT = "a".repeat(64);
const HUMAN = "b".repeat(64);

describe("TypeScript huddle service", () => {
  it("publishes the compatible lifecycle, exposes one secure audio route, and tears down", async () => {
    const published: Event[] = [];
    const identity = IdentityService.create(undefined, async () => undefined);
    const events = new DesktopEventBus();
    const huddle = new HuddleService({
      channels: {
        members: async () => ({
          members: [
            {
              display_name: null,
              is_agent: false,
              joined_at: null,
              pubkey: identity.info().pubkey,
              role: "owner",
            },
            {
              display_name: null,
              is_agent: true,
              joined_at: null,
              pubkey: AGENT,
              role: "bot",
            },
          ],
          next_cursor: null,
        }),
      },
      events,
      identity,
      relay: {
        publish: async (event) => {
          expect(verifyEvent(event)).toBe(true);
          published.push(event);
          return { eventId: event.id, message: "" };
        },
      },
      workspace: { relayUrl: () => "wss://relay.example.test/base" },
    });

    const joined = await huddle.start({
      channelName: "  Product   huddle ",
      memberPubkeys: [AGENT, AGENT],
      parentChannelId: PARENT,
    });
    expect(joined.ephemeral_channel_id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    expect(published.slice(0, 4).map((event) => event.kind)).toEqual([
      9_007, 48_106, 9_000, 48_100,
    ]);
    expect(JSON.parse(published.at(3)!.content)).toEqual({
      ephemeral_channel_id: joined.ephemeral_channel_id,
    });
    expect(huddle.state()).toMatchObject({
      agent_pubkeys: [AGENT],
      is_creator: true,
      phase: "connected",
    });

    const audio = huddle.audioConfig();
    expect(audio).toEqual({
      audio_url: `wss://relay.example.test/base/huddle/${joined.ephemeral_channel_id}/audio`,
      ephemeral_channel_id: joined.ephemeral_channel_id,
      parent_channel_id: PARENT,
      relay_url: "wss://relay.example.test/base",
    });

    huddle.confirmActive();
    huddle.syncRoster({
      ephemeralChannelId: joined.ephemeral_channel_id,
      participants: [identity.info().pubkey, HUMAN],
    });
    expect(huddle.state()).toMatchObject({
      participants: [identity.info().pubkey, HUMAN],
      phase: "active",
    });
    await huddle.end({});
    expect(published.map((event) => event.kind)).toContain(48_103);
    expect(published.map((event) => event.kind)).toContain(9_001);
    expect(published.map((event) => event.kind)).toContain(9_002);
    expect(huddle.state().phase).toBe("idle");
    expect(
      events
        .poll(0)
        .events.some((event) => event.event === "huddle-state-changed"),
    ).toBe(true);
  });

  it("fails safe on insecure remote audio and foreign roster sessions", async () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    const huddle = new HuddleService({
      channels: {
        members: async () => ({ members: [], next_cursor: null }),
      },
      events: new DesktopEventBus(),
      identity,
      relay: {
        publish: async (event) => ({ eventId: event.id, message: "" }),
      },
      workspace: { relayUrl: () => "ws://relay.example.test" },
    });
    const joined = await huddle.join({
      ephemeralChannelId: "00000000-0000-4000-8000-000000000002",
      parentChannelId: PARENT,
    });
    expect(() => huddle.audioConfig()).toThrow("WSS");
    expect(() =>
      huddle.syncRoster({
        ephemeralChannelId: "00000000-0000-4000-8000-000000000003",
        participants: [],
      }),
    ).toThrow("stale");
    expect(joined.ephemeral_channel_id).toContain("00000000");
  });
});
