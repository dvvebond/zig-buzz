import { generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import { verifyNostrEvent } from "@buzz/core";

import {
  buildArchiveIdentityRequest,
  buildCreateChannel,
  buildCustomEmojiSet,
  buildHuddleEnded,
  buildHuddleGuidelines,
  buildHuddleStarted,
  buildMessage,
  buildUpdateChannel,
  signTemplate,
} from "./builders.js";
import { extractAtNames, stripCodeRegions } from "./mentions.js";

const CHANNEL_ID = "00000000-0000-4000-8000-000000000001";
const ROOT = "a".repeat(64);
const PARENT = "b".repeat(64);

describe("Buzz event SDK", () => {
  it("builds nested message tags in Rust-compatible order and signs", () => {
    const built = buildMessage({
      broadcast: true,
      channelId: CHANNEL_ID,
      content: "hello",
      mentions: ["C".repeat(64), "c".repeat(64)],
      thread: { parentEventId: PARENT, rootEventId: ROOT },
    });
    expect(built.tags).toEqual([
      ["h", CHANNEL_ID],
      ["e", ROOT, "", "root"],
      ["e", PARENT, "", "reply"],
      ["p", "c".repeat(64)],
      ["broadcast", "1"],
    ]);
    expect(verifyNostrEvent(signTemplate(built, generateSecretKey()))).toBe(
      true,
    );
  });

  it("normalizes channel names and models ttl clear distinctly", () => {
    expect(
      buildCreateChannel({ channelId: CHANNEL_ID, name: "##general" }).tags,
    ).toContainEqual(["name", "general"]);
    expect(
      buildUpdateChannel({ channelId: CHANNEL_ID, ttl: null }).tags,
    ).toContainEqual(["ttl", ""]);
  });

  it("rejects duplicate normalized custom emoji", () => {
    expect(() =>
      buildCustomEmojiSet([
        { shortcode: ":Party:", url: "https://example.com/a.png" },
        { shortcode: "party", url: "https://example.com/b.png" },
      ]),
    ).toThrow("duplicate");
  });

  it("builds protected identity archive requests", () => {
    const built = buildArchiveIdentityRequest({
      content: "retired",
      reason: "bot-rebuilt",
      replacedBy: "b".repeat(64),
      targetPubkey: "a".repeat(64),
    });
    expect(built).toEqual({
      content: "retired",
      kind: 9_035,
      tags: [
        ["-"],
        ["p", "a".repeat(64)],
        ["reason", "bot-rebuilt"],
        ["replaced-by", "b".repeat(64)],
      ],
    });
  });

  it("builds Rust-compatible huddle lifecycle and guideline events", () => {
    const ephemeral = "00000000-0000-4000-8000-000000000002";
    expect(buildHuddleStarted(CHANNEL_ID, ephemeral)).toEqual({
      content: JSON.stringify({ ephemeral_channel_id: ephemeral }),
      kind: 48_100,
      tags: [["h", CHANNEL_ID]],
    });
    expect(buildHuddleEnded(CHANNEL_ID, ephemeral).kind).toBe(48_103);
    expect(buildHuddleGuidelines(ephemeral, "Speak briefly.")).toEqual({
      content: "Speak briefly.",
      kind: 48_106,
      tags: [["h", ephemeral]],
    });
  });

  it("extracts mentions while ignoring code", () => {
    expect(stripCodeRegions("hi `@ignored` @Ada")).not.toContain("@ignored");
    expect(extractAtNames("hi `@ignored` @Ada and @ada")).toEqual(["ada"]);
  });
});
