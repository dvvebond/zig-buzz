import { describe, expect, it } from "vitest";

import {
  EMPTY_CLIENT_STATE,
  mergeChannelLocalStates,
  parseChannelSectionEnvelope,
  parseClientLocalState,
} from "./client-local-state";

describe("mobile client-local state", () => {
  it("strictly parses synchronized channel sections", () => {
    expect(
      parseChannelSectionEnvelope({
        assignments: { channel: "work", orphan: "missing" },
        sections: [{ id: "work", name: "Work", order: 0 }],
        version: 1,
      }),
    ).toEqual({
      assignments: { channel: "work" },
      sections: [{ id: "work", name: "Work", order: 0 }],
      version: 1,
    });
    expect(parseChannelSectionEnvelope({ version: 2 })).toBeUndefined();
  });

  it("fails closed on corrupt or oversized input", () => {
    expect(parseClientLocalState("{")).toEqual(EMPTY_CLIENT_STATE);
    expect(parseClientLocalState("x".repeat(600 * 1024))).toEqual(
      EMPTY_CLIENT_STATE,
    );
  });

  it("drops invalid sections, drafts, and cross-references", () => {
    const parsed = parseClientLocalState(
      JSON.stringify({
        channels: {
          channel: {
            muted: true,
            sectionId: "missing",
            starred: false,
            updatedAt: 10,
          },
        },
        drafts: [
          {
            channelId: "channel",
            key: "channel",
            text: "unsent",
            updatedAt: 11,
          },
          { channelId: "bad channel", key: "bad", text: "ignored" },
        ],
        sections: [],
        version: 1,
      }),
    );
    expect(parsed.channels.channel).toEqual({
      muted: true,
      starred: false,
      updatedAt: 10,
    });
    expect(parsed.drafts).toHaveLength(1);
  });

  it("merges per-channel state by newest timestamp deterministically", () => {
    expect(
      mergeChannelLocalStates(
        {
          a: { muted: false, starred: true, updatedAt: 2 },
          b: { muted: false, starred: false, updatedAt: 1 },
        },
        {
          a: { muted: true, starred: false, updatedAt: 1 },
          b: { muted: true, starred: false, updatedAt: 3 },
        },
      ),
    ).toEqual({
      a: { muted: false, starred: true, updatedAt: 2 },
      b: { muted: true, starred: false, updatedAt: 3 },
    });
  });
});
