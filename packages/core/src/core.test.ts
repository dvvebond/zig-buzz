import { generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  eventMatchesFilter,
  isEphemeralKind,
  KIND_REMOTE_AGENT_COMMAND,
  signNostrEvent,
  unixNow,
  verifyNostrEvent,
} from "./index.js";

describe("core event compatibility", () => {
  it("signs and verifies a NIP-01 event", () => {
    const event = signNostrEvent(
      {
        content: "hello",
        created_at: unixNow(),
        kind: 1,
        tags: [["h", "engineering"]],
      },
      generateSecretKey(),
    );

    expect(verifyNostrEvent(event)).toBe(true);
    expect(
      eventMatchesFilter(event, {
        "#h": ["engineering"],
        authors: [event.pubkey.slice(0, 12)],
        kinds: [1],
      }),
    ).toBe(true);
  });

  it("rejects a modified signed event", () => {
    const event = signNostrEvent(
      { content: "original", created_at: unixNow(), kind: 1, tags: [] },
      generateSecretKey(),
    );

    expect(verifyNostrEvent({ ...event, content: "modified" })).toBe(false);
  });

  it("classifies BRAP control messages as ephemeral", () => {
    expect(KIND_REMOTE_AGENT_COMMAND).toBe(24211);
    expect(isEphemeralKind(KIND_REMOTE_AGENT_COMMAND)).toBe(true);
  });
});
