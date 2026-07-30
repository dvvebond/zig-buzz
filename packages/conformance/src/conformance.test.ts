import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ConformanceError,
  checkTrace,
  parseJsonLines,
  type TraceStep,
} from "./index.js";

const community = "aaaa0000-0000-0000-0000-000000000001";
const channel = "cafe0000-0000-0000-0000-000000000010";
const state = {
  resolved_community: community,
  bound_host: "a.example.test",
  actor: "0123456789abcdef",
};
const step = (action: TraceStep["action"]): TraceStep => ({
  schema_version: 1,
  action,
  state_after: state,
});

describe("conformance checker", () => {
  it("accepts a covered confined execution", () => {
    const trace = [
      step({
        type: "auth_check",
        channel,
        claimed_community: community,
        verdict: "allow",
      }),
      step({
        type: "write_insert",
        msg_id: "opaque",
        channel,
        claimed_community: community,
      }),
      step({
        type: "read_message_rows",
        channel,
        row_communities: [community],
      }),
    ];
    expect(() =>
      checkTrace({
        trace,
        requiredCriticalActions: new Set([
          "auth_check",
          "write_insert",
          "read_message_rows",
        ]),
      }),
    ).not.toThrow();
  });

  it.each([
    [
      "non_interference",
      step({
        type: "read_message_rows",
        channel,
        row_communities: ["bbbb0000-0000-0000-0000-000000000002"],
      }),
    ],
    [
      "illegal_transition",
      step({
        type: "auth_check",
        channel,
        claimed_community: "bbbb0000-0000-0000-0000-000000000002",
        verdict: "allow",
      }),
    ],
    ["coverage_breach", step({ type: "impl_bug", kind: "missing_emit" })],
  ] as const)("rejects %s", (kind, value) => {
    try {
      checkTrace({ trace: [value] });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConformanceError);
      expect((error as ConformanceError).kind).toBe(kind);
    }
  });

  it("parses the frozen JSONL wire shape", () => {
    expect(
      parseJsonLines(
        `${JSON.stringify(step({ type: "sanitized_error", reason: "restricted" }))}\n`,
      ),
    ).toHaveLength(1);
  });

  it("replays the committed conformance fixtures", () => {
    const fixture = (name: string) =>
      parseJsonLines(
        readFileSync(
          new URL(`../tests/fixtures/${name}`, import.meta.url),
          "utf8",
        ),
      );
    expect(() => checkTrace({ trace: fixture("good.jsonl") })).not.toThrow();
    for (const name of [
      "bad_coverage_breach.jsonl",
      "bad_foreign_row_leak.jsonl",
      "bad_host_channel_mismatch.jsonl",
    ]) {
      expect(() => checkTrace({ trace: fixture(name) }), name).toThrow(
        ConformanceError,
      );
    }
  });
});
