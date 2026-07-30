import { randomUUID } from "node:crypto";

import type { IdentityService } from "./identity.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED_ENV = new Set([
  "BUZZ_PRIVATE_KEY",
  "BUZZ_REMOTE_TOKEN",
  "BUZZ_REMOTE_WORKER_PRIVATE_KEY",
  "HOME",
  "PATH",
]);

export type Persona = {
  avatar_url: string | null;
  created_at: string;
  display_name: string;
  env_vars: Record<string, string>;
  id: string;
  is_active: boolean;
  is_builtin: false;
  model: string | null;
  name_pool: string[];
  parallelism: number | null;
  provider: string | null;
  respond_to: string | null;
  respond_to_allowlist: string[];
  runtime: string | null;
  source_team: null;
  system_prompt: string;
  updated_at: string;
};

export type Team = {
  created_at: string;
  description: string | null;
  id: string;
  instructions: string | null;
  is_builtin: false;
  is_symlink: false;
  name: string;
  persona_ids: string[];
  source_dir: null;
  symlink_target: null;
  updated_at: string;
  version: null;
};

type ChannelTemplate = {
  agents: {
    personas: unknown[];
    teams: unknown[];
  };
  canvas_template: string | null;
  channel_type: "forum" | "stream";
  created_at: string;
  description: string | null;
  id: string;
  is_builtin: false;
  name: string;
  updated_at: string;
  visibility: "open" | "private";
};

export class LocalEntityService {
  readonly #identity: IdentityService;

  constructor(identity: IdentityService) {
    this.#identity = identity;
  }

  personas(): Persona[] {
    return this.#identity.setting<Persona[]>("personas.v1", []);
  }

  async createPersona(args: Record<string, unknown>): Promise<Persona> {
    const input = requireObject(args.input, "input");
    const now = new Date().toISOString();
    const behavior = optionalObject(input.behavior);
    const persona: Persona = {
      avatar_url: optionalHttpUrl(input.avatarUrl, "avatarUrl"),
      created_at: now,
      display_name: requireText(input.displayName, "displayName", 128),
      env_vars: validateEnv(input.envVars),
      id: randomUUID(),
      is_active: true,
      is_builtin: false,
      model: optionalText(input.model, "model", 512),
      name_pool: stringArray(input.namePool, "namePool", 100, 128),
      parallelism: optionalPositiveInteger(
        behavior?.parallelism,
        "parallelism",
      ),
      provider: optionalText(input.provider, "provider", 128),
      respond_to: optionalRespondTo(behavior?.respondTo),
      respond_to_allowlist: pubkeyArray(behavior?.respondToAllowlist),
      runtime: optionalText(input.runtime, "runtime", 128),
      source_team: null,
      system_prompt: requireStringWithin(
        input.systemPrompt,
        "systemPrompt",
        256 * 1024,
      ),
      updated_at: now,
    };
    await this.#savePersonas([...this.personas(), persona]);
    return persona;
  }

  async updatePersona(args: Record<string, unknown>): Promise<Persona> {
    const input = requireObject(args.input, "input");
    const id = requireUuid(input.id, "persona id");
    const personas = this.personas();
    const index = personas.findIndex((persona) => persona.id === id);
    const previous = personas[index];
    if (!previous) throw new Error("persona not found");
    const behavior = optionalObject(input.behavior);
    const updated: Persona = {
      ...previous,
      avatar_url: optionalHttpUrl(input.avatarUrl, "avatarUrl"),
      display_name: requireText(input.displayName, "displayName", 128),
      ...(input.envVars === undefined
        ? {}
        : { env_vars: validateEnv(input.envVars) }),
      model: optionalText(input.model, "model", 512),
      name_pool: stringArray(input.namePool, "namePool", 100, 128),
      provider: optionalText(input.provider, "provider", 128),
      runtime: optionalText(input.runtime, "runtime", 128),
      system_prompt: requireStringWithin(
        input.systemPrompt,
        "systemPrompt",
        256 * 1024,
      ),
      updated_at: new Date().toISOString(),
      ...(behavior
        ? {
            parallelism: optionalPositiveInteger(
              behavior.parallelism,
              "parallelism",
            ),
            respond_to: optionalRespondTo(behavior.respondTo),
            respond_to_allowlist: pubkeyArray(behavior.respondToAllowlist),
          }
        : {}),
    };
    personas[index] = updated;
    await this.#savePersonas(personas);
    return updated;
  }

