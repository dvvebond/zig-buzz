import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { nip19 } from "nostr-tools";
import {
  redactSensitiveText,
  RemoteProtocolError,
  type RemoteDeploymentConfig,
} from "@buzz/remote-agent-protocol";

import type { DeploymentState } from "./state.js";

type RuntimeDefinition = {
  readonly command: string;
  readonly args: readonly string[];
};

const ACP_CLI = fileURLToPath(import.meta.resolve("@buzz/acp/cli"));
const BUILT_IN_AGENT_CLI = fileURLToPath(
  import.meta.resolve("@buzz/agent/cli"),
);
const RUNTIMES: Readonly<Record<string, RuntimeDefinition>> = {
  "buzz-agent": {
    args: [BUILT_IN_AGENT_CLI],
    command: process.execPath,
  },
  goose: { args: ["acp"], command: "goose" },
  codex: { args: [], command: "codex-acp" },
  claude: { args: [], command: "claude-agent-acp" },
};

export class AgentProcessManager {
  readonly #processes = new Map<string, ChildProcess>();
  readonly #dataDirectory: string;
  readonly #relayUrl: string;
  readonly #ownerPubkey: string;

  public constructor(input: {
    readonly dataDirectory: string;
    readonly relayUrl: string;
    readonly ownerPubkey: string;
  }) {
    this.#dataDirectory = input.dataDirectory;
    this.#relayUrl = input.relayUrl;
    this.#ownerPubkey = input.ownerPubkey;
  }

  public isRunning(deploymentId: string): boolean {
    const child = this.#processes.get(deploymentId);
    return child !== undefined && child.exitCode === null && !child.killed;
  }

  public async start(deployment: DeploymentState): Promise<void> {
    if (this.isRunning(deployment.id)) return;
    if (deployment.status === "revoked") {
      throw new RemoteProtocolError(
        "CAPABILITY_DENIED",
        "revoked deployments cannot be started",
      );
    }

    const runtime = RUNTIMES[deployment.config.runtimeId];
    if (!runtime) {
      throw new RemoteProtocolError(
        "CONFIG_INVALID",
        `runtime '${deployment.config.runtimeId}' is not allowlisted on this worker`,
      );
    }
    const workDirectory = join(
      this.#dataDirectory,
      "deployments",
      deployment.id,
    );
    await mkdir(workDirectory, { mode: 0o700, recursive: true });
    const logPath = join(workDirectory, "agent.log");
    const env = resolveEnvironment(deployment.config, process.env);
    const agentSecret = Uint8Array.from(
      Buffer.from(deployment.agentSecretKeyHex, "hex"),
    );

    const args = [
      "--relay-url",
      this.#relayUrl,
      "--agent-owner",
      this.#ownerPubkey,
      "--agent-command",
      runtime.command,
      "--agent-args",
      runtime.args.join(","),
      "--idle-timeout",
      String(deployment.config.idleTimeoutSeconds ?? 900),
      "--max-turn-duration",
      String(deployment.config.maxTurnDurationSeconds ?? 7_200),
      "--parallelism",
      String(deployment.config.parallelism ?? 1),
      "--respond-to",
      deployment.config.respondTo ?? "owner-only",
    ];
    // Keep the Nostr private key out of argv/process listings. buzz-acp reads
    // the same value from its documented environment fallback.
    env.BUZZ_PRIVATE_KEY = nip19.nsecEncode(agentSecret);
    if (deployment.config.systemPrompt) {
      env.BUZZ_ACP_SYSTEM_PROMPT = deployment.config.systemPrompt;
    }
    if (deployment.config.model) env.BUZZ_AGENT_MODEL = deployment.config.model;
    if (deployment.config.providerId) {
      env.BUZZ_AGENT_PROVIDER = deployment.config.providerId;
    }
    if (deployment.config.respondToAllowlist?.length) {
      env.BUZZ_ACP_RESPOND_TO_ALLOWLIST =
        deployment.config.respondToAllowlist.join(",");
    }

    // Opened last so a rejected deployment — a missing secret reference, an
    // unallowlisted runtime, an invalid key — cannot leak a descriptor. A
    // repeatedly rejected deploy would otherwise exhaust the worker's fds.
    const log = await open(logPath, "a", 0o600);
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [ACP_CLI, ...args], {
        cwd: workDirectory,
        env,
        shell: false,
        stdio: ["ignore", log.fd, log.fd],
        windowsHide: true,
      });
    } catch (error) {
      await log.close();
      throw error;
    }
    const spawnedChild = child;
    const closeLog = (): void => {
      this.#processes.delete(deployment.id);
      void log.close();
    };
    spawnedChild.once("exit", closeLog);
    spawnedChild.once("error", closeLog);
    this.#processes.set(deployment.id, spawnedChild);
    await new Promise<void>((resolve, reject) => {
      spawnedChild.once("spawn", resolve);
      spawnedChild.once("error", reject);
    });
  }

  public async stop(
    deploymentId: string,
    timeoutMilliseconds = 10_000,
  ): Promise<void> {
    const child = this.#processes.get(deploymentId);
    if (!child || child.exitCode !== null) {
      this.#processes.delete(deploymentId);
      return;
    }
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMilliseconds);
    timer.unref();
    try {
      await once(child, "exit");
    } finally {
      clearTimeout(timer);
      this.#processes.delete(deploymentId);
    }
  }

  public async readLogTail(
    deploymentId: string,
    lines: number,
  ): Promise<string> {
    const logPath = join(
      this.#dataDirectory,
      "deployments",
      deploymentId,
      "agent.log",
    );
    const metadata = await stat(logPath);
    const maxBytes = 256 * 1024;
    const start = Math.max(0, metadata.size - maxBytes);
    const handle = await open(logPath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(metadata.size, maxBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return redactSensitiveText(
        buffer
          .subarray(0, bytesRead)
          .toString("utf8")
          .split(/\r?\n/)
          .slice(-Math.min(lines, 2_000))
          .join("\n"),
      );
    } finally {
      await handle.close();
    }
  }
}

function resolveEnvironment(
  config: RemoteDeploymentConfig,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH,
    LANG: source.LANG,
    LC_ALL: source.LC_ALL,
  };
  for (const [name, reference] of Object.entries(
    config.secretReferences ?? {},
  )) {
    if (!reference.startsWith("env://")) {
      throw new RemoteProtocolError(
        "SECRET_REFERENCE_MISSING",
        `this worker does not have a resolver for ${reference.split("://")[0]}:// references`,
      );
    }
    const sourceName = reference.slice("env://".length);
    const value = source[sourceName];
    if (!value) {
      throw new RemoteProtocolError(
        "SECRET_REFERENCE_MISSING",
        `required secret environment variable ${sourceName} is missing`,
      );
    }
    env[name] = value;
  }
  return env;
}
