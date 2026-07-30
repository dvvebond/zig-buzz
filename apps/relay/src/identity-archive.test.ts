import { randomUUID } from "node:crypto";

import {
  KIND_IA_ARCHIVED,
  KIND_IA_ARCHIVED_LIST,
  KIND_IA_ARCHIVE_REQUEST,
  signNostrEvent,
  unixNow,
} from "@buzz/core";
import { MemoryEventStore } from "@buzz/db";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { IdentityArchiveService } from "./identity-archive.js";

describe("NIP-IA identity archive service", () => {
  it("archives a self-signed identity and publishes a delta plus snapshot", async () => {
    const communityId = randomUUID();
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const eventStore = new MemoryEventStore();
    const published: number[] = [];
    const inserts: unknown[][] = [];
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("FROM communities")) {
        return rows([{ id: communityId }]);
      }
      if (sql.includes("INSERT INTO archived_identities")) {
        inserts.push([...(values ?? [])]);
        return rows([{}]);
      }
      if (
        sql.includes("SELECT pubkey") &&
        sql.includes("FROM archived_identities")
      ) {
        return rows([{ pubkey }]);
      }
      return rows([]);
    });
    const service = new IdentityArchiveService({
      community: "relay.example",
      eventStore,
      pool: { query } as unknown as Pool,
      publishEvent: async (event) => {
        published.push(event.kind);
      },
      relaySecretKey: generateSecretKey(),
    });
    const event = signNostrEvent(
      {
        content: "Retired identity",
        created_at: unixNow(),
        kind: KIND_IA_ARCHIVE_REQUEST,
        tags: [["-"], ["p", pubkey], ["reason", "Rotated credentials"]],
      },
      secret,
    );

    await service.execute(event);

    expect(inserts).toEqual([
      [
        communityId,
        pubkey,
        "self",
        pubkey,
        "Rotated credentials",
        null,
        event.id,
      ],
    ]);
    expect(published).toEqual([KIND_IA_ARCHIVED, KIND_IA_ARCHIVED_LIST]);
    const state = await eventStore.query("relay.example", {
      kinds: [KIND_IA_ARCHIVED, KIND_IA_ARCHIVED_LIST],
      limit: 10,
    });
    const delta = state.find(({ kind }) => kind === KIND_IA_ARCHIVED);
    expect(delta?.content).toBe("Retired identity");
    expect(delta?.tags).toContainEqual(["consent", "self", pubkey]);
    expect(delta?.tags).toContainEqual(["e", event.id]);
    expect(
      state.find(({ kind }) => kind === KIND_IA_ARCHIVED_LIST)?.tags,
    ).toContainEqual(["p", pubkey]);
  });

  it("requires one exact NIP-70 protected tag", async () => {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const service = new IdentityArchiveService({
      community: "relay.example",
      eventStore: new MemoryEventStore(),
      pool: { query: vi.fn() } as unknown as Pool,
      publishEvent: async () => undefined,
      relaySecretKey: generateSecretKey(),
    });
    const malformed = signNostrEvent(
      {
        content: "",
        created_at: unixNow(),
        kind: KIND_IA_ARCHIVE_REQUEST,
        tags: [
          ["-", "extra"],
          ["p", pubkey],
        ],
      },
      secret,
    );
    await expect(service.execute(malformed)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });
});

function rows(values: readonly Record<string, unknown>[]): {
  readonly rowCount: number;
  readonly rows: readonly Record<string, unknown>[];
} {
  return { rowCount: values.length, rows: values };
}
