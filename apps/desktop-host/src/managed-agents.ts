import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactSensitiveText } from "@buzz/remote-agent-protocol";
import type { EventTemplate } from "@buzz/sdk";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
  type Event,
} from "nostr-tools";

import type { IdentityService } from "./identity.js";
import type { LocalEntityService } from "./local-entities.js";
import type { NestService } from "./nest.js";
import { RelayHttpClient } from "./relay-http.js";
import type { RuntimeCatalogService } from "./runtime-catalog.js";

const ACP_CLI = fileURLToPath(import.meta.resolve("@buzz/acp/cli"));
const BUILT_IN_AGENT_CLI = fileURLToPath(
  import.meta.resolve("@buzz/agent/cli"),
);
const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_LOG_BYTES = 256 * 1024;
const MAX_LOG_LINES = 2_000;
const STORE_KEY = "managed-agents.v1";
const RESERVED_ENV = new Set([
  "BUZZ_PRIVATE_KEY",
  "BUZZ_AUTH_TAG",
  "BUZZ_ACP_AGENT_OWNER",
  "BUZZ_ACP_RESPOND_TO",
  "BUZZ_ACP_RESPOND_TO_ALLOWLIST",
  "BUZZ_REMOTE_TOKEN",
  "BUZZ_REMOTE_WORKER_PRIVATE_KEY",
]);

type Backend =
  | { type: "local" }
  | { type: "provider"; id: string; config: Record<string, unknown> };
type RespondTo = "owner-only" | "allowlist" | "anyone";

type AgentRecord = {
  acpCommand: string;
  agentArgs: string[];
  agentCommand: string;
  agentCommandOverride: string | null;
  authTag: [string, string, string, string];
  autoRestartOnConfigChange: boolean;
  avatarUrl: string | null;
  backend: Backend;
  backendAgentId: string | null;
  createdAt: string;
  envVars: Record<string, string>;
  idleTimeoutSeconds: number | null;
  lastError: string | null;
  lastErrorCode: number | null;
  lastExitCode: number | null;
  lastStartedAt: string | null;
  lastStoppedAt: string | null;
  maxTurnDurationSeconds: number | null;
  mcpCommand: string;
  model: string | null;
  name: string;
  parallelism: number;
  personaId: string | null;
  personaSourceVersion: string | null;
  privateKeyHex: string;
  provider: string | null;
  pubkey: string;
  relayUrl: string;
  respondTo: RespondTo;
  respondToAllowlist: string[];
  runtime: string | null;
  startOnAppLaunch: boolean;
  systemPrompt: string | null;
  teamId: string | null;
  turnTimeoutSeconds: number;
  updatedAt: string;
};

type Runtime = {
  child: ChildProcess;
  error: string | null;
  lifecycle: "starting" | "listening" | "waking" | "ready" | "failed";
  logPath: string;
  startNonce: string;
  stopping: boolean;
};

export class ManagedAgentService {
  readonly #dataDirectory: string;
  #defaultRelayUrl: string;
  readonly #identity: IdentityService;
  readonly #localEntities: LocalEntityService;
  readonly #nest:
    | Pick<NestService, "ensure" | "regenerate" | "root">
    | undefined;
  readonly #runtimeCatalog: RuntimeCatalogService | undefined;
  readonly #processes = new Map<string, Runtime>();
  readonly #sessionConfig = new Map<string, Record<string, unknown>>();
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(input: {
    dataDirectory: string;
    defaultRelayUrl: string;
    identity: IdentityService;
    localEntities: LocalEntityService;
    nest?: Pick<NestService, "ensure" | "regenerate" | "root">;
    runtimeCatalog?: RuntimeCatalogService;
  }) {
    this.#dataDirectory = path.resolve(input.dataDirectory, "managed-agents");
    this.#defaultRelayUrl = normalizeRelayUrl(input.defaultRelayUrl);
    this.#identity = input.identity;
    this.#localEntities = input.localEntities;
    this.#nest = input.nest;
    this.#runtimeCatalog = input.runtimeCatalog;
  }

  async setWorkspaceRelayUrl(
    relayUrl: string,
    forceRestart = false,
  ): Promise<void> {
    const next = normalizeRelayUrl(relayUrl);
    if (next === this.#defaultRelayUrl && !forceRestart) return;
    const running = [...this.#processes.entries()]
      .filter(([, runtime]) => isAlive(runtime.child))
      .map(([pubkey]) => pubkey);
    this.#defaultRelayUrl = next;
    for (const pubkey of running) {
      try {
        await this.stop(pubkey);
        await this.start(pubkey);
      } catch (error) {
        await this.#patch(pubkey, {
          lastError: `workspace relay switch failed: ${safeError(error)}`,
        }).catch(() => undefined);
      }
    }
    await this.#refreshNest();
  }

