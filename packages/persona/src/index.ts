import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { parseDocument } from "yaml";

export const MAX_FRONTMATTER_BYTES = 1_048_576;
export const MAX_BODY_BYTES = 262_144;
const MAX_TEXT_BYTES = MAX_FRONTMATTER_BYTES + MAX_BODY_BYTES + 200;

export type RespondTo = {
  readonly mentions?: boolean;
  readonly keywords: readonly string[];
  readonly allMessages?: boolean;
};

export type McpServerConfig = {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

export type PersonaHooks = {
  readonly onStart?: string;
  readonly onStop?: string;
  readonly onMessage?: string;
};

export type PersonaConfig = {
  readonly name: string;
  readonly displayName: string;
  readonly avatar?: string;
  readonly description: string;
  readonly version?: string;
  readonly author?: string;
  readonly skills: readonly string[];
  readonly mcpServers: readonly McpServerConfig[];
  readonly subscribe?: readonly string[];
  readonly triggers?: RespondTo;
  readonly model?: string;
  readonly runtime?: string;
  readonly temperature?: number;
  readonly maxContextTokens?: number;
  readonly threadReplies?: boolean;
  readonly broadcastReplies?: boolean;
  readonly hooks?: PersonaHooks;
  readonly prompt: string;
};

export type BehavioralDefaults = {
  readonly model?: string;
  readonly temperature?: number;
  readonly maxContextTokens?: number;
  readonly subscribe?: readonly string[];
  readonly triggers?: RespondTo;
  readonly threadReplies?: boolean;
  readonly broadcastReplies?: boolean;
};

export type PackManifest = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly author?: string;
  readonly license?: string;
  readonly homepage?: string;
  readonly keywords: readonly string[];
  readonly engines?: { readonly buzz?: string };
  readonly personas: readonly string[];
  readonly packInstructions?: string;
  readonly mcpConfig?: string;
  readonly hooksConfig?: string;
  readonly defaults?: BehavioralDefaults;
};

export type ResolvedPersona = {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly avatar?: string;
  readonly version: string;
  readonly systemPrompt: string;
  readonly packInstructions?: string;
  readonly model?: string;
  readonly llmProvider?: string;
  readonly runtime?: string;
  readonly temperature?: number;
  readonly maxContextTokens?: number;
  readonly subscribe: readonly string[];
  readonly triggers: {
    readonly mentions: boolean;
    readonly keywords: readonly string[];
    readonly allMessages: boolean;
  };
  readonly threadReplies: boolean;
  readonly broadcastReplies: boolean;
  readonly mcpServers: readonly McpServerConfig[];
  readonly hooks?: PersonaHooks;
  readonly skills: readonly string[];
  readonly runtimeEnvVars: Readonly<Record<string, string>>;
};

export type ResolvedPack = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly personas: readonly ResolvedPersona[];
};

export class PersonaPackError extends Error {
  public constructor(
    readonly code:
      | "INVALID_MANIFEST"
      | "INVALID_PERSONA"
      | "FILE_TOO_LARGE"
      | "PATH_TRAVERSAL"
      | "PATH_ESCAPE"
      | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "PersonaPackError";
  }
}

export function splitFrontmatter(content: string): {
  readonly frontmatter: string;
  readonly body: string;
} {
  const opening = /^---\r?\n/.exec(content);
  if (!opening) {
    throw new PersonaPackError(
      "INVALID_PERSONA",
      "missing frontmatter delimiters",
    );
  }
  const start = opening[0].length;
  const close = /\r?\n---(?:\r?\n|$)/g;
  close.lastIndex = start;
  const match = close.exec(content);
  if (!match) {
    throw new PersonaPackError(
      "INVALID_PERSONA",
      "missing closing frontmatter delimiter",
    );
  }
  const frontmatter = content.slice(start, match.index);
  const body = content.slice(match.index + match[0].length);
  if (Buffer.byteLength(frontmatter) > MAX_FRONTMATTER_BYTES) {
    throw new PersonaPackError("FILE_TOO_LARGE", "frontmatter exceeds 1 MiB");
  }
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    throw new PersonaPackError(
      "FILE_TOO_LARGE",
      "persona body exceeds 256 KiB",
    );
  }
  return { body, frontmatter };
}

