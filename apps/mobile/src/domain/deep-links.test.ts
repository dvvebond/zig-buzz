import { describe, expect, it } from "vitest";

import {
  buildMessageLink,
  parseDeepLink,
  validateRelayUrl,
} from "./deep-links";

const channelId = "729e6cf2-6252-4d02-bcca-31e60190f4b9";
const eventId = "a".repeat(64);

describe("mobile deep links", () => {
  it("round trips canonical message links", () => {
    const link = buildMessageLink({ channelId, messageId: eventId });
    expect(parseDeepLink(link)).toEqual({
      channelId,
      messageId: eventId,
      type: "message",
    });
  });

  it("fails closed for insecure and private relay targets", () => {
    expect(validateRelayUrl("ws://example.com", false)).toBeUndefined();
    expect(validateRelayUrl("wss://192.168.1.2", false)).toBeUndefined();
    expect(validateRelayUrl("ws://localhost:3000", true)).toBe(
      "ws://localhost:3000/",
    );
  });
});
