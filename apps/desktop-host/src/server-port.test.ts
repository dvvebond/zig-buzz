import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readRememberedPort, rememberPort } from "./server-port.js";

const directory = async () => mkdtemp(path.join(os.tmpdir(), "buzz-port-"));

describe("remembered desktop port", () => {
  it("round-trips a port so the browser origin survives a restart", async () => {
    // The UI keeps the active identity and community in per-origin storage, so a
    // fresh ephemeral port each launch showed an empty app that looked like a
    // first run even though the host still held everything.
    const dataDirectory = await directory();
    await rememberPort(dataDirectory, 64_341);
    expect(await readRememberedPort(dataDirectory)).toBe(64_341);
  });

  it("treats a missing or unusable record as no preference", async () => {
    const dataDirectory = await directory();
    expect(await readRememberedPort(dataDirectory)).toBeUndefined();

    const file = path.join(dataDirectory, "desktop-port.json");
    for (const contents of [
      "not json",
      "{}",
      '{"port":"64341"}',
      '{"port":0}',
      '{"port":80}',
      '{"port":70000}',
      '{"port":1.5}',
    ]) {
      await writeFile(file, contents);
      expect(await readRememberedPort(dataDirectory)).toBeUndefined();
    }
  });

  it("refuses to record a port outside the unprivileged range", async () => {
    const dataDirectory = await directory();
    await rememberPort(dataDirectory, 0);
    await rememberPort(dataDirectory, 80);
    expect(await readRememberedPort(dataDirectory)).toBeUndefined();
  });

  it("stores the record privately", async () => {
    const dataDirectory = await directory();
    await rememberPort(dataDirectory, 50_000);
    const contents = await readFile(
      path.join(dataDirectory, "desktop-port.json"),
      "utf8",
    );
    expect(JSON.parse(contents)).toEqual({ port: 50_000 });
  });
});
