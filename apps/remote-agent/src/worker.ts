import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  RemoteProtocolError,
  commandPayloadSchema,
  remoteCapabilities,
  type CommandPayload,
  type RemoteCapability,
} from "@buzz/remote-agent-protocol";

import type { AgentProcessManager } from "./process-manager.js";
import type {
  DeploymentState,
  EncryptedStateStore,
  WorkerState,
} from "./state.js";

export type CommandResult = {
  readonly outcome: "completed" | "rejected";
  readonly code?: string;
  readonly message?: string;
  readonly agentPubkey?: string;
};

export class RemoteWorker {
  #state: WorkerState;
  readonly #store: EncryptedStateStore;
  readonly #processes: AgentProcessManager;
  readonly #capabilities: ReadonlySet<RemoteCapability>;

  public constructor(input: {
    readonly state: WorkerState;
    readonly store: EncryptedStateStore;
    readonly processes: AgentProcessManager;
    readonly capabilities?: readonly RemoteCapability[];
  }) {
    this.#state = input.state;
    this.#store = input.store;
    this.#processes = input.processes;
    this.#capabilities = new Set(input.capabilities ?? remoteCapabilities);
  }

  public state(): Readonly<WorkerState> {
    return this.#state;
  }

  public async handle(payload: CommandPayload): Promise<CommandResult> {
    const parsed = commandPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        code: "CONFIG_INVALID",
        message: "remote command payload is invalid",
        outcome: "rejected",
      };
    }
    const command = parsed.data;
    const action = command.body.action;
    if (!this.#capabilities.has(action)) {
      return {
        code: "CAPABILITY_DENIED",
        message: `worker capability '${action}' is disabled`,
        outcome: "rejected",
      };
    }
    try {
      return await this.#execute(command);
    } catch (error) {
      if (error instanceof RemoteProtocolError) {
        return {
          code: error.code,
          message: error.message,
          outcome: "rejected",
        };
      }
      return {
        code: "WORKER_OPERATION_FAILED",
        message: "remote worker operation failed; inspect local worker logs",
        outcome: "rejected",
      };
    }
  }

  async #execute(payload: CommandPayload): Promise<CommandResult> {
    const deploymentId = payload.deploymentId;
    switch (payload.body.action) {
      case "deploy": {
        if (this.#state.deployments[deploymentId]?.status === "revoked") {
          throw new RemoteProtocolError(
            "CAPABILITY_DENIED",
            "revoked deployment cannot be recreated with the same ID",
          );
        }
        const existing = this.#state.deployments[deploymentId];
        const deployment: DeploymentState = {
          agentSecretKeyHex:
            existing?.agentSecretKeyHex ??
            Buffer.from(generateSecretKey()).toString("hex"),
          config: payload.body.config,
          id: deploymentId,
          status: "stopped",
          updatedAt: payload.issuedAt,
        };
        await this.#replaceDeployment(deployment);
        await this.#processes.start(deployment);
        await this.#replaceDeployment({
          ...deployment,
          status: "running",
          updatedAt: payload.issuedAt,
        });
        return {
          agentPubkey: getPublicKey(
            Uint8Array.from(Buffer.from(deployment.agentSecretKeyHex, "hex")),
          ),
          message: "agent deployed and running",
          outcome: "completed",
        };
      }
      case "start": {
        const deployment = this.#requireDeployment(deploymentId);
        await this.#processes.start(deployment);
        await this.#replaceDeployment({
          ...deployment,
          status: "running",
          updatedAt: payload.issuedAt,
        });
        return { message: "agent running", outcome: "completed" };
      }
      case "stop": {
        const deployment = this.#requireDeployment(deploymentId);
        await this.#processes.stop(deploymentId);
        await this.#replaceDeployment({
          ...deployment,
          status: "stopped",
          updatedAt: payload.issuedAt,
        });
        return { message: "agent stopped", outcome: "completed" };
      }
      case "restart": {
        const deployment = this.#requireDeployment(deploymentId);
        await this.#processes.stop(deploymentId);
        await this.#processes.start(deployment);
        await this.#replaceDeployment({
          ...deployment,
          status: "running",
          updatedAt: payload.issuedAt,
        });
        return { message: "agent restarted", outcome: "completed" };
      }
      case "update": {
        const deployment = this.#requireDeployment(deploymentId);
        const updated: DeploymentState = {
          ...deployment,
          config: payload.body.config,
          updatedAt: payload.issuedAt,
        };
        await this.#replaceDeployment(updated);
        if (this.#processes.isRunning(deploymentId)) {
          await this.#processes.stop(deploymentId);
          await this.#processes.start(updated);
        }
        return { message: "agent configuration updated", outcome: "completed" };
      }
      case "status": {
        const deployment = this.#requireDeployment(deploymentId);
        const running = this.#processes.isRunning(deploymentId);
        return {
          message: JSON.stringify({
            running,
            status: deployment.status,
            updatedAt: deployment.updatedAt,
          }),
          outcome: "completed",
        };
      }
      case "logs": {
        this.#requireDeployment(deploymentId);
        const tail = await this.#processes.readLogTail(
          deploymentId,
          payload.body.lines,
        );
        return {
          message: Buffer.from(tail, "utf8")
            .subarray(0, 48 * 1024)
            .toString("utf8"),
          outcome: "completed",
        };
      }
      case "revoke": {
        const deployment = this.#requireDeployment(deploymentId);
        await this.#processes.stop(deploymentId);
        const revoked: DeploymentState = {
          ...deployment,
          agentSecretKeyHex: payload.body.eraseAgentKey
            ? "0".repeat(64)
            : deployment.agentSecretKeyHex,
          status: "revoked",
          updatedAt: payload.issuedAt,
        };
        await this.#replaceDeployment(revoked);
        return {
          message: payload.body.eraseAgentKey
            ? "deployment revoked and local agent key erased"
            : "deployment revoked",
          outcome: "completed",
        };
      }
    }
  }

  #requireDeployment(deploymentId: string): DeploymentState {
    const deployment = this.#state.deployments[deploymentId];
    if (!deployment) {
      throw new RemoteProtocolError(
        "DEPLOYMENT_NOT_FOUND",
        "deployment does not exist on this worker",
      );
    }
    if (deployment.status === "revoked") {
      throw new RemoteProtocolError(
        "CAPABILITY_DENIED",
        "deployment has been revoked",
      );
    }
    return deployment;
  }

  async #replaceDeployment(deployment: DeploymentState): Promise<void> {
    this.#state = {
      ...this.#state,
      deployments: {
        ...this.#state.deployments,
        [deployment.id]: deployment,
      },
    };
    await this.#store.save(this.#state);
  }
}
