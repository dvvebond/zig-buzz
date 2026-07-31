import { signNostrEvent } from "@buzz/core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  commandReply,
  eventMentionsPubkey,
  mentionCommandReply,
} from "./logic.js";

describe("countdown bot commands", () => {
  it("creates bounded countdown replies", () => {
    expect(commandReply("!countdown 5")).toBe("5 4 3 2 1 🚀");
    expect(commandReply("!countdown 0")).toBe(
      "Please use a number from 1 to 100.",
    );
    expect(commandReply("!countdown 101")).toBe(
      "Please use a number from 1 to 100.",
    );
  });

  it("creates descending Fibonacci replies", () => {
    expect(commandReply("!fib 5")).toBe("3 2 1 1 0");
    expect(commandReply("!fib 8")).toBe("13 8 5 3 2 1 1 0");
    expect(mentionCommandReply("@Countdown Bot fib 5")).toBe("3 2 1 1 0");
  });

  it("requires an exact recipient tag for mention commands", () => {
    const secretKey = generateSecretKey();
    const pubkey = getPublicKey(secretKey);
    const event = signNostrEvent(
      {
        content: "@Countdown Bot fib 5",
        created_at: 1,
        kind: 9,
        tags: [["p", pubkey]],
      },
      generateSecretKey(),
    );
    expect(eventMentionsPubkey(event, pubkey)).toBe(true);
    expect(eventMentionsPubkey(event, "0".repeat(64))).toBe(false);
  });
});
