import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { IdentityService } from "./identity.js";
import { RuntimeCatalogService } from "./runtime-catalog.js";

describe("RuntimeCatalogService", () => {
  it("returns the complete built-in and preset catalog wire shape", async () => {
    const service = new RuntimeCatalogService(
      IdentityService.create(undefined, async () => undefined),
    );
    const entries = await service.discover();
    expect(entries.map((entry) => entry.id)).toEqual([
      "goose",
      "claude",
      "codex",
      "buzz-agent",
      "cursor",
      "omp",
      "grok",
      "opencode",
      "kimi",
      "amp",
      "hermes",
      "openclaw",
    ]);
    const builtIn = entries.find((entry) => entry.id === "buzz-agent");
    expect(builtIn).toMatchObject({
      auth_status: { status: "not_applicable" },
      availability: "available",
      binary_path: process.execPath,
      command: "buzz-agent",
      model_env_var: "BUZZ_AGENT_MODEL",
      provider_env_var: "BUZZ_AGENT_PROVIDER",
      source: "builtin",
      thinking_env_var: "BUZZ_AGENT_THINKING_EFFORT",
    });
  });

  it("persists custom harness definitions and rejects reserved control env", async () => {
    let persisted:
      | { identitySecretHex: string; settings: Record<string, unknown> }
      | undefined;
    const identity = IdentityService.create(undefined, async (state) => {
      persisted = structuredClone(state);
    });
    const service = new RuntimeCatalogService(identity);
    const saved = await service.save({
      args: ["acp"],
      command: process.execPath,
      env: { SAFE_TOKEN: "encrypted-at-rest" },
      id: "my-runtime",
      installHint: "Already installed",
      installInstructionsUrl: "https://example.test/install",
      label: "My Runtime",
    });
    expect(saved).toMatchObject({
      availability: "available",
      definition_env: { SAFE_TOKEN: "encrypted-at-rest" },
      id: "my-runtime",
      source: "custom",
    });
    expect(persisted?.settings["custom-harnesses.v1"]).toBeDefined();

    await expect(
      service.save({
        command: process.execPath,
        env: { BUZZ_PRIVATE_KEY: "forged" },
        id: "unsafe-runtime",
        label: "Unsafe",
      }),
    ).rejects.toThrow(/reserved/);
    await expect(
      service.save({
        command: process.execPath,
        id: "goose",
        label: "Shadow",
      }),
    ).rejects.toThrow(/reserved/);
  });

  it("executes only a freshly discovered provider binary and bounds its protocol", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(path.join(os.tmpdir(), "buzz-provider-"));
    const executable = path.join(directory, "buzz-backend-test");
    await writeFile(
      executable,
      [
        `#!${process.execPath}`,
        "let body = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { body += chunk; });",
        "process.stdin.on('end', () => {",
        "  const request = JSON.parse(body);",
        "  process.stdout.write(JSON.stringify({ ok: request.op === 'info', name: 'Test Provider', version: '1.0.0' }));",
        "});",
      ].join("\n"),
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const previousPath = process.env.PATH;
    process.env.PATH = directory;
    try {
      const service = new RuntimeCatalogService(
        IdentityService.create(undefined, async () => undefined),
      );
      expect(await service.discoverBackendProviders()).toEqual([
        {
          binaryPath: await import("node:fs/promises").then((fs) =>
            fs.realpath(executable),
          ),
          id: "test",
        },
      ]);
      await expect(
        service.probeBackendProvider(executable),
      ).resolves.toMatchObject({
        name: "Test Provider",
        ok: true,
        version: "1.0.0",
      });
      await expect(
        service.probeBackendProvider(process.execPath),
      ).rejects.toThrow(/not a discovered/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
