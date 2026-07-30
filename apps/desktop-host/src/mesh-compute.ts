import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import type { DesktopEventBus } from "./event-bus.js";
import type { IdentityService } from "./identity.js";
import { MeshRuntimeInstaller } from "./mesh-installer.js";
import type { WorkspaceService } from "./workspace.js";

type MeshMode = "serve" | "client";
type MeshState = "off" | "starting" | "running" | "stopping" | "failed";

export type MeshNodeStatus = {
  apiBaseUrl: string | null;
  consoleUrl: string | null;
  deviceId: string | null;
  deviceName: string | null;
  endpointId: string | null;
  health:
    | { reason?: null; status: "ok" }
    | { reason: string; status: "degraded" | "failed" };
  inviteToken: string | null;
  mode: MeshMode | null;
  modelId: string | null;
  modelName: string | null;
  state: MeshState;
};

export type MeshServingUsage = {
  endpointAttempts: number;
  inflight: number;
  localAttempts: number;
  peakInflight: number;
  peers: number;
  remoteAttempts: number;
  requestsServed: number;
  tokensPerSecond: number;
  tokensServed: number;
};

type MeshModelOption = { id: string; name: string | null };

type StartRequest = {
  joinToken?: string;
  maxVramGb?: number;
  mode: MeshMode;
  modelId?: string;
};

const DEFAULT_API_PORT = 9_337;
const DEFAULT_CONSOLE_PORT = 3_131;
const MAX_PROCESS_LOG_BYTES = 256 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._~+:/@-]{0,1023}$/;

export class MeshComputeService {
  readonly #apiPort: number;
  readonly #consolePort: number;
  readonly #dataDirectory: string;
  readonly #events: DesktopEventBus;
  readonly #fetch: typeof fetch;
  readonly #identity: IdentityService;
  readonly #installer: MeshRuntimeInstaller;
  readonly #startupTimeoutMs: number;
  readonly #workspace: Pick<WorkspaceService, "relayUrl">;
  #child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  #inviteToken: string | null = null;
  #lastError: string | null = null;
  #log = "";
  #mode: MeshMode | null = null;
  #modelId: string | null = null;
  #operation: Promise<void> = Promise.resolve();
  #state: MeshState = "off";
  #stopping = false;

