import type { AgentMemoryService } from "./memory.js";
import type { LocalEntityService, Persona } from "./local-entities.js";
import type { ManagedAgentService } from "./managed-agents.js";
import type { DesktopMediaService } from "./media.js";
import {
  decodeAgentSnapshot,
  decodeTeamSnapshot,
  encodeAgentSnapshot,
  encodeTeamSnapshot,
  startsWithPng,
  type AgentSnapshot,
  type SnapshotFormat,
  type SnapshotMemoryLevel,
  type TeamSnapshot,
} from "./snapshots.js";

export class SnapshotService {
  readonly #localEntities: LocalEntityService;
  readonly #managedAgents: ManagedAgentService;
  readonly #media: DesktopMediaService;
  readonly #memory: AgentMemoryService;

  constructor(input: {
    readonly localEntities: LocalEntityService;
    readonly managedAgents: ManagedAgentService;
    readonly media: DesktopMediaService;
    readonly memory: AgentMemoryService;
  }) {
    this.#localEntities = input.localEntities;
    this.#managedAgents = input.managedAgents;
    this.#media = input.media;
    this.#memory = input.memory;
  }

  async encodeAgent(args: Record<string, unknown>): Promise<{
    fileBytes: number[];
    fileName: string;
  }> {
    const format = parseFormat(args.format);
    const memoryLevel = parseMemoryLevel(args.memoryLevel);
    const source = this.#agentSource(args.id);
    const memorySource =
      memoryLevel === "none"
        ? undefined
        : requirePubkey(args.memorySourcePubkey, "memorySourcePubkey");
    if (
      memorySource &&
      (!this.#managedAgents.owns(memorySource) ||
        this.#managedSummary(memorySource)?.persona_id !== source.persona.id)
    ) {
      throw new Error("memory source does not belong to the selected persona");
    }
    const entries = memorySource
      ? await this.#memory.snapshotEntries(memorySource, memoryLevel)
      : [];
    const snapshot = personaSnapshot(source.persona, memoryLevel, entries);
    const avatarPngDataUrl =
      typeof args.avatarPngDataUrl === "string"
        ? args.avatarPngDataUrl
        : source.persona.avatar_url?.startsWith("data:image/")
          ? source.persona.avatar_url
          : undefined;
    const bytes = await encodeAgentSnapshot(snapshot, format, avatarPngDataUrl);
    enforceEncodedLimit(bytes, "agent", format);
    return {
      fileBytes: [...bytes],
      fileName: `${safeName(source.persona.display_name)}.agent.${format}`,
    };
  }

  async exportAgent(args: Record<string, unknown>): Promise<boolean> {
    const payload = await this.encodeAgent(args);
    return this.#media.saveBytes(payload.fileName, payload.fileBytes);
  }

  async previewAgent(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const fileName = requireString(args.fileName, "fileName");
    if (
      fileName.toLowerCase().endsWith(".persona.json") ||
      fileName.toLowerCase().endsWith(".persona.png")
    ) {
      throw new Error(
        "Legacy persona snapshots are unsupported; import a .agent.json or .agent.png snapshot",
      );
    }
    const snapshot = await decodeAgentSnapshot(
      snapshotBytes(args.fileBytes, "agent"),
    );
    const allowlist = snapshot.definition.respondToAllowlist ?? [];
    return {
      avatarUrl:
        snapshot.profile.avatarDataUrl ?? snapshot.profile.avatarUrl ?? null,
      displayName: snapshot.profile.displayName,
      hasSourceAllowlist: allowlist.length > 0,
      memoryEntryCount: snapshot.memory.entries.length,
      memoryLevel: snapshot.memory.level,
      sourceAllowlistCount: allowlist.length,
      systemPrompt: snapshot.definition.systemPrompt ?? null,
    };
  }

  async confirmAgent(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const input = object(args.input, "input");
    const keepAllowlist = requireBoolean(input.keepAllowlist, "keepAllowlist");
    const snapshot = await decodeAgentSnapshot(
      snapshotBytes(input.fileBytes, "agent"),
    );
    const persona = await this.#createPersona(snapshot, keepAllowlist);
    let created: Record<string, unknown> | undefined;
    try {
      created = await this.#createManagedAgent(
        snapshot,
        persona.id,
        keepAllowlist,
      );
    } catch (error) {
      await this.#localEntities
        .deletePersona(persona.id)
        .catch(() => undefined);
      throw error;
    }
    const agent = object(created.agent, "created agent");
    const pubkey = requirePubkey(agent.pubkey, "created agent pubkey");
    const restored = await this.#memory.restore(
      pubkey,
      snapshot.memory.entries,
    );
    return {
      displayName: snapshot.profile.displayName,
      memoryErrors: restored.errors,
      memoryTotal: snapshot.memory.entries.length,
      memoryWritten: restored.written,
      newPubkey: pubkey,
      personaId: persona.id,
      profileSyncError:
        typeof created.profile_sync_error === "string"
          ? created.profile_sync_error
          : null,
    };
  }

  async encodeTeam(args: Record<string, unknown>): Promise<{
    fileBytes: number[];
    fileName: string;
  }> {
    const id = requireString(args.id, "id");
    const format = parseFormat(args.format);
    const memoryLevel = parseMemoryLevel(args.memoryLevel);
    const team = this.#localEntities.teams().find((entry) => entry.id === id);
    if (!team) throw new Error("team not found");
    const members: AgentSnapshot[] = [];
    for (const personaId of team.persona_ids) {
      const persona = this.#localEntities
        .personas()
        .find((entry) => entry.id === personaId);
      if (!persona) throw new Error(`team persona is missing: ${personaId}`);
      const managed = this.#managedAgents
        .list()
        .find((entry) => entry.persona_id === personaId);
      if (memoryLevel !== "none" && !managed) {
        throw new Error(
          `persona ${persona.display_name} has no managed instance for memory export`,
        );
      }
      const entries =
        memoryLevel === "none"
          ? []
          : await this.#memory.snapshotEntries(managed?.pubkey, memoryLevel);
      members.push(personaSnapshot(persona, memoryLevel, entries));
    }
    const snapshot: TeamSnapshot = {
      format: "buzz-team-snapshot",
      members,
      team: {
        ...(team.description ? { description: team.description } : {}),
        ...(team.instructions ? { instructions: team.instructions } : {}),
        name: team.name,
      },
      version: 1,
    };
    const bytes = await encodeTeamSnapshot(snapshot, format);
    enforceEncodedLimit(bytes, "team", format);
    return {
      fileBytes: [...bytes],
      fileName: `${safeName(team.name)}.team.${format}`,
    };
  }

  async exportTeam(args: Record<string, unknown>): Promise<boolean> {
    const payload = await this.encodeTeam(args);
    return this.#media.saveBytes(payload.fileName, payload.fileBytes);
  }

  async previewTeam(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const snapshot = await decodeTeamSnapshot(
      snapshotBytes(args.fileBytes, "team"),
    );
    const members = snapshot.members.map((member) => {
      const allowlist = member.definition.respondToAllowlist ?? [];
      return {
        avatarUrl:
          member.profile.avatarDataUrl ?? member.profile.avatarUrl ?? null,
        displayName: member.profile.displayName,
        hasSourceAllowlist: allowlist.length > 0,
        sourceAllowlistCount: allowlist.length,
        systemPrompt: member.definition.systemPrompt ?? null,
      };
    });
    return {
      description: snapshot.team.description ?? null,
      hasSourceAllowlist: members.some((member) => member.hasSourceAllowlist),
      instructions: snapshot.team.instructions ?? null,
      members,
      name: snapshot.team.name,
    };
  }

  async confirmTeam(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const input = object(args.input, "input");
    const keepAllowlist = requireBoolean(input.keepAllowlist, "keepAllowlist");
    const snapshot = await decodeTeamSnapshot(
      snapshotBytes(input.fileBytes, "team"),
    );
    const personas: Persona[] = [];
    const pubkeys: string[] = [];
    let team: ReturnType<LocalEntityService["teams"]>[number] | undefined;
    try {
      for (const member of snapshot.members) {
        personas.push(await this.#createPersona(member, keepAllowlist));
      }
      team = await this.#localEntities.createTeam({
        input: {
          description: snapshot.team.description ?? null,
          instructions: snapshot.team.instructions ?? null,
          name: snapshot.team.name,
          personaIds: personas.map((persona) => persona.id),
        },
      });
      const members: Record<string, unknown>[] = [];
      for (const [index, member] of snapshot.members.entries()) {
        const persona = personas[index];
        if (!persona) throw new Error("team snapshot member indexing failed");
        const created = await this.#createManagedAgent(
          member,
          persona.id,
          keepAllowlist,
          team.id,
        );
        const agent = object(created.agent, "created agent");
        const pubkey = requirePubkey(agent.pubkey, "created agent pubkey");
        pubkeys.push(pubkey);
        const restored = await this.#memory.restore(
          pubkey,
          member.memory.entries,
        );
        members.push({
          displayName: member.profile.displayName,
          memoryErrors: restored.errors,
          memoryTotal: member.memory.entries.length,
          memoryWritten: restored.written,
          personaId: persona.id,
          profileSyncError:
            typeof created.profile_sync_error === "string"
              ? created.profile_sync_error
              : null,
          pubkey,
        });
      }
      return {
        members,
        personaIds: personas.map((persona) => persona.id),
        team,
      };
    } catch (error) {
      for (const pubkey of pubkeys.reverse()) {
        await this.#managedAgents.remove(pubkey).catch(() => undefined);
      }
      if (team) {
        await this.#localEntities.deleteTeam(team.id).catch(() => undefined);
      }
      for (const persona of personas.reverse()) {
        await this.#localEntities
          .deletePersona(persona.id)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  #agentSource(idValue: unknown): { readonly persona: Persona } {
    const id = requireString(idValue, "id");
    const direct = this.#localEntities
      .personas()
      .find((persona) => persona.id === id);
    if (direct) return { persona: direct };
    const managed = this.#managedSummary(id);
    const personaId =
      managed && typeof managed.persona_id === "string"
        ? managed.persona_id
        : undefined;
    const persona = personaId
      ? this.#localEntities.personas().find((entry) => entry.id === personaId)
      : undefined;
    if (!persona) throw new Error("agent snapshot source not found");
    return { persona };
  }

  #managedSummary(pubkey: string): Record<string, unknown> | undefined {
    return this.#managedAgents
      .list()
      .find((record) => record.pubkey === pubkey);
  }

  #createPersona(
    snapshot: AgentSnapshot,
    keepAllowlist: boolean,
  ): Promise<Persona> {
    return this.#localEntities.createPersona({
      input: {
        avatarUrl:
          snapshot.profile.avatarDataUrl ?? snapshot.profile.avatarUrl ?? null,
        behavior: {
          parallelism: snapshot.definition.parallelism ?? null,
          respondTo: personaRespondTo(snapshot.definition.respondTo),
          respondToAllowlist: keepAllowlist
            ? (snapshot.definition.respondToAllowlist ?? [])
            : [],
        },
        displayName: snapshot.profile.displayName,
        envVars: {},
        model: snapshot.definition.model ?? null,
        namePool: snapshot.definition.namePool ?? [],
        provider: snapshot.definition.provider ?? null,
        runtime: snapshot.definition.runtime ?? null,
        systemPrompt: snapshot.definition.systemPrompt ?? "",
      },
    });
  }

  #createManagedAgent(
    snapshot: AgentSnapshot,
    personaId: string,
    keepAllowlist: boolean,
    teamId?: string,
  ): Promise<Record<string, unknown>> {
    const allowlist = keepAllowlist
      ? (snapshot.definition.respondToAllowlist ?? [])
      : [];
    const respondTo =
      snapshot.definition.respondTo === "allowlist" && allowlist.length === 0
        ? "owner-only"
        : (snapshot.definition.respondTo ?? "owner-only");
    return this.#managedAgents.create({
      input: {
        avatarUrl:
          snapshot.profile.avatarDataUrl ?? snapshot.profile.avatarUrl ?? null,
        backend: { type: "local" },
        idleTimeoutSeconds: snapshot.definition.idleTimeoutSeconds ?? null,
        maxTurnDurationSeconds:
          snapshot.definition.maxTurnDurationSeconds ?? null,
        model: snapshot.definition.model ?? null,
        name: snapshot.profile.displayName,
        parallelism: snapshot.definition.parallelism ?? 1,
        personaId,
        provider: snapshot.definition.provider ?? null,
        respondTo,
        respondToAllowlist: allowlist,
        spawnAfterCreate: false,
        startOnAppLaunch: false,
        systemPrompt: snapshot.definition.systemPrompt ?? "",
        ...(teamId ? { teamId } : {}),
      },
    });
  }
}

