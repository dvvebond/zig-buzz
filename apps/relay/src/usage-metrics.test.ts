import { describe, expect, it } from "vitest";
import type { MediaStorage } from "@buzz/media";
import type { Pool, PoolClient } from "pg";

import { UsageMetricsCollector } from "./usage-metrics.js";

const COMMUNITY_ID = "11111111-1111-4111-8111-111111111111";
const SHA256 = "a".repeat(64);

describe("deployment usage metrics", () => {
  it("elects one collector, zero-fills database gauges, and publishes a bounded storage snapshot", async () => {
    const released: unknown[] = [];
    const client = {
      query: async (sql: string) => fakeQuery(sql),
      release: (destroy?: unknown) => released.push(destroy),
    } as unknown as PoolClient;
    const pool = {
      connect: async () => client,
    } as unknown as Pool;
    const storage = {
      list: async () => ({
        objects: [
          { key: `${SHA256}.png`, size: 120 },
          {
            key: `_meta/${COMMUNITY_ID}/${SHA256}.json`,
            size: 20,
          },
        ],
      }),
    } as unknown as MediaStorage;
    const collector = new UsageMetricsCollector(pool, storage, {
      intervalMs: 5_000,
      perCommunity: true,
      storage: {
        enabled: true,
        intervalMs: 60_000,
        maxObjects: 100,
        timeoutMs: 1_000,
      },
    });

    await collector.tick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await collector.tick();

    const rendered = collector.render();
    expect(rendered).toContain("buzz_usage_poller_is_leader 1");
    expect(rendered).toContain('buzz_total_users{type="human"} 2');
    expect(rendered).toContain(
      'buzz_community_channels{community="one.example",type="forum"} 0',
    );
    expect(rendered).toContain(
      'buzz_total_active_users{type="unknown",window="30d"} 1',
    );
    expect(rendered).toContain(
      'buzz_community_storage_bytes{community="one.example"} 120',
    );
    expect(rendered).toContain('buzz_total_storage_bytes{kind="physical"} 140');

    await collector.stop();
    expect(released).toEqual([true]);
  });
});

function fakeQuery(sql: string): {
  readonly rowCount: number;
  readonly rows: readonly Record<string, unknown>[];
} {
  const normalized = sql.replaceAll(/\s+/g, " ").trim();
  if (normalized.startsWith("SELECT pg_try_advisory_lock")) {
    return { rowCount: 1, rows: [{ acquired: true }] };
  }
  if (normalized === "SELECT 1") {
    return { rowCount: 1, rows: [{}] };
  }
  if (normalized.includes("SELECT id::text AS id, host FROM communities")) {
    return {
      rowCount: 1,
      rows: [{ host: "one.example", id: COMMUNITY_ID }],
    };
  }
  if (normalized.includes("COUNT(*)::text AS count FROM communities")) {
    return { rowCount: 1, rows: [{ count: "1" }] };
  }
  if (normalized.includes("FROM users")) {
    return {
      rowCount: 1,
      rows: [{ agent: "1", community_id: COMMUNITY_ID, human: "2" }],
    };
  }
  if (normalized.includes("FROM channels")) {
    return {
      rowCount: 1,
      rows: [{ community_id: COMMUNITY_ID, count: "3", type: "stream" }],
    };
  }
  if (normalized.includes("FROM relay_members")) {
    return {
      rowCount: 1,
      rows: [{ community_id: COMMUNITY_ID, count: "1", type: "owner" }],
    };
  }
  if (normalized.includes("FROM workflows")) {
    return {
      rowCount: 1,
      rows: [{ community_id: COMMUNITY_ID, count: "2", type: "active" }],
    };
  }
  if (normalized.includes("FROM git_repo_names")) {
    return {
      rowCount: 1,
      rows: [{ community_id: COMMUNITY_ID, count: "4" }],
    };
  }
  if (normalized.includes("COUNT(DISTINCT e.pubkey)")) {
    return {
      rowCount: 1,
      rows: [
        {
          agent: "1",
          community_id: COMMUNITY_ID,
          human: "2",
          unknown: "1",
        },
      ],
    };
  }
  if (normalized.includes("COUNT(DISTINCT channel_id)")) {
    return {
      rowCount: 1,
      rows: [{ community_id: COMMUNITY_ID, count: "1" }],
    };
  }
  if (
    normalized.includes("FROM events") &&
    normalized.includes("WHERE kind = 9")
  ) {
    return {
      rowCount: 1,
      rows: [{ community_id: COMMUNITY_ID, count: "5" }],
    };
  }
  if (normalized.startsWith("DELETE FROM relay_invites")) {
    return { rowCount: 0, rows: [] };
  }
  throw new Error(`unexpected usage query: ${normalized}`);
}
