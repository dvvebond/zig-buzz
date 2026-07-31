import {
  lstat,
  mkdtemp,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NestService, upsertManagedSection } from "./nest.js";

describe("NestService", () => {
  it("creates a private, idempotent TypeScript agent workspace", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "buzz-nest-test-"));
    const root = path.join(parent, "nest");
    const nest = await NestService.create(root);

    await nest.ensure();
    await nest.ensure();

    for (const directory of [
      "GUIDES",
      "RESEARCH",
      "PLANS",
      "WORK_LOGS",
      "OUTBOX",
      "REPOS",
      ".scratch",
    ]) {
      expect((await lstat(path.join(root, directory))).isDirectory()).toBe(
        true,
      );
    }
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toContain(
      "# Buzz Nest",
    );
    expect(
      await readFile(
        path.join(root, ".agents/skills/buzz-cli/SKILL.md"),
        "utf8",
      ),
    ).toContain("# Buzz CLI Skill");
    if (process.platform !== "win32") {
      expect(
        await readlink(path.join(root, ".codex/skills/buzz-cli")),
      ).toContain(".agents/skills/buzz-cli");
    }
  });

  it("regenerates only the managed roster and preserves trailing user notes", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "buzz-nest-test-"));
    const root = path.join(parent, "nest");
    const nest = await NestService.create(root);
    await nest.ensure();
    const agentsPath = path.join(root, "AGENTS.md");
    await writeFile(
      agentsPath,
      `${await readFile(agentsPath, "utf8")}\nUser-owned notes.\n`,
    );

    await nest.regenerate(
      [{ name: "Ada | Agent", persona_id: "Researcher" }],
      "wss://relay.example/",
    );

    const result = await readFile(agentsPath, "utf8");
    expect(result).toContain("| Ada \\| Agent | Researcher | @Ada \\| Agent |");
    expect(result).toContain("- Relay: wss://relay.example/");
    expect(result).toContain("User-owned notes.");
  });

  it("rejects a symlinked workspace root", async () => {
    if (process.platform === "win32") return;
    const parent = await mkdtemp(path.join(os.tmpdir(), "buzz-nest-test-"));
    const target = await mkdtemp(path.join(os.tmpdir(), "buzz-nest-target-"));
    const root = path.join(parent, "nest");
    await symlink(target, root, "dir");
    const nest = await NestService.create(root);
    await expect(nest.ensure()).rejects.toThrow(/real directory/);
  });
});

describe("upsertManagedSection", () => {
  it("replaces an ordered managed block without duplicating markers", () => {
    const current =
      "# Header\n\n<!-- BEGIN BUZZ MANAGED — old -->\nold\n<!-- END BUZZ MANAGED -->\n\nnotes\n";
    const result = upsertManagedSection(current, "new");
    expect(result.match(/BEGIN BUZZ MANAGED/g)).toHaveLength(1);
    expect(result).toContain("\nnew\n");
    expect(result).toContain("\nnotes\n");
  });
});
