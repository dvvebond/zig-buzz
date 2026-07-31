import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { DEFAULT_BASE_PROMPT } from "./base-prompt.js";
import { frameSystemPrompt } from "./harness.js";

describe("Buzz ACP base prompt", () => {
  it("keeps the generated TypeScript prompt identical to the reviewable source", async () => {
    const markdown = await readFile(
      new URL("../base-prompt.md", import.meta.url),
      "utf8",
    );
    expect(DEFAULT_BASE_PROMPT).toBe(markdown);
  });

  it("frames the shared workspace, base instructions, and persona instructions", () => {
    expect(
      frameSystemPrompt("/work/buzz", "base instructions", "persona rules"),
    ).toBe(
      "[Workspace]\nYour absolute working directory is `/work/buzz`. All workspace files — `AGENTS.md`, `RESEARCH/`, `PLANS/`, `GUIDES/`, `WORK_LOGS/`, `OUTBOX/` — and repositories under `/work/buzz/REPOS/` live here. Do not search other directories for them.\n\n[Base]\nbase instructions\n\n[System]\npersona rules",
    );
  });

  it("supports explicitly disabling the base without inventing a workspace frame", () => {
    expect(frameSystemPrompt("/work/buzz", null, "persona rules")).toBe(
      "[System]\npersona rules",
    );
    expect(frameSystemPrompt("/", "base", undefined)).toBe("[Base]\nbase");
    expect(frameSystemPrompt("/work/buzz", null, undefined)).toBeUndefined();
  });
});