  async rebindOwnerAuthorization(): Promise<void> {
    const records = this.#records().map((record) => ({
      ...record,
      authTag: this.#identity.ownerAuthTag(record.pubkey),
      updatedAt: new Date().toISOString(),
    }));
    await this.#save(records);
  }

  list(): Array<Record<string, unknown>> {
    return this.#records().map((record) => this.#summary(record));
  }

  owns(pubkey: unknown): boolean {
    return (
      typeof pubkey === "string" &&
      HEX_PUBKEY.test(pubkey) &&
      this.#records().some((record) => record.pubkey === pubkey)
    );
  }

  async applyInboundProjection(
    pubkeyValue: unknown,
    projection: {
      model: string | null | undefined;
      name: string;
      parallelism: number;
      personaId: string | null;
      personaSourceVersion: string | null | undefined;
      provider: string | null | undefined;
      respondTo: RespondTo;
      respondToAllowlist: string[];
      systemPrompt: string | null | undefined;
    },
  ): Promise<boolean> {
    const pubkey = requirePubkey(pubkeyValue);
    const records = this.#records();
    const index = records.findIndex((record) => record.pubkey === pubkey);
    const previous = records[index];
    if (!previous) return false;
    const definitionLinked = projection.personaId !== null;
    records[index] = {
      ...previous,
      name: projection.name,
      parallelism: projection.parallelism,
      personaId: projection.personaId,
      respondTo: projection.respondTo,
      respondToAllowlist: [...projection.respondToAllowlist],
      updatedAt: new Date().toISOString(),
      ...(definitionLinked
        ? {}
        : {
            model: projection.model ?? null,
            personaSourceVersion: projection.personaSourceVersion ?? null,
            provider: projection.provider ?? null,
            systemPrompt: projection.systemPrompt ?? null,
          }),
    };
    await this.#save(records);
    return true;
  }

  async removeInbound(pubkeyValue: unknown): Promise<boolean> {
    const pubkey = requirePubkey(pubkeyValue);
    const records = this.#records();
    if (!records.some((record) => record.pubkey === pubkey)) return false;
    await this.stop(pubkey).catch(() => undefined);
    await this.#save(records.filter((record) => record.pubkey !== pubkey));
    return true;
  }

  signingCredential(pubkeyValue: unknown): {
    authTag: [string, string, string, string];
    nsec: string;
  } | null {
    if (
      typeof pubkeyValue !== "string" ||
      !HEX_PUBKEY.test(pubkeyValue.toLowerCase())
    ) {
      return null;
    }
    const record = this.#records().find(
      (item) => item.pubkey === pubkeyValue.toLowerCase(),
    );
    if (!record) return null;
    const secret = Uint8Array.from(Buffer.from(record.privateKeyHex, "hex"));
    try {
      return {
        authTag: [...record.authTag],
        nsec: nip19.nsecEncode(secret),
      };
    } finally {
      secret.fill(0);
    }
  }

  async publishEngram(
    pubkeyValue: unknown,
    slugValue: unknown,
    bodyValue: unknown,
    createdAtValue?: unknown,
  ): Promise<Record<string, unknown>> {
    const pubkey = requirePubkey(pubkeyValue);
    const slug = validateEngramSlug(slugValue);
    const body = requireString(bodyValue, "body", 65_000);
    const createdAt =
      createdAtValue === undefined
        ? Math.floor(Date.now() / 1_000)
        : requireInteger(
            createdAtValue,
            "createdAt",
            0,
            Number.MAX_SAFE_INTEGER,
          );
    const record = this.#require(pubkey);
    const secret = Uint8Array.from(Buffer.from(record.privateKeyHex, "hex"));
    try {
      const ownerPubkey = this.#identity.info().pubkey;
      const conversationKey = nip44.v2.utils.getConversationKey(
        secret,
        ownerPubkey,
      );
      const plaintext =
        slug === "core"
          ? JSON.stringify({ slug, profile: body })
          : JSON.stringify({ slug, value: body });
      if (Buffer.byteLength(plaintext, "utf8") > 65_535) {
        throw new Error("engram body exceeds the NIP-44 plaintext limit");
      }
      const ciphertext = nip44.v2.encrypt(plaintext, conversationKey);
      const d = createHmac("sha256", conversationKey)
        .update("agent-memory/v1/d-tag", "utf8")
        .update(Buffer.from([0]))
        .update(slug, "utf8")
        .digest("hex");
      const event = finalizeEvent(
        {
          content: ciphertext,
          created_at: createdAt,
          kind: 30_174,
          tags: [
            ["d", d],
            ["p", ownerPubkey],
          ],
        },
        secret,
      );
      const client = new RelayHttpClient({
        authTag: record.authTag,
        baseUrl: this.#defaultRelayUrl.replace(/^ws/, "http"),
        sign: (input) =>
          finalizeEvent(
            {
              content: requireString(input.content, "content", 1024 * 1024),
              created_at:
                typeof input.created_at === "number"
                  ? input.created_at
                  : Math.floor(Date.now() / 1_000),
              kind: requireInteger(input.kind, "kind", 0, 65_535),
              tags: Array.isArray(input.tags) ? (input.tags as string[][]) : [],
            },
            secret,
          ),
      });
      await client.publish(event);
      return {
        createdAt: event.created_at,
        eventId: event.id,
        slug,
      };
    } finally {
      secret.fill(0);
    }
  }

  async publishAsAgent(
    pubkeyValue: unknown,
    template: EventTemplate,
  ): Promise<Event> {
    const record = this.#require(requirePubkey(pubkeyValue));
    const event = this.signAsAgent(record.pubkey, template);
    await this.publishSignedAsAgent(record.pubkey, event);
    return event;
  }

  signAsAgent(pubkeyValue: unknown, template: EventTemplate): Event {
    const record = this.#require(requirePubkey(pubkeyValue));
    if (
      !Number.isSafeInteger(template.kind) ||
      template.kind < 0 ||
      template.kind > 65_535 ||
      Buffer.byteLength(template.content, "utf8") > 256 * 1024 ||
      template.tags.length > 2_048
    ) {
      throw new Error("managed agent event template is invalid");
    }
    const secret = Uint8Array.from(Buffer.from(record.privateKeyHex, "hex"));
    try {
      return finalizeEvent(
        {
          content: template.content,
          created_at: Math.floor(Date.now() / 1_000),
          kind: template.kind,
          tags: template.tags.map((tag) => [...tag]),
        },
        secret,
      );
    } finally {
      secret.fill(0);
    }
  }

  async publishSignedAsAgent(
    pubkeyValue: unknown,
    event: Event,
  ): Promise<void> {
    const record = this.#require(requirePubkey(pubkeyValue));
    if (event.pubkey !== record.pubkey) {
      throw new Error("signed event does not belong to the managed agent");
    }
    const secret = Uint8Array.from(Buffer.from(record.privateKeyHex, "hex"));
    try {
      const client = new RelayHttpClient({
        authTag: record.authTag,
        baseUrl: this.#defaultRelayUrl.replace(/^ws/, "http"),
        sign: (input) =>
          finalizeEvent(
            {
              content: requireString(input.content, "content", 1024 * 1024),
              created_at:
                typeof input.created_at === "number"
                  ? input.created_at
                  : Math.floor(Date.now() / 1_000),
              kind: requireInteger(input.kind, "kind", 0, 65_535),
              tags: Array.isArray(input.tags) ? (input.tags as string[][]) : [],
            },
            secret,
          ),
      });
      await client.publish(event);
    } finally {
      secret.fill(0);
    }
  }

  async create(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const input = requireObject(args.input, "input");
    const backend = parseBackend(input.backend);
    if (backend.type !== "local") {
      throw new Error(
        "provider-managed agents are not supported by the TypeScript desktop host; use a secure remote worker deployment",
      );
    }
    const name = requireText(input.name, "name", 128);
    const personaId = optionalId(input.personaId, "personaId");
    const teamId = optionalId(input.teamId, "teamId");
    if (
      personaId &&
      !this.#localEntities
        .personas()
        .some((persona) => persona.id === personaId && persona.is_active)
    ) {
      throw new Error("persona is missing or inactive");
    }
    if (
      teamId &&
      !this.#localEntities.teams().some((team) => team.id === teamId)
    ) {
      throw new Error("team not found");
    }
    const persona = personaId
      ? this.#localEntities.personas().find((item) => item.id === personaId)
      : undefined;
    const secret = generateSecretKey();
    const privateKeyHex = Buffer.from(secret).toString("hex");
    const pubkey = getPublicKey(secret);
    const now = new Date().toISOString();
    const respondTo = parseRespondTo(
      input.respondTo ?? persona?.respond_to ?? "owner-only",
    );
    const respondToAllowlist = parsePubkeys(
      input.respondToAllowlist ?? persona?.respond_to_allowlist ?? [],
    );
    if (respondTo === "allowlist" && respondToAllowlist.length === 0) {
      throw new Error("allowlist mode requires at least one pubkey");
    }
    const runtime = optionalText(input.agentCommand, "agentCommand", 1_024);
    const agentCommand =
      runtime ??
      (persona?.runtime === "buzz-agent" || persona?.runtime === "buzz-agent-ts"
        ? persona.runtime
        : "buzz-agent");
    const record: AgentRecord = {
      acpCommand:
        optionalText(input.acpCommand, "acpCommand", 1_024) ?? "buzz-acp",
      agentArgs: parseArgs(input.agentArgs),
      agentCommand,
      agentCommandOverride:
        input.harnessOverride === true || !personaId ? agentCommand : null,
      authTag: this.#identity.ownerAuthTag(pubkey),
      autoRestartOnConfigChange: true,
      avatarUrl: optionalHttpUrl(
        input.avatarUrl ?? persona?.avatar_url,
        "avatarUrl",
      ),
      backend,
      backendAgentId: null,
      createdAt: now,
      envVars: validateEnv(input.envVars),
      idleTimeoutSeconds: optionalInteger(
        input.idleTimeoutSeconds,
        "idleTimeoutSeconds",
        1,
        604_800,
      ),
      lastError: null,
      lastErrorCode: null,
      lastExitCode: null,
      lastStartedAt: null,
      lastStoppedAt: null,
      maxTurnDurationSeconds: optionalInteger(
        input.maxTurnDurationSeconds,
        "maxTurnDurationSeconds",
        10,
        604_800,
      ),
      mcpCommand: optionalText(input.mcpCommand, "mcpCommand", 1_024) ?? "",
      model:
        optionalText(input.model, "model", 1_024) ?? persona?.model ?? null,
      name,
      parallelism:
        optionalInteger(
          input.parallelism ?? persona?.parallelism,
          "parallelism",
          1,
          32,
        ) ?? 1,
      personaId,
      personaSourceVersion: null,
      privateKeyHex,
      provider:
        optionalText(input.provider, "provider", 128) ??
        persona?.provider ??
        null,
      pubkey,
      relayUrl: normalizeRelayUrl(this.#defaultRelayUrl),
      respondTo,
      respondToAllowlist,
      runtime:
        persona?.runtime ??
        this.#runtimeCatalog?.definitionForCommand(agentCommand)?.id ??
        (agentCommand === "buzz-agent" ? "buzz-agent" : null),
      startOnAppLaunch: input.startOnAppLaunch === true,
      systemPrompt:
        optionalText(input.systemPrompt, "systemPrompt", 1024 * 1024) ??
        persona?.system_prompt ??
        null,
      teamId,
      turnTimeoutSeconds:
        optionalInteger(
          input.turnTimeoutSeconds,
          "turnTimeoutSeconds",
          1,
          604_800,
        ) ?? 300,
      updatedAt: now,
    };
    const records = this.#records();
    records.push(record);
    await this.#save(records);

    let spawnError: string | null = null;
    if (input.spawnAfterCreate === true) {
      try {
        await this.start(pubkey);
      } catch (error) {
        spawnError = safeError(error);
      }
    }
    let profileSyncError: string | null = null;
    try {
      await this.#syncProfile(record);
    } catch (error) {
      profileSyncError = safeError(error);
    }
    const current = this.#require(pubkey);
    return {
      agent: this.#summary(current),
      private_key_nsec: nip19.nsecEncode(secret),
      profile_sync_error: profileSyncError,
      spawn_error: spawnError,
    };
  }

  async start(pubkeyValue: unknown): Promise<Record<string, unknown>> {
    const record = this.#require(requirePubkey(pubkeyValue));
    const active = this.#processes.get(record.pubkey);
    if (active && isAlive(active.child)) return this.#summary(record);
    if (record.backend.type !== "local") {
      throw new Error("provider agent cannot be started by the local host");
    }

    const runtimeDirectory = path.join(this.#dataDirectory, record.pubkey);
    await mkdir(runtimeDirectory, { mode: 0o700, recursive: true });
    await this.#nest?.ensure();
    const workDirectory = this.#nest?.root() ?? runtimeDirectory;
    const logPath = path.join(runtimeDirectory, "agent.log");
    const log = await open(logPath, "a", 0o600);
    const runtime = this.#resolveRuntime(record);
    const startNonce = randomBytes(16).toString("hex");
    const args = [
      ACP_CLI,
      "--relay-url",
      this.#defaultRelayUrl,
      "--agent-owner",
      this.#identity.info().pubkey,
      "--agent-command",
      runtime.command,
      "--agent-args",
      runtime.args.join(","),
      "--max-turn-duration",
      String(record.maxTurnDurationSeconds ?? 7_200),
      "--parallelism",
      String(record.parallelism),
      "--respond-to",
      record.respondTo,
      "--publish-agent-text",
      String(runtime.builtIn),
    ];
    const nsec = nip19.nsecEncode(
      Uint8Array.from(Buffer.from(record.privateKeyHex, "hex")),
    );
    const child = spawn(process.execPath, args, {
      cwd: workDirectory,
      env: {
        ...process.env,
        ...runtime.environment,
        ...record.envVars,
        BUZZ_ACP_RESPOND_TO_ALLOWLIST: record.respondToAllowlist.join(","),
        BUZZ_ACP_SYSTEM_PROMPT: record.systemPrompt ?? undefined,
        BUZZ_AGENT_MODEL: record.model ?? undefined,
        BUZZ_AGENT_PROVIDER: record.provider ?? undefined,
        BUZZ_AUTH_TAG: JSON.stringify(record.authTag),
        BUZZ_MANAGED_AGENT: "1",
        BUZZ_MANAGED_AGENT_START_NONCE: startNonce,
        BUZZ_PRIVATE_KEY: nsec,
      },
      shell: false,
      stdio: ["ignore", log.fd, log.fd],
      windowsHide: true,
    });
    const runtimeState: Runtime = {
      child,
      error: null,
      lifecycle: "starting",
      logPath,
      startNonce,
      stopping: false,
    };
    this.#processes.set(record.pubkey, runtimeState);
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    try {
      await spawned;
    } catch (error) {
      this.#processes.delete(record.pubkey);
      await log.close().catch(() => undefined);
      await this.#patch(record.pubkey, {
        lastError: safeError(error),
        lastErrorCode: errorCode(error),
      });
      throw error;
    }
    await this.#patch(record.pubkey, {
      lastError: null,
      lastErrorCode: null,
      lastStartedAt: new Date().toISOString(),
    });
    child.once("exit", (code, signal) => {
      this.#processes.delete(record.pubkey);
      void log.close().catch(() => undefined);
      void this.#patch(record.pubkey, {
        lastError:
          runtimeState.stopping || code === 0
            ? null
            : `agent exited unexpectedly${signal ? ` (${signal})` : ""}`,
        lastExitCode: code,
        lastStoppedAt: new Date().toISOString(),
      }).catch(() => undefined);
    });
    return this.#summary(this.#require(record.pubkey));
  }

  async stop(pubkeyValue: unknown): Promise<Record<string, unknown>> {
    const pubkey = requirePubkey(pubkeyValue);
    this.#require(pubkey);
    const runtime = this.#processes.get(pubkey);
    if (runtime && isAlive(runtime.child)) {
      runtime.stopping = true;
      runtime.child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (isAlive(runtime.child)) runtime.child.kill("SIGKILL");
      }, 10_000);
      timer.unref();
      try {
        await once(runtime.child, "exit");
      } finally {
        clearTimeout(timer);
      }
    }
    this.#processes.delete(pubkey);
    this.#sessionConfig.delete(pubkey);
    await this.#patch(pubkey, {
      lastError: null,
      lastStoppedAt: new Date().toISOString(),
    });
    return this.#summary(this.#require(pubkey));
  }

  async restart(pubkeyValue: unknown): Promise<Record<string, unknown>> {
    const pubkey = requirePubkey(pubkeyValue);
    await this.stop(pubkey);
    return this.start(pubkey);
  }

  async remove(pubkeyValue: unknown): Promise<void> {
    const pubkey = requirePubkey(pubkeyValue);
    await this.stop(pubkey);
    const records = this.#records();
    if (!records.some((record) => record.pubkey === pubkey)) {
      throw new Error("managed agent not found");
    }
    await this.#save(records.filter((record) => record.pubkey !== pubkey));
  }

  async update(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const input = requireObject(args.input, "input");
    const pubkey = requirePubkey(input.pubkey);
    const previous = this.#require(pubkey);
    const next: AgentRecord = {
      ...previous,
      ...(input.name === undefined
        ? {}
        : { name: requireText(input.name, "name", 128) }),
      ...(input.model === undefined
        ? {}
        : { model: nullableText(input.model, "model", 1_024) }),
      ...(input.provider === undefined
        ? {}
        : { provider: nullableText(input.provider, "provider", 128) }),
      ...(input.systemPrompt === undefined
        ? {}
        : {
            systemPrompt: nullableText(
              input.systemPrompt,
              "systemPrompt",
              1024 * 1024,
            ),
          }),
      ...(input.envVars === undefined
        ? {}
        : { envVars: validateEnv(input.envVars) }),
      ...(input.parallelism === undefined
        ? {}
        : {
            parallelism: requireInteger(
              input.parallelism,
              "parallelism",
              1,
              32,
            ),
          }),
      ...(input.turnTimeoutSeconds === undefined
        ? {}
        : {
            turnTimeoutSeconds: requireInteger(
              input.turnTimeoutSeconds,
              "turnTimeoutSeconds",
              1,
              604_800,
            ),
          }),
      ...(input.relayUrl === undefined
        ? {}
        : { relayUrl: normalizeRelayUrl(input.relayUrl) }),
      ...(input.agentCommand === undefined
        ? {}
        : {
            agentCommand: requireText(
              input.agentCommand,
              "agentCommand",
              1_024,
            ),
            agentCommandOverride:
              input.harnessOverride === false
                ? null
                : requireText(input.agentCommand, "agentCommand", 1_024),
            runtime:
              this.#runtimeCatalog?.definitionForCommand(
                requireText(input.agentCommand, "agentCommand", 1_024),
              )?.id ?? previous.runtime,
          }),
      ...(input.agentArgs === undefined
        ? {}
        : { agentArgs: parseArgs(input.agentArgs) }),
      ...(input.mcpCommand === undefined
        ? {}
        : {
            mcpCommand:
              optionalText(input.mcpCommand, "mcpCommand", 1_024) ?? "",
          }),
      ...(input.respondTo === undefined
        ? {}
        : { respondTo: parseRespondTo(input.respondTo) }),
      ...(input.respondToAllowlist === undefined
        ? {}
        : { respondToAllowlist: parsePubkeys(input.respondToAllowlist) }),
      updatedAt: new Date().toISOString(),
    };
    if (
      next.respondTo === "allowlist" &&
      next.respondToAllowlist.length === 0
    ) {
      throw new Error("allowlist mode requires at least one pubkey");
    }
    await this.#replace(next);
    let profileSyncError: string | null = null;
    try {
      await this.#syncProfile(next);
    } catch (error) {
      profileSyncError = safeError(error);
    }
    return {
      agent: this.#summary(next),
      profile_sync_error: profileSyncError,
    };
  }

  async setStartOnLaunch(
    pubkeyValue: unknown,
    enabled: unknown,
  ): Promise<Record<string, unknown>> {
    if (typeof enabled !== "boolean")
      throw new Error("startOnAppLaunch must be boolean");
    const pubkey = requirePubkey(pubkeyValue);
    await this.#patch(pubkey, { startOnAppLaunch: enabled });
    return this.#summary(this.#require(pubkey));
  }

  async setAutoRestart(
    pubkeyValue: unknown,
    enabled: unknown,
  ): Promise<Record<string, unknown>> {
    if (typeof enabled !== "boolean") {
      throw new Error("autoRestartOnConfigChange must be boolean");
    }
    const pubkey = requirePubkey(pubkeyValue);
    await this.#patch(pubkey, { autoRestartOnConfigChange: enabled });
    return this.#summary(this.#require(pubkey));
  }

  async log(
    pubkeyValue: unknown,
    lineCountValue: unknown,
  ): Promise<{
    content: string;
    log_path: string;
  }> {
    const record = this.#require(requirePubkey(pubkeyValue));
    const logPath = this.#logPath(record.pubkey);
    const lines =
      lineCountValue === undefined
        ? 500
        : requireInteger(lineCountValue, "lineCount", 1, MAX_LOG_LINES);
    let metadata;
    try {
      metadata = await stat(logPath);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return { content: "", log_path: logPath };
      throw error;
    }
    const start = Math.max(0, metadata.size - MAX_LOG_BYTES);
    const handle = await open(logPath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(metadata.size, MAX_LOG_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return {
        content: redactSensitiveText(
          buffer
            .subarray(0, bytesRead)
            .toString("utf8")
            .split(/\r?\n/)
            .slice(-lines)
            .join("\n"),
          [record.privateKeyHex],
        ),
        log_path: logPath,
      };
    } finally {
      await handle.close();
    }
  }

  runtimes(): Array<Record<string, unknown>> {
    return this.#records().map((record) => this.#runtimeStatus(record));
  }

  runtimeStatus(
    pubkeyValue: unknown,
    relayUrlValue?: unknown,
  ): Record<string, unknown> {
    const record = this.#require(requirePubkey(pubkeyValue));
    if (
      relayUrlValue !== undefined &&
      normalizeRelayUrl(relayUrlValue) !== this.#defaultRelayUrl
    ) {
      throw new Error("relay URL does not match this managed agent");
    }
    return this.#runtimeStatus(record);
  }

  putSessionConfig(pubkeyValue: unknown, payloadValue: unknown): void {
    const pubkey = requirePubkey(pubkeyValue);
    this.#require(pubkey);
    const payload = requireObject(payloadValue, "payload");
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded, "utf8") > 1024 * 1024) {
      throw new Error("session config payload exceeds the 1 MiB limit");
    }
    if (
      payload.relayUrl !== undefined &&
      normalizeRelayUrl(payload.relayUrl) !== this.#defaultRelayUrl
    ) {
      throw new Error(
        "session config relay URL does not match the active runtime",
      );
    }
    this.#sessionConfig.set(pubkey, structuredClone(payload));
  }

  async configSurface(pubkeyValue: unknown): Promise<Record<string, unknown>> {
    const record = this.#require(requirePubkey(pubkeyValue));
    const definition = this.#runtimeCatalog?.definitionForCommand(
      record.agentCommand,
    );
    const runtimeId = record.runtime ?? definition?.id ?? null;
    const session = this.#sessionConfig.get(record.pubkey);
    const fileConfig =
      runtimeId && this.#runtimeCatalog
        ? await this.#runtimeCatalog.runtimeFileConfig(runtimeId)
        : null;
    const configOptions = parseConfigOptions(session?.configOptions);
    const sessionModel = parseSessionModel(session?.models);
    const mode = firstText(
      findConfigOption(configOptions, ["mode"])?.value,
      parseStringList(session?.modes)[0],
      record.envVars.GOOSE_MODE,
      record.envVars.BUZZ_AGENT_MODE,
    );
    const thinking = firstText(
      findConfigOption(configOptions, ["thinking", "thinking_effort"])?.value,
      record.envVars.GOOSE_THINKING_EFFORT,
      record.envVars.BUZZ_AGENT_THINKING_EFFORT,
    );
    const model = firstText(
      sessionModel,
      record.model,
      stringProperty(fileConfig, "model"),
    );
    const provider = firstText(
      record.provider,
      stringProperty(fileConfig, "provider"),
    );
    const preSpawn = !this.#processes.has(record.pubkey);
    const required = runtimeId === "goose" || runtimeId === "buzz-agent";
    return {
      advanced: configOptions.map((option) => ({
        key: option.id,
        label: option.label,
        origin: "acpConfigOption",
        schemaType:
          option.options.length > 0
            ? { options: option.options, type: "enum" }
            : { type: "string" },
        value: option.value,
        writeVia: { configId: option.id, type: "acpSetConfigOption" },
      })),
      extensions: parseExtensions(session?.extensions),
      isPreSpawn: preSpawn,
      normalized: {
        contextLimit: normalizedEnvironmentField(
          firstText(
            record.envVars.GOOSE_CONTEXT_LIMIT,
            record.envVars.BUZZ_AGENT_MAX_CONTEXT_TOKENS,
          ),
          firstText(
            definition?.env.GOOSE_CONTEXT_LIMIT,
            definition?.env.BUZZ_AGENT_MAX_CONTEXT_TOKENS,
          ),
          "BUZZ_AGENT_MAX_CONTEXT_TOKENS",
        ),
        maxOutputTokens: normalizedEnvironmentField(
          firstText(
            record.envVars.GOOSE_MAX_TOKENS,
            record.envVars.BUZZ_AGENT_MAX_OUTPUT_TOKENS,
          ),
          firstText(
            definition?.env.GOOSE_MAX_TOKENS,
            definition?.env.BUZZ_AGENT_MAX_OUTPUT_TOKENS,
          ),
          "BUZZ_AGENT_MAX_OUTPUT_TOKENS",
        ),
        mode: normalizedField(
          mode,
          mode
            ? findConfigOption(configOptions, ["mode"])
              ? "acpConfigOption"
              : "envVar"
            : "globalDefault",
          mode
            ? findConfigOption(configOptions, ["mode"])
              ? {
                  configId:
                    findConfigOption(configOptions, ["mode"])?.id ?? "mode",
                  type: "acpSetConfigOption",
                }
              : {
                  envKey:
                    runtimeId === "goose" ? "GOOSE_MODE" : "BUZZ_AGENT_MODE",
                  type: "respawnWithEnvVar",
                }
            : { type: "readOnly" },
          false,
        ),
        model: normalizedField(
          model,
          sessionModel
            ? "runtimeOverride"
            : record.model
              ? "buzzExplicit"
              : fileConfig
                ? "configFile"
                : "globalDefault",
          sessionModel
            ? { type: "acpSetSessionModel" }
            : definition?.modelEnvVar
              ? { envKey: definition.modelEnvVar, type: "respawnWithEnvVar" }
              : { type: "acpSetSessionModel" },
          required,
        ),
        provider: normalizedField(
          provider,
          record.provider
            ? "buzzExplicit"
            : fileConfig
              ? "configFile"
              : "globalDefault",
          definition?.providerEnvVar
            ? { envKey: definition.providerEnvVar, type: "respawnWithEnvVar" }
            : { type: "readOnly" },
          required,
        ),
        systemPrompt: normalizedField(
          record.systemPrompt,
          record.systemPrompt ? "buzzExplicit" : "globalDefault",
          { envKey: "BUZZ_ACP_SYSTEM_PROMPT", type: "respawnWithEnvVar" },
          false,
        ),
        thinkingEffort: normalizedField(
          thinking,
          findConfigOption(configOptions, ["thinking", "thinking_effort"])
            ? "acpConfigOption"
            : thinking
              ? "envVar"
              : "globalDefault",
          definition?.thinkingEnvVar
            ? {
                envKey: definition.thinkingEnvVar,
                type: "respawnWithEnvVar",
              }
            : { type: "readOnly" },
          false,
        ),
      },
      runtimeId,
      runtimeLabel: definition?.label ?? runtimeId,
      sources: {
        acpConfigOptions: preSpawn ? "pending" : "available",
        acpNative:
          runtimeId === "goose"
            ? preSpawn
              ? "pending"
              : "available"
            : "notApplicable",
        configFile: runtimeId === "goose" ? "available" : "notApplicable",
        configFilePath:
          runtimeId === "goose" ? "~/.config/goose/config.yaml" : null,
        envVars: "available",
        mcpConfigFilePath:
          runtimeId === "goose" ? "~/.config/goose/config.yaml" : null,
      },
    };
  }

  putRuntimeLifecycle(
    outerPubkeyValue: unknown,
    payloadValue: unknown,
  ): Record<string, unknown> {
    const outerPubkey = requirePubkey(outerPubkeyValue);
    const payload = requireObject(payloadValue, "payload");
    const pubkey = requirePubkey(payload.pubkey);
    if (pubkey !== outerPubkey) {
      throw new Error(
        "observer signer does not match lifecycle payload pubkey",
      );
    }
    if (normalizeRelayUrl(payload.relayUrl) !== this.#defaultRelayUrl) {
      throw new Error("lifecycle relay URL does not match the tracked runtime");
    }
    const lifecycle = requireLifecycle(payload.lifecycle);
    const error =
      payload.error === undefined || payload.error === null
        ? null
        : requireString(payload.error, "error", 8_192);
    if (lifecycle === "failed" && !error) {
      throw new Error("failed lifecycle requires an error");
    }
    if (lifecycle !== "failed" && error) {
      throw new Error("lifecycle error is only valid for failed");
    }
    const runtime = this.#processes.get(pubkey);
    if (!runtime || !isAlive(runtime.child)) {
      throw new Error("lifecycle frame does not match a tracked runtime pair");
    }
    const startNonce = requireString(payload.startNonce, "startNonce", 128);
    if (runtime.startNonce !== startNonce) {
      throw new Error(
        "lifecycle frame does not match the current harness generation",
      );
    }
    runtime.lifecycle = lifecycle;
    runtime.error = error;
    return this.#runtimeStatus(this.#require(pubkey));
  }

  async startOnLaunch(): Promise<void> {
    for (const record of this.#records()) {
      if (!record.startOnAppLaunch || record.backend.type !== "local") continue;
      await this.start(record.pubkey).catch(async (error) => {
        await this.#patch(record.pubkey, { lastError: safeError(error) });
      });
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.#processes.keys()].map((pubkey) => this.stop(pubkey)),
    );
  }

  #records(): AgentRecord[] {
    const value = this.#identity.setting<unknown>(STORE_KEY, []);
    if (!Array.isArray(value))
      throw new Error("managed agent store is corrupt");
    return value.map(parseStoredRecord);
  }

  #require(pubkey: string): AgentRecord {
    const record = this.#records().find((item) => item.pubkey === pubkey);
    if (!record) throw new Error("managed agent not found");
    return record;
  }

  async #replace(next: AgentRecord): Promise<void> {
    const records = this.#records();
    const index = records.findIndex((record) => record.pubkey === next.pubkey);
    if (index < 0) throw new Error("managed agent not found");
    records[index] = next;
    await this.#save(records);
  }

  async #patch(pubkey: string, patch: Partial<AgentRecord>): Promise<void> {
    const record = this.#require(pubkey);
    await this.#replace({
      ...record,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
  }

  async #save(records: AgentRecord[]): Promise<void> {
    const operation = this.#writeQueue.then(() =>
      this.#identity.setSetting(STORE_KEY, records),
    );
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
    await this.#refreshNest(records);
  }

  async #refreshNest(records = this.#records()): Promise<void> {
    if (!this.#nest) return;
    await this.#nest
      .regenerate(records, this.#defaultRelayUrl)
      .catch(() => undefined);
  }

  #summary(record: AgentRecord): Record<string, unknown> {
    const runtime = this.#processes.get(record.pubkey);
    const running = runtime !== undefined && isAlive(runtime.child);
    return {
      acp_command: record.acpCommand,
      agent_args: [...record.agentArgs],
      agent_command: record.agentCommand,
      agent_command_override: record.agentCommandOverride,
      auto_restart_on_config_change: record.autoRestartOnConfigChange,
      avatar_url: record.avatarUrl,
      backend: structuredClone(record.backend),
      backend_agent_id: record.backendAgentId,
      created_at: record.createdAt,
      env_vars: structuredClone(record.envVars),
      idle_timeout_seconds: record.idleTimeoutSeconds,
      last_error: record.lastError,
      last_error_code: record.lastErrorCode,
      last_exit_code: record.lastExitCode,
      last_started_at: record.lastStartedAt,
      last_stopped_at: record.lastStoppedAt,
      log_path: this.#logPath(record.pubkey),
      max_turn_duration_seconds: record.maxTurnDurationSeconds,
      mcp_command: record.mcpCommand,
      model: record.model,
      model_source: record.model ? "instance_legacy" : null,
      name: record.name,
      needs_restart: false,
      parallelism: record.parallelism,
      persona_id: record.personaId,
      persona_orphaned:
        record.personaId !== null &&
        !this.#localEntities
          .personas()
          .some((item) => item.id === record.personaId),
      persona_out_of_date: false,
      pid: running ? (runtime.child.pid ?? null) : null,
      provider: record.provider,
      pubkey: record.pubkey,
      relay_url: this.#defaultRelayUrl,
      respond_to: record.respondTo,
      respond_to_allowlist: [...record.respondToAllowlist],
      runtime: record.runtime,
      start_on_app_launch: record.startOnAppLaunch,
      status: running ? "running" : "stopped",
      system_prompt: record.systemPrompt,
      team_id: record.teamId,
      turn_timeout_seconds: record.turnTimeoutSeconds,
      updated_at: record.updatedAt,
    };
  }

  #runtimeStatus(record: AgentRecord): Record<string, unknown> {
    const runtime = this.#processes.get(record.pubkey);
    const running = runtime !== undefined && isAlive(runtime.child);
    return {
      error: running ? runtime.error : record.lastError,
      lifecycle: running
        ? runtime.lifecycle
        : record.lastError
          ? "failed"
          : "stopped",
      localSetup: true,
      logPath: this.#logPath(record.pubkey),
      pid: running ? (runtime.child.pid ?? null) : null,
      pubkey: record.pubkey,
      relayUrl: this.#defaultRelayUrl,
    };
  }

  #logPath(pubkey: string): string {
    return path.join(this.#dataDirectory, pubkey, "agent.log");
  }

  async #syncProfile(record: AgentRecord): Promise<void> {
    const secret = Uint8Array.from(Buffer.from(record.privateKeyHex, "hex"));
    try {
      const client = new RelayHttpClient({
        authTag: record.authTag,
        baseUrl: this.#defaultRelayUrl.replace(/^ws/, "http"),
        sign: (input) =>
          finalizeEvent(
            {
              content: requireString(input.content, "content", 1024 * 1024),
              created_at:
                typeof input.created_at === "number"
                  ? input.created_at
                  : Math.floor(Date.now() / 1_000),
              kind: requireInteger(input.kind, "kind", 0, 65_535),
              tags: Array.isArray(input.tags) ? (input.tags as string[][]) : [],
            },
            secret,
          ),
      });
      const content = JSON.stringify({
        display_name: record.name,
        name: record.name,
        ...(record.avatarUrl ? { picture: record.avatarUrl } : {}),
      });
      await client.publish(
        finalizeEvent(
          {
            content,
            created_at: Math.floor(Date.now() / 1_000),
            kind: 0,
            tags: [record.authTag],
          },
          secret,
        ),
      );
    } finally {
      secret.fill(0);
    }
  }

  #resolveRuntime(record: AgentRecord): {
    args: string[];
    builtIn: boolean;
    command: string;
    environment: Record<string, string>;
  } {
    if (["buzz-agent", "buzz-agent-ts"].includes(record.agentCommand)) {
      return {
        args: [BUILT_IN_AGENT_CLI, ...record.agentArgs],
        builtIn: true,
        command: process.execPath,
        environment: {},
      };
    }
    if (record.agentCommand.includes("\0")) {
      throw new Error("invalid agent command");
    }
    const definition = this.#runtimeCatalog?.definitionForCommand(
      record.agentCommand,
    );
    return {
      args:
        record.agentArgs.length > 0
          ? [...record.agentArgs]
          : [...(definition?.args ?? [])],
      builtIn: false,
      command: definition?.command ?? record.agentCommand,
      environment: structuredClone(definition?.env ?? {}),
    };
  }
}

function normalizeRelayUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("relayUrl must be a string");
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "relay URL may not contain credentials, query, or fragment",
    );
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    url.hostname,
  );
  if (url.protocol !== "wss:" && !(loopback && url.protocol === "ws:")) {
    throw new Error("remote relay URLs must use wss");
  }
  url.pathname = "/";
  return url.toString();
}

function parseBackend(value: unknown): Backend {
  if (value === undefined || value === null) return { type: "local" };
  const input = requireObject(value, "backend");
  if (input.type === "local") return { type: "local" };
  if (input.type !== "provider")
    throw new Error("invalid managed agent backend");
  return {
    config: structuredClone(requireObject(input.config, "backend config")),
    id: requireText(input.id, "backend id", 128),
    type: "provider",
  };
}

function parseStoredRecord(value: unknown): AgentRecord {
  const input = requireObject(value, "managed agent record");
  if (
    typeof input.privateKeyHex !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.privateKeyHex) ||
    typeof input.pubkey !== "string" ||
    !HEX_PUBKEY.test(input.pubkey) ||
    getPublicKey(Uint8Array.from(Buffer.from(input.privateKeyHex, "hex"))) !==
      input.pubkey
  ) {
    throw new Error("managed agent store contains an invalid keypair");
  }
  const record = structuredClone(value) as AgentRecord & {
    personaSourceVersion?: string | null;
  };
  return {
    ...record,
    personaSourceVersion: record.personaSourceVersion ?? null,
  };
}

