import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  computeAuditHash,
  normalizeAuditTimestamp,
} from "./hash.js";
import type { AuditEntry } from "./types.js";

function sampleEntry(): AuditEntry {
  return {
    action: "event_created",
    actorPubkey: new Uint8Array(32).fill(0xab),
    communityId: "00000000-0000-4000-8000-000000000001",
    createdAt: "2026-01-01T00:00:00+00:00",
    detail: null,
    hash: new Uint8Array(),
    objectId: "abc123",
    prevHash: null,
    seq: 1n,
  };
}

describe("audit hash", () => {
  it("is deterministic, tenant-bound, and sensitive to optional presence", () => {
    const entry = sampleEntry();
    const hash = computeAuditHash(entry);
    expect(hash).toHaveLength(32);
    expect(computeAuditHash(entry)).toEqual(hash);
    expect(
      computeAuditHash({
        ...entry,
        communityId: "00000000-0000-4000-8000-000000000002",
      }),
    ).not.toEqual(hash);
    expect(
      computeAuditHash({ ...entry, actorPubkey: new Uint8Array() }),
    ).not.toEqual(computeAuditHash({ ...entry, actorPubkey: null }));
  });

  it("canonicalizes object keys recursively", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe(
      '{"a":{"b":3,"y":2},"z":1}',
    );
  });

  it("normalizes PostgreSQL microseconds like chrono RFC3339", () => {
    expect(normalizeAuditTimestamp("2026-01-01T00:00:00.000000+00:00")).toBe(
      "2026-01-01T00:00:00+00:00",
    );
    expect(normalizeAuditTimestamp("2026-01-01T00:00:00.123000+00:00")).toBe(
      "2026-01-01T00:00:00.123+00:00",
    );
    expect(normalizeAuditTimestamp("2026-01-01T00:00:00.123456+00:00")).toBe(
      "2026-01-01T00:00:00.123456+00:00",
    );
  });
});