function personaSnapshot(
  persona: Persona,
  memoryLevel: SnapshotMemoryLevel,
  entries: readonly { readonly slug: string; readonly body: string }[],
): AgentSnapshot {
  const respondTo = snapshotRespondTo(persona.respond_to);
  const avatar = persona.avatar_url;
  return {
    definition: {
      name: persona.display_name,
      ...(persona.system_prompt ? { systemPrompt: persona.system_prompt } : {}),
      ...(persona.runtime ? { runtime: persona.runtime } : {}),
      ...(persona.model ? { model: persona.model } : {}),
      ...(persona.provider ? { provider: persona.provider } : {}),
      ...(persona.parallelism ? { parallelism: persona.parallelism } : {}),
      ...(respondTo ? { respondTo } : {}),
      ...(persona.respond_to_allowlist.length > 0
        ? { respondToAllowlist: persona.respond_to_allowlist }
        : {}),
      ...(persona.name_pool.length > 0 ? { namePool: persona.name_pool } : {}),
    },
    format: "buzz-agent-snapshot",
    memory: { entries, level: memoryLevel },
    profile: {
      displayName: persona.display_name,
      ...(avatar?.startsWith("data:image/")
        ? { avatarDataUrl: avatar }
        : avatar
          ? { avatarUrl: avatar }
          : {}),
    },
    version: 1,
  };
}

