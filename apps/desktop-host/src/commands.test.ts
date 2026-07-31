import { describe, expect, it } from "vitest";

import { CommandRegistry, type CommandContext } from "./commands.js";

/**
 * The bridge is untyped at the boundary, so a handler returning the wrong JSON
 * shape only fails in the browser — and a list the UI calls `.find` on fails by
 * throwing during render, which blanks the screen rather than showing an error.
 * These assertions pin the shape of the list-returning stubs.
 */
describe("CommandRegistry list contracts", () => {
  const registry = new CommandRegistry({} as unknown as CommandContext);

  it.each([
    "get_baked_build_env",
    "get_baked_build_env_keys",
  ])("%s returns an array", async (command) => {
    const result = await registry.invoke(command, {});
    expect(Array.isArray(result)).toBe(true);
  });
});
