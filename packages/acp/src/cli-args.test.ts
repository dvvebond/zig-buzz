import { describe, expect, it } from "vitest";

import { parseArguments } from "./cli-args.js";

describe("parseArguments", () => {
  it("accepts an empty value, which is how a no-argument runtime is launched", () => {
    // Claude Code, Codex, and Buzz Agent all declare no extra arguments, so the
    // desktop host joins an empty list and passes `--agent-args ""`. Rejecting
    // that crashed the harness before it could connect, leaving the agent
    // silent with no reply to any message.
    const parsed = parseArguments([
      "--agent-command",
      "buzz-agent",
      "--agent-args",
      "",
      "--parallelism",
      "1",
    ]);
    expect(parsed.get("agent-args")).toBe("");
    expect(parsed.get("agent-command")).toBe("buzz-agent");
    expect(parsed.get("parallelism")).toBe("1");
  });

  it("still rejects a flag with no value at all", () => {
    expect(() => parseArguments(["--agent-args"])).toThrow(
      /missing value for --agent-args/,
    );
    expect(() =>
      parseArguments(["--agent-args", "--parallelism", "1"]),
    ).toThrow(/missing value for --agent-args/);
  });

  it("rejects a positional argument", () => {
    expect(() => parseArguments(["acp"])).toThrow(/unexpected argument acp/);
  });
});
