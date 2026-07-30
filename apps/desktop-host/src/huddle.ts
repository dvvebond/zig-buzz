import { randomUUID } from "node:crypto";

import {
  buildAddMember,
  buildArchive,
  buildCreateChannel,
  buildHuddleEnded,
  buildHuddleGuidelines,
  buildHuddleStarted,
  buildLeave,
  buildRemoveMember,
  type EventTemplate,
} from "@buzz/sdk";

import type { ChannelService } from "./channels.js";
import type { DesktopEventBus } from "./event-bus.js";
import type { IdentityService } from "./identity.js";
import type { RelayHttpClient } from "./relay-http.js";
import type { WorkspaceService } from "./workspace.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBKEY = /^[0-9a-f]{64}$/;
const MAX_AGENTS = 20;
const MAX_ROSTER = 255;

export type HuddlePhase =
  | "idle"
  | "creating"
  | "connecting"
  | "connected"
  | "active"
  | "leaving";

export type VoiceInputMode = "push_to_talk" | "voice_activity";

export type HuddleState = {
  agent_pubkeys: string[];
  ephemeral_channel_id: string | null;
  is_creator: boolean;
  parent_channel_id: string | null;
  participants: string[];
  phase: HuddlePhase;
  transcription_enabled: boolean;
  tts_enabled: boolean;
  voice_input_mode: VoiceInputMode;
};

export type HuddleAudioConfig = {
  audio_url: string;
  ephemeral_channel_id: string;
  parent_channel_id: string;
  relay_url: string;
};

/**
 * Authoritative huddle lifecycle state.
 *
 * Media remains in the renderer, where WebCodecs and Web Audio can process
 * real-time frames without routing high-rate PCM through JSON IPC. This
 * service alone signs channel and lifecycle events.
 */
export class HuddleService {
  readonly #channels: Pick<ChannelService, "members">;
  readonly #events: DesktopEventBus;
  readonly #identity: IdentityService;
  readonly #relay: Pick<RelayHttpClient, "publish">;
  readonly #workspace: Pick<WorkspaceService, "relayUrl">;
  #state: HuddleState = defaultState();
  #generation = 0;

  constructor(input: {
    channels: Pick<ChannelService, "members">;
    events: DesktopEventBus;
    identity: IdentityService;
    relay: Pick<RelayHttpClient, "publish">;
    workspace: Pick<WorkspaceService, "relayUrl">;
  }) {
    this.#channels = input.channels;
    this.#events = input.events;
    this.#identity = input.identity;
    this.#relay = input.relay;
    this.#workspace = input.workspace;
  }

  state(): HuddleState {
    return structuredClone(this.#state);
  }

  async start(args: Record<string, unknown>): Promise<{
    ephemeral_channel_id: string;
  }> {
    const parentChannelId = requireUuid(
      args.parentChannelId,
      "parentChannelId",
    );
    const agents = requirePubkeyList(args.memberPubkeys, MAX_AGENTS);
    if (this.#state.phase !== "idle") {
      throw new Error(
        `cannot start huddle: already in phase ${this.#state.phase}`,
      );
    }

    const generation = ++this.#generation;
    this.#state = {
      ...defaultState(),
      parent_channel_id: parentChannelId,
      phase: "creating",
    };
    this.#emitState();

    const ephemeralChannelId = randomUUID();
    const fallbackName = `huddle-${ephemeralChannelId.slice(0, 8)}`;
    const channelName = normalizeChannelName(args.channelName, fallbackName);
    let created = false;
    try {
      await this.#publish(
        buildCreateChannel({
          channelId: ephemeralChannelId,
          channelType: "stream",
          name: channelName,
          ttl: 3_600,
          visibility: "private",
        }),
      );
      created = true;

      try {
        await this.#publish(
          buildHuddleGuidelines(
            ephemeralChannelId,
            voiceModeGuidelines(parentChannelId),
          ),
        );
      } catch {
        // Guidelines are advisory and must not strand an otherwise valid room.
      }

