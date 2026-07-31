import { access, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AcpProcessClient } from "@buzz/acp";

import type { LocalEntityService } from "./local-entities.js";
import type { ManagedAgentService } from "./managed-agents.js";
import type { MeshComputeService } from "./mesh-compute.js";
import type {
  RuntimeCatalogEntry,
  RuntimeCatalogService,
} from "./runtime-catalog.js";

const BUILT_IN_AGENT_CLI = fileURLToPath(
  import.meta.resolve("@buzz/agent/cli"),
);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const RESERVED_ENV = new Set([
  "BUZZ_ACP_AGENT_OWNER",
  "BUZZ_ACP_RESPOND_TO",
  "BUZZ_ACP_RESPOND_TO_ALLOWLIST",
  "BUZZ_AUTH_TAG",
  "BUZZ_PRIVATE_KEY",
  "BUZZ_REMOTE_TOKEN",
  "BUZZ_REMOTE_WORKER_PRIVATE_KEY",
  "HOME",
  "NOSTR_PRIVATE_KEY",
  "PATH",
]);
const OPENAI_NON_TEXT_MARKERS = [
  "audio",
  "dall-e",
  "embedding",
  "image",
  "moderation",
  "realtime",
  "speech",
  "transcribe",
  "tts",
  "whisper",
] as const;

export type AgentModelInfo = {
  description: string | null;
  id: string;
  name: string | null;
};

export type AgentModelsResponse = {
  agentDefaultModel: string | null;
  agentName: string;
  agentVersion: string;
  models: AgentModelInfo[];
  selectedModel: string | null;
  supportsSwitching: boolean;
};

type DiscoveryInput = {
  acpCommand: string | null;
  agentArgs: string[] | null;
  agentCommand: string;
  definitionEnv: Record<string, string>;
  envVars: Record<string, string>;
  provider: string | null;
};

type DiscoveryConfig = {
  agentArgs: string[];
  agentCommand: string;
  environment: Record<string, string>;
  provider: DiscoveryProvider;
  selectedModel: string | null;
};

type DiscoveryProvider = {
  inferred: boolean;
  value: string | null;
};

export class AgentModelService {
  readonly #fetch: typeof fetch;
  readonly #localEntities: LocalEntityService;
  readonly #managedAgents: ManagedAgentService;
  readonly #mesh: MeshComputeService;
  readonly #runtimeCatalog: RuntimeCatalogService;

  constructor(input: {
    localEntities: LocalEntityService;
    managedAgents: ManagedAgentService;
    mesh: MeshComputeService;
    runtimeCatalog: RuntimeCatalogService;
    fetch?: typeof fetch;
  }) {
    this.#fetch = input.fetch ?? fetch;
    this.#localEntities = input.localEntities;
    this.#managedAgents = input.managedAgents;
    this.#mesh = input.mesh;
    this.#runtimeCatalog = input.runtimeCatalog;
  }

