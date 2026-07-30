import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopEventBus } from "./event-bus.js";
import { IdentityService } from "./identity.js";
import { MeshComputeService } from "./mesh-compute.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

describe("MeshComputeService", () => {
  it("supervises a private serving node and reports its local usage", async () => {
    const fixture = await createFixture();
    const service = fixture.service;
    try {
      const status = await service.start({
        request: {
          maxVramGb: 12,
          mode: "serve",
          modelId: "Qwen3-8B-Q4_K_M",
        },
      });
      expect(status).toMatchObject({
        deviceId: "device-test",
        endpointId: "endpoint-test",
        health: { status: "ok" },
        inviteToken: "buzz-secure-invite-token-123456",
        mode: "serve",
        modelId: "Qwen3-8B-Q4_K_M",
        state: "running",
      });
      expect(status.apiBaseUrl).toBe(`http://127.0.0.1:${fixture.apiPort}/v1`);
      expect(await service.servingUsage()).toEqual({
        endpointAttempts: 2,
        inflight: 1,
        localAttempts: 5,
        peakInflight: 3,
        peers: 2,
        remoteAttempts: 4,
        requestsServed: 11,
        tokensPerSecond: 17.5,
        tokensServed: 900,
      });
      await expect(service.installedModels()).resolves.toContainEqual({
        id: "Qwen3-8B-Q4_K_M",
        name: "Qwen 3 8B",
      });
      const catalog = await service.modelCatalog();
      expect(catalog.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            installed: true,
            name: "Qwen3-8B-Q4_K_M",
            sizeGb: 5,
          }),
        ]),
      );

      const stopped = await service.stop();
      expect(stopped).toMatchObject({
        apiBaseUrl: null,
        inviteToken: null,
        mode: null,
        state: "off",
      });
      expect(fixture.savedSettings.at(-1)).toMatchObject({
        key: "mesh.sharing",
        value: { enabled: false },
      });
    } finally {
      await service.shutdown();
    }
  }, 15_000);

  it("keeps a joined client alive when stop-sharing is requested", async () => {
    const fixture = await createFixture();
    const service = fixture.service;
    try {
      await service.start({
        request: {
          joinToken: "buzz-secure-invite-token-123456",
          mode: "client",
        },
      });
      const status = await service.stop();
      expect(status).toMatchObject({ mode: "client", state: "running" });
      await service.shutdown();
      await expect(service.status()).resolves.toMatchObject({
        mode: null,
        state: "off",
      });
    } finally {
      await service.shutdown();
    }
  });

  it("rejects incomplete and malformed start requests before spawning", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        fixture.service.start({ request: { mode: "serve" } }),
      ).rejects.toThrow(/modelId is required/);
      await expect(
        fixture.service.start({
          request: { joinToken: "short", mode: "client" },
        }),
      ).rejects.toThrow(/joinToken has an invalid format/);
    } finally {
      await fixture.service.shutdown();
    }
  });
});

async function createFixture(): Promise<{
  apiPort: number;
  consolePort: number;
  savedSettings: Array<{ key: string; value: unknown }>;
  service: MeshComputeService;
}> {
  const dataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "buzz-mesh-compute-test-"),
  );
  cleanup.push(() => rm(dataDirectory, { force: true, recursive: true }));
  const executable = path.join(dataDirectory, "fake-mesh-llm");
  const apiPort = await availablePort();
  const consolePort = await availablePort();
  await writeFile(executable, fakeRuntimeSource(), { mode: 0o700 });
  await chmod(executable, 0o700);
  const savedSettings: Array<{ key: string; value: unknown }> = [];
  const identity = IdentityService.create(undefined, async () => undefined);
  const originalSetSetting = identity.setSetting.bind(identity);
  identity.setSetting = async (key: string, value: unknown) => {
    savedSettings.push({ key, value });
    await originalSetSetting(key, value);
  };
  const service = new MeshComputeService({
    apiPort,
    binaryPath: executable,
    consolePort,
    dataDirectory,
    events: new DesktopEventBus(),
    identity,
    startupTimeoutMs: 5_000,
    workspace: { relayUrl: () => "wss://relay.example.test" },
  });
  cleanup.push(() => service.shutdown());
  return { apiPort, consolePort, savedSettings, service };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("unable to allocate test port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function fakeRuntimeSource(): string {
  return `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("mesh-llm 99.0.0-test\\n");
  process.exit(0);
}
if (args[0] === "setup") process.exit(0);
if (args[0] === "models" && args[1] === "installed") {
  process.stdout.write(JSON.stringify({
    models: [{ id: "Qwen3-8B-Q4_K_M", name: "Qwen 3 8B" }]
  }));
  process.exit(0);
}
if (args[0] === "models" && args[1] === "recommended") {
  process.stdout.write(JSON.stringify({
    models: [{
      description: "Test model",
      id: "Qwen3-8B-Q4_K_M",
      size: "5.0GB",
      sizeGb: 5
    }]
  }));
  process.exit(0);
}
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const apiPort = Number(valueAfter("--port"));
const consolePort = Number(valueAfter("--console"));
if (!Number.isInteger(apiPort) || !Number.isInteger(consolePort)) process.exit(2);
const api = http.createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/v1/models") {
    response.end(JSON.stringify({ data: [{ id: "Qwen3-8B-Q4_K_M" }] }));
  } else {
    response.statusCode = 404;
    response.end("{}");
  }
});
const consoleServer = http.createServer((request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.url !== "/api/status") {
    response.statusCode = 404;
    response.end("{}");
    return;
  }
  response.end(JSON.stringify({
    deviceId: "device-test",
    deviceName: "Test device",
    endpointId: "endpoint-test",
    inviteToken: "buzz-secure-invite-token-123456",
    peers: [{ id: "one" }, { id: "two" }],
    routing_metrics: {
      avg_tokens_per_second: 17.5,
      completion_tokens_observed: 900,
      local_node: {
        current_inflight_requests: 1,
        endpoint_attempt_count: 2,
        local_attempt_count: 5,
        peak_inflight_requests: 3,
        remote_attempt_count: 4
      },
      request_count: 11
    }
  }));
});
api.listen(apiPort, "127.0.0.1");
consoleServer.listen(consolePort, "127.0.0.1", () => {
  process.stdout.write("Invite token: buzz-secure-invite-token-123456\\n");
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  let pending = 2;
  const done = () => {
    pending -= 1;
    if (pending === 0) process.exit(0);
  };
  api.close(done);
  consoleServer.close(done);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;
}