  async deletePersona(idValue: unknown): Promise<void> {
    const id = requireUuid(idValue, "persona id");
    const personas = this.personas();
    if (!personas.some((persona) => persona.id === id)) {
      throw new Error("persona not found");
    }
    const teams = this.teams();
    if (teams.some((team) => team.persona_ids.includes(id))) {
      throw new Error("persona is still referenced by a team");
    }
    await this.#savePersonas(personas.filter((persona) => persona.id !== id));
  }

  async setPersonaActive(
    idValue: unknown,
    activeValue: unknown,
  ): Promise<Persona> {
    const id = requireUuid(idValue, "persona id");
    if (typeof activeValue !== "boolean")
      throw new Error("active must be boolean");
    const personas = this.personas();
    const index = personas.findIndex((persona) => persona.id === id);
    const previous = personas[index];
    if (!previous) throw new Error("persona not found");
    const updated = {
      ...previous,
      is_active: activeValue,
      updated_at: new Date().toISOString(),
    };
    personas[index] = updated;
    await this.#savePersonas(personas);
    return updated;
  }

  teams(): Team[] {
    return this.#identity.setting<Team[]>("teams.v1", []);
  }

  async applyInboundPersona(
    dTag: string,
    projection: {
      avatarUrl: string | null;
      displayName: string;
      model: string | null;
      namePool: string[];
      parallelism: number | null;
      provider: string | null;
      respondTo: string | null;
      respondToAllowlist: string[];
      runtime: string | null;
      systemPrompt: string;
    },
    eventTime: string,
  ): Promise<void> {
    const personas = this.personas();
    const index = personas.findIndex((persona) => persona.id === dTag);
    const existing = personas[index];
    if (existing) {
      personas[index] = {
        ...existing,
        avatar_url: projection.avatarUrl,
        display_name: projection.displayName,
        model: projection.model,
        name_pool: [...projection.namePool],
        parallelism: projection.parallelism,
        provider: projection.provider,
        respond_to: projection.respondTo,
        respond_to_allowlist: [...projection.respondToAllowlist],
        runtime: projection.runtime,
        system_prompt: projection.systemPrompt,
        updated_at: eventTime,
      };
    } else {
      personas.push({
        avatar_url: projection.avatarUrl,
        created_at: eventTime,
        display_name: projection.displayName,
        env_vars: {},
        id: dTag,
        is_active: true,
        is_builtin: false,
        model: projection.model,
        name_pool: [...projection.namePool],
        parallelism: projection.parallelism,
        provider: projection.provider,
        respond_to: projection.respondTo,
        respond_to_allowlist: [...projection.respondToAllowlist],
        runtime: projection.runtime,
        source_team: null,
        system_prompt: projection.systemPrompt,
        updated_at: eventTime,
      });
    }
    await this.#savePersonas(personas);
  }

  async applyInboundTeam(
    dTag: string,
    projection: {
      description: string | null;
      instructions: string | null | undefined;
      name: string;
      personaIds: string[] | undefined;
    },
    eventTime: string,
  ): Promise<void> {
    const teams = this.teams();
    const index = teams.findIndex((team) => team.id === dTag);
    const existing = teams[index];
    if (existing) {
      teams[index] = {
        ...existing,
        description: projection.description,
        ...(projection.instructions === undefined
          ? {}
          : { instructions: projection.instructions }),
        name: projection.name,
        ...(projection.personaIds === undefined
          ? {}
          : { persona_ids: [...projection.personaIds] }),
        updated_at: eventTime,
      };
    } else {
      teams.push({
        created_at: eventTime,
        description: projection.description,
        id: dTag,
        instructions: projection.instructions ?? null,
        is_builtin: false,
        is_symlink: false,
        name: projection.name,
        persona_ids: [...(projection.personaIds ?? [])],
        source_dir: null,
        symlink_target: null,
        updated_at: eventTime,
        version: null,
      });
    }
    await this.#saveTeams(teams);
  }