  constructor(input: {
    dataDirectory: string;
    events: DesktopEventBus;
    identity: IdentityService;
    workspace: Pick<WorkspaceService, "relayUrl">;
    apiPort?: number;
    binaryPath?: string;
    consolePort?: number;
    fetch?: typeof fetch;
    startupTimeoutMs?: number;
  }) {
    this.#dataDirectory = path.resolve(input.dataDirectory);
    this.#events = input.events;
    this.#identity = input.identity;
    this.#workspace = input.workspace;
    this.#apiPort = requirePort(input.apiPort ?? DEFAULT_API_PORT, "apiPort");
    this.#consolePort = requirePort(
      input.consolePort ?? DEFAULT_CONSOLE_PORT,
      "consolePort",
    );
    if (this.#apiPort === this.#consolePort) {
      throw new Error("mesh API and console ports must differ");
    }
    this.#fetch = input.fetch ?? fetch;
    this.#startupTimeoutMs = input.startupTimeoutMs ?? 180_000;
    this.#installer = new MeshRuntimeInstaller({
      dataDirectory: this.#dataDirectory,
      events: this.#events,
      ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
  }

  async restore(): Promise<void> {
    const config = this.#identity.setting<unknown>("mesh.sharing", null);
    if (
      typeof config !== "object" ||
      config === null ||
      !("enabled" in config) ||
      config.enabled !== true ||
      !("modelId" in config) ||
      typeof config.modelId !== "string"
    ) {
      return;
    }
    await this.start({
      request: {
        mode: "serve",
        modelId: config.modelId,
        ...("maxVramGb" in config && typeof config.maxVramGb === "number"
          ? { maxVramGb: config.maxVramGb }
          : {}),
      },
    });
  }

  start(args: Record<string, unknown>): Promise<MeshNodeStatus> {
    return this.#serialize(async () => {
      const request = parseStartRequest(args.request);
      if (this.#child) {
        if (request.mode === "serve" && this.#mode === "client") {
          await this.#stopOwnedRuntime();
        } else {
          throw new Error("mesh node is already running");
        }
      }
      this.#state = "starting";
      this.#mode = request.mode;
      this.#modelId = request.modelId ?? null;
      this.#lastError = null;
      this.#inviteToken = null;
      this.#log = "";
      this.#emitStatus();

      try {
        const binary = await this.#installer.ensure();
        await mkdir(path.join(this.#dataDirectory, "mesh-llm"), {
          mode: 0o700,
          recursive: true,
        });
        await this.#ensureRuntime(binary);
        this.#spawnRuntime(binary, request);
        await this.#waitUntilReady();
        this.#state = "running";
        if (request.mode === "serve") {
          await this.#identity.setSetting("mesh.sharing", {
            enabled: true,
            maxVramGb: request.maxVramGb ?? null,
            modelId: request.modelId,
          });
        }
        this.#emitStatus();
        return this.status();
      } catch (error) {
        this.#lastError = safeError(error);
        this.#state = "failed";
        await this.#stopOwnedRuntime().catch(() => undefined);
        this.#state = "failed";
        this.#emitStatus();
        throw error;
      }
    });
  }

  stop(): Promise<MeshNodeStatus> {
    return this.#serialize(async () => {
      if (this.#mode === "client" && this.#child) return this.status();
      this.#state = "stopping";
      this.#emitStatus();
      await this.#stopOwnedRuntime();
      await this.#identity.setSetting("mesh.sharing", {
        enabled: false,
        maxVramGb: null,
        modelId: "",
      });
      this.#reset();
      this.#emitStatus();
      return this.status();
    });
  }

  async shutdown(): Promise<void> {
    await this.#serialize(async () => {
      await this.#stopOwnedRuntime();
      this.#reset();
    });
  }

  async status(): Promise<MeshNodeStatus> {
    if (!this.#child) return this.#localStatus();
    const payload = await this.#fetchManagementStatus().catch((error) => {
      this.#lastError = safeError(error);
      return null;
    });
    if (payload) this.#updateIdentityFromStatus(payload);
    return this.#localStatus(payload);
  }

  async servingUsage(): Promise<MeshServingUsage> {
    const payload = this.#child
      ? await this.#fetchManagementStatus().catch(() => null)
      : null;
    return usageFromPayload(payload);
  }

  async installedModels(): Promise<MeshModelOption[]> {
    const binary = await this.#installer.find();
    if (!binary) return [];
    const result = await runBounded(
      binary,
      ["models", "installed", "--json"],
      30_000,
      8 * 1024 * 1024,
      this.#runtimeEnvironment(),
    );
    return modelsFromJson(result.stdout);
  }

  async availableModels(): Promise<MeshModelOption[]> {
    if (!this.#child || this.#state !== "running") {
      throw new Error("no Buzz shared compute serving members are available");
    }
    const result = await this.#fetchJson(
      `http://127.0.0.1:${this.#apiPort}/v1/models`,
      3_000,
    );
    return modelsFromJson(JSON.stringify(result));
  }

  async modelCatalog(): Promise<{
    entries: Array<{
      curated: boolean;
      description: string;
      fit: "comfortable" | "tight" | "tradeoff" | "too_large";
      installed: boolean;
      name: string;
      recommended: boolean;
      size: string;
      sizeGb: number;
    }>;
    gpuName: string | null;
    recommended: string | null;
    vramDisplay: string;
    vramGb: number;
  }> {
    const hardware = await hardwareSurvey();
    const installed = await this.installedModels().catch(() => []);
    const binary = await this.#installer.find();
    let source = fallbackCatalog();
    if (binary) {
      try {
        const result = await runBounded(
          binary,
          ["models", "recommended", "--json"],
          30_000,
          8 * 1024 * 1024,
          this.#runtimeEnvironment(),
        );
        const parsed = catalogFromJson(result.stdout);
        if (parsed.length > 0) source = parsed;
      } catch {
        // The built-in fallback keeps model selection usable offline.
      }
    }
    const installedIds = new Set(
      installed.flatMap((model) => [
        canonicalModel(model.id),
        ...(model.name ? [canonicalModel(model.name)] : []),
      ]),
    );
    const recommendedName =
      hardware.vramGb >= 50
        ? "gemma-4-26B-A4B-it-UD-Q4_K_M"
        : "Gemma-4-E4B-it-Q4_K_M";
    const entries = source.map((entry) => ({
      ...entry,
      curated:
        entry.name === "gemma-4-26B-A4B-it-UD-Q4_K_M" ||
        entry.name === "Gemma-4-E4B-it-Q4_K_M",
      fit: modelFit(entry.sizeGb, hardware.vramGb),
      installed: installedIds.has(canonicalModel(entry.name)),
      recommended: entry.name === recommendedName,
    }));
    entries.sort(
      (left, right) =>
        Number(right.recommended) - Number(left.recommended) ||
        Number(right.curated) - Number(left.curated) ||
        fitRank(left.fit) - fitRank(right.fit) ||
        right.sizeGb - left.sizeGb,
    );
    return {
      entries,
      gpuName: hardware.gpuName,
      recommended: entries.some((entry) => entry.name === recommendedName)
        ? recommendedName
        : (entries[0]?.name ?? null),
      vramDisplay: `${hardware.vramGb.toFixed(1)} GB`,
      vramGb: hardware.vramGb,
    };
  }

  #spawnRuntime(binary: string, request: StartRequest): void {
    const command =
      request.mode === "serve"
        ? [
            "serve",
            "--headless",
            "--model",
            request.modelId!,
            "--port",
            String(this.#apiPort),
            "--console",
            String(this.#consolePort),
            "--mesh-name",
            meshName(this.#workspace.relayUrl()),
            ...(request.maxVramGb
              ? ["--max-vram", String(request.maxVramGb)]
              : []),
          ]
        : [
            "client",
            "--headless",
            "--join",
            request.joinToken!,
            "--port",
            String(this.#apiPort),
            "--console",
            String(this.#consolePort),
          ];
    const child = spawn(binary, command, {
      cwd: path.join(this.#dataDirectory, "mesh-llm"),
      env: this.#runtimeEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    this.#stopping = false;
    const onData = (chunk: Buffer) => {
      this.#appendLog(chunk.toString("utf8"));
      this.#captureInviteToken(chunk.toString("utf8"));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (error) => {
      this.#lastError = error.message;
    });
    child.once("exit", (code, signal) => {
      if (this.#child === child) this.#child = null;
      if (!this.#stopping) {
        this.#lastError =
          `Mesh-LLM exited ${signal ? `from ${signal}` : `with code ${code ?? "unknown"}`}` +
          (this.#log ? `: ${this.#log.slice(-2_000)}` : "");
        this.#state = "failed";
        this.#emitStatus();
      }
    });
  }

  async #ensureRuntime(binary: string): Promise<void> {
    try {
      await runBounded(
        binary,
        ["setup", "--no-service", "--no-interactive"],
        15 * 60_000,
        4 * 1024 * 1024,
        this.#runtimeEnvironment(),
      );
    } catch (error) {
      throw new Error(`Mesh-LLM setup failed: ${safeError(error)}`);
    }
  }

  async #waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.#startupTimeoutMs;
    let last = "waiting for the local API";
    while (Date.now() < deadline) {
      if (!this.#child) {
        throw new Error(this.#lastError ?? "Mesh-LLM exited during startup");
      }
      try {
        const [management, models] = await Promise.all([
          this.#fetchManagementStatus(),
          this.#fetchJson(`http://127.0.0.1:${this.#apiPort}/v1/models`, 2_000),
        ]);
        this.#updateIdentityFromStatus(management);
        if (
          typeof models === "object" &&
          models !== null &&
          "data" in models &&
          Array.isArray(models.data)
        ) {
          return;
        }
        last = "the model catalog has not synchronized";
      } catch (error) {
        last = safeError(error);
      }
      await delay(500);
    }
    throw new Error(`Mesh-LLM did not become ready: ${last}`);
  }

  async #fetchManagementStatus(): Promise<Record<string, unknown>> {
    const result = await this.#fetchJson(
      `http://127.0.0.1:${this.#consolePort}/api/status`,
      3_000,
    );
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result)
    ) {
      throw new Error("Mesh-LLM returned an invalid status payload");
    }
    return result as Record<string, unknown>;
  }

  async #fetchJson(url: string, timeoutMs: number): Promise<unknown> {
    const response = await this.#fetch(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      throw new Error(`local mesh API returned ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 8 * 1024 * 1024) {
      throw new Error("local mesh API response exceeds 8 MiB");
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  async #stopOwnedRuntime(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#stopping = true;
    child.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise<boolean>((resolve) =>
        child.once("exit", () => resolve(true)),
      ),
      delay(12_000).then(() => false),
    ]);
    if (!exited) {
      child.kill("SIGKILL");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        delay(2_000),
      ]);
    }
    if (this.#child === child) this.#child = null;
  }

  #runtimeEnvironment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      MESH_LLM_DATA_DIR: path.join(this.#dataDirectory, "mesh-llm"),
      NO_COLOR: "1",
    };
  }

  #updateIdentityFromStatus(payload: Record<string, unknown>): void {
    const token = findString(payload, [
      "inviteToken",
      "invite_token",
      "joinToken",
      "join_token",
    ]);
    if (token && Buffer.byteLength(token, "utf8") <= MAX_TOKEN_BYTES) {
      this.#inviteToken = token;
    }
  }

  #captureInviteToken(output: string): void {
    const match = output.match(
      /(?:invite|join)\s+token(?:\s+is)?\s*[:=]\s*([A-Za-z0-9._~+:/=-]{20,16384})/i,
    );
    if (match?.[1]) this.#inviteToken = match[1];
  }

  #appendLog(value: string): void {
    this.#log = `${this.#log}${value}`.slice(-MAX_PROCESS_LOG_BYTES);
  }

  #localStatus(payload?: Record<string, unknown> | null): MeshNodeStatus {
    const running = this.#child !== null && this.#state === "running";
    const reason = this.#lastError;
    return {
      apiBaseUrl:
        running || this.#state === "starting"
          ? `http://127.0.0.1:${this.#apiPort}/v1`
          : null,
      consoleUrl:
        running || this.#state === "starting"
          ? `http://127.0.0.1:${this.#consolePort}`
          : null,
      deviceId: findString(payload, ["deviceId", "device_id", "node_id"]),
      deviceName: findString(payload, [
        "deviceName",
        "device_name",
        "node_name",
      ]),
      endpointId: findString(payload, ["endpointId", "endpoint_id", "node_id"]),
      health:
        this.#state === "failed"
          ? {
              reason: reason ?? "Mesh-LLM stopped unexpectedly",
              status: "failed",
            }
          : reason
            ? { reason, status: "degraded" }
            : { status: "ok" },
      inviteToken: this.#inviteToken,
      mode: this.#mode,
      modelId:
        this.#modelId ?? findString(payload, ["modelId", "model_id", "model"]),
      modelName:
        this.#modelId ??
        findString(payload, ["modelName", "model_name", "model"]),
      state: this.#state,
    };
  }

  #emitStatus(): void {
    this.#events.emit("mesh-node-status-changed", this.#localStatus());
  }

  #reset(): void {
    this.#child = null;
    this.#inviteToken = null;
    this.#lastError = null;
    this.#mode = null;
    this.#modelId = null;
    this.#state = "off";
    this.#stopping = false;
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function parseStartRequest(value: unknown): StartRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("mesh start request must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.mode !== "serve" && input.mode !== "client") {
    throw new Error("mesh mode must be serve or client");
  }
  const modelId =
    input.modelId === undefined
      ? undefined
      : requireModelId(input.modelId, "modelId");
  const joinToken =
    input.joinToken === undefined ? undefined : requireToken(input.joinToken);
  if (input.mode === "serve" && !modelId) {
    throw new Error("modelId is required for serve mode");
  }
  if (input.mode === "client" && !joinToken) {
    throw new Error("joinToken is required for client mode");
  }
  let maxVramGb: number | undefined;
  if (input.maxVramGb !== undefined) {
    if (
      typeof input.maxVramGb !== "number" ||
      !Number.isFinite(input.maxVramGb) ||
      input.maxVramGb <= 0 ||
      input.maxVramGb > 1_024
    ) {
      throw new Error("maxVramGb must be between 0 and 1024");
    }
    maxVramGb = input.maxVramGb;
  }
  return {
    mode: input.mode,
    ...(joinToken ? { joinToken } : {}),
    ...(maxVramGb ? { maxVramGb } : {}),
    ...(modelId ? { modelId } : {}),
  };
}

