import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AcpProcessClient } from "@buzz/acp";

import type { IdentityService } from "./identity.js";
import { PRESET_RUNTIME_IDS } from "./runtime-presets.js";

const STORE_KEY = "custom-harnesses.v1";
const HARNESS_ID = /^[a-z0-9_][a-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const PROVIDER_BINARY = /^buzz-backend-([a-z0-9][a-z0-9_-]{0,63})(?:\.exe)?$/i;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const RESERVED_ENV = new Set([
  "BUZZ_PRIVATE_KEY",
  "BUZZ_AUTH_TAG",
  "BUZZ_ACP_AGENT_OWNER",
  "BUZZ_ACP_RESPOND_TO",
  "BUZZ_ACP_RESPOND_TO_ALLOWLIST",
  "BUZZ_REMOTE_TOKEN",
  "BUZZ_REMOTE_WORKER_PRIVATE_KEY",
  "NOSTR_PRIVATE_KEY",
]);

type Source = "builtin" | "preset" | "custom";
type Availability =
  | "available"
  | "adapter_missing"
  | "adapter_outdated"
  | "cli_missing"
  | "not_installed";

type AuthStatus =
  | { status: "logged_in" }
  | { status: "logged_out" }
  | { status: "config_invalid"; diagnostic: string }
  | { status: "not_applicable" }
  | { status: "unknown" };

type HarnessDefinition = {
  args: string[];
  command: string;
  env: Record<string, string>;
  id: string;
  installHint: string;
  installInstructionsUrl: string;
  label: string;
};

export type RuntimeDefinition = HarnessDefinition & {
  adapterPackage?: string;
  avatarUrl: string;
  commands: string[];
  mcpCommand: string | null;
  modelEnvVar: string | null;
  providerEnvVar: string | null;
  source: Source;
  thinkingEnvVar: string | null;
  underlyingCli: string | null;
};

export type RuntimeCatalogEntry = {
  auth_status: AuthStatus;
  availability: Availability;
  avatar_url: string;
  binary_path: string | null;
  can_auto_install: boolean;
  command: string | null;
  default_args: string[];
  definition_env?: Record<string, string>;
  id: string;
  install_hint: string;
  install_instructions_url: string;
  label: string;
  login_hint?: string;
  mcp_command: string | null;
  model_env_var: string | null;
  node_required: boolean;
  provider_env_var: string | null;
  requires_external_cli: boolean;
  source: Source;
  thinking_env_var: string | null;
  underlying_cli_path: string | null;
};

type AuthMethod = {
  _meta?: unknown;
  args: string[];
  command: string[];
  description: string | null;
  id: string;
  name: string;
  type: string | null;
};

const BUILT_INS: readonly RuntimeDefinition[] = [
  {
    args: ["acp"],
    avatarUrl: "https://goose-docs.ai/img/logo_dark.png",
    command: "goose",
    commands: ["goose"],
    env: { GOOSE_MODE: "auto" },
    id: "goose",
    installHint: "Buzz talks to Goose through the Goose CLI.",
    installInstructionsUrl:
      "https://goose-docs.ai/docs/getting-started/installation/",
    label: "Goose",
    mcpCommand: null,
    modelEnvVar: "GOOSE_MODEL",
    providerEnvVar: "GOOSE_PROVIDER",
    source: "builtin",
    thinkingEnvVar: "GOOSE_THINKING_EFFORT",
    underlyingCli: "goose",
  },
  {
    adapterPackage: "@agentclientprotocol/claude-agent-acp",
    args: [],
    avatarUrl:
      "https://raw.githubusercontent.com/anthropics/claude-code/main/assets/claude-code-logo.png",
    command: "claude-agent-acp",
    commands: ["claude-agent-acp", "claude-code-acp"],
    env: {},
    id: "claude",
    installHint:
      "Install Claude Code, then install the ACP adapter with npm install -g @agentclientprotocol/claude-agent-acp.",
    installInstructionsUrl: "https://code.claude.com/docs/en/getting-started",
    label: "Claude Code",
    mcpCommand: null,
    modelEnvVar: null,
    providerEnvVar: null,
    source: "builtin",
    thinkingEnvVar: null,
    underlyingCli: "claude",
  },
  {
    adapterPackage: "@agentclientprotocol/codex-acp",
    args: [],
    avatarUrl: "https://developers.openai.com/favicon.ico",
    command: "codex-acp",
    commands: ["codex-acp"],
    env: {},
    id: "codex",
    installHint:
      "Install Codex, then install the ACP adapter with npm install -g @agentclientprotocol/codex-acp.",
    installInstructionsUrl: "https://developers.openai.com/codex/cli/",
    label: "Codex",
    mcpCommand: "buzz-dev-mcp",
    modelEnvVar: null,
    providerEnvVar: null,
    source: "builtin",
    thinkingEnvVar: null,
    underlyingCli: "codex",
  },
  {
    args: [],
    avatarUrl:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Crect width='128' height='128' rx='28' fill='%23111419'/%3E%3Cpath d='M34 80V48l30-18 30 18v32L64 98z' fill='%23f6c344'/%3E%3Ccircle cx='53' cy='61' r='6' fill='%23111419'/%3E%3Ccircle cx='75' cy='61' r='6' fill='%23111419'/%3E%3Cpath d='M50 77h28' stroke='%23111419' stroke-width='7' stroke-linecap='round'/%3E%3C/svg%3E",
    command: "buzz-agent",
    commands: ["buzz-agent"],
    env: {},
    id: "buzz-agent",
    installHint: "Ships with the Buzz TypeScript desktop app.",
    installInstructionsUrl: "https://github.com/block/buzz",
    label: "Buzz Agent",
    mcpCommand: "buzz-dev-mcp",
    modelEnvVar: "BUZZ_AGENT_MODEL",
    providerEnvVar: "BUZZ_AGENT_PROVIDER",
    source: "builtin",
    thinkingEnvVar: "BUZZ_AGENT_THINKING_EFFORT",
    underlyingCli: null,
  },
] as const;

const PRESETS: readonly RuntimeDefinition[] = [
  preset(
    "cursor",
    "Cursor",
    "cursor-agent",
    ["acp"],
    "https://cursor.com/downloads",
    "Buzz talks to Cursor through cursor-agent ACP mode.",
  ),
  preset(
    "omp",
    "Oh My Pi",
    "omp",
    ["acp"],
    "https://github.com/can1357/oh-my-pi",
    "Buzz talks to Oh My Pi through omp acp.",
  ),
  preset(
    "grok",
    "Grok Build",
    "grok",
    ["agent", "--always-approve", "stdio"],
    "https://build.x.ai/docs",
    "Buzz talks to Grok Build through its agent stdio mode.",
  ),
  preset(
    "opencode",
    "OpenCode",
    "opencode",
    ["acp"],
    "https://opencode.ai/docs",
    "Buzz talks to OpenCode through opencode acp.",
  ),
  preset(
    "kimi",
    "Kimi Code",
    "kimi",
    ["acp"],
    "https://kimi.ai/download",
    "Buzz talks to Kimi Code through kimi acp.",
  ),
  {
    ...preset(
      "amp",
      "Amp",
      "amp-acp",
      [],
      "https://github.com/tao12345666333/amp-acp",
      "Buzz talks to Amp through the amp-acp adapter.",
    ),
    underlyingCli: "amp",
  },
  preset(
    "hermes",
    "Hermes Agent",
    "hermes-acp",
    [],
    "https://hermes-agent.nousresearch.com",
    "Buzz talks to Hermes Agent through hermes-acp.",
  ),
  preset(
    "openclaw",
    "OpenClaw",
    "openclaw",
    ["acp"],
    "https://docs.openclaw.ai/start/getting-started",
    "Buzz talks to OpenClaw through openclaw acp. Configure credentials in the OpenClaw Gateway environment as well.",
  ),
] as const;

if (
  PRESETS.length !== PRESET_RUNTIME_IDS.length ||
  PRESETS.some(
    (definition, index) => definition.id !== PRESET_RUNTIME_IDS[index],
  )
) {
  throw new Error("desktop runtime preset definitions are out of sync");
}

const RESERVED_IDS = new Set(
  [...BUILT_INS, ...PRESETS].map((definition) => definition.id),
);

export class RuntimeCatalogService {
  readonly #identity: IdentityService;
  readonly #authMethods = new Map<string, AuthMethod[]>();
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(identity: IdentityService) {
    this.#identity = identity;
  }

  async discover(): Promise<RuntimeCatalogEntry[]> {
    const definitions = [
      ...BUILT_INS,
      ...PRESETS,
      ...this.#customDefinitions().map(toCustomRuntime),
    ];
    return Promise.all(
      definitions.map((definition) => this.#entry(definition)),
    );
  }

  async save(
    definitionValue: unknown,
    originalIdValue?: unknown,
  ): Promise<RuntimeCatalogEntry> {
    const definition = parseHarnessDefinition(definitionValue);
    if (RESERVED_IDS.has(definition.id)) {
      throw new Error(
        `id "${definition.id}" is reserved for a built-in harness`,
      );
    }
    const originalId = parseOptionalHarnessId(originalIdValue);
    if (originalId && RESERVED_IDS.has(originalId)) {
      throw new Error(`originalId "${originalId}" is a built-in harness`);
    }
    const existing = this.#customDefinitions().filter(
      (item) => item.id !== originalId && item.id !== definition.id,
    );
    await this.#saveDefinitions([...existing, definition]);
    return this.#entry(toCustomRuntime(definition));
  }

  async remove(idValue: unknown): Promise<void> {
    const id = requireHarnessId(idValue, "id");
    if (RESERVED_IDS.has(id)) {
      throw new Error(`harness "${id}" is built-in and cannot be deleted`);
    }
    await this.#saveDefinitions(
      this.#customDefinitions().filter((definition) => definition.id !== id),
    );
    this.#authMethods.delete(id);
  }

  async install(runtimeIdValue: unknown): Promise<Record<string, unknown>> {
    const runtimeId = requireHarnessId(runtimeIdValue, "runtimeId");
    const definition = [...BUILT_INS].find((item) => item.id === runtimeId);
    if (!definition) {
      throw new Error("only built-in runtimes have automated install recipes");
    }
    const current = await this.#entry(definition);
    if (current.availability === "available") {
      return {
        failed_restart_count: 0,
        restarted_count: 0,
        steps: [],
        success: true,
      };
    }
    if (!definition.adapterPackage || current.availability === "cli_missing") {
      return installFailure(
        "manual installation required",
        definition.installHint,
      );
    }
    const npm = await findExecutable("npm");
    if (!npm) {
      return installFailure(
        "install ACP adapter",
        "Node.js and npm are required. Install them, then retry.",
      );
    }
    const result = await runBounded(
      npm,
      ["install", "--global", definition.adapterPackage],
      { stdin: null, timeoutMs: 120_000 },
    );
    return {
      failed_restart_count: 0,
      restarted_count: 0,
      steps: [
        {
          command: `npm install --global ${definition.adapterPackage}`,
          exit_code: result.exitCode,
          stderr: result.stderr,
          stdout: result.stdout,
          step: "install ACP adapter",
          success: result.exitCode === 0,
          ...(result.exitCode === 0
            ? {}
            : {
                hint: "Check npm permissions and network access, then retry.",
              }),
        },
      ],
      success: result.exitCode === 0,
    };
  }

  async prerequisites(inputValue: unknown): Promise<Record<string, unknown>> {
    const input = requireObject(inputValue, "input");
    const acpCommand =
      optionalString(input.acpCommand, "acpCommand", 1_024) ?? "buzz-acp";
    const mcpCommand =
      optionalString(input.mcpCommand, "mcpCommand", 1_024) ?? "";
    return {
      acp: await commandAvailability(acpCommand, true),
      mcp: await commandAvailability(mcpCommand, false),
    };
  }

  async gitBashPrerequisite(): Promise<Record<string, unknown> | null> {
    if (process.platform !== "win32") return null;
    const resolved = await findExecutable("bash");
    return {
      available: resolved !== null,
      install_hint:
        "Install Git for Windows so Buzz can launch development tools.",
      install_instructions_url: "https://git-scm.com/download/win",
      path: resolved,
    };
  }

  async discoverAuthMethods(
    runtimeIdValue: unknown,
  ): Promise<{ methods: AuthMethod[] }> {
    const runtimeId = requireHarnessId(runtimeIdValue, "runtimeId");
    const resolved = await this.#resolveAvailable(runtimeId);
    if (runtimeId === "buzz-agent" || runtimeId === "goose") {
      this.#authMethods.set(runtimeId, []);
      return { methods: [] };
    }
    const client = new AcpProcessClient({
      args: resolved.definition.args,
      command: resolved.binaryPath,
      cwd: os.homedir(),
      environment: resolved.definition.env,
      inheritEnvironment: true,
      requestTimeoutMilliseconds: 15_000,
    });
    try {
      const initialized = await client.start();
      const raw = (initialized as { authMethods?: unknown }).authMethods;
      const methods = parseAuthMethods(raw);
      this.#authMethods.set(runtimeId, methods);
      return { methods: structuredClone(methods) };
    } finally {
      await client.shutdown().catch(() => undefined);
    }
  }

  async connectAuth(requestValue: unknown): Promise<{ launched: boolean }> {
    const request = requireObject(requestValue, "request");
    const runtimeId = requireHarnessId(request.runtimeId, "runtimeId");
    const methodId = requireString(request.methodId, "methodId", 256);
    const advertised =
      this.#authMethods.get(runtimeId) ??
      (await this.discoverAuthMethods(runtimeId)).methods;
    const method = advertised.find((item) => item.id === methodId);
    if (!method) {
      throw new Error("auth method is no longer advertised by this adapter");
    }
    if (method.type === "terminal") {
      throw new Error(
        "this adapter requires an interactive terminal login; run its documented login command, then refresh",
      );
    }
    const resolved = await this.#resolveAvailable(runtimeId);
    const client = new AcpProcessClient({
      args: resolved.definition.args,
      command: resolved.binaryPath,
      cwd: os.homedir(),
      environment: resolved.definition.env,
      inheritEnvironment: true,
      requestTimeoutMilliseconds: 60_000,
    });
    try {
      await client.start();
      await client.authenticate(method.id);
      return { launched: true };
    } finally {
      await client.shutdown().catch(() => undefined);
    }
  }

  async runtimeFileConfig(
    runtimeIdValue: unknown,
  ): Promise<Record<string, unknown> | null> {
    const runtimeId = requireHarnessId(runtimeIdValue, "runtimeId");
    if (runtimeId !== "goose") return null;
    const configPath = path.join(
      os.homedir(),
      ".config",
      "goose",
      "config.yaml",
    );
    let raw: string;
    try {
      const { readFile } = await import("node:fs/promises");
      raw = await readFile(configPath, "utf8");
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
    if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) {
      throw new Error("Goose config exceeds the 1 MiB limit");
    }
    const values = parseSimpleYamlScalars(raw);
    const provider =
      values.get("GOOSE_PROVIDER") ?? values.get("provider") ?? null;
    const model = values.get("GOOSE_MODEL") ?? values.get("model") ?? null;
    const satisfiedEnvKeys = [...values.entries()]
      .filter(([key, value]) => ENV_NAME.test(key) && value.trim() !== "")
      .map(([key]) => key)
      .sort();
    return { model, provider, satisfiedEnvKeys };
  }

  async discoverBackendProviders(): Promise<
    Array<{ binaryPath: string; id: string }>
  > {
    const candidates = await providerCandidates();
    return [...candidates.entries()]
      .map(([binaryPath, id]) => ({ binaryPath, id }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async probeBackendProvider(
    binaryPathValue: unknown,
  ): Promise<Record<string, unknown>> {
    const binaryPath = requireString(binaryPathValue, "binaryPath", 4_096);
    const canonical = await realpath(binaryPath).catch(() => null);
    if (!canonical) throw new Error(`binary not found: ${binaryPath}`);
    const candidates = await providerCandidates();
    if (!candidates.has(canonical)) {
      throw new Error(
        `binary "${binaryPath}" is not a discovered buzz-backend-* provider`,
      );
    }
    const response = await runBounded(canonical, [], {
      stdin: `${JSON.stringify({ op: "info", request_id: randomUUID() })}\n`,
      timeoutMs: 10_000,
    });
    if (response.exitCode !== 0) {
      throw new Error(
        `provider probe failed (exit ${response.exitCode ?? -1}): ${response.stderr || "no diagnostic"}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.stdout);
    } catch {
      throw new Error("provider returned invalid JSON");
    }
    const result = requireObject(parsed, "provider response");
    if (typeof result.ok !== "boolean") {
      throw new Error("provider response is missing a boolean ok field");
    }
    return structuredClone(result);
  }

  definitionForCommand(command: string): RuntimeDefinition | null {
    const normalized = path
      .basename(command)
      .toLowerCase()
      .replace(/\.exe$/, "");
    const definition = [
      ...BUILT_INS,
      ...PRESETS,
      ...this.#customDefinitions().map(toCustomRuntime),
    ].find(
      (item) =>
        item.id === command ||
        item.commands.some(
          (candidate) =>
            path
              .basename(candidate)
              .toLowerCase()
              .replace(/\.exe$/, "") === normalized,
        ),
    );
    return definition ? structuredClone(definition) : null;
  }

  async #resolveAvailable(runtimeId: string): Promise<{
    binaryPath: string;
    definition: RuntimeDefinition;
  }> {
    const definition = [
      ...BUILT_INS,
      ...PRESETS,
      ...this.#customDefinitions().map(toCustomRuntime),
    ].find((item) => item.id === runtimeId);
    if (!definition) throw new Error(`unknown ACP runtime: ${runtimeId}`);
    const entry = await this.#entry(definition);
    if (entry.availability !== "available" || !entry.binary_path) {
      throw new Error(
        `${definition.label} is not available (${entry.availability})`,
      );
    }
    return { binaryPath: entry.binary_path, definition };
  }

  async #entry(definition: RuntimeDefinition): Promise<RuntimeCatalogEntry> {
    const builtInAgent = definition.id === "buzz-agent";
    const adapterPath = builtInAgent
      ? process.execPath
      : await firstExecutable(definition.commands);
    const underlyingPath = definition.underlyingCli
      ? await findExecutable(definition.underlyingCli)
      : null;
    let availability: Availability;
    if (definition.underlyingCli && !underlyingPath) {
      availability = "cli_missing";
    } else if (definition.adapterPackage && !adapterPath) {
      availability = "adapter_missing";
    } else if (!adapterPath) {
      availability = "not_installed";
    } else {
      availability = "available";
    }
    const npmAvailable =
      definition.adapterPackage === undefined ||
      (await findExecutable("npm")) !== null;
    return {
      auth_status:
        definition.underlyingCli && availability === "available"
          ? { status: "unknown" }
          : { status: "not_applicable" },
      availability,
      avatar_url: definition.avatarUrl,
      binary_path: adapterPath,
      can_auto_install:
        availability === "adapter_missing" &&
        underlyingPath !== null &&
        npmAvailable,
      command: adapterPath ? definition.command : null,
      default_args: [...definition.args],
      ...(definition.source === "custom"
        ? { definition_env: structuredClone(definition.env) }
        : {}),
      id: definition.id,
      install_hint: definition.installHint,
      install_instructions_url: definition.installInstructionsUrl,
      label: definition.label,
      ...(definition.id === "claude"
        ? { login_hint: "Run the Claude CLI to complete authentication." }
        : definition.id === "codex"
          ? { login_hint: "Run codex login to authenticate." }
          : {}),
      mcp_command: definition.mcpCommand,
      model_env_var: definition.modelEnvVar,
      node_required:
        availability === "adapter_missing" &&
        definition.adapterPackage !== undefined &&
        !npmAvailable,
      provider_env_var: definition.providerEnvVar,
      requires_external_cli: definition.underlyingCli !== null,
      source: definition.source,
      thinking_env_var: definition.thinkingEnvVar,
      underlying_cli_path: underlyingPath,
    };
  }

  #customDefinitions(): HarnessDefinition[] {
    const raw = this.#identity.setting<unknown>(STORE_KEY, []);
    if (!Array.isArray(raw)) throw new Error("custom harness store is corrupt");
    return raw.map(parseHarnessDefinition);
  }

  async #saveDefinitions(definitions: HarnessDefinition[]): Promise<void> {
    const operation = this.#writeQueue.then(() =>
      this.#identity.setSetting(STORE_KEY, definitions),
    );
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
  }
}

function preset(
  id: string,
  label: string,
  command: string,
  args: string[],
  installInstructionsUrl: string,
  installHint: string,
): RuntimeDefinition {
  return {
    args,
    avatarUrl: "",
    command,
    commands: [command],
    env: {},
    id,
    installHint,
    installInstructionsUrl,
    label,
    mcpCommand: null,
    modelEnvVar: null,
    providerEnvVar: null,
    source: "preset",
    thinkingEnvVar: null,
    underlyingCli: null,
  };
}

function toCustomRuntime(definition: HarnessDefinition): RuntimeDefinition {
  return {
    ...definition,
    avatarUrl: "",
    commands: [definition.command],
    mcpCommand: null,
    modelEnvVar: null,
    providerEnvVar: null,
    source: "custom",
    thinkingEnvVar: null,
    underlyingCli: null,
  };
}

function parseHarnessDefinition(value: unknown): HarnessDefinition {
  const input = requireObject(value, "definition");
  const id = requireHarnessId(input.id, "id");
  const label = requireString(input.label, "label", 256).trim();
  const command = requireString(input.command, "command", 4_096).trim();
  if (!label || !command)
    throw new Error("label and command must not be empty");
  if (command.includes("\0"))
    throw new Error("command may not contain NUL bytes");
  const args = parseArgs(input.args);
  const env = parseEnvironment(input.env);
  const installInstructionsUrl =
    optionalString(
      input.installInstructionsUrl,
      "installInstructionsUrl",
      4_096,
    ) ?? "";
  if (installInstructionsUrl) {
    const parsed = new URL(installInstructionsUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("installInstructionsUrl must use https or http");
    }
  }
  return {
    args,
    command,
    env,
    id,
    installHint: optionalString(input.installHint, "installHint", 8_192) ?? "",
    installInstructionsUrl,
    label,
  };
}

function parseArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error("args must contain at most 128 strings");
  }
  return value.map((item, index) => {
    const arg = requireString(item, `args[${index}]`, 16 * 1024);
    if (arg.includes("\0") || arg.includes(",")) {
      throw new Error("args may not contain commas or NUL bytes");
    }
    return arg;
  });
}

function parseEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const input = requireObject(value, "env");
  if (Object.keys(input).length > 256) throw new Error("env has too many keys");
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!ENV_NAME.test(key) || RESERVED_ENV.has(key)) {
      throw new Error(`env key "${key}" is invalid or reserved`);
    }
    output[key] = requireString(raw, `env.${key}`, 64 * 1024);
  }
  return output;
}

async function commandAvailability(
  command: string,
  builtInAcp: boolean,
): Promise<Record<string, unknown>> {
  if (command === "") {
    return { available: true, command, resolved_path: null };
  }
  if (builtInAcp && ["buzz-acp", "buzz-acp-ts"].includes(command)) {
    return { available: true, command, resolved_path: process.execPath };
  }
  const resolved = await findExecutable(command);
  return { available: resolved !== null, command, resolved_path: resolved };
}

async function firstExecutable(
  commands: readonly string[],
): Promise<string | null> {
  for (const command of commands) {
    const resolved = await findExecutable(command);
    if (resolved) return resolved;
  }
  return null;
}

async function findExecutable(command: string): Promise<string | null> {
  if (!command || command.includes("\0")) return null;
  const hasPath =
    path.isAbsolute(command) || command.includes("/") || command.includes("\\");
  const candidates = hasPath
    ? [path.resolve(command)]
    : pathDirectories().flatMap((directory) =>
        process.platform === "win32"
          ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`].map(
              (name) => path.join(directory, name),
            )
          : [path.join(directory, command)],
      );
  for (const candidate of candidates) {
    try {
      await access(candidate, process.platform === "win32" ? 0 : 1);
      const metadata = await stat(candidate);
      if (!metadata.isFile()) continue;
      // Deliberately not resolved through realpath. Version managers install
      // multi-call launchers — Hermit, asdf, Volta — that dispatch on argv[0],
      // so collapsing `bin/npm` to `bin/hermit` makes the launcher parse the
      // tool's own arguments and fail with something like
      // `hermit: error: unknown flag --global`.
      return path.resolve(candidate);
    } catch {
      // Continue through the deterministic candidate list.
    }
  }
  return null;
}

function pathDirectories(): string[] {
  const values = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  const extras =
    process.platform === "win32"
      ? []
      : [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          path.join(os.homedir(), ".local", "bin"),
          path.join(os.homedir(), ".volta", "bin"),
        ];
  return [...new Set([...values, ...extras])];
}

async function providerCandidates(): Promise<Map<string, string>> {
  const candidates = new Map<string, string>();
  for (const directory of pathDirectories()) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = PROVIDER_BINARY.exec(name);
      if (!match?.[1]) continue;
      const found = await findExecutable(path.join(directory, name));
      // Canonicalised deliberately: this map is the allowlist
      // `probeBackendProvider` checks a caller-supplied path against, so two
      // names for one binary must collapse to a single entry. `findExecutable`
      // itself must not canonicalise — see the note there about argv[0].
      const resolved = found ? await realpath(found).catch(() => found) : null;
      if (resolved && !candidates.has(resolved)) {
        candidates.set(resolved, match[1].toLowerCase());
      }
    }
  }
  return candidates;
}

async function runBounded(
  executable: string,
  args: readonly string[],
  options: { stdin: string | null; timeoutMs: number },
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let overflow = false;
    const capture = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      if (current.byteLength + chunk.byteLength > MAX_CAPTURE_BYTES) {
        overflow = true;
        return Buffer.concat([current, chunk]).subarray(0, MAX_CAPTURE_BYTES);
      }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stdout = capture(stdout, chunk);
      if (overflow) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      stderr = capture(stderr, chunk);
      if (overflow) child.kill("SIGKILL");
    });
    child.once("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    timer.unref();
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (overflow) {
        reject(new Error("child process output exceeded the 1 MiB limit"));
        return;
      }
      resolve({
        exitCode,
        stderr: stderr.toString("utf8").trim().slice(0, MAX_CAPTURE_BYTES),
        stdout: stdout.toString("utf8").trim().slice(0, MAX_CAPTURE_BYTES),
      });
    });
    if (options.stdin === null) child.stdin.end();
    else child.stdin.end(options.stdin);
  });
}