function validateEnv(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  const input = requireObject(value, "envVars");
  if (Object.keys(input).length > 256) throw new Error("too many env vars");
  const output: Record<string, string> = {};
  for (const [name, raw] of Object.entries(input)) {
    if (!ENV_NAME.test(name) || RESERVED_ENV.has(name)) {
      throw new Error(`environment variable ${name} is reserved or invalid`);
    }
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 64 * 1024) {
      throw new Error(`environment variable ${name} has an invalid value`);
    }
    output[name] = raw;
  }
  return output;
}

function parseArgs(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error("agentArgs must contain at most 128 strings");
  }
  return value.map((item, index) => {
    const arg = requireText(item, `agentArgs[${index}]`, 16 * 1024);
    if (arg.includes(",") || arg.includes("\0")) {
      throw new Error("agent arguments may not contain commas or NUL bytes");
    }
    return arg;
  });
}

function parsePubkeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new Error("respondToAllowlist must contain at most 500 pubkeys");
  }
  return [
    ...new Set(
      value.map((item) => {
        if (typeof item !== "string" || !HEX_PUBKEY.test(item.toLowerCase())) {
          throw new Error("respondToAllowlist contains an invalid pubkey");
        }
        return item.toLowerCase();
      }),
    ),
  ];
}

function validateEngramSlug(value: unknown): string {
  const slug = requireText(value, "slug", 255);
  if (slug === "core") return slug;
  if (
    !/^mem\/[a-z0-9][a-z0-9_-]{0,63}(?:\/[a-z0-9][a-z0-9_-]{0,63})*$/.test(slug)
  ) {
    throw new Error("engram slug must be core or a canonical mem/... path");
  }
  return slug;
}

