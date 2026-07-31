import { signNostrEvent } from "@buzz/core";
import { generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  buildCustomEmojiTags,
  customEmojiFromTags,
  normalizeShortcode,
  unionCustomEmoji,
} from "./custom-emoji";

const secretKey = generateSecretKey();

describe("custom emoji", () => {
  it("normalizes and rejects malformed shortcodes", () => {
    expect(normalizeShortcode(":Ship-It:")).toBe("ship-it");
    expect(normalizeShortcode("bad space")).toBeUndefined();
  });

  it("parses unique secure emoji tags", () => {
    expect(
      customEmojiFromTags([
        ["emoji", "Party", "https://cdn.example/party.png"],
        ["emoji", "party", "https://cdn.example/other.png"],
        ["emoji", "bad space", "https://cdn.example/bad.png"],
      ]),
    ).toEqual([{ shortcode: "party", url: "https://cdn.example/party.png" }]);
  });

  it("uses newest set with a deterministic tie break", () => {
    const make = (url: string, createdAt: number) =>
      signNostrEvent(
        {
          content: "",
          created_at: createdAt,
          kind: 30_030,
          tags: [["emoji", "party", url]],
        },
        secretKey,
      );
    expect(
      unionCustomEmoji([
        make("https://cdn.example/z.png", 2),
        make("https://cdn.example/a.png", 2),
        make("https://cdn.example/old.png", 1),
      ]),
    ).toEqual([{ shortcode: "party", url: "https://cdn.example/a.png" }]);
  });

  it("adds one self-contained event tag per referenced emoji", () => {
    expect(
      buildCustomEmojiTags("go :party: :PARTY: :unknown:", [
        { shortcode: "party", url: "https://cdn.example/party.png" },
      ]),
    ).toEqual([["emoji", "party", "https://cdn.example/party.png"]]);
  });
});
