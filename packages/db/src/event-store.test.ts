import { generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import {
  KIND_AUTH,
  KIND_DELETION,
  KIND_REACTION,
  signNostrEvent,
} from "@buzz/core";

import { MemoryEventStore } from "./event-store.js";

describe("event store contract", () => {
  it("stores, filters, orders, and counts normal signed events", async () => {
    const store = new MemoryEventStore();
    const secret = generateSecretKey();
    const first = event(secret, 1, 100, [["p", "a".repeat(64)]], "first");
    const second = event(secret, 1, 101, [["p", "b".repeat(64)]], "second");
    await store.store("one.example", first);
    await store.store("one.example", second);
    await store.store("two.example", first);

    await expect(
      store.query("one.example", { "#p": ["a".repeat(64)], kinds: [1] }),
    ).resolves.toEqual([first]);
    await expect(
      store.query("one.example", { authors: [first.pubkey.slice(0, 12)] }),
    ).resolves.toEqual([second, first]);
    await expect(store.count("one.example", { kinds: [1] })).resolves.toBe(2);
    await expect(store.count("two.example", { kinds: [1] })).resolves.toBe(1);
  });

  it("never persists AUTH or ephemeral events", async () => {
    const store = new MemoryEventStore();
    const secret = generateSecretKey();
    await expect(
      store.store("buzz.example", event(secret, KIND_AUTH, 100, [], "")),
    ).rejects.toThrow(/authentication events/i);
    await expect(
      store.store("buzz.example", event(secret, 24_201, 100, [], "")),
    ).resolves.toEqual({ status: "ephemeral" });
    await expect(store.count("buzz.example", {})).resolves.toBe(0);
  });

  it("keeps only the winning replaceable event", async () => {
    const store = new MemoryEventStore();
    const secret = generateSecretKey();
    const older = event(secret, 30_123, 100, [["d", "profile"]], "old");
    const newer = event(secret, 30_123, 101, [["d", "profile"]], "new");
    expect((await store.store("buzz.example", newer)).status).toBe("inserted");
    expect((await store.store("buzz.example", older)).status).toBe(
      "superseded",
    );
    await expect(
      store.query("buzz.example", { "#d": ["profile"], kinds: [30_123] }),
    ).resolves.toEqual([newer]);
  });

  it("atomically deduplicates active reactions by target, actor, and emoji", async () => {
    const store = new MemoryEventStore();
    const secret = generateSecretKey();
    const target = event(secret, 1, 100, [], "target");
    await store.store("buzz.example", target);
    const first = event(secret, KIND_REACTION, 101, [["e", target.id]], "👍");
    const duplicate = event(
      secret,
      KIND_REACTION,
      102,
      [["e", target.id]],
      "👍",
    );

    await expect(store.store("buzz.example", first)).resolves.toEqual({
      status: "inserted",
    });
    await expect(store.store("buzz.example", duplicate)).resolves.toEqual({
      message: "duplicate: reaction already exists",
      status: "duplicate",
    });
    await expect(
      store.query("buzz.example", { kinds: [KIND_REACTION] }),
    ).resolves.toEqual([first]);
  });

  it("stores a NIP-09 tombstone while removing its exact target", async () => {
    const store = new MemoryEventStore();
    const secret = generateSecretKey();
    const target = event(secret, 1, 100, [], "delete me");
    await store.store("buzz.example", target);
    const deletion = event(secret, KIND_DELETION, 101, [["e", target.id]], "");

    await expect(store.store("buzz.example", deletion)).resolves.toEqual({
      status: "inserted",
    });
    await expect(
      store.query("buzz.example", { ids: [target.id] }),
    ).resolves.toEqual([]);
    await expect(
      store.getById("buzz.example", target.id),
    ).resolves.toBeUndefined();
    await expect(
      store.getById("buzz.example", target.id, { includeDeleted: true }),
    ).resolves.toMatchObject({ event: target });
    await expect(
      store.query("buzz.example", { ids: [deletion.id] }),
    ).resolves.toEqual([deletion]);
  });
});

function event(
  secretKey: Uint8Array,
  kind: number,
  createdAt: number,
  tags: string[][],
  content: string,
) {
  return signNostrEvent(
    {
      content,
      created_at: createdAt,
      kind,
      tags,
    },
    secretKey,
  );
}