  async discover(args: Record<string, unknown>): Promise<AgentModelsResponse> {
    const input = parseDiscoveryInput(args.input);
    const definition = this.#runtimeCatalog.definitionForCommand(
      input.agentCommand,
    );
    const environment = mergeEnvironment(
      definition?.env ?? {},
      input.definitionEnv,
      input.envVars,
    );
    const provider = effectiveProvider(
      input.provider,
      definition?.providerEnvVar ?? null,
      environment,
    );
    return this.#discover({
      agentArgs: input.agentArgs ?? definition?.args ?? [],
      agentCommand: definition?.command ?? input.agentCommand,
      environment,
      provider,
      selectedModel: null,
    });
  }

  async get(pubkeyValue: unknown): Promise<AgentModelsResponse> {
    const pubkey = requirePubkey(pubkeyValue);
    const summary = this.#managedAgents
      .list()
      .find((entry) => entry.pubkey === pubkey);
    if (!summary) throw new Error(`agent ${pubkey} not found`);
    const personaId =
      typeof summary.persona_id === "string" ? summary.persona_id : null;
    const persona = personaId
      ? this.#localEntities.personas().find((entry) => entry.id === personaId)
      : undefined;
    if (personaId && !persona) {
      throw new Error(
        `cannot discover models for ${pubkey}: its linked persona is missing`,
      );
    }
    const storedCommand = requireText(
      summary.agent_command,
      "agent command",
      1_024,
    );
    const override =
      typeof summary.agent_command_override === "string" &&
      summary.agent_command_override.trim()
        ? summary.agent_command_override.trim()
        : null;
    const personaRuntime = persona?.runtime?.trim() || null;
    const commandReference = override ?? personaRuntime ?? storedCommand;
    const definition =
      this.#runtimeCatalog.definitionForCommand(commandReference);
    if (personaRuntime && !definition && !override) {
      throw new Error(
        `cannot discover models for ${pubkey}: its runtime "${personaRuntime}" is unavailable`,
      );
    }
    const recordEnv = parseEnvironment(summary.env_vars, "agent envVars");
    const environment = mergeEnvironment(
      definition?.env ?? {},
      persona?.env_vars ?? {},
      recordEnv,
    );
    const explicitProvider = persona
      ? persona.provider
      : optionalText(summary.provider, "provider", 128);
    const selectedModel = persona
      ? persona.model
      : optionalText(summary.model, "model", 1_024);
    const storedArgs = parseArguments(summary.agent_args, "agent args");
    return this.#discover({
      agentArgs:
        storedArgs.length > 0 ? storedArgs : (definition?.args ?? storedArgs),
      agentCommand: definition?.command ?? commandReference,
      environment,
      provider: effectiveProvider(
        explicitProvider,
        definition?.providerEnvVar ?? null,
        environment,
      ),
      selectedModel,
    });
  }

  async #discover(config: DiscoveryConfig): Promise<AgentModelsResponse> {
    const provider = config.provider.value?.trim().toLowerCase() ?? null;
    if (provider === "relay-mesh") {
      let models: Array<{ id: string; name: string | null }>;
      try {
        models = await this.#mesh.availableModels();
      } catch (error) {
        throw new Error(
          `Buzz shared compute model discovery failed: ${safeError(error)}`,
        );
      }
      if (models.length === 0) {
        throw new Error("No live Buzz shared compute models are available");
      }
      return response(
        "relay-mesh",
        "local-mesh-catalog",
        models.map((model) => ({ ...model, description: null })),
        config.selectedModel,
      );
    }

    const direct =
      (await this.#discoverOpenAi(config)) ??
      (await this.#discoverAnthropic(config)) ??
      (await this.#discoverDatabricks(config));
    if (direct) return direct;
    return this.#discoverAcp(config);
  }

  async #discoverOpenAi(
    config: DiscoveryConfig,
  ): Promise<AgentModelsResponse | null> {
    const provider = config.provider.value?.trim().toLowerCase();
    if (provider !== "openai" && provider !== "openai-compat") return null;
    const apiKey = requiredEnvironment(
      config.provider,
      config.environment,
      "OPENAI_COMPAT_API_KEY",
    );
    if (!apiKey) return null;
    const base =
      environmentValue(config.environment, "OPENAI_COMPAT_BASE_URL") ??
      "https://api.openai.com/v1";
    const url = safeProviderUrl(base, "/models");
    const payload = await fetchJson(
      this.#fetch,
      url,
      {
        Authorization: `Bearer ${apiKey}`,
      },
      config.environment,
      "OpenAI model discovery",
    );
    const data = objectArray(payload, "data", "OpenAI model discovery");
    const items = data.flatMap((entry) => {
      const id = stringAt(entry, "id");
      if (!id) return [];
      const created =
        typeof entry.created === "number" && Number.isFinite(entry.created)
          ? entry.created
          : null;
      return [{ created, id }];
    });
    const openAi = provider === "openai";
    const allIds = new Set(items.map((item) => item.id));
    const seen = new Set<string>();
    const models = items
      .sort(
        (left, right) =>
          (right.created ?? -1) - (left.created ?? -1) ||
          left.id.localeCompare(right.id),
      )
      .filter((item) => !openAi || isOpenAiTextModel(item.id))
      .filter((item) => {
        const alias = datedSnapshotAlias(item.id);
        return !openAi || !alias || !allIds.has(alias);
      })
      .filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .map((item) => ({
        description: null,
        id: item.id,
        name: openAiDisplayName(item.id),
      }));
    if (models.length === 0) {
      throw new Error(
        "OpenAI model discovery returned no compatible text models",
      );
    }
    return response(provider, "models-api", models, config.selectedModel);
  }

  async #discoverAnthropic(
    config: DiscoveryConfig,
  ): Promise<AgentModelsResponse | null> {
    const provider = config.provider.value?.trim().toLowerCase();
    if (provider !== "anthropic") return null;
    const apiKey = requiredEnvironment(
      config.provider,
      config.environment,
      "ANTHROPIC_API_KEY",
    );
    if (!apiKey) return null;
    const base =
      environmentValue(config.environment, "ANTHROPIC_BASE_URL") ??
      "https://api.anthropic.com";
    const url = safeProviderUrl(
      base,
      new URL(base).pathname.replace(/\/$/, "").endsWith("/v1")
        ? "/models"
        : "/v1/models",
    );
    const models: AgentModelInfo[] = [];
    const seen = new Set<string>();
    let afterId: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const requestUrl = new URL(url);
      if (afterId) requestUrl.searchParams.set("after_id", afterId);
      const payload = await fetchJson(
        this.#fetch,
        requestUrl,
        {
          "anthropic-version": "2023-06-01",
          "x-api-key": apiKey,
        },
        config.environment,
        "Anthropic model discovery",
      );
      for (const entry of objectArray(
        payload,
        "data",
        "Anthropic model discovery",
      )) {
        const id = stringAt(entry, "id");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        models.push({
          description: null,
          id,
          name: stringAt(entry, "display_name"),
        });
      }
      const pageObject = requireObject(payload, "Anthropic response");
      if (pageObject.has_more !== true) break;
      afterId = stringAt(pageObject, "last_id");
      if (!afterId) {
        throw new Error(
          "Anthropic model discovery pagination did not return last_id",
        );
      }
    }
    if (models.length === 0) {
      throw new Error("Anthropic model discovery returned no models");
    }
    return response(provider, "models-api", models, config.selectedModel);
  }

  async #discoverDatabricks(
    config: DiscoveryConfig,
  ): Promise<AgentModelsResponse | null> {
    const provider = config.provider.value?.trim().toLowerCase();
    if (
      provider !== "databricks" &&
      provider !== "databricks_v2" &&
      provider !== "databricks-v2"
    ) {
      return null;
    }
    const host = environmentValue(config.environment, "DATABRICKS_HOST");
    const token = environmentValue(config.environment, "DATABRICKS_TOKEN");
    if (!host || !token) {
      if (config.provider.inferred) return null;
      throw new Error(
        `config: ${host ? "DATABRICKS_TOKEN" : "DATABRICKS_HOST"} required`,
      );
    }
    const v2 = provider !== "databricks";
    const models = v2
      ? await this.#databricksV2(host, token, config.environment)
      : await this.#databricksV1(host, token, config.environment);
    if (models.length === 0) {
      throw new Error("Databricks model discovery returned no models");
    }
    return response(provider, "models-api", models, config.selectedModel);
  }

  async #databricksV1(
    host: string,
    token: string,
    environment: Record<string, string>,
  ): Promise<AgentModelInfo[]> {
    const payload = await fetchJson(
      this.#fetch,
      safeProviderUrl(host, "/api/2.0/serving-endpoints"),
      { Authorization: `Bearer ${token}` },
      environment,
      "Databricks model discovery",
    );
    return objectArray(payload, "endpoints", "Databricks model discovery")
      .filter((entry) => {
        const ready = objectValue(entry.state)?.ready;
        const task = entry.task;
        return (
          (ready === undefined || ready === "READY") &&
          (task === undefined ||
            task === "llm/v1/chat" ||
            task === "llm/v1/completions")
        );
      })
      .flatMap((entry) => {
        const id = stringAt(entry, "name");
        return id ? [{ description: null, id, name: id }] : [];
      });
  }

  async #databricksV2(
    host: string,
    token: string,
    environment: Record<string, string>,
  ): Promise<AgentModelInfo[]> {
    const endpoint = safeProviderUrl(host, "/api/ai-gateway/v2/endpoints");
    const collected: Array<AgentModelInfo & { created: number | null }> = [];
    let pageToken: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const url = new URL(endpoint);
      url.searchParams.set("page_size", "100");
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const payload = await fetchJson(
        this.#fetch,
        url,
        { Authorization: `Bearer ${token}` },
        environment,
        "Databricks v2 model discovery",
      );
      const object = requireObject(payload, "Databricks v2 response");
      for (const entry of objectArray(
        object,
        "endpoints",
        "Databricks v2 model discovery",
      )) {
        const id = stringAt(entry, "name");
        if (!id || !isChatCapableDatabricksEndpoint(id)) continue;
        const rawCreated = entry.created_timestamp;
        const parsed =
          typeof rawCreated === "number"
            ? rawCreated
            : typeof rawCreated === "string"
              ? Number(rawCreated)
              : Number.NaN;
        collected.push({
          created: Number.isFinite(parsed) ? parsed : null,
          description: null,
          id,
          name: id,
        });
      }
      const next = stringAt(object, "next_page_token");
      if (!next || next === pageToken) break;
      pageToken = next;
    }
    if (collected.length === 0) {
      return ["databricks-gpt-5-5", "databricks-claude-opus-4-7"].map((id) => ({
        description: null,
        id,
        name: id,
      }));
    }
    return collected
      .sort(
        (left, right) =>
          (right.created ?? -1) - (left.created ?? -1) ||
          left.id.localeCompare(right.id),
      )
      .map(({ created: _created, ...model }) => model);
  }

  async #discoverAcp(config: DiscoveryConfig): Promise<AgentModelsResponse> {
    const resolved = await this.#resolveAgent(config.agentCommand);
    const client = new AcpProcessClient({
      args: [...resolved.prefixArgs, ...config.agentArgs],
      command: resolved.executable,
      cwd: os.homedir(),
      environment: config.environment,
      inheritEnvironment: true,
      permissionPolicy: "deny",
      requestTimeoutMilliseconds: 20_000,
    });
    try {
      const initialized = await client.start();
      const session = await client.newSession();
      return normalizeAcpModels(
        initialized as unknown as Record<string, unknown>,
        session as unknown as Record<string, unknown>,
        config.selectedModel,
      );
    } catch (error) {
      const diagnostic = redactSecrets(
        `${safeError(error)}${client.stderrTail ? `: ${client.stderrTail}` : ""}`,
        config.environment,
      );
      throw new Error(`ACP model discovery failed: ${diagnostic}`);
    } finally {
      await client.shutdown().catch(() => undefined);
    }
  }

  async #resolveAgent(command: string): Promise<{
    executable: string;
    prefixArgs: string[];
  }> {
    const normalized = path.basename(command).replace(/\.exe$/i, "");
    if (normalized === "buzz-agent" || normalized === "buzz-agent-ts") {
      return { executable: process.execPath, prefixArgs: [BUILT_IN_AGENT_CLI] };
    }
    const direct = await findExecutable(command);
    if (direct) return { executable: direct, prefixArgs: [] };
    const definition = this.#runtimeCatalog.definitionForCommand(command);
    const entries = await this.#runtimeCatalog.discover();
    const entry = definition
      ? entries.find((candidate) => candidate.id === definition.id)
      : matchingRuntime(entries, command);
    if (!entry?.binary_path || entry.availability !== "available") {
      throw new Error(`agent command is not available: ${command}`);
    }
    return { executable: entry.binary_path, prefixArgs: [] };
  }
}

