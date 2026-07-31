import {
  KIND_NIP29_GROUP_METADATA,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_SYSTEM_MESSAGE,
  signNostrEvent,
} from "@buzz/core";
import { generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import {
  buildMainTimeline,
  parseChannel,
  projectTimeline,
  threadReference,
} from "./models";

const channelId = "729e6cf2-6252-4d02-bcca-31e60190f4b9";
const secretKey = generateSecretKey();

function event(
  kind: number,
  content: string,
  tags: string[][],
  createdAt = 1_700_000_000,
) {
  return signNostrEvent(
    { content, created_at: createdAt, kind, tags },
    secretKey,
  );
}

describe("mobile domain models", () => {
  it("parses bounded channel metadata", () => {
    const channel = parseChannel(
      event(
        KIND_NIP29_GROUP_METADATA,
        JSON.stringify({
          about: "Product work",
          name: "Roadmap",
          type: "forum",
          visibility: "private",
        }),
        [["d", channelId]],
      ),
    );
    expect(channel).toMatchObject({
      about: "Product work",
      id: channelId,
      name: "Roadmap",
      type: "forum",
      visibility: "private",
    });
  });

  it("projects edits, deletes, reactions, and thread markers", () => {
    const root = event(KIND_STREAM_MESSAGE, "original", [["h", channelId]]);
    const reply = event(
      KIND_STREAM_MESSAGE,
      "reply",
      [
        ["h", channelId],
        ["e", root.id, "", "root"],
        ["e", root.id, "", "reply"],
      ],
      root.created_at + 1,
    );
    const edit = event(
      KIND_STREAM_MESSAGE_EDIT,
      "edited",
      [
        ["h", channelId],
        ["e", root.id],
      ],
      root.created_at + 2,
    );
    const reaction = event(7, "🔥", [["e", root.id]], root.created_at + 3);
    const timeline = projectTimeline([reaction, edit, reply, root]);
    expect(timeline[0]?.content).toBe("edited");
    expect(timeline[0]?.editedAt).toBe(edit.created_at);
    expect(timeline[0]?.reactions.get("🔥")).toEqual([reaction.pubkey]);
    expect(threadReference(reply)).toEqual({
      parentId: root.id,
      rootId: root.id,
    });
    const main = buildMainTimeline(timeline);
    expect(main).toHaveLength(1);
    expect(main[0]?.replyCount).toBe(1);
    expect(main[0]?.replyParticipants).toEqual([reply.pubkey]);
  });

  it("honors every deletion target and deleted reaction", () => {
    const first = event(KIND_STREAM_MESSAGE, "first", [["h", channelId]]);
    const second = event(
      KIND_STREAM_MESSAGE,
      "second",
      [["h", channelId]],
      first.created_at + 1,
    );
    const reaction = event(7, "🔥", [["e", first.id]], first.created_at + 2);
    const deleteReaction = event(
      5,
      "",
      [["e", reaction.id]],
      first.created_at + 3,
    );
    const deleteMessages = event(
      5,
      "",
      [
        ["e", first.id],
        ["e", second.id],
      ],
      first.created_at + 4,
    );
    expect(
      projectTimeline([
        first,
        second,
        reaction,
        deleteReaction,
        deleteMessages,
      ]),
    ).toEqual([]);
  });

  it("parses system events into visible timeline rows", () => {
    const joined = event(
      KIND_SYSTEM_MESSAGE,
      JSON.stringify({
        actor: "a".repeat(64),
        target: "a".repeat(64),
        type: "member_joined",
      }),
      [["h", channelId]],
    );
    const timeline = projectTimeline([joined]);
    expect(timeline[0]?.system).toEqual({
      actorPubkey: "a".repeat(64),
      targetPubkey: "a".repeat(64),
      type: "member_joined",
    });
  });
});
