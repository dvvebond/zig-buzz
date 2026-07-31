import { generateSecretKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { signNostrEvent } from "@buzz/core";

import { encodeOutbox, parseOutbox } from "./outbox";

describe("signed event outbox", () => {
  it("keeps only valid signed events and deduplicates IDs", () => {
    const secretKey = generateSecretKey();
    const event = signNostrEvent(
      {
        content: "offline",
        created_at: 1_700_000_000,
        kind: 9,
        tags: [["h", "channel"]],
      },
      secretKey,
    );
    const parsed = parseOutbox(
      JSON.stringify([
        event,
        event,
        { ...event, content: "tampered" },
        { nope: true },
      ]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ content: "offline", id: event.id });
    expect(parseOutbox(encodeOutbox([event]))[0]).toMatchObject({
      id: event.id,
    });
    secretKey.fill(0);
  });

  it("fails closed on malformed and oversized state", () => {
    expect(parseOutbox("{")).toEqual([]);
    expect(parseOutbox("x".repeat(4 * 1024 * 1024))).toEqual([]);
  });
});
