import { generateSecretKey } from "nostr-tools/pure";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { KIND_EVENT_REMINDER, signNostrEvent, unixNow } from "@buzz/core";

import { ReminderScheduler } from "./reminder-scheduler.js";

describe("ReminderScheduler", () => {
  it("claims a due reminder before publishing it exactly once", async () => {
    const event = reminder();
    let claimed = false;
    const order: string[] = [];
    const pool = poolWithQuery(async (sql) => {
      if (sql.includes("SELECT DISTINCT ON")) {
        return { rowCount: 1, rows: [dueRow(event)] };
      }
      if (sql.includes("SET delivered_at = $4")) {
        if (claimed) return { rowCount: 0, rows: [] };
        claimed = true;
        order.push("claim");
        return { rowCount: 1, rows: [{}] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const publish = vi.fn(async () => {
      order.push("publish");
    });
    const scheduler = new ReminderScheduler(pool, publish);

    await expect(scheduler.tick(unixNow())).resolves.toBe(1);
    await expect(scheduler.tick(unixNow())).resolves.toBe(0);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(event, "one.example");
    expect(order).toEqual(["claim", "publish"]);
  });

  it("compare-and-clears its claim when publication fails", async () => {
    const event = reminder();
    let released = false;
    const pool = poolWithQuery(async (sql) => {
      if (sql.includes("SELECT DISTINCT ON")) {
        return { rowCount: 1, rows: [dueRow(event)] };
      }
      if (sql.includes("SET delivered_at = $4")) {
        return { rowCount: 1, rows: [{}] };
      }
      if (sql.includes("SET delivered_at = NULL")) {
        released = true;
        return { rowCount: 1, rows: [{}] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const scheduler = new ReminderScheduler(pool, async () => {
      throw new Error("Redis unavailable");
    });

    await expect(scheduler.tick(unixNow())).rejects.toThrow(
      "Redis unavailable",
    );
    expect(released).toBe(true);
  });
});

function reminder() {
  return signNostrEvent(
    {
      content: "encrypted",
      created_at: unixNow() - 1,
      kind: KIND_EVENT_REMINDER,
      tags: [
        ["d", "reminder-1"],
        ["not_before", String(unixNow() - 1)],
      ],
    },
    generateSecretKey(),
  );
}

function dueRow(event: ReturnType<typeof reminder>) {
  return {
    community_id: "0325903d-fac1-4cb0-87dd-c749271954d5",
    content: event.content,
    created_at: new Date(event.created_at * 1_000),
    host: "one.example",
    id: event.id,
    kind: event.kind,
    pubkey: event.pubkey,
    sig: event.sig,
    tags: event.tags,
  };
}

function poolWithQuery(
  query: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<{
    readonly rowCount: number;
    readonly rows: readonly unknown[];
  }>,
): Pool {
  return { query } as unknown as Pool;
}