export function normalizeAcpModels(
  initialized: Record<string, unknown>,
  session: Record<string, unknown>,
  selectedModel: string | null,
): AgentModelsResponse {
  const agentInfo = objectValue(initialized.agentInfo);
  const agentName = stringAt(agentInfo, "name") ?? "unknown";
  const agentVersion = stringAt(agentInfo, "version") ?? "unknown";
  const seen = new Set<string>();
  const models: AgentModelInfo[] = [];
  let agentDefaultModel: string | null = null;
  const configOptions = Array.isArray(session.configOptions)
    ? session.configOptions
    : [];
  for (const rawOption of configOptions) {
    const option = objectValue(rawOption);
    if (!option || option.category !== "model") continue;
    if (typeof option.currentValue === "string") {
      agentDefaultModel = option.currentValue;
    }
    for (const raw of flattenAcpOptions(option.options)) {
      const id = stringAt(raw, "value");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({
        description: stringAt(raw, "description"),
        id,
        name: stringAt(raw, "name") ?? stringAt(raw, "displayName"),
      });
    }
  }
  const meta = objectValue(session._meta);
  const unstable =
    objectValue(meta?.models) ??
    objectValue(meta?.modelState) ??
    objectValue(session.unstable);
  if (unstable) {
    agentDefaultModel =
      stringAt(unstable, "currentModelId") ?? agentDefaultModel;
    const available = Array.isArray(unstable.availableModels)
      ? unstable.availableModels
      : [];
    for (const raw of available) {
      const model = objectValue(raw);
      const id = stringAt(model, "modelId") ?? stringAt(model, "id");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({
        description: stringAt(model, "description"),
        id,
        name: stringAt(model, "name"),
      });
    }
  }
  return {
    agentDefaultModel,
    agentName,
    agentVersion,
    models,
    selectedModel,
    supportsSwitching: models.length > 0,
  };
}