export function parsePersonaMarkdown(content: string): PersonaConfig {
  const { body, frontmatter } = splitFrontmatter(content);
  const raw = parseYamlObject(frontmatter, "persona frontmatter");
  rejectUnknown(raw, [
    "name",
    "display_name",
    "avatar",
    "description",
    "version",
    "author",
    "skills",
    "mcp_servers",
    "subscribe",
    "triggers",
    "respond_to",
    "model",
    "runtime",
    "temperature",
    "max_context_tokens",
    "thread_replies",
    "broadcast_replies",
    "hooks",
  ]);
  const name = requiredString(raw.name, "name", 64);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new PersonaPackError(
      "INVALID_PERSONA",
      "persona name may contain only letters, numbers, _ and -",
    );
  }
  const displayName = requiredString(raw.display_name, "display_name", 128);
  const description = requiredString(raw.description, "description", 2_048);
  const subscribe = optionalStringArray(raw.subscribe, "subscribe", 256);
  const triggers = parseTriggers(raw.triggers ?? raw.respond_to);
  const mcpServers = parseMcpServers(raw.mcp_servers);
  const hooks = parseHooks(raw.hooks);
  const temperature = optionalNumber(raw.temperature, "temperature", 0, 2);
  const maxContextTokens = optionalInteger(
    raw.max_context_tokens,
    "max_context_tokens",
    1,
    10_000_000,
  );
  return {
    ...((optionalString(raw.author, "author", 256) as string | undefined)
      ? { author: optionalString(raw.author, "author", 256) as string }
      : {}),
    ...((optionalString(raw.avatar, "avatar", 1_024) as string | undefined)
      ? { avatar: optionalString(raw.avatar, "avatar", 1_024) as string }
      : {}),
    ...(raw.broadcast_replies === undefined
      ? {}
      : {
          broadcastReplies: boolean(raw.broadcast_replies, "broadcast_replies"),
        }),
    description,
    displayName,
    ...(hooks ? { hooks } : {}),
    ...(maxContextTokens === undefined ? {} : { maxContextTokens }),
    ...((optionalString(raw.model, "model", 512) as string | undefined)
      ? { model: optionalString(raw.model, "model", 512) as string }
      : {}),
    mcpServers,
    name,
    prompt: body,
    ...((optionalString(raw.runtime, "runtime", 128) as string | undefined)
      ? { runtime: optionalString(raw.runtime, "runtime", 128) as string }
      : {}),
    skills: optionalStringArray(raw.skills, "skills", 256) ?? [],
    ...(subscribe === undefined ? {} : { subscribe }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(raw.thread_replies === undefined
      ? {}
      : { threadReplies: boolean(raw.thread_replies, "thread_replies") }),
    ...(triggers ? { triggers } : {}),
    ...((optionalString(raw.version, "version", 128) as string | undefined)
      ? { version: optionalString(raw.version, "version", 128) as string }
      : {}),
  };
}