  async removeInbound(kind: 30_175 | 30_176, dTag: string): Promise<void> {
    if (kind === 30_175) {
      await this.#savePersonas(
        this.personas().filter((persona) => persona.id !== dTag),
      );
      return;
    }
    await this.#saveTeams(this.teams().filter((team) => team.id !== dTag));
  }

  async createTeam(args: Record<string, unknown>): Promise<Team> {
    const input = requireObject(args.input, "input");
    const now = new Date().toISOString();
    const team: Team = {
      created_at: now,
      description: optionalText(input.description, "description", 4_096),
      id: randomUUID(),
      instructions: optionalText(
        input.instructions,
        "instructions",
        256 * 1024,
      ),
      is_builtin: false,
      is_symlink: false,
      name: requireText(input.name, "name", 128),
      persona_ids: this.#personaIds(input.personaIds),
      source_dir: null,
      symlink_target: null,
      updated_at: now,
      version: null,
    };
    await this.#saveTeams([...this.teams(), team]);
    return team;
  }

  async updateTeam(args: Record<string, unknown>): Promise<Team> {
    const input = requireObject(args.input, "input");
    const id = requireUuid(input.id, "team id");
    const teams = this.teams();
    const index = teams.findIndex((team) => team.id === id);
    const previous = teams[index];
    if (!previous) throw new Error("team not found");
    const updated: Team = {
      ...previous,
      description: optionalText(input.description, "description", 4_096),
      instructions: optionalText(
        input.instructions,
        "instructions",
        256 * 1024,
      ),
      name: requireText(input.name, "name", 128),
      persona_ids: this.#personaIds(input.personaIds),
      updated_at: new Date().toISOString(),
    };
    teams[index] = updated;
    await this.#saveTeams(teams);
    return updated;
  }

  async deleteTeam(idValue: unknown): Promise<void> {
    const id = requireUuid(idValue, "team id");
    const teams = this.teams();
    if (!teams.some((team) => team.id === id))
      throw new Error("team not found");
    await this.#saveTeams(teams.filter((team) => team.id !== id));
  }

  templates(): ChannelTemplate[] {
    return this.#identity.setting<ChannelTemplate[]>(
      "channel-templates.v1",
      [],
    );
  }

  async createTemplate(
    args: Record<string, unknown>,
  ): Promise<ChannelTemplate> {
    const input = requireObject(args.input, "input");
    const now = new Date().toISOString();
    const template: ChannelTemplate = {
      agents: validateTemplateAgents(
        input.agents,
        this.personas(),
        this.teams(),
      ),
      canvas_template: optionalText(
        input.canvasTemplate,
        "canvasTemplate",
        256 * 1024,
      ),
      channel_type: parseChannelType(input.channelType),
      created_at: now,
      description: optionalText(input.description, "description", 4_096),
      id: randomUUID(),
      is_builtin: false,
      name: requireText(input.name, "name", 128),
      updated_at: now,
      visibility: parseVisibility(input.visibility),
    };
    await this.#saveTemplates([...this.templates(), template]);
    return template;
  }

  async updateTemplate(
    args: Record<string, unknown>,
  ): Promise<ChannelTemplate> {
    const input = requireObject(args.input, "input");
    const id = requireUuid(input.id, "template id");
    const templates = this.templates();
    const index = templates.findIndex((template) => template.id === id);
    const previous = templates[index];
    if (!previous) throw new Error("channel template not found");
    const updated: ChannelTemplate = {
      ...previous,
      agents: validateTemplateAgents(
        input.agents,
        this.personas(),
        this.teams(),
      ),
      canvas_template: optionalText(
        input.canvasTemplate,
        "canvasTemplate",
        256 * 1024,
      ),
      channel_type: parseChannelType(input.channelType),
      description: optionalText(input.description, "description", 4_096),
      name: requireText(input.name, "name", 128),
      updated_at: new Date().toISOString(),
      visibility: parseVisibility(input.visibility),
    };
    templates[index] = updated;
    await this.#saveTemplates(templates);
    return updated;
  }

  async deleteTemplate(idValue: unknown): Promise<void> {
    const id = requireUuid(idValue, "template id");
    const templates = this.templates();
    if (!templates.some((template) => template.id === id)) {
      throw new Error("channel template not found");
    }
    await this.#saveTemplates(
      templates.filter((template) => template.id !== id),
    );
  }

  async duplicateTemplate(idValue: unknown): Promise<ChannelTemplate> {
    const id = requireUuid(idValue, "template id");
    const source = this.templates().find((template) => template.id === id);
    if (!source) throw new Error("channel template not found");
    const now = new Date().toISOString();
    const copy = {
      ...structuredClone(source),
      created_at: now,
      id: randomUUID(),
      is_builtin: false as const,
      name: `${source.name} Copy`,
      updated_at: now,
    };
    await this.#saveTemplates([...this.templates(), copy]);
    return copy;
  }

  globalAgentConfig(): Record<string, unknown> {
    return this.#identity.setting("global-agent-config.v1", {
      env_vars: {},
      model: null,
      preferred_runtime: null,
      provider: null,
    });
  }

  async setGlobalAgentConfig(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const config = requireObject(args.config, "config");
    const saved = {
      env_vars: validateEnv(config.env_vars),
      model: optionalText(config.model, "model", 512),
      preferred_runtime: optionalText(
        config.preferred_runtime,
        "preferred_runtime",
        128,
      ),
      provider: optionalText(config.provider, "provider", 128),
    };
    await this.#identity.setSetting("global-agent-config.v1", saved);
    return { config: saved, failed_restart_count: 0, restarted_count: 0 };
  }

  async encodePersonaSnapshot(args: Record<string, unknown>): Promise<{
    fileBytes: number[];
    fileName: string;
  }> {
    const id = requireUuid(args.id, "persona id");
    const persona = this.personas().find((entry) => entry.id === id);
    if (!persona) throw new Error("persona not found");
    if (args.format !== "json") {
      throw new Error("TypeScript desktop currently exports snapshots as JSON");
    }
    const payload = Buffer.from(
      JSON.stringify({
        format: "buzz-agent-snapshot",
        memoryLevel: args.memoryLevel ?? "none",
        persona,
        version: 1,
      }),
      "utf8",
    );
    return {
      fileBytes: [...payload],
      fileName: `${safeName(persona.display_name)}.agent.json`,
    };
  }

  async encodeTeamSnapshot(args: Record<string, unknown>): Promise<{
    fileBytes: number[];
    fileName: string;
  }> {
    const id = requireUuid(args.id, "team id");
    const team = this.teams().find((entry) => entry.id === id);
    if (!team) throw new Error("team not found");
    if (args.format !== "json") {
      throw new Error("TypeScript desktop currently exports snapshots as JSON");
    }
    const personas = this.personas().filter((persona) =>
      team.persona_ids.includes(persona.id),
    );
    const payload = Buffer.from(
      JSON.stringify({
        format: "buzz-team-snapshot",
        memoryLevel: args.memoryLevel ?? "none",
        personas,
        team,
        version: 1,
      }),
      "utf8",
    );
    return {
      fileBytes: [...payload],
      fileName: `${safeName(team.name)}.team.json`,
    };
  }

  async #savePersonas(value: Persona[]): Promise<void> {
    await this.#identity.setSetting("personas.v1", value);
  }

  async #saveTeams(value: Team[]): Promise<void> {
    await this.#identity.setSetting("teams.v1", value);
  }

  async #saveTemplates(value: ChannelTemplate[]): Promise<void> {
    await this.#identity.setSetting("channel-templates.v1", value);
  }

  #personaIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 500) {
      throw new Error("personaIds must contain at most 500 IDs");
    }
    const known = new Set(this.personas().map((persona) => persona.id));
    return [...new Set(value.map((id) => requireUuid(id, "persona id")))].map(
      (id) => {
        if (!known.has(id)) throw new Error(`persona not found: ${id}`);
        return id;
      },
    );
  }
}

