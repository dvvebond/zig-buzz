import { describe, expect, it } from "vitest";

import { buildSearchQuery, normalizeSearchText } from "./search.js";

const COMMUNITY_ID = "00000000-0000-4000-8000-000000000001";
const CHANNEL_ID = "00000000-0000-4000-8000-000000000002";

describe("search query", () => {
  it("normalizes empty, NUL, and bounded search text", () => {
    expect(normalizeSearchText("   ")).toBeNull();
    expect(normalizeSearchText(" foo\0bar ")).toBe("foo bar");
    expect(normalizeSearchText("x".repeat(5_000))).toHaveLength(4_096);
  });

  it("always leads with a bound community fence", () => {
    const built = buildSearchQuery({
      channelScope: { type: "channels", channelIds: [CHANNEL_ID] },
      communityId: COMMUNITY_ID,
      mode: "full-text",
      text: "release plan",
    });
    expect(built?.text).toContain("e.community_id = $2::uuid");
    expect(built?.text).toContain("e.channel_id = ANY($3::uuid[])");
    expect(built?.values).toEqual([
      "release plan",
      COMMUNITY_ID,
      [CHANNEL_ID],
      100,
      0,
    ]);
  });

  it("uses normalized, bound tokens for prefix mode", () => {
    const built = buildSearchQuery({
      channelScope: { type: "channel-less-only" },
      communityId: COMMUNITY_ID,
      mode: "prefix",
      text: "pro",
    });
    expect(built?.text).toContain("regexp_split_to_table($1");
    expect(built?.text).toContain("e.channel_id IS NULL");
    expect(built?.text).not.toContain("pro");
  });
});