export function parseManifest(content: string): PackManifest {
  if (Buffer.byteLength(content) > MAX_TEXT_BYTES) {
    throw new PersonaPackError("FILE_TOO_LARGE", "manifest is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new PersonaPackError("INVALID_MANIFEST", "manifest is invalid JSON");
  }
  const raw = object(value, "manifest");
  const defaults = parseDefaults(raw.defaults);
  return {
    ...(optionalString(raw.author, "author", 256)
      ? { author: optionalString(raw.author, "author", 256) as string }
      : {}),
    ...(defaults ? { defaults } : {}),
    ...(optionalString(raw.description, "description", 4_096)
      ? {
          description: optionalString(
            raw.description,
            "description",
            4_096,
          ) as string,
        }
      : {}),
    ...(raw.engines === undefined
      ? {}
      : {
          engines: {
            ...(optionalString(
              object(raw.engines, "engines").buzz,
              "engines.buzz",
              128,
            )
              ? {
                  buzz: optionalString(
                    object(raw.engines, "engines").buzz,
                    "engines.buzz",
                    128,
                  ) as string,
                }
              : {}),
          },
        }),
    ...(optionalString(raw.homepage, "homepage", 2_048)
      ? { homepage: optionalString(raw.homepage, "homepage", 2_048) as string }
      : {}),
    ...(optionalString(raw.hooks_config, "hooks_config", 1_024)
      ? {
          hooksConfig: optionalString(
            raw.hooks_config,
            "hooks_config",
            1_024,
          ) as string,
        }
      : {}),
    id: requiredString(raw.id, "id", 128),
    keywords: optionalStringArray(raw.keywords, "keywords", 256) ?? [],
    ...(optionalString(raw.license, "license", 128)
      ? { license: optionalString(raw.license, "license", 128) as string }
      : {}),
    ...(optionalString(raw.mcp_config, "mcp_config", 1_024)
      ? {
          mcpConfig: optionalString(
            raw.mcp_config,
            "mcp_config",
            1_024,
          ) as string,
        }
      : {}),
    name: requiredString(raw.name, "name", 256),
    ...(optionalString(raw.pack_instructions, "pack_instructions", 1_024)
      ? {
          packInstructions: optionalString(
            raw.pack_instructions,
            "pack_instructions",
            1_024,
          ) as string,
        }
      : {}),
    personas: optionalStringArray(raw.personas, "personas", 1_024) ?? [],
    version: requiredString(raw.version, "version", 128),
  };
}

export async function resolvePack(
  packDirectory: string,
): Promise<ResolvedPack> {
  const root = await canonicalDirectory(packDirectory);
  const manifestPath = await safeResolve(root, ".plugin/plugin.json", true);
  const manifest = parseManifest(
    await readBounded(manifestPath, MAX_TEXT_BYTES),
  );
  if (manifest.personas.length === 0) {
    throw new PersonaPackError(
      "INVALID_MANIFEST",
      "pack contains zero personas",
    );
  }
  const packInstructions = await optionalPackText(
    root,
    manifest.packInstructions,
    "instructions.md",
  );
  const sharedMcp = await optionalJson(root, manifest.mcpConfig, ".mcp.json");
  const seen = new Set<string>();
  const personas: ResolvedPersona[] = [];
  for (const path of manifest.personas) {
    const absolute = await safeResolve(root, path, true);
    const persona = parsePersonaMarkdown(
      await readBounded(absolute, MAX_TEXT_BYTES),
    );
    if (seen.has(persona.name)) {
      throw new PersonaPackError(
        "INVALID_PERSONA",
        `duplicate persona name: ${persona.name}`,
      );
    }
    seen.add(persona.name);
    personas.push(
      resolvePersona(
        persona,
        manifest.defaults,
        manifest.version,
        packInstructions,
        sharedMcp,
      ),
    );
  }
  const assignments = await resolveSkills(root, personas);
  return {
    description: manifest.description ?? "",
    id: manifest.id,
    name: manifest.name,
    personas: personas.map((persona) => ({
      ...persona,
      skills: assignments[persona.name] ?? persona.skills,
    })),
    version: manifest.version,
  };
}

export async function validatePack(packDirectory: string): Promise<{
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}> {
  try {
    await resolvePack(packDirectory);
    return { errors: [], warnings: [] };
  } catch (error) {
    return {
      errors: [error instanceof Error ? error.message : String(error)],
      warnings: [],
    };
  }
}

export function splitModel(value: string): {
  readonly provider?: string;
  readonly model: string;
} {
  const index = value.indexOf(":");
  if (index < 0) return { model: value };
  const provider = value.slice(0, index);
  return {
    model: value.slice(index + 1),
    ...(provider ? { provider } : {}),
  };
}

function resolvePersona(
  persona: PersonaConfig,
  defaults: BehavioralDefaults | undefined,
  packVersion: string,
  instructions: string | undefined,
  sharedMcp: unknown,
): ResolvedPersona {
  const modelValue = persona.model ?? defaults?.model;
  const model = modelValue ? splitModel(modelValue) : undefined;
  const triggerSource = persona.triggers ?? defaults?.triggers;
  const temperature = persona.temperature ?? defaults?.temperature;
  const maxContextTokens =
    persona.maxContextTokens ?? defaults?.maxContextTokens;
  const runtimeEnvVars: Record<string, string> = {};
  if (model) {
    if (persona.runtime === "buzz-agent") {
      runtimeEnvVars.BUZZ_AGENT_MODEL = model.model;
      if (model.provider) runtimeEnvVars.BUZZ_AGENT_PROVIDER = model.provider;
    } else {
      runtimeEnvVars.GOOSE_MODEL = model.model;
      if (model.provider) runtimeEnvVars.GOOSE_PROVIDER = model.provider;
    }
  }
  if (temperature !== undefined) {
    runtimeEnvVars.GOOSE_TEMPERATURE = String(temperature);
  }
  if (maxContextTokens !== undefined) {
    runtimeEnvVars.GOOSE_CONTEXT_LIMIT = String(maxContextTokens);
  }
  return {
    ...(persona.avatar ? { avatar: persona.avatar } : {}),
    broadcastReplies:
      persona.broadcastReplies ?? defaults?.broadcastReplies ?? false,
    description: persona.description,
    displayName: persona.displayName,
    ...(instructions?.trim() ? { packInstructions: instructions.trim() } : {}),
    ...(model ? { model: model.model } : {}),
    ...(model?.provider ? { llmProvider: model.provider } : {}),
    ...(maxContextTokens === undefined ? {} : { maxContextTokens }),
    mcpServers: mergeMcpServers(sharedMcp, persona.mcpServers),
    name: persona.name,
    ...(persona.runtime ? { runtime: persona.runtime } : {}),
    runtimeEnvVars,
    skills: persona.skills,
    subscribe: persona.subscribe ?? defaults?.subscribe ?? [],
    systemPrompt: persona.prompt,
    ...(temperature === undefined ? {} : { temperature }),
    threadReplies: persona.threadReplies ?? defaults?.threadReplies ?? true,
    triggers: {
      allMessages: triggerSource?.allMessages ?? false,
      keywords: triggerSource?.keywords ?? [],
      mentions: triggerSource?.mentions ?? true,
    },
    version: persona.version ?? packVersion,
    ...(persona.hooks ? { hooks: persona.hooks } : {}),
  };
}

function mergeMcpServers(
  shared: unknown,
  persona: readonly McpServerConfig[],
): McpServerConfig[] {
  const result = new Map<string, McpServerConfig>();
  if (shared && typeof shared === "object" && !Array.isArray(shared)) {
    const servers = (shared as Record<string, unknown>).mcpServers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      for (const [name, config] of Object.entries(servers)) {
        try {
          result.set(name, parseMcpServer({ ...object(config, name), name }));
        } catch {
          // Invalid shared entries are excluded; validatePack reports the pack
          // resolution error when a persona depends on a missing server.
        }
      }
    }
  }
  for (const server of persona) result.set(server.name, server);
  return [...result.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

async function resolveSkills(
  root: string,
  personas: readonly ResolvedPersona[],
): Promise<Record<string, readonly string[]>> {
  const claimed = new Set(
    personas.flatMap((persona) =>
      persona.skills.map((skill) => basename(skill.replace(/\/+$/, ""))),
    ),
  );
  let shared: string[] = [];
  try {
    const directory = await safeResolve(root, "skills", true);
    shared = (
      await Promise.all(
        (
          await readdir(directory, { withFileTypes: true })
        ).map(async (entry) =>
          entry.isDirectory() && !entry.name.startsWith(".")
            ? entry.name
            : undefined,
        ),
      )
    ).filter(
      (value): value is string => value !== undefined && !claimed.has(value),
    );
  } catch {
    shared = [];
  }
  return Object.fromEntries(
    personas.map((persona) => [
      persona.name,
      [
        ...new Set([
          ...persona.skills.map((skill) => basename(skill.replace(/\/+$/, ""))),
          ...shared,
        ]),
      ],
    ]),
  );
}

async function canonicalDirectory(path: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error();
    return canonical;
  } catch {
    throw new PersonaPackError(
      "NOT_FOUND",
      `pack directory not found: ${path}`,
    );
  }
}

async function safeResolve(
  root: string,
  value: string,
  mustExist: boolean,
): Promise<string> {
  if (
    !value ||
    isAbsolute(value) ||
    value.split(/[\\/]+/).includes("..") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new PersonaPackError("PATH_TRAVERSAL", `unsafe pack path: ${value}`);
  }
  const joined = resolve(root, value);
  if (
    joined !== root &&
    !joined.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  ) {
    throw new PersonaPackError(
      "PATH_ESCAPE",
      `pack path escapes root: ${value}`,
    );
  }
  if (!mustExist) return joined;
  let canonical: string;
  try {
    canonical = await realpath(joined);
    const details = await lstat(canonical);
    if (!details.isFile() && !details.isDirectory()) throw new Error();
  } catch {
    throw new PersonaPackError("NOT_FOUND", `pack file not found: ${value}`);
  }
  if (relative(root, canonical).startsWith("..")) {
    throw new PersonaPackError(
      "PATH_ESCAPE",
      `pack path escapes root: ${value}`,
    );
  }
  return canonical;
}

async function readBounded(path: string, maximum: number): Promise<string> {
  const details = await stat(path);
  if (details.size > maximum) {
    throw new PersonaPackError("FILE_TOO_LARGE", `file too large: ${path}`);
  }
  return readFile(path, "utf8");
}

async function optionalPackText(
  root: string,
  configured: string | undefined,
  fallback: string,
): Promise<string | undefined> {
  const path = configured ?? fallback;
  try {
    return await readBounded(
      await safeResolve(root, path, true),
      MAX_TEXT_BYTES,
    );
  } catch (error) {
    if (
      !configured &&
      error instanceof PersonaPackError &&
      error.code === "NOT_FOUND"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function optionalJson(
  root: string,
  configured: string | undefined,
  fallback: string,
): Promise<unknown> {
  const raw = await optionalPackText(root, configured, fallback);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new PersonaPackError(
      "INVALID_MANIFEST",
      "MCP config is invalid JSON",
    );
  }
}

function parseYamlObject(value: string, name: string): Record<string, unknown> {
  const document = parseDocument(value, {
    merge: false,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new PersonaPackError("INVALID_PERSONA", `${name} is invalid YAML`);
  }
  return object(document.toJS({ maxAliasCount: 20 }), name);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PersonaPackError("INVALID_PERSONA", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new PersonaPackError(
      "INVALID_PERSONA",
      `unknown persona fields: ${unknown.join(", ")}`,
    );
  }
}

function requiredString(value: unknown, name: string, maximum: number): string {
  const parsed = optionalString(value, name, maximum);
  if (!parsed) {
    throw new PersonaPackError("INVALID_PERSONA", `${name} is required`);
  }
  return parsed;
}

function optionalString(
  value: unknown,
  name: string,
  maximum: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new PersonaPackError("INVALID_PERSONA", `${name} is invalid`);
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  name: string,
  maximum: number,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > maximum) {
    throw new PersonaPackError("INVALID_PERSONA", `${name} is invalid`);
  }
  return value.map((item, index) =>
    requiredString(item, `${name}[${index}]`, 1_024),
  );
}

function optionalNumber(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new PersonaPackError("INVALID_PERSONA", `${name} is invalid`);
  }
  return value;
}

function optionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const parsed = optionalNumber(value, name, minimum, maximum);
  if (parsed !== undefined && !Number.isSafeInteger(parsed)) {
    throw new PersonaPackError("INVALID_PERSONA", `${name} must be an integer`);
  }
  return parsed;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new PersonaPackError("INVALID_PERSONA", `${name} must be boolean`);
  }
  return value;
}