function response(
  agentName: string,
  agentVersion: string,
  models: AgentModelInfo[],
  selectedModel: string | null,
): AgentModelsResponse {
  return {
    agentDefaultModel: null,
    agentName,
    agentVersion,
    models,
    selectedModel,
    supportsSwitching: models.length > 0,
  };
}

function parseDiscoveryInput(value: unknown): DiscoveryInput {
  const input = requireObject(value, "input");
  return {
    acpCommand: optionalText(input.acpCommand, "acpCommand", 1_024),
    agentArgs:
      input.agentArgs === undefined
        ? null
        : parseArguments(input.agentArgs, "agentArgs"),
    agentCommand: requireText(input.agentCommand, "agent command", 1_024),
    definitionEnv: parseEnvironment(input.definitionEnv, "definitionEnv"),
    envVars: parseEnvironment(input.envVars, "envVars"),
    provider: optionalText(input.provider, "provider", 128),
  };
}

function parseEnvironment(
  value: unknown,
  name: string,
): Record<string, string> {
  if (value === undefined) return {};
  const object = requireObject(value, name);
  if (Object.keys(object).length > 256) {
    throw new Error(`${name} has too many keys`);
  }
  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(object)) {
    if (!ENV_NAME.test(key) || RESERVED_ENV.has(key)) {
      throw new Error(`${name} key "${key}" is invalid or reserved`);
    }
    if (
      typeof raw !== "string" ||
      raw.includes("\0") ||
      Buffer.byteLength(raw, "utf8") > 64 * 1024
    ) {
      throw new Error(`${name}.${key} must be a string up to 64 KiB`);
    }
    output[key] = raw;
  }
  return output;
}

