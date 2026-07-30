import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KIND_HTTP_AUTH, signNostrEvent, unixNow } from "@buzz/core";

import { createRelayServer } from "./server.js";

type TestRelay = ReturnType<typeof createRelayServer>;
const relays: TestRelay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("moderation HTTP reads", () => {
  it("binds NIP-98 to the full URL and returns moderator-only rows", async () => {
    const moderatorSecret = generateSecretKey();
    const moderatorPubkey = getPublicKey(moderatorSecret);
    const communityId = randomUUID();
    const reportId = randomUUID();
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("JOIN relay_members")) {
        return {
          rows:
            values?.[1] === moderatorPubkey
              ? [{ community_id: communityId, role: "admin" }]
              : [],
        };
      }
      if (sql.includes("FROM moderation_reports")) {
        expect(values).toEqual([communityId, "open", 12]);
        return {
          rows: [
            {
              action_id: null,
              channel_id: null,
              created_at: new Date("2026-07-29T00:00:00.000Z"),
              id: reportId,
              note: "private moderator note",
              report_event_id: "11".repeat(32),
              report_type: "spam",
              reporter_pubkey: "22".repeat(32),
              resolved_at: null,
              resolved_by: null,
              status: "open",
              target_blob_sha256: null,
              target_event_id: "33".repeat(32),
              target_kind: "event",
              target_pubkey: null,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const { baseUrl } = await startRelay({
      pool: { query } as unknown as Pool,
    });
    const url = `${baseUrl}/moderation/reports?status=open&limit=12`;
    const response = await signedGet(url, moderatorSecret);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      {
        action_id: null,
        channel_id: null,
        created_at: "2026-07-29T00:00:00.000Z",
        id: reportId,
        note: "private moderator note",
        report_event_id: "11".repeat(32),
        report_type: "spam",
        reporter_pubkey: "22".repeat(32),
        resolved_at: null,
        resolved_by: null,
        status: "open",
        target: "33".repeat(32),
        target_kind: "event",
      },
    ]);

    const wrongBinding = await signedGet(
      `${baseUrl}/moderation/audit?limit=1`,
      moderatorSecret,
      `${baseUrl}/moderation/audit`,
    );
    expect(wrongBinding.status).toBe(401);
  });

  it("denies members and clamps bounded audit reads", async () => {
    const adminSecret = generateSecretKey();
    const memberSecret = generateSecretKey();
    const adminPubkey = getPublicKey(adminSecret);
    const memberPubkey = getPublicKey(memberSecret);
    const communityId = randomUUID();
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("JOIN relay_members")) {
        return {
          rows: [
            {
              community_id: communityId,
              role: values?.[1] === adminPubkey ? "owner" : "member",
            },
          ],
        };
      }
      if (sql.includes("FROM moderation_actions")) {
        expect(values).toEqual([communityId, 500]);
        return { rows: [{ action: "ban", id: randomUUID() }] };
      }
      return { rows: [] };
    });
    const { baseUrl } = await startRelay({
      pool: { query } as unknown as Pool,
    });

    const denied = await signedGet(
      `${baseUrl}/moderation/restricted`,
      memberSecret,
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toEqual({
      error: "restricted: moderator access required",
    });
    expect(memberPubkey).not.toBe(adminPubkey);

    const audit = await signedGet(
      `${baseUrl}/moderation/audit?limit=99999`,
      adminSecret,
    );
    expect(audit.status).toBe(200);
    await expect(audit.json()).resolves.toEqual([
      expect.objectContaining({ action: "ban" }),
    ]);
  });
});

async function signedGet(
  url: string,
  secret: Uint8Array,
  signedUrl = url,
): Promise<Response> {
  const event = signNostrEvent(
    {
      content: "",
      created_at: unixNow(),
      kind: KIND_HTTP_AUTH,
      tags: [
        ["u", signedUrl],
        ["method", "GET"],
      ],
    },
    secret,
  );
  return fetch(url, {
    headers: {
      Authorization: `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`,
    },
  });
}

async function startRelay(
  options: Partial<Parameters<typeof createRelayServer>[0]>,
): Promise<{ baseUrl: string; relay: TestRelay }> {
  const publicUrl = new URL("ws://localhost:1/");
  const relay = createRelayServer({
    community: "localhost",
    host: "127.0.0.1",
    ownerPubkeys: new Set(),
    port: 0,
    publicUrl,
    ...options,
  });
  relays.push(relay);
  await relay.listen();
  const address = relay.address();
  if (!address || typeof address === "string") {
    throw new Error("test relay did not bind a TCP port");
  }
  publicUrl.port = String(address.port);
  return {
    baseUrl: `http://localhost:${address.port}`,
    relay,
  };
}
