import {
  KIND_EVENT_REMINDER,
  signNostrEvent,
  type NostrEvent,
} from "@buzz/core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  decryptReminderEvent,
  encryptReminderContent,
  newestReminders,
  parseNotBefore,
  parseReminderContent,
} from "./reminders";

const secretKey = generateSecretKey();
const pubkey = getPublicKey(secretKey);
const target = {
  authorPubkey: "b".repeat(64),
  channelId: "729e6cf2-6252-4d02-bcca-31e60190f4b9",
  eventId: "a".repeat(64),
  preview: "Ship the release",
};

function reminderEvent(
  status: "pending" | "done",
  createdAt: number,
): NostrEvent {
  return signNostrEvent(
    {
      content: encryptReminderContent({ status, target }, secretKey, pubkey),
      created_at: createdAt,
      kind: KIND_EVENT_REMINDER,
      tags: [
        ["d", "c".repeat(32)],
        ...(status === "pending" ? [["not_before", "1700000100"]] : []),
      ],
    },
    secretKey,
  );
}

describe("NIP-ER reminders", () => {
  it("parses strict not_before values", () => {
    expect(parseNotBefore("0")).toBe(0);
    expect(parseNotBefore("01")).toBeUndefined();
    expect(parseNotBefore("-1")).toBeUndefined();
  });

  it("fails closed on malformed plaintext", () => {
    expect(parseReminderContent("{}")).toBeUndefined();
    expect(
      parseReminderContent(JSON.stringify({ note: "x", status: "pending" })),
    ).toEqual({ note: "x", status: "pending" });
  });

  it("round trips self-encrypted content", () => {
    expect(
      decryptReminderEvent(reminderEvent("pending", 10), secretKey, pubkey)
        ?.content,
    ).toEqual({ status: "pending", target });
  });

  it("keeps the newest parameterized replacement", () => {
    expect(
      newestReminders(
        [reminderEvent("pending", 10), reminderEvent("done", 11)],
        secretKey,
        pubkey,
      )[0]?.content.status,
    ).toBe("done");
  });
});
