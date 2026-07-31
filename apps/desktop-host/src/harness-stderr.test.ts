import { describe, expect, it } from "vitest";

import { promotableHarnessError } from "./harness-stderr.js";

describe("promotableHarnessError", () => {
  it("promotes a reported failure so a live agent's silence has a reason", () => {
    // The case that started this: the agent answered once, its provider session
    // expired, and every later turn failed. The process stayed up, so nothing
    // set lastError and the UI simply went quiet.
    expect(
      promotableHarnessError(
        "buzz-acp: Internal error: Failed to authenticate: OAuth session expired and could not be refreshed",
      ),
    ).toBe(
      "Internal error: Failed to authenticate: OAuth session expired and could not be refreshed",
    );
  });

  it("ignores progress and unprefixed CLI noise", () => {
    expect(promotableHarnessError("buzz-acp ready")).toBeNull();
    expect(promotableHarnessError("")).toBeNull();
    expect(promotableHarnessError("  ")).toBeNull();
    expect(promotableHarnessError("some underlying CLI warning")).toBeNull();
    expect(promotableHarnessError("buzz-acp:")).toBeNull();
    expect(promotableHarnessError("buzz-acp:    ")).toBeNull();
  });

  it("redacts secrets and bounds the length", () => {
    const leaky = promotableHarnessError(
      "buzz-acp: failed for nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    );
    expect(leaky).not.toContain("nsec1qqqq");
    expect(leaky).toContain("[REDACTED]");
    expect(
      (promotableHarnessError(`buzz-acp: ${"x".repeat(4_000)}`) ?? "").length,
    ).toBeLessThanOrEqual(512);
  });
});
