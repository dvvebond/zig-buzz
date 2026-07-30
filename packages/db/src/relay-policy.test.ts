import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  KIND_AGENT_OBSERVER_FRAME,
  KIND_DM_VISIBILITY,
  KIND_EVENT_REMINDER,
  KIND_GIFT_WRAP,
  KIND_IA_ARCHIVED,
  KIND_IA_ARCHIVED_LIST,
  KIND_MODERATION_BAN,
  KIND_PERSONA,
  KIND_PROFILE,
  KIND_PUSH_LEASE,
  KIND_REPORT,
  KIND_TEXT_NOTE,
  signNostrEvent,
  unixNow,
} from "@buzz/core";

import {
  eventChannelId,
  OpenRelayAccessPolicy,
  PostgresRelayAccessPolicy,
  type RelayAccessPolicy,
} from "./relay-policy.js";

describe("relay access policy private projections", () => {
  it("keeps global-only coordinates global despite signed h tags", () => {
    const secret = generateSecretKey();
    const channelId = "00000000-0000-4000-8000-000000000001";
    const profile = signNostrEvent(
      {
        content: "{}",
        created_at: unixNow(),
        kind: KIND_PROFILE,
        tags: [["h", channelId]],
      },
      secret,
    );
    const message = signNostrEvent(
      {
        content: "channel scoped",
        created_at: unixNow(),
        kind: 9,
        tags: [["h", channelId]],
      },
      secret,
    );
    expect(eventChannelId(profile)).toBeUndefined();
    expect(eventChannelId(message)).toBe(channelId);
  });

  it("authorizes unlinkable gift-wrap envelope signers as the transport principal", async () => {
    const sender = getPublicKey(generateSecretKey());
    const recipient = getPublicKey(generateSecretKey());
    const wrap = signNostrEvent(
      {
        content: "opaque",
        created_at: unixNow(),
        kind: KIND_GIFT_WRAP,
        tags: [
          ["p", recipient],
          ["h", "00000000-0000-4000-8000-000000000001"],
        ],
      },
      generateSecretKey(),
    );
    const policy = new OpenRelayAccessPolicy();

    expect(wrap.pubkey).not.toBe(sender);
    expect(eventChannelId(wrap)).toBeUndefined();
    await expect(
      policy.canPublish("relay.example", sender, wrap),
    ).resolves.toBe(true);
  });

  it("makes DM visibility relay-only and readable only by its addressed viewer", async () => {
    const relaySecret = generateSecretKey();
    const viewer = getPublicKey(generateSecretKey());
    const other = getPublicKey(generateSecretKey());
    const snapshot = signNostrEvent(
      {
        content: "",
        created_at: unixNow(),
        kind: KIND_DM_VISIBILITY,
        tags: [
          ["d", viewer],
          ["p", viewer],
          ["h", "00000000-0000-4000-8000-000000000001"],
        ],
      },
      relaySecret,
    );
    const policy: RelayAccessPolicy = new OpenRelayAccessPolicy();

    await expect(
      policy.canPublish("relay.example", snapshot.pubkey, snapshot),
    ).resolves.toBe(false);
    await expect(
      policy.canRead("relay.example", viewer, snapshot),
    ).resolves.toBe(true);
    await expect(
      policy.canRead("relay.example", other, snapshot),
    ).resolves.toBe(false);
    await expect(
      policy.canRead("relay.example", other, snapshot, viewer),
    ).resolves.toBe(false);
  });

  it("requires durable moderation for private reports and direct commands", async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const policy = new OpenRelayAccessPolicy();
    for (const kind of [KIND_REPORT, KIND_MODERATION_BAN]) {
      const event = signNostrEvent(
        {
          content: "",
          created_at: unixNow(),
          kind,
          tags: [["p", "ab".repeat(32)]],
        },
        secret,
      );
      await expect(
        policy.canPublish("relay.example", pubkey, event),
      ).resolves.toBe(false);
    }
  });

  it("rejects client attempts to forge relay-authoritative projections", async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const policy = new OpenRelayAccessPolicy();
    for (const kind of [KIND_IA_ARCHIVED, KIND_IA_ARCHIVED_LIST]) {
      const event = signNostrEvent(
        {
          content: "",
          created_at: unixNow(),
          kind,
          tags: [["-"]],
        },
        secret,
      );
      await expect(
        policy.canPublish("relay.example", pubkey, event),
      ).resolves.toBe(false);
    }
  });

  it("applies author-only, persona sharing, and p-gated visibility per result", async () => {
    const authorSecret = generateSecretKey();
    const author = getPublicKey(authorSecret);
    const viewer = getPublicKey(generateSecretKey());
    const other = getPublicKey(generateSecretKey());
    const policy = new OpenRelayAccessPolicy();
    const event = (kind: number, tags: string[][] = []) =>
      signNostrEvent(
        {
          content: "",
          created_at: unixNow(),
          kind,
          tags,
        },
        authorSecret,
      );

    for (const kind of [KIND_EVENT_REMINDER, KIND_PUSH_LEASE]) {
      const privateEvent = event(kind);
      await expect(
        policy.canRead("relay.example", author, privateEvent),
      ).resolves.toBe(true);
      await expect(
        policy.canRead("relay.example", viewer, privateEvent),
      ).resolves.toBe(false);
    }

    const privatePersona = event(KIND_PERSONA);
    await expect(
      policy.canRead("relay.example", author, privatePersona),
    ).resolves.toBe(true);
    await expect(
      policy.canRead("relay.example", viewer, privatePersona),
    ).resolves.toBe(false);
    await expect(
      policy.canRead(
        "relay.example",
        viewer,
        event(KIND_PERSONA, [["shared", "true"]]),
      ),
    ).resolves.toBe(true);

    for (const kind of [KIND_GIFT_WRAP, KIND_AGENT_OBSERVER_FRAME]) {
      const addressedEvent = event(kind, [["p", viewer]]);
      await expect(
        policy.canRead("relay.example", viewer, addressedEvent),
      ).resolves.toBe(true);
      await expect(
        policy.canRead("relay.example", other, addressedEvent),
      ).resolves.toBe(false);
    }

    await expect(
      policy.canRead("relay.example", other, event(KIND_TEXT_NOTE)),
    ).resolves.toBe(true);
  });

  it("applies bans at admission and timeouts at the write seam to both principals", async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const owner = getPublicKey(generateSecretKey());
    const event = signNostrEvent(
      {
        content: "blocked while timed out",
        created_at: unixNow(),
        kind: KIND_TEXT_NOTE,
        tags: [],
      },
      secret,
    );
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("cb.muted_until > now()")) {
        return { rowCount: 1, rows: [{}] };
      }
      expect(values).toEqual(["relay.example", [pubkey, owner], false]);
      return { rowCount: 1, rows: [{}] };
    });
    const policy = new PostgresRelayAccessPolicy(
      { query } as unknown as Pool,
      false,
    );
    await expect(
      policy.canPublish("relay.example", pubkey, event, owner),
    ).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(2);

    query.mockReset();
    query.mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(
      policy.canConnect("relay.example", pubkey, owner),
    ).resolves.toBe(false);
    expect(query.mock.calls[0]?.[1]).toEqual([
      "relay.example",
      [pubkey, owner],
      false,
    ]);
  });
});