function mergeEnvironment(
  ...layers: ReadonlyArray<Record<string, string>>
): Record<string, string> {
  return Object.assign({}, ...layers);
}

function effectiveProvider(
  explicit: string | null,
  providerEnvVar: string | null,
  environment: Record<string, string>,
): DiscoveryProvider {
  const value = explicit?.trim();
  if (value) return { inferred: false, value };
  return {
    inferred: true,
    value: providerEnvVar
      ? environmentValue(environment, providerEnvVar)
      : null,
  };
}

function requiredEnvironment(
  provider: DiscoveryProvider,
  environment: Record<string, string>,
  name: string,
): string | null {
  const value = environmentValue(environment, name);
  if (value) return value;
  if (provider.inferred) return null;
  throw new Error(`config: ${name} required`);
}

function environmentValue(
  environment: Record<string, string>,
  name: string,
): string | null {
  const value = environment[name]?.trim() || process.env[name]?.trim();
  return value || null;
}

function safeProviderUrl(baseValue: string, suffix: string): URL {
  let base: URL;
  try {
    base = new URL(baseValue);
  } catch {
    throw new Error("model discovery base URL is invalid");
  }
  if (
    base.username ||
    base.password ||
    base.hash ||
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && isLoopback(base.hostname)))
  ) {
    throw new Error(
      "model discovery requires HTTPS, except for a loopback development endpoint",
    );
  }
  const pathname = `${base.pathname.replace(/\/$/, "")}${suffix}`;
  base.pathname = pathname.replace(/\/{2,}/g, "/");
  base.search = "";
  return base;
}