function requireModelId(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 1_024 ||
    !MODEL_ID.test(value.trim())
  ) {
    throw new Error(`${name} has an invalid format`);
  }
  return value.trim();
}

function requireToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 20 ||
    Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES ||
    /[\s\0]/.test(value)
  ) {
    throw new Error("joinToken has an invalid format");
  }
  return value;
}

function requirePort(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1_024 || value > 65_535) {
    throw new Error(`${name} must be between 1024 and 65535`);
  }
  return value;
}

function meshName(relayUrl: string): string {
  const url = new URL(relayUrl);
  const digest = createHash("sha256")
    .update(url.origin.toLowerCase())
    .digest("hex");
  return `buzz-community-${digest.slice(0, 32)}`;
}

function usageFromPayload(
  payload: Record<string, unknown> | null,
): MeshServingUsage {
  const routing = objectAt(payload, ["routing_metrics", "routingMetrics"]);
  const local = objectAt(routing, ["local_node", "localNode"]);
  return {
    endpointAttempts: numberAt(local, [
      "endpoint_attempt_count",
      "endpointAttemptCount",
    ]),
    inflight:
      numberAt(local, [
        "current_inflight_requests",
        "currentInflightRequests",
      ]) || numberAt(payload, ["inflight_requests", "inflightRequests"]),
    localAttempts: numberAt(local, [
      "local_attempt_count",
      "localAttemptCount",
    ]),
    peakInflight: numberAt(local, [
      "peak_inflight_requests",
      "peakInflightRequests",
    ]),
    peers: arrayAt(payload, ["peers"]).length,
    remoteAttempts: numberAt(local, [
      "remote_attempt_count",
      "remoteAttemptCount",
    ]),
    requestsServed: numberAt(routing, ["request_count", "requestCount"]),
    tokensPerSecond: numberAt(routing, [
      "avg_tokens_per_second",
      "avgTokensPerSecond",
    ]),
    tokensServed: numberAt(routing, [
      "completion_tokens_observed",
      "completionTokensObserved",
    ]),
  };
}

