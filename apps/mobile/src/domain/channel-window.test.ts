import { describe, expect, it } from "vitest";

import type { NostrEvent } from "@buzz/core";

import { parseChannelWindow } from "./channel-window";

const CHANNEL = "123e4567-e89b-12d3-a456-426614174000";
const ROOT = "a".repeat(64);

function event(input: {
  readonly id?: string;
  readonly kind: number;
  readonly content?: string;
  readonly tags?: readonly string[][];
}): NostrEvent {
  return {
    content: input.content ?? "",
    created_at: 10,
    id: input.id ?? "b".repeat(64),
    kind: input.kind,
    pubkey: "c".repeat(64),
    sig: "d".repeat(128),
    tags: (input.tags ?? []).map((tag) => [...tag]),
  };
}

describe("channel window", () => {
  it("parses bounds and thread summaries without leaking overlays into rows", () => {
    const page = parseChannelWindow(
      [
        event({ kind: 40_002, tags: [["h", CHANNEL]] }),
        event({
          content: JSON.stringify({
            descendant_count: 3,
            last_reply_at: 12,
            participants: ["e".repeat(64)],
            reply_count: 2,
          }),
          kind: 39_005,
          tags: [["e", ROOT]],
        }),
        event({
          content: JSON.stringify({
            has_more: true,
            next_cursor: { created_at: 10, id: ROOT },
          }),
          kind: 39_006,
          tags: [
            ["d", `${CHANNEL}:head`],
            ["h", CHANNEL],
          ],
        }),
      ],
      CHANNEL,
    );
    expect(page.events).toHaveLength(1);
    expect(page.nextCursor).toEqual({ createdAt: 10, eventId: ROOT });
    expect(page.summaries.get(ROOT)).toEqual({
      descendantCount: 3,
      lastReplyAt: 12,
      participantPubkeys: ["e".repeat(64)],
      replyCount: 2,
    });
  });

  it("rejects mismatched and contradictory bounds", () => {
    expect(() =>
      parseChannelWindow(
        [
          event({
            content: JSON.stringify({
              has_more: true,
              next_cursor: null,
            }),
            kind: 39_006,
            tags: [
              ["d", `${CHANNEL}:head`],
              ["h", CHANNEL],
            ],
          }),
        ],
        CHANNEL,
      ),
    ).toThrow(/disagree/);
  });
});