function parseFormat(value: unknown): SnapshotFormat {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "json"
  ) {
    return "json";
  }
  if (value === "png") return "png";
  throw new Error("format must be json or png");
}

function parseMemoryLevel(value: unknown): SnapshotMemoryLevel {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "none"
  ) {
    return "none";
  }
  if (value === "core" || value === "everything") return value;
  throw new Error("memoryLevel must be none, core, or everything");
}

function snapshotBytes(value: unknown, type: "agent" | "team"): Uint8Array {
  const maximum = type === "agent" ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) bytes = value;
  else if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= maximum &&
    value.every(
      (byte) =>
        Number.isInteger(byte) &&
        (byte as number) >= 0 &&
        (byte as number) <= 255,
    )
  ) {
    bytes = Uint8Array.from(value as number[]);
  } else {
    throw new Error("fileBytes must be a bounded byte array");
  }
  const cap = startsWithPng(bytes)
    ? maximum
    : type === "agent"
      ? 5 * 1024 * 1024
      : 25 * 1024 * 1024;
  if (bytes.byteLength === 0 || bytes.byteLength > cap) {
    throw new Error(`${type} snapshot exceeds its format size limit`);
  }
  return bytes;
}

function enforceEncodedLimit(
  bytes: Uint8Array,
  type: "agent" | "team",
  format: SnapshotFormat,
): void {
  const maximum =
    type === "agent"
      ? format === "png"
        ? 10 * 1024 * 1024
        : 5 * 1024 * 1024
      : format === "png"
        ? 50 * 1024 * 1024
        : 25 * 1024 * 1024;
  if (bytes.byteLength > maximum) {
    throw new Error(
      `${type} snapshot exceeds the ${maximum / (1024 * 1024)} MiB limit`,
    );
  }
}

function personaRespondTo(
  value: AgentSnapshot["definition"]["respondTo"],
): string | null {
  if (value === "anyone") return "all";
  if (value === "allowlist") return "mentions-and-allowlist";
  return value ?? null;
}

function snapshotRespondTo(
  value: string | null,
): AgentSnapshot["definition"]["respondTo"] | undefined {
  if (value === "all") return "anyone";
  if (value === "mentions-and-allowlist") return "allowlist";
  if (value === "owner-only") return "owner-only";
  return undefined;
}

function safeName(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "snapshot"
  );
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function requirePubkey(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.toLowerCase())
  ) {
    throw new Error(`${name} must be 64 hexadecimal characters`);
  }
  return value.toLowerCase();
}
