import { describe, expect, it } from "vitest";

import type { NewAuditEntry } from "@buzz/audit";

import { RelayAuditQueue } from "./audit-queue.js";

const entry: NewAuditEntry = {
  action: "event_created",
  actorPubkey: new Uint8Array(32).fill(1),
  communityId: "00000000-0000-4000-8000-000000000001",
  detail: { event_kind: 1 },
  objectId: "",
};

describe("relay audit queue", () => {
  it("serializes and drains entries without losing optional-value identity", async () => {
    const logged: NewAuditEntry[] = [];
    let active = 0;
    let maximumActive = 0;
    const queue = new RelayAuditQueue({
      log: async (input) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        logged.push(input);
        active -= 1;
        return {
          action: input.action,
          actorPubkey: input.actorPubkey ?? null,
          communityId: input.communityId,
          createdAt: "2026-01-01T00:00:00+00:00",
          detail: input.detail,
          hash: new Uint8Array(32),
          objectId: input.objectId ?? null,
          prevHash: null,
          seq: 1n,
        };
      },
    });
    await Promise.all([queue.enqueue(entry), queue.enqueue(entry)]);
    await queue.close();
    expect(logged).toHaveLength(2);
    expect(logged[0]?.objectId).toBe("");
    expect(maximumActive).toBe(1);
    expect(queue.errorCount).toBe(0);
  });

  it("counts persistence failures while continuing the queue", async () => {
    let calls = 0;
    const queue = new RelayAuditQueue({
      log: async () => {
        calls += 1;
        throw new Error("database unavailable");
      },
    });
    await queue.enqueue(entry);
    await queue.enqueue(entry);
    await queue.close();
    expect(calls).toBe(2);
    expect(queue.errorCount).toBe(2);
  });
});