function modelsFromJson(text: string): MeshModelOption[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Mesh-LLM returned invalid installed-model JSON");
  }
  const result = new Map<string, MeshModelOption>();
  for (const object of collectObjects(parsed)) {
    const id = findString(object, [
      "id",
      "modelId",
      "model_id",
      "modelRef",
      "model_ref",
      "name",
      "path",
    ]);
    if (!id || id.length > 2_048) continue;
    result.set(id, {
      id,
      name: findString(object, ["displayName", "display_name", "name"]),
    });
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function catalogFromJson(text: string): Array<{
  description: string;
  name: string;
  size: string;
  sizeGb: number;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const result = new Map<
    string,
    { description: string; name: string; size: string; sizeGb: number }
  >();
  for (const object of collectObjects(parsed)) {
    const name = findString(object, ["id", "modelId", "model_id", "name"]);
    if (!name || !MODEL_ID.test(name)) continue;
    const sizeText =
      findString(object, ["size", "sizeLabel", "size_label"]) ?? "";
    const sizeGb =
      numberAt(object, ["sizeGb", "size_gb", "gb"]) || parseSizeGb(sizeText);
    if (!(sizeGb > 0 && sizeGb <= 2_000)) continue;
    result.set(name, {
      description:
        findString(object, ["description", "about"]) ??
        "Mesh-LLM catalog model",
      name,
      size: sizeText || `${sizeGb.toFixed(1)}GB`,
      sizeGb,
    });
  }
  return [...result.values()];
}

function fallbackCatalog(): Array<{
  description: string;
  name: string;
  size: string;
  sizeGb: number;
}> {
  return [
    {
      description:
        "Gemma 4 efficient instruction model — Buzz small-machine default",
      name: "Gemma-4-E4B-it-Q4_K_M",
      size: "4.0GB",
      sizeGb: 4,
    },
    {
      description: "Qwen 3 8B instruction model",
      name: "Qwen3-8B-Q4_K_M",
      size: "5.0GB",
      sizeGb: 5,
    },
    {
      description: "Gemma 4 26B MoE — Buzz 64GB+ default",
      name: "gemma-4-26B-A4B-it-UD-Q4_K_M",
      size: "17GB",
      sizeGb: 17,
    },
  ];
}

async function hardwareSurvey(): Promise<{
  gpuName: string | null;
  vramGb: number;
}> {
  if (process.platform === "darwin") {
    const memoryGb = os.totalmem() / 1e9;
    let gpuName: string | null = null;
    try {
      const result = await runBounded(
        "system_profiler",
        ["SPDisplaysDataType", "-json"],
        10_000,
        2 * 1024 * 1024,
        process.env,
      );
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
      const display = collectObjects(parsed).find((entry) =>
        findString(entry, ["sppci_model", "_name"]),
      );
      gpuName = display ? findString(display, ["sppci_model", "_name"]) : null;
    } catch {
      // Unified memory is still accurately available from os.totalmem().
    }
    return { gpuName, vramGb: memoryGb };
  }
  try {
    const result = await runBounded(
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
      5_000,
      64 * 1024,
      process.env,
    );
    const [line] = result.stdout.trim().split(/\r?\n/);
    const match = line?.match(/^(.+),\s*([0-9.]+)$/);
    if (match) {
      return {
        gpuName: match[1]!.trim(),
        vramGb: (Number(match[2]) * 1024 * 1024) / 1e9,
      };
    }
  } catch {
    // CPU/unified-memory fallback.
  }
  return { gpuName: null, vramGb: os.totalmem() / 1e9 };
}

function modelFit(
  modelGb: number,
  vramGb: number,
): "comfortable" | "tight" | "tradeoff" | "too_large" {
  if (modelGb <= vramGb * 0.6) return "comfortable";
  if (modelGb <= vramGb * 0.9) return "tight";
  if (modelGb <= vramGb * 1.1) return "tradeoff";
  return "too_large";
}

function fitRank(value: ReturnType<typeof modelFit>): number {
  return ["comfortable", "tight", "tradeoff", "too_large"].indexOf(value);
}

function parseSizeGb(value: string): number {
  const match = value.match(/([0-9]+(?:\.[0-9]+)?)\s*(GB|GiB)/i);
  return match ? Number(match[1]) : 0;
}

function canonicalModel(value: string): string {
  return value
    .trim()
    .replace(/@main$/i, "")
    .toLowerCase();
}

function collectObjects(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectObjects(entry, depth + 1));
  }
  const object = value as Record<string, unknown>;
  return [
    object,
    ...Object.values(object).flatMap((entry) =>
      collectObjects(entry, depth + 1),
    ),
  ];
}

