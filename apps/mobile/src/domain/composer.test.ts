import { describe, expect, it } from "vitest";

import {
  activeEmojiQuery,
  activeMentionQuery,
  applyMarkup,
  buildMentionTags,
  replaceActiveToken,
} from "./composer";

describe("mobile composer helpers", () => {
  it("detects and replaces active autocomplete tokens", () => {
    expect(activeMentionQuery("hello @al")).toBe("al");
    expect(activeEmojiQuery("ship :par")).toBe("par");
    expect(replaceActiveToken("hello @al", "@", "alice")).toBe("hello @alice ");
    expect(replaceActiveToken("ship :par", ":", "party")).toBe("ship :party: ");
  });

  it("wraps the current selection without losing cursor position", () => {
    expect(applyMarkup("hello", { end: 5, start: 0 }, "**")).toEqual({
      content: "**hello**",
      selection: { end: 7, start: 2 },
    });
  });

  it("only emits selected mentions still present in final content", () => {
    expect(
      buildMentionTags("hello @alice", [
        { pubkey: "a".repeat(64), token: "alice" },
        { pubkey: "b".repeat(64), token: "bob" },
      ]),
    ).toEqual([["p", "a".repeat(64)]]);
  });
});