function parseTriggers(value: unknown): RespondTo | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = object(value, "triggers");
  rejectUnknown(raw, ["mentions", "keywords", "all_messages"]);
  return {
    ...(raw.all_messages === undefined
      ? {}
      : { allMessages: boolean(raw.all_messages, "triggers.all_messages") }),
    keywords: optionalStringArray(raw.keywords, "triggers.keywords", 256) ?? [],
    ...(raw.mentions === undefined
      ? {}
      : { mentions: boolean(raw.mentions, "triggers.mentions") }),
  };
}

function parseMcpServers(value: unknown): McpServerConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 64) {
    throw new PersonaPackError("INVALID_PERSONA", "mcp_servers is invalid");
  }
  return value.map(parseMcpServer);
}

function parseMcpServer(value: unknown): McpServerConfig {
  const raw = object(value, "MCP server");
  rejectUnknown(raw, ["name", "command", "args", "env"]);
  const envRaw = raw.env === undefined ? {} : object(raw.env, "MCP env");
  const env = Object.fromEntries(
    Object.entries(envRaw).map(([key, item]) => [
      key,
      requiredString(item, `env.${key}`, 16_384),
    ]),
  );
  return {
    args: optionalStringArray(raw.args, "MCP args", 256) ?? [],
    command: requiredString(raw.command, "MCP command", 2_048),
    env,
    name: requiredString(raw.name, "MCP name", 128),
  };
}

