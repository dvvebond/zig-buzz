import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  runPendingReset,
  validateResetTarget,
  writeResetSentinel,
} from "./reset.js";

describe("desktop reset", () => {
  it("uses a durable outside sentinel and removes only the exact Buzz data tree", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "buzz-reset-test-"));
    const target = path.join(parent, "Buzz TypeScript");
    const sibling = path.join(parent, "keep.txt");
    await mkdir(path.join(target, "archive"), { recursive: true });
    await writeFile(path.join(target, "state.enc.json"), "secret");
    await writeFile(path.join(target, "archive", "archive.sqlite3"), "records");
    await writeFile(sibling, "keep");

    const sentinel = await writeResetSentinel(target);
    expect(JSON.parse(await readFile(sentinel, "utf8"))).toMatchObject({
      version: 1,
    });
    expect(await runPendingReset(target)).toBe(true);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sibling, "utf8")).resolves.toBe("keep");
    expect(await runPendingReset(target)).toBe(false);
  });

  it("refuses broad or symlinked destructive targets", async () => {
    await expect(
      validateResetTarget(path.parse(process.cwd()).root),
    ).rejects.toThrow(/unsafe/);
    await expect(validateResetTarget(os.homedir())).rejects.toThrow(/unsafe/);
    await expect(
      validateResetTarget(path.join(os.tmpdir(), "ordinary-data")),
    ).rejects.toThrow(/unsafe/);

    const parent = await mkdtemp(path.join(os.tmpdir(), "buzz-reset-link-"));
    const actual = path.join(parent, "actual-buzz-data");
    const linked = path.join(parent, "linked-buzz-data");
    await mkdir(actual);
    await symlink(actual, linked);
    await expect(writeResetSentinel(linked)).rejects.toThrow(/symlinked/);
  });
});