function parseRespondTo(value: unknown): RespondTo {
  if (value !== "owner-only" && value !== "allowlist" && value !== "anyone") {
    throw new Error("respondTo must be owner-only, allowlist, or anyone");
  }
  return value;
}

function optionalId(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireText(value, name, 256);
}

function optionalText(
  value: unknown,
  name: string,
  maxBytes: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requireText(value, name, maxBytes);
}

function nullableText(
  value: unknown,
  name: string,
  maxBytes: number,
): string | null {
  if (value === null || value === "") return null;
  return requireText(value, name, maxBytes);
}

function optionalHttpUrl(value: unknown, name: string): string | null {
  const text =
    typeof value === "string" && value.startsWith("data:image/")
      ? requireString(value, name, 3 * 1024 * 1024)
      : optionalText(value, name, 2_048);
  if (!text) return null;
  if (
    /^data:image\/(?:png|jpeg|gif|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/i.test(
      text,
    )
  ) {
    return text;
  }
  const url = new URL(text);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must use http: or https:`);
  }
  return url.toString();
}

function optionalInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number | null {
  if (value === undefined || value === null || value === 0) return null;
  return requireInteger(value, name, min, max);
}

function requireInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function requireText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  const text = value.trim();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`${name} exceeds its size limit`);
  }
  return text;
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

function requirePubkey(value: unknown): string {
  if (typeof value !== "string" || !HEX_PUBKEY.test(value.toLowerCase())) {
    throw new Error("pubkey must be 64 hexadecimal characters");
  }
  return value.toLowerCase();
}

type ConfigOption = {
  id: string;
  label: string;
  options: string[];
  value: string | null;
};

function parseConfigOptions(value: unknown): ConfigOption[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 256).flatMap((item): ConfigOption[] => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return [];
    }
    const input = item as Record<string, unknown>;
    const id =
      typeof input.id === "string"
        ? input.id
        : typeof input.configId === "string"
          ? input.configId
          : null;
    if (!id || Buffer.byteLength(id, "utf8") > 256) return [];
    const rawOptions = Array.isArray(input.options) ? input.options : [];
    const options = rawOptions.slice(0, 256).flatMap((option): string[] => {
      if (typeof option === "string") return [option];
      if (
        typeof option === "object" &&
        option !== null &&
        !Array.isArray(option) &&
        typeof (option as Record<string, unknown>).value === "string"
      ) {
        const optionValue = (option as Record<string, unknown>).value;
        return typeof optionValue === "string" ? [optionValue] : [];
      }
      return [];
    });
    const rawValue = input.value ?? input.currentValue;
    return [
      {
        id,
        label: typeof input.displayName === "string" ? input.displayName : id,
        options,
        value:
          typeof rawValue === "string" ||
          typeof rawValue === "number" ||
          typeof rawValue === "boolean"
            ? String(rawValue)
            : null,
      },
    ];
  });
}

function findConfigOption(
  options: readonly ConfigOption[],
  candidates: readonly string[],
): ConfigOption | undefined {
  const normalized = new Set(candidates.map((item) => item.toLowerCase()));
  return options.find((option) => normalized.has(option.id.toLowerCase()));
}

function parseSessionModel(value: unknown): string | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const current = (value as Record<string, unknown>).currentModelId;
    return typeof current === "string" && current.trim() ? current : null;
  }
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      (item as Record<string, unknown>).isCurrent === true
    ) {
      const input = item as Record<string, unknown>;
      const model = input.modelId ?? input.id;
      if (typeof model === "string" && model.trim()) return model;
    }
  }
  return null;
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 256)
    .filter(
      (item): item is string =>
        typeof item === "string" && Buffer.byteLength(item, "utf8") <= 1_024,
    );
}

function parseExtensions(
  value: unknown,
): Array<{ enabled: boolean; kind: string; name: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 256).flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return [];
    }
    const input = item as Record<string, unknown>;
    if (typeof input.name !== "string" || typeof input.kind !== "string") {
      return [];
    }
    return [
      {
        enabled: input.enabled !== false,
        kind: input.kind,
        name: input.name,
      },
    ];
  });
}

function normalizedField(
  value: string | null,
  origin:
    | "buzzExplicit"
    | "acpConfigOption"
    | "configFile"
    | "envVar"
    | "globalDefault"
    | "runtimeOverride",
  writeVia: Record<string, string>,
  isRequired: boolean,
): Record<string, unknown> | null {
  if (value === null && !isRequired) return null;
  return {
    isRequired,
    origin,
    overriddenOrigin: null,
    overriddenValue: null,
    value,
    writeVia,
  };
}

function normalizedEnvironmentField(
  explicit: string | null,
  definition: string | null,
  envKey: string,
): Record<string, unknown> | null {
  const value = explicit ?? definition;
  if (value === null) return null;
  return normalizedField(
    value,
    "envVar",
    { envKey, type: "respawnWithEnvVar" },
    false,
  );
}

function firstText(...values: Array<string | null | undefined>): string | null {
  return (
    values.find(
      (value): value is string =>
        typeof value === "string" && value.trim() !== "",
    ) ?? null
  );
}

function stringProperty(
  value: Record<string, unknown> | null,
  key: string,
): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function requireLifecycle(
  value: unknown,
): "listening" | "waking" | "ready" | "failed" {
  if (
    value !== "listening" &&
    value !== "waking" &&
    value !== "ready" &&
    value !== "failed"
  ) {
    throw new Error(
      "observer lifecycle must be listening, waking, ready, or failed",
    );
  }
  return value;
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null && !child.killed;
}

function safeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "managed agent operation failed";
  return redactSensitiveText(message)
    .slice(0, 2_048)
    .replaceAll(/[\r\n\t]/g, " ");
}

function errorCode(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "errno" in error &&
    typeof error.errno === "number"
  ) {
    return error.errno;
  }
  return null;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