function validateTemplateAgents(
  value: unknown,
  personas: Persona[],
  teams: Team[],
): { personas: unknown[]; teams: unknown[] } {
  if (value === undefined || value === null) return { personas: [], teams: [] };
  const input = requireObject(value, "agents");
  const personaEntries = Array.isArray(input.personas) ? input.personas : [];
  const teamEntries = Array.isArray(input.teams) ? input.teams : [];
  if (personaEntries.length > 100 || teamEntries.length > 100) {
    throw new Error(
      "template may reference at most 100 personas and 100 teams",
    );
  }
  const personaIds = new Set(personas.map((persona) => persona.id));
  const teamIds = new Set(teams.map((team) => team.id));
  for (const entry of personaEntries) {
    const item = requireObject(entry, "persona template entry");
    if (!personaIds.has(requireUuid(item.personaId, "personaId"))) {
      throw new Error("template references an unknown persona");
    }
  }
  for (const entry of teamEntries) {
    const item = requireObject(entry, "team template entry");
    if (!teamIds.has(requireUuid(item.teamId, "teamId"))) {
      throw new Error("template references an unknown team");
    }
  }
  return {
    personas: structuredClone(personaEntries),
    teams: structuredClone(teamEntries),
  };
}

function validateEnv(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  const object = requireObject(value, "env vars");
  if (Object.keys(object).length > 256) {
    throw new Error("env vars may contain at most 256 entries");
  }
  const output: Record<string, string> = {};
  for (const [name, raw] of Object.entries(object)) {
    if (!ENV_NAME.test(name) || RESERVED_ENV.has(name)) {
      throw new Error(`environment variable is reserved or invalid: ${name}`);
    }
    if (typeof raw !== "string") throw new Error(`${name} must be a string`);
    if (Buffer.byteLength(raw, "utf8") > 16 * 1024) {
      throw new Error(`${name} exceeds the 16 KiB limit`);
    }
    if (raw.length > 0) output[name] = raw;
  }
  return output;
}

function pubkeyArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 500) {
    throw new Error("respondToAllowlist must contain at most 500 keys");
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || !/^[0-9a-f]{64}$/.test(entry)) {
      throw new Error("respondToAllowlist contains an invalid pubkey");
    }
    return entry;
  });
}

function stringArray(
  value: unknown,
  name: string,
  maximumItems: number,
  maximumBytes: number,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${name} must contain at most ${maximumItems} strings`);
  }
  return value.map((entry) => requireText(entry, name, maximumBytes));
}

function optionalRespondTo(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    !["all", "mentions", "mentions-and-allowlist", "owner-only"].includes(
      String(value),
    )
  ) {
    throw new Error("respondTo is invalid");
  }
  return String(value);
}

function optionalPositiveInteger(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 128
  ) {
    throw new Error(`${name} must be an integer from 1 to 128`);
  }
  return value;
}

function parseChannelType(value: unknown): "forum" | "stream" {
  if (value === undefined || value === null || value === "stream")
    return "stream";
  if (value === "forum") return "forum";
  throw new Error("channelType must be stream or forum");
}

function parseVisibility(value: unknown): "open" | "private" {
  if (value === undefined || value === null || value === "open") return "open";
  if (value === "private") return "private";
  throw new Error("visibility must be open or private");
}

function optionalHttpUrl(value: unknown, name: string): string | null {
  const text =
    typeof value === "string" && value.startsWith("data:image/")
      ? requireStringWithin(value, name, 3 * 1024 * 1024)
      : optionalText(value, name, 2_048);
  if (!text) return text;
  if (
    /^data:image\/(?:png|jpeg|gif|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/i.test(
      text,
    )
  ) {
    return text;
  }
  const url = new URL(text);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials`);
  }
  return text;
}

function optionalText(
  value: unknown,
  name: string,
  maximumBytes: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireText(value, name, maximumBytes);
}

function requireText(
  value: unknown,
  name: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${name} exceeds the ${maximumBytes} byte limit`);
  }
  return value;
}

function requireStringWithin(
  value: unknown,
  name: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${name} exceeds the ${maximumBytes} byte limit`);
  }
  return value;
}

function requireUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> | null {
  return value === undefined || value === null
    ? null
    : requireObject(value, "behavior");
}

function safeName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "snapshot"
  );
}