async function fetchJson(
  fetcher: typeof fetch,
  url: URL,
  headers: Record<string, string>,
  redactionEnvironment: Record<string, string>,
  label: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Accept: "application/json", ...headers },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`${label} request failed: ${safeError(error)}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeds 8 MiB`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeds 8 MiB`);
  }
  const text = new TextDecoder("utf8").decode(bytes);
  if (!response.ok) {
    throw new Error(
      `${label} HTTP ${response.status}: ${redactSecrets(
        text.slice(0, 8_192),
        redactionEnvironment,
      )}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} response parse failed`);
  }
}

function objectArray(
  value: unknown,
  key: string,
  label: string,
): Record<string, unknown>[] {
  const object = requireObject(value, `${label} response`);
  if (!Array.isArray(object[key])) {
    throw new Error(`${label} response is missing the ${key} array`);
  }
  return object[key].flatMap((entry) => {
    const object = objectValue(entry);
    return object ? [object] : [];
  });
}

function flattenAcpOptions(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const object = objectValue(entry);
    if (!object) return [];
    if (Array.isArray(object.options)) return flattenAcpOptions(object.options);
    return [object];
  });
}

function isOpenAiTextModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (OPENAI_NON_TEXT_MARKERS.some((marker) => lower.includes(marker))) {
    return false;
  }
  return (
    lower.startsWith("gpt-") ||
    /^o[0-9]/.test(lower) ||
    lower.startsWith("chatgpt-")
  );
}

function datedSnapshotAlias(id: string): string | null {
  const match = id.match(/^(.*)-[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  return match?.[1] ?? null;
}

function openAiDisplayName(id: string): string {
  const canonical = datedSnapshotAlias(id) ?? id;
  if (canonical.startsWith("chatgpt-")) {
    return `ChatGPT ${titleModel(canonical.slice(8))}`;
  }
  if (canonical.startsWith("gpt-")) {
    return `GPT-${titleModel(canonical.slice(4))}`;
  }
  return canonical;
}

function titleModel(value: string): string {
  return value
    .split("-")
    .map((part) =>
      part.toLowerCase() === "pro"
        ? "Pro"
        : ["mini", "nano"].includes(part.toLowerCase())
          ? part.toLowerCase()
          : part,
    )
    .join(" ");
}

function isChatCapableDatabricksEndpoint(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.includes("embedding")) return false;
  return !lower.split("-").some((part) => part === "bge" || part === "gte");
}

function matchingRuntime(
  entries: RuntimeCatalogEntry[],
  command: string,
): RuntimeCatalogEntry | undefined {
  const normalized = path
    .basename(command)
    .toLowerCase()
    .replace(/\.exe$/, "");
  return entries.find(
    (entry) =>
      entry.id === command ||
      (entry.command &&
        path
          .basename(entry.command)
          .toLowerCase()
          .replace(/\.exe$/, "") === normalized),
  );
}

async function findExecutable(command: string): Promise<string | null> {
  if (!command || command.includes("\0")) return null;
  const hasPath =
    path.isAbsolute(command) || command.includes("/") || command.includes("\\");
  const candidates = hasPath
    ? [path.resolve(command)]
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .flatMap((directory) =>
          process.platform === "win32"
            ? ["", ".exe", ".cmd", ".bat"].map((suffix) =>
                path.join(directory, `${command}${suffix}`),
              )
            : [path.join(directory, command)],
        );
  for (const candidate of candidates) {
    try {
      await access(candidate, process.platform === "win32" ? 0 : 1);
      if (!(await stat(candidate)).isFile()) continue;
      // Deliberately not resolved through realpath: multi-call launchers such
      // as Hermit, asdf, and Volta dispatch on argv[0], so collapsing the
      // symlink would run the launcher itself instead of the tool.
      return path.resolve(candidate);
    } catch {
      // Continue through the caller-controlled, bounded candidate list.
    }
  }
  return null;
}

function redactSecrets(
  text: string,
  environment: Record<string, string>,
): string {
  let output = text;
  for (const [key, value] of Object.entries({
    ...process.env,
    ...environment,
  })) {
    if (
      value &&
      value.length >= 4 &&
      /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|NSEC)/i.test(key)
    ) {
      output = output.replaceAll(value, "[REDACTED]");
    }
  }
  return output.slice(0, 16_384);
}

function parseArguments(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error(`${name} must contain at most 128 strings`);
  }
  return value.map((entry, index) => {
    if (
      typeof entry !== "string" ||
      entry.includes("\0") ||
      Buffer.byteLength(entry, "utf8") > 16 * 1024
    ) {
      throw new Error(`${name}[${index}] is invalid`);
    }
    return entry;
  });
}

function requirePubkey(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("pubkey must be 64 lowercase hexadecimal characters");
  }
  return value;
}

function requireText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximum
  ) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function optionalText(
  value: unknown,
  name: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireText(value, name, maximum);
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringAt(
  object: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = object?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(normalized)
  );
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