function findString(
  object: Record<string, unknown> | null | undefined,
  names: readonly string[],
): string | null {
  if (!object) return null;
  for (const name of names) {
    const value = object[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const nestedName of ["node", "identity", "mesh", "runtime", "status"]) {
    const nested = object[nestedName];
    if (
      typeof nested === "object" &&
      nested !== null &&
      !Array.isArray(nested)
    ) {
      const found = findString(nested as Record<string, unknown>, names);
      if (found) return found;
    }
  }
  return null;
}

function objectAt(
  object: Record<string, unknown> | null,
  names: readonly string[],
): Record<string, unknown> | null {
  if (!object) return null;
  for (const name of names) {
    const value = object[name];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

function arrayAt(
  object: Record<string, unknown> | null,
  names: readonly string[],
): unknown[] {
  if (!object) return [];
  for (const name of names) {
    if (Array.isArray(object[name])) return object[name] as unknown[];
  }
  return [];
}

function numberAt(
  object: Record<string, unknown> | null,
  names: readonly string[],
): number {
  if (!object) return 0;
  for (const name of names) {
    const value = object[name];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return 0;
}

async function runBounded(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  maximumBytes: number,
  env: NodeJS.ProcessEnv,
): Promise<{ stderr: string; stdout: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(error);
    };
    const append = (current: Buffer, chunk: Buffer): Buffer => {
      const next = Buffer.concat([current, chunk]);
      if (next.byteLength > maximumBytes) {
        fail(new Error("mesh command output exceeded its safety limit"));
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(
      () => fail(new Error("mesh command timed out")),
      timeoutMs,
    );
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(
          new Error(
            `mesh command exited ${signal ?? code}: ${stderr.toString("utf8").slice(-2_000)}`,
          ),
        );
      } else {
        resolve({
          stderr: stderr.toString("utf8"),
          stdout: stdout.toString("utf8"),
        });
      }
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