      const enrolled: string[] = [];
      for (const pubkey of agents) {
        try {
          await this.#publish(
            buildAddMember(ephemeralChannelId, pubkey, "bot"),
          );
          enrolled.push(pubkey);
        } catch {
          // Relay policy may reject an individual agent; other agents proceed.
        }
      }
      await this.#publish(
        buildHuddleStarted(parentChannelId, ephemeralChannelId),
      );

      if (generation !== this.#generation) {
        throw new Error("huddle start was superseded");
      }
      this.#state = {
        ...defaultState(),
        agent_pubkeys: enrolled,
        ephemeral_channel_id: ephemeralChannelId,
        is_creator: true,
        parent_channel_id: parentChannelId,
        participants: unique([this.#identity.info().pubkey, ...enrolled]),
        phase: "connected",
      };
      this.#emitState();
      return { ephemeral_channel_id: ephemeralChannelId };
    } catch (error) {
      if (created) {
        await this.#publishBestEffort(buildArchive(ephemeralChannelId));
      }
      if (generation === this.#generation) {
        this.#reset();
      }
      throw error;
    }
  }

  async join(args: Record<string, unknown>): Promise<{
    ephemeral_channel_id: string;
  }> {
    const parentChannelId = requireUuid(
      args.parentChannelId,
      "parentChannelId",
    );
    const ephemeralChannelId = requireUuid(
      args.ephemeralChannelId,
      "ephemeralChannelId",
    );
    if (this.#state.phase !== "idle") {
      throw new Error(
        `cannot join huddle: already in phase ${this.#state.phase}`,
      );
    }
    ++this.#generation;
    this.#state = {
      ...defaultState(),
      ephemeral_channel_id: ephemeralChannelId,
      parent_channel_id: parentChannelId,
      participants: [this.#identity.info().pubkey],
      phase: "connecting",
    };
    this.#emitState();

    try {
      const agents = await this.#agentPubkeys(ephemeralChannelId).catch(
        () => [],
      );
      this.#state = {
        ...this.#state,
        agent_pubkeys: agents,
        phase: "connected",
      };
      this.#emitState();
      return { ephemeral_channel_id: ephemeralChannelId };
    } catch (error) {
      this.#reset();
      throw error;
    }
  }

  confirmActive(): void {
    if (this.#state.phase === "active") return;
    if (this.#state.phase !== "connected") {
      throw new Error(`cannot confirm active: phase is ${this.#state.phase}`);
    }
    this.#state.phase = "active";
    this.#emitState();
  }

  async leave(): Promise<void> {
    if (this.#state.phase === "idle") return;
    const parent = this.#state.parent_channel_id;
    const ephemeral = this.#state.ephemeral_channel_id;
    this.#state.phase = "leaving";
    this.#emitState();

    if (parent && ephemeral) {
      let humanCount = 2;
      try {
        const members = await this.#channels.members(ephemeral);
        humanCount = members.members.filter(
          (member) => member.role !== "bot" && !member.is_agent,
        ).length;
      } catch {
        // Fail safe: a transient read must never archive other users' room.
      }
      if (humanCount <= 1) {
        await this.#endAndArchive(parent, ephemeral);
      } else {
        await this.#publishBestEffort(buildLeave(ephemeral));
      }
    }
    this.#reset();
  }

  async end(args: Record<string, unknown>): Promise<void> {
    if (this.#state.phase === "idle") return;
    if (!this.#state.is_creator && args.force !== true) {
      throw new Error(
        "only the huddle creator can end it — use leave_huddle instead",
      );
    }
    const parent = this.#state.parent_channel_id;
    const ephemeral = this.#state.ephemeral_channel_id;
    this.#state.phase = "leaving";
    this.#emitState();
    if (parent && ephemeral) await this.#endAndArchive(parent, ephemeral);
    this.#reset();
  }

  audioConfig(): HuddleAudioConfig {
    if (
      !["connected", "active"].includes(this.#state.phase) ||
      !this.#state.parent_channel_id ||
      !this.#state.ephemeral_channel_id
    ) {
      throw new Error("no active huddle");
    }
    const relayUrl = validateAudioRelay(this.#workspace.relayUrl());
    const audio = new URL(relayUrl);
    audio.pathname = `${audio.pathname.replace(/\/+$/, "")}/huddle/${this.#state.ephemeral_channel_id}/audio`;
    return {
      audio_url: audio.toString(),
      ephemeral_channel_id: this.#state.ephemeral_channel_id,
      parent_channel_id: this.#state.parent_channel_id,
      relay_url: relayUrl,
    };
  }

  reconnectConfig(): HuddleAudioConfig {
    return this.audioConfig();
  }

  async agentPubkeys(): Promise<string[]> {
    const ephemeral = this.#state.ephemeral_channel_id;
    if (!ephemeral) return [];
    const agents = await this.#agentPubkeys(ephemeral);
    this.#state.agent_pubkeys = agents;
    return [...agents];
  }

  async addAgent(agentPubkeyValue: unknown): Promise<{
    ephemeral_added: true;
    parent_added: boolean;
    parent_error: string | null;
  }> {
    const agentPubkey = requirePubkey(agentPubkeyValue, "agentPubkey");
    if (
      !["connected", "active"].includes(this.#state.phase) ||
      !this.#state.ephemeral_channel_id ||
      !this.#state.parent_channel_id
    ) {
      throw new Error("no active huddle");
    }
    if (
      !this.#state.agent_pubkeys.includes(agentPubkey) &&
      this.#state.agent_pubkeys.length >= MAX_AGENTS
    ) {
      throw new Error(`agent limit reached: ${MAX_AGENTS} (max ${MAX_AGENTS})`);
    }
    await this.#publish(
      buildAddMember(this.#state.ephemeral_channel_id, agentPubkey, "bot"),
    );
    let parentAdded = true;
    let parentError: string | null = null;
    try {
      await this.#publish(
        buildAddMember(this.#state.parent_channel_id, agentPubkey, "bot"),
      );
    } catch (error) {
      parentAdded = false;
      parentError = safeError(error);
    }
    this.#state.agent_pubkeys = unique([
      ...this.#state.agent_pubkeys,
      agentPubkey,
    ]);
    this.#state.participants = unique([
      ...this.#state.participants,
      agentPubkey,
    ]);
    this.#emitState();
    return {
      ephemeral_added: true,
      parent_added: parentAdded,
      parent_error: parentError,
    };
  }

  syncRoster(args: Record<string, unknown>): void {
    const ephemeral = requireUuid(
      args.ephemeralChannelId,
      "ephemeralChannelId",
    );
    if (ephemeral !== this.#state.ephemeral_channel_id) {
      throw new Error("huddle roster is for a stale session");
    }
    const participants = requirePubkeyList(args.participants, MAX_ROSTER);
    this.#state.participants = participants;
    this.#emitState();
  }

  setTtsEnabled(value: unknown): void {
    this.#state.tts_enabled = requireBoolean(value, "enabled");
    this.#emitState();
  }

  requestSpeech(value: unknown): void {
    if (typeof value !== "string") throw new Error("text must be a string");
    const text = [...value.trim()].slice(0, 2_000).join("");
    if (
      !text ||
      !this.#state.tts_enabled ||
      !["connected", "active"].includes(this.#state.phase)
    ) {
      return;
    }
    this.#events.emit("huddle-speak-request", { text });
  }

  setTranscriptionEnabled(value: unknown): void {
    this.#state.transcription_enabled = requireBoolean(value, "enabled");
    this.#emitState();
  }

  setVoiceInputMode(value: unknown): void {
    if (value !== "push_to_talk" && value !== "voice_activity") {
      throw new Error("mode must be push_to_talk or voice_activity");
    }
    this.#state.voice_input_mode = value;
    this.#emitState();
  }

  voiceInputMode(): VoiceInputMode {
    return this.#state.voice_input_mode;
  }

  pipelineStatus(): { stt: string; tts: string } {
    return { stt: "browser", tts: "browser" };
  }

  #emitState(): void {
    this.#events.emit("huddle-state-changed", this.state());
  }

  #reset(): void {
    ++this.#generation;
    this.#state = defaultState();
    this.#emitState();
  }

  async #agentPubkeys(ephemeral: string): Promise<string[]> {
    const members = await this.#channels.members(ephemeral);
    return unique(
      members.members
        .filter((member) => member.role === "bot" || member.is_agent)
        .map((member) => member.pubkey),
    );
  }

  async #endAndArchive(parent: string, ephemeral: string): Promise<void> {
    await this.#publishBestEffort(buildHuddleEnded(parent, ephemeral));
    try {
      const members = await this.#channels.members(ephemeral);
      for (const member of members.members) {
        if (member.role === "bot" || member.is_agent) {
          await this.#publishBestEffort(
            buildRemoveMember(ephemeral, member.pubkey),
          );
        }
      }
    } catch {
      // Archive is authoritative; cleanup is defense-in-depth.
    }
    await this.#publishBestEffort(buildArchive(ephemeral));
  }

  async #publish(template: EventTemplate): Promise<void> {
    const event = this.#identity.sign(
      template as unknown as Record<string, unknown>,
    );
    await this.#relay.publish(event);
  }

  async #publishBestEffort(template: EventTemplate): Promise<void> {
    try {
      await this.#publish(template);
    } catch {
      // Teardown must remain idempotent and release local media state.
    }
  }
}

