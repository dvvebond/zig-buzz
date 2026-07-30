import { generateSecretKey } from "nostr-tools/pure";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  KIND_NIP43_LEAVE_REQUEST,
  KIND_NIP43_MEMBER_REMOVED,
  KIND_NIP43_MEMBERSHIP_LIST,
  signNostrEvent,
  unixNow,
} from "@buzz/core";
import { MemoryEventStore } from "@buzz/db";

import {
  RelayMembershipCommands,
  validateWorkspaceIcon,
} from "./relay-membership.js";

describe("relay membership commands", () => {
  it("validates workspace icons without script or whitespace schemes", () => {
    expect(() =>
      validateWorkspaceIcon("https://relay.example/icon.png"),
    ).not.toThrow();
    expect(() =>
      validateWorkspaceIcon("data:image/webp;base64,UklGRg=="),
    ).not.toThrow();
    expect(() => validateWorkspaceIcon("javascript:alert(1)")).toThrow(
      /http\(s\)/,
    );
    expect(() =>
      validateWorkspaceIcon("https://relay.example/bad icon.png"),
    ).toThrow(/whitespace/);
  });

  it("executes a protected self-leave and publishes relay-signed delta/snapshot state", async () => {
    const memberSecret = generateSecretKey();
    const relaySecret = generateSecretKey();
    const store = new MemoryEventStore();
    const published: number[] = [];
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return result([]);
      }
      if (sql.includes("FROM communities") && sql.includes("FOR SHARE")) {
        return result([{ id: "00000000-0000-4000-8000-000000000001" }]);
      }
      if (sql.includes("FROM community_bans")) return result([]);
      if (sql.includes("FROM relay_members") && sql.includes("FOR UPDATE")) {
        return result([{ role: "member" }]);
      }
      if (sql.includes("DELETE FROM relay_members")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("SET relay_membership_snapshot_at")) {
        return result([{ created_at: String(unixNow()) }]);
      }
      if (sql.includes("FROM relay_members") && sql.includes("ORDER BY")) {
        return result([
          {
            pubkey: "ab".repeat(32),
            role: "owner",
          },
        ]);
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const pool = {
      connect: async () => ({
        query: clientQuery,
        release: vi.fn(),
      }),
    } as unknown as Pool;
    const service = new RelayMembershipCommands({
      community: "relay.example",
      eventStore: store,
      pool,
      publishEvent: async (event) => {
        published.push(event.kind);
      },
      relaySecretKey: relaySecret,
    });
    const leave = signNostrEvent(
      {
        content: "",
        created_at: unixNow(),
        kind: KIND_NIP43_LEAVE_REQUEST,
        tags: [["-"]],
      },
      memberSecret,
    );

    await expect(service.execute(leave)).resolves.toBe(
      "info: you have left this relay",
    );
    expect(published).toEqual([
      KIND_NIP43_MEMBER_REMOVED,
      KIND_NIP43_MEMBERSHIP_LIST,
    ]);
    await expect(
      store.query("relay.example", {
        kinds: [KIND_NIP43_MEMBER_REMOVED, KIND_NIP43_MEMBERSHIP_LIST],
      }),
    ).resolves.toHaveLength(2);
  });

  it("requires the exact protected tag on leave requests", async () => {
    const secret = generateSecretKey();
    const service = new RelayMembershipCommands({
      community: "relay.example",
      eventStore: new MemoryEventStore(),
      pool: {} as Pool,
      publishEvent: async () => undefined,
      relaySecretKey: generateSecretKey(),
    });
    const event = signNostrEvent(
      {
        content: "",
        created_at: unixNow(),
        kind: KIND_NIP43_LEAVE_REQUEST,
        tags: [["-", "not-exact"]],
      },
      secret,
    );
    await expect(service.execute(event)).rejects.toThrow(/exact NIP-70/);
  });
});

function result<T>(rows: T[]) {
  return { rowCount: rows.length, rows };
}