function parseHooks(value: unknown): PersonaHooks | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = object(value, "hooks");
  rejectUnknown(raw, ["on_start", "on_stop", "on_message"]);
  return {
    ...(optionalString(raw.on_message, "hooks.on_message", 1_024)
      ? {
          onMessage: optionalString(
            raw.on_message,
            "hooks.on_message",
            1_024,
          ) as string,
        }
      : {}),
    ...(optionalString(raw.on_start, "hooks.on_start", 1_024)
      ? {
          onStart: optionalString(
            raw.on_start,
            "hooks.on_start",
            1_024,
          ) as string,
        }
      : {}),
    ...(optionalString(raw.on_stop, "hooks.on_stop", 1_024)
      ? {
          onStop: optionalString(raw.on_stop, "hooks.on_stop", 1_024) as string,
        }
      : {}),
  };
}

function parseDefaults(value: unknown): BehavioralDefaults | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = object(value, "defaults");
  const triggers = parseTriggers(raw.triggers ?? raw.respond_to);
  const subscribe = optionalStringArray(
    raw.subscribe,
    "defaults.subscribe",
    256,
  );
  return {
    ...(raw.broadcast_replies === undefined
      ? {}
      : {
          broadcastReplies: boolean(
            raw.broadcast_replies,
            "defaults.broadcast_replies",
          ),
        }),
    ...(optionalInteger(
      raw.max_context_tokens,
      "defaults.max_context_tokens",
      1,
      10_000_000,
    ) === undefined
      ? {}
      : {
          maxContextTokens: optionalInteger(
            raw.max_context_tokens,
            "defaults.max_context_tokens",
            1,
            10_000_000,
          ) as number,
        }),
    ...(optionalString(raw.model, "defaults.model", 512)
      ? { model: optionalString(raw.model, "defaults.model", 512) as string }
      : {}),
    ...(subscribe === undefined ? {} : { subscribe }),
    ...(optionalNumber(raw.temperature, "defaults.temperature", 0, 2) ===
    undefined
      ? {}
      : {
          temperature: optionalNumber(
            raw.temperature,
            "defaults.temperature",
            0,
            2,
          ) as number,
        }),
    ...(raw.thread_replies === undefined
      ? {}
      : {
          threadReplies: boolean(raw.thread_replies, "defaults.thread_replies"),
        }),
    ...(triggers ? { triggers } : {}),
  };
}