function defaultState(): HuddleState {
  return {
    agent_pubkeys: [],
    ephemeral_channel_id: null,
    is_creator: false,
    parent_channel_id: null,
    participants: [],
    phase: "idle",
    transcription_enabled: false,
    tts_enabled: true,
    voice_input_mode: "voice_activity",
  };
}

function requireUuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function requirePubkey(value: unknown, name: string): string {
  if (typeof value !== "string" || !PUBKEY.test(value)) {
    throw new Error(`${name} must be a lowercase 64-character hex pubkey`);
  }
  return value;
}

function requirePubkeyList(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`pubkey list must contain at most ${maximum} entries`);
  }
  return unique(value.map((entry) => requirePubkey(entry, "pubkey")));
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function normalizeChannelName(value: unknown, fallback: string): string {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new Error("channelName must be a string");
  }
  const normalized = (typeof value === "string" ? value : "")
    .trim()
    .replace(/\s+/g, " ");
  return [...(normalized || fallback)].slice(0, 80).join("");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function validateAudioRelay(value: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (
    (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("huddle audio relay must use WSS (or loopback WS)");
  }
  return url.toString().replace(/\/$/, "");
}

function voiceModeGuidelines(parentChannelId: string): string {
  return `You are in a live voice huddle attached to channel ${parentChannelId}.
Your text is read aloud via TTS, message by message, in the order sent.

Latency matters most: reply immediately. Send each finished sentence as its
own message instead of holding it for a longer reply.

- If you are not addressed or relevant, do not respond.
- Keep replies brief and conversational. Avoid markdown and code blocks.
- Before a tool call, say one short sentence; then summarize the key finding.
- If interrupted by a new human message, drop unsent sentences and respond to it.
- In multi-agent huddles, identify yourself only when needed.`;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
