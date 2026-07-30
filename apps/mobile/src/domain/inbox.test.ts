import { describe, expect, it } from "vitest";

import type { NostrEvent } from "@buzz/core";

import { buildInboxItems, inboxDeepLinkEvent, inboxItemIsDone } from "./inbox";

const PUBKEY = "a".repeat(64);

function event(
  idCharacter: string,
  createdAt: number,
  tags: readonly string[][],
): NostrEvent {
  return {
    content: idCharacter,
    created_at: createdAt,
    id: idCharacter.repeat(64),
    kind: 9,
    pubkey: PUBKEY,
    sig: "b".repeat(128),
    tags: tags.map((tag) => [...tag]),
  };
}

describe("activity inbox", () => {
  it("groups DMs and thread replies into stable conversations", () => {
    const root = "c".repeat(64);
    const items = buildInboxItems(
      [
        {
          category: "activity",
          event: event("1", 1, [["h", "dm-channel"]]),
        },
        {
          category: "mention",
          event: event("2", 2, [["h", "dm-channel"]]),
        },
        {
          category: "activity",
          event: event("3", 3, [
            ["h", "channel"],
            ["e", root, "", "root"],
            ["e", root, "", "reply"],
          ]),
        },
        {
          category: "needs_action",
          event: event("4", 4, [
            ["h", "channel"],
            ["e", root, "", "root"],
            ["e", "3".repeat(64), "", "reply"],
          ]),
        },
      ],
      new Set(["dm-channel"]),
    );
    expect(items).toHaveLength(2);
    expect(
      items.find((item) => item.conversationId === "dm:dm-channel"),
    ).toMatchObject({
      category: "mention",
      latestActivityAt: 2,
    });
    expect(items.find((item) => item.conversationId === root)).toMatchObject({
      category: "needs_action",
      latestActivityAt: 4,
      threadRootId: root,
    });
  });

  it("honors explicit unread overrides and targets the oldest unread event", () => {
    const [item] = buildInboxItems(
      [
        { category: "activity", event: event("1", 10, [["h", "dm"]]) },
        { category: "activity", event: event("2", 20, [["h", "dm"]]) },
        { category: "activity", event: event("3", 30, [["h", "dm"]]) },
      ],
      new Set(["dm"]),
    );
    if (!item) throw new Error("expected grouped inbox item");
    expect(
      inboxItemIsDone(item, {
        doneIds: new Set([item.conversationId]),
        readAt: 30,
        unreadIds: new Set([item.conversationId]),
      }),
    ).toBe(false);
    expect(inboxDeepLinkEvent(item, 10).created_at).toBe(20);
  });
});