function parseAuthMethods(value: unknown): AuthMethod[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("adapter returned invalid auth methods");
  }
  return value.map((item, index) => {
    const input = requireObject(item, `authMethods[${index}]`);
    const meta = input._meta;
    const metaObject =
      typeof meta === "object" && meta !== null && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)
        : {};
    const terminal = metaObject["terminal-auth"];
    const terminalObject =
      typeof terminal === "object" &&
      terminal !== null &&
      !Array.isArray(terminal)
        ? (terminal as Record<string, unknown>)
        : {};
    return {
      ...(meta === undefined ? {} : { _meta: structuredClone(meta) }),
      args: parseStringArray(input.args, "args"),
      command: parseStringArray(
        input.command ?? terminalObject.command,
        "command",
      ),
      description:
        optionalString(input.description, "description", 4_096) ?? null,
      id: requireString(input.id, "id", 256),
      name: requireString(input.name, "name", 256),
      type: optionalString(input.type, "type", 64) ?? null,
    };
  });
}

function parseStringArray(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error(`${name} must be a bounded string array`);
  }
  return value.map((item, index) =>
    requireString(item, `${name}[${index}]`, 4_096),
  );
}

function parseSimpleYamlScalars(raw: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (
      !match?.[1] ||
      match[2] === undefined ||
      match[2].startsWith("|") ||
      match[2].startsWith(">")
    ) {
      continue;
    }
    let value = match[2].replace(/\s+#.*$/, "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value && value !== "null" && value !== "~") values.set(match[1], value);
  }
  return values;
}

function installFailure(step: string, hint: string): Record<string, unknown> {
  return {
    failed_restart_count: 0,
    restarted_count: 0,
    steps: [
      {
        command: "",
        exit_code: null,
        hint,
        stderr: "",
        stdout: "",
        step,
        success: false,
      },
    ],
    success: false,
  };
}

function requireHarnessId(value: unknown, name: string): string {
  const id = requireString(value, name, 64).trim().toLowerCase();
  if (!HARNESS_ID.test(id)) throw new Error(`${name} has an invalid format`);
  return id;
}

function parseOptionalHarnessId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireHarnessId(value, "originalId");
}

function optionalString(
  value: unknown,
  name: string,
  maxBytes: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireString(value, name, maxBytes);
}

function requireString(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${name} exceeds its size limit`);
  }
  return value;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
