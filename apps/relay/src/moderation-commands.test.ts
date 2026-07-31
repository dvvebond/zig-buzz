import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import {
  KIND_MODERATION_BAN,
  KIND_REPORT,
  signNostrEvent,
  unixNow,
} from "@buzz/core";

import { RelayModerationCommands } from "./moderation-commands.js";

describe("moderation direct commands", () => {
  it("persists a private report queue row without requiring public event storage", async () => {
    const communityId = randomUUID();
    const reporter = generateSecretKey();
    const target = getPublicKey(generateSecretKey());
    const { client, pool, queries } = fakePool((sql) => {
      if (sql.includes("FROM communities")) return rows([{ id: communityId }]);
      if (sql.includes("INSERT INTO moderation_reports")) return rows([]);
      return rows([]);
    });
    const service = new RelayModerationCommands(pool, "relay.example");
    const report = signNostrEvent(
      {
        content: "Only moderators should see this context",
        created_at: unixNow(),
        kind: KIND_REPORT,
        tags: [["p", target, "spam"]],
      },
      reporter,
    );

    await expect(service.execute(report)).resolves.toEqual({
      handled: true,
    });
    expect(client.release).toHaveBeenCalledOnce();
    const insert = queries.find(({ sql }) =>
      sql.includes("INSERT INTO moderation_reports"),
    );
    expect(insert?.values).toEqual([
      communityId,
      report.id,
      report.pubkey,
      "pubkey",
      target,
      null,
      "spam",
      "Only moderators should see this context",
    ]);
  });

  it("atomically bans a member, writes an audit row, and requests live disconnect", async () => {
    const communityId = randomUUID();
    const owner = generateSecretKey();
    const target = getPublicKey(generateSecretKey());
    const actionId = randomUUID();
    const { pool, queries } = fakePool((sql) => {
      if (sql.includes("FROM communities")) return rows([{ id: communityId }]);
      if (sql.includes("FROM relay_members") && sql.includes("FOR UPDATE")) {
        return rows([{ role: "owner" }]);
      }
      if (sql.includes("FROM community_bans")) return rows([]);
      if (sql.includes("INSERT INTO moderation_actions")) {
        return rows([{ id: actionId }]);
      }
      return rows([], 1);
    });
    const notices = {
      deliver: vi.fn(async () => undefined),
    };
    const service = new RelayModerationCommands(
      pool,
      "relay.example",
      undefined,
      notices,
    );
    const event = signNostrEvent(
      {
        content: "",
        created_at: unixNow(),
        kind: KIND_MODERATION_BAN,
        tags: [
          ["p", target],
          ["reason", "spam"],
        ],
      },
      owner,
    );

    await expect(service.execute(event)).resolves.toEqual({
      disconnectPubkey: target,
      handled: true,
    });
    expect(
      queries.some(({ sql }) => sql.includes("INSERT INTO community_bans")),
    ).toBe(true);
    expect(
      queries.some(({ sql }) => sql.includes("INSERT INTO moderation_actions")),
    ).toBe(true);
    expect(queries.at(-1)?.sql).toBe("COMMIT");
    expect(notices.deliver).toHaveBeenCalledWith({
      notice: {
        actionId,
        kind: "restriction",
        publicReason: "spam",
        restriction: "ban",
      },
      recipientPubkey: target,
    });
  });

  it("prevents an admin from banning another privileged member", async () => {
    const communityId = randomUUID();
    const admin = generateSecretKey();
    const target = getPublicKey(generateSecretKey());
    const { pool, queries } = fakePool((sql) => {
      if (sql.includes("FROM communities")) return rows([{ id: communityId }]);
      if (sql.includes("FROM relay_members") && sql.includes("FOR UPDATE")) {
        return rows([{ role: "admin" }]);
      }
      if (sql.includes("FROM community_bans")) return rows([]);
      if (sql.includes("SELECT role FROM relay_members")) {
        return rows([{ role: "owner" }]);
      }
      return rows([]);
    });
    const service = new RelayModerationCommands(pool, "relay.example");
    const event = signNostrEvent(
      {
        content: "",
        created_at: unixNow(),
        kind: KIND_MODERATION_BAN,
        tags: [["p", target]],
      },
      admin,
    );

    await expect(service.execute(event)).rejects.toMatchObject({
      code: "CAPABILITY_DENIED",
    });
    expect(queries.at(-1)?.sql).toBe("ROLLBACK");
    expect(
      queries.some(({ sql }) => sql.includes("INSERT INTO community_bans")),
    ).toBe(false);
  });
});

function fakePool(
  respond: (
    sql: string,
    values: readonly unknown[] | undefined,
  ) => {
    readonly rowCount: number;
    readonly rows: readonly Record<string, unknown>[];
  },
): {
  readonly client: PoolClient;
  readonly pool: Pool;
  readonly queries: {
    readonly sql: string;
    readonly values: readonly unknown[] | undefined;
  }[];
} {
  const queries: {
    readonly sql: string;
    readonly values: readonly unknown[] | undefined;
  }[] = [];
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    queries.push({ sql, values });
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return rows([]);
    }
    return respond(sql, values);
  });
  const client = {
    query,
    release: vi.fn(),
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { client, pool, queries };
}

function rows(
  values: readonly Record<string, unknown>[],
  rowCount = values.length,
): {
  readonly rowCount: number;
  readonly rows: readonly Record<string, unknown>[];
} {
  return { rowCount, rows: values };
}
