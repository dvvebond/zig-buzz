import { createHash } from "node:crypto";
import { createServer } from "node:http";

import { KIND_HTTP_AUTH, signNostrEvent, unixNow } from "@buzz/core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it } from "vitest";

import { Nip98ReplayGuard } from "./nip98.js";
import { normalizeCandidateHost, RelayOperatorHttp } from "./operator-http.js";

const OPERATOR_ORIGIN = "https://operator.example";

describe("relay operator HTTP", () => {
  it("normalizes safe authority variants and rejects ambiguous hosts", () => {
    expect(normalizeCandidateHost("Acme.Example:443")).toBe("acme.example");
    expect(normalizeCandidateHost("acme.example.")).toBe("acme.example");
    expect(normalizeCandidateHost("[::1]:3000")).toBe("[::1]:3000");
    for (const host of [
      "",
      "https://acme.example",
      "acme.example/path",
      "user@acme.example",
      "bad_label.example",
      "-bad.example",
      "bad-.example",
      "example..com",
    ]) {
      expect(() => normalizeCandidateHost(host)).toThrow();
    }
  });

  it("binds auth to the configured origin, ignores inbound Host authority, and rejects replay", async () => {
    const operatorSecret = generateSecretKey();
    const observed: unknown[][] = [];
    const pool = {
      query: async (_sql: string, parameters?: unknown[]) => {
        observed.push(parameters ?? []);
        return rows([{ id: "f5277670-eab2-43cb-948e-06be9967a1cc" }]);
      },
    } as unknown as Pool;
    const handler = new RelayOperatorHttp({
      apiOrigin: new URL(OPERATOR_ORIGIN),
      deploymentHost: "relay.example",
      operatorPubkeys: new Set([getPublicKey(operatorSecret)]),
      pool,
      replay: new Nip98ReplayGuard(),
    });
    const server = await start(handler);
    try {
      const target =
        "/operator/communities/availability?host=Acme.Example%3A443";
      const authorization = nip98(operatorSecret, "GET", target);
      const accepted = await fetch(`${server.origin}${target}`, {
        headers: {
          Authorization: authorization,
          Host: "untrusted-ingress.example",
        },
      });
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toEqual({
        available: false,
        community_id: "f5277670-eab2-43cb-948e-06be9967a1cc",
        host: "Acme.Example:443",
        normalized_host: "acme.example",
      });
      expect(observed).toContainEqual(["acme.example"]);

      const replay = await fetch(`${server.origin}${target}`, {
        headers: { Authorization: authorization },
      });
      expect(replay.status).toBe(401);

      const mismatched = await fetch(`${server.origin}${target}`, {
        headers: {
          Authorization: nip98(operatorSecret, "GET", `${target}&extra=1`),
        },
      });
      expect(mismatched.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("atomically creates a host and initial owner for create-only requests", async () => {
    const operatorSecret = generateSecretKey();
    const ownerPubkey = getPublicKey(generateSecretKey());
    const communityId = "39ae849c-aee2-4a31-95f5-98dd6c16a208";
    const statements: string[] = [];
    let released = false;
    const client = {
      query: async (sql: string) => {
        statements.push(sql.replaceAll(/\s+/g, " ").trim());
        if (sql.includes("RETURNING id, host")) {
          return rows([
            {
              host: "team.example",
              id: communityId,
            },
          ]);
        }
        if (sql.includes("count(*)::text")) return rows([{ count: "0" }]);
        return rows([]);
      },
      release: () => {
        released = true;
      },
    } as unknown as PoolClient;
    const pool = {
      connect: async () => client,
    } as unknown as Pool;
    const snapshots: Array<[string, string]> = [];
    const handler = new RelayOperatorHttp({
      apiOrigin: new URL(OPERATOR_ORIGIN),
      deploymentHost: "relay.example",
      onMembershipChanged: async (id, host) => {
        snapshots.push([id, host]);
      },
      operatorPubkeys: new Set([getPublicKey(operatorSecret)]),
      pool,
      replay: new Nip98ReplayGuard(),
    });
    const server = await start(handler);
    try {
      const target = "/operator/communities";
      const body = Buffer.from(
        JSON.stringify({
          create_only: true,
          host: "team.example",
          initial_owner_pubkey: ownerPubkey,
        }),
      );
      const response = await fetch(`${server.origin}${target}`, {
        body,
        headers: {
          Authorization: nip98(operatorSecret, "POST", target, body),
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        community_id: communityId,
        host: "team.example",
        owner_pubkey: ownerPubkey,
        status: "created",
      });
      expect(statements[0]).toBe("BEGIN");
      expect(statements).toContain("COMMIT");
      expect(
        statements.some((sql) => sql.includes("pg_advisory_xact_lock")),
      ).toBe(true);
      expect(
        statements.some((sql) => sql.includes("INSERT INTO relay_members")),
      ).toBe(true);
      expect(released).toBe(true);
      expect(snapshots).toEqual([[communityId, "team.example"]]);
    } finally {
      await server.close();
    }
  });
});

function nip98(
  secret: Uint8Array,
  method: string,
  target: string,
  body = Buffer.alloc(0),
): string {
  const event = signNostrEvent(
    {
      content: "",
      created_at: unixNow(),
      kind: KIND_HTTP_AUTH,
      tags: [
        ["u", `${OPERATOR_ORIGIN}${target}`],
        ["method", method],
        ...(body.length > 0
          ? [["payload", createHash("sha256").update(body).digest("hex")]]
          : []),
      ],
    },
    secret,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

async function start(handler: RelayOperatorHttp): Promise<{
  close: () => Promise<void>;
  origin: string;
}> {
  const server = createServer((request, response) => {
    void handler.handle(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("operator test server has no TCP address");
  }
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    origin: `http://127.0.0.1:${address.port}`,
  };
}

function rows<T extends Record<string, unknown>>(values: T[]): QueryResult<T> {
  return {
    command: "SELECT",
    fields: [],
    oid: 0,
    rowCount: values.length,
    rows: values,
  };
}
