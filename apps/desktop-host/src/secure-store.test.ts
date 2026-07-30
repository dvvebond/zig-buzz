import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SecureStore } from "./secure-store.js";

describe("SecureStore", () => {
  it("encrypts state at rest and detects ciphertext tampering", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "buzz-store-"));
    const store = new SecureStore(directory);
    const state = {
      identitySecretHex: "42".repeat(32),
      settings: { theme: "dark" },
    };
    await store.save(state);

    const raw = await readFile(path.join(directory, "state.enc.json"), "utf8");
    expect(raw).not.toContain(state.identitySecretHex);
    await expect(store.load()).resolves.toEqual(state);

    const envelope = JSON.parse(raw) as { ciphertext: string };
    const bytes = Buffer.from(envelope.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    envelope.ciphertext = bytes.toString("base64");
    await writeFile(
      path.join(directory, "state.enc.json"),
      JSON.stringify(envelope),
    );
    await expect(store.load()).rejects.toThrow();
  });
});
