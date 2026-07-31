import {
  RemoteAgentOwnerConnection,
  createEnrollmentInvitation,
  type EnrollmentInvitation,
  type OwnerConnectionEvent,
} from "@buzz/remote-agent-client";
import { nip19 } from "nostr-tools";

import { getRelayWsUrl } from "@/shared/api/tauri";
import { getNsec } from "@/shared/api/tauriIdentity";
import type { AcpRuntime, AgentPersona } from "@/shared/api/types";

export type RemoteEnrollmentState = {
  readonly invitation: EnrollmentInvitation;
  readonly setupCommand: string;
};

export type StoredRemoteAgent = {
  readonly agentPubkey: string;
  readonly createdAt: number;
  readonly deploymentId: string;
  readonly name: string;
  readonly personaId: string;
  readonly relayUrl: string;
  readonly workerPubkey: string;
};

const REMOTE_AGENT_STORAGE_KEY = "buzz.remote-agents.v1";
const listeners = new Set<(event: OwnerConnectionEvent) => void>();
let active:
  | {
      readonly connection: RemoteAgentOwnerConnection;
      readonly ownerSecretKey: Uint8Array;
      readonly relayUrl: string;
    }
  | undefined;
let connecting: Promise<typeof active> | undefined;

export function subscribeRemoteAgentEvents(
  listener: (event: OwnerConnectionEvent) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function beginRemoteEnrollment(): Promise<RemoteEnrollmentState> {
  const context = await ensureOwnerConnection();
  if (!context) throw new Error("remote-agent connection is unavailable");
  const invitation = await createEnrollmentInvitation({
    allowInsecureLocalhost: isLoopbackRelay(context.relayUrl),
    capabilities: [
      "deploy",
      "start",
      "stop",
      "restart",
      "update",
      "status",
      "logs",
      "revoke",
    ],
    ownerSecretKey: context.ownerSecretKey,
    relayUrl: context.relayUrl,
  });
  return {
    invitation,
    setupCommand: [
      "buzz-remote-agent",
      "--relay",
      shellQuote(context.relayUrl),
      "--enrollment-token",
      shellQuote(invitation.token),
    ].join(" "),
  };
}

export async function approveRemoteEnrollment(input: {
  readonly enrollment: Extract<
    OwnerConnectionEvent,
    { type: "enrollment" }
  >["payload"];
  readonly workerPubkey: string;
}): Promise<void> {
  const context = await ensureOwnerConnection();
  if (!context) throw new Error("remote-agent connection is unavailable");
  context.connection.approveEnrollment(input);
}

export async function deployRemoteAgent(input: {
  readonly deploymentId: string;
  readonly workerPubkey: string;
  readonly persona: AgentPersona;
  readonly runtime: AcpRuntime;
}): Promise<StoredRemoteAgent> {
  const context = await ensureOwnerConnection();
  if (!context) throw new Error("remote-agent connection is unavailable");
  const acknowledgement = await context.connection.sendCommandAndWait(
    {
      body: {
        action: "deploy",
        config: {
          displayName: input.persona.displayName,
          runtimeId: input.runtime.id,
          ...(input.persona.systemPrompt
            ? { systemPrompt: input.persona.systemPrompt }
            : {}),
          ...(input.persona.model ? { model: input.persona.model } : {}),
          ...(input.persona.provider
            ? { providerId: input.persona.provider }
            : {}),
        },
      },
      deploymentId: input.deploymentId,
      workerPubkey: input.workerPubkey,
    },
    2 * 60_000,
  );
  const agentPubkey = acknowledgement.body.agentPubkey;
  if (!agentPubkey) {
    throw new Error("remote worker did not return the new agent identity");
  }
  const record: StoredRemoteAgent = {
    agentPubkey,
    createdAt: Date.now(),
    deploymentId: input.deploymentId,
    name: input.persona.displayName,
    personaId: input.persona.id,
    relayUrl: context.relayUrl,
    workerPubkey: input.workerPubkey,
  };
  saveStoredRemoteAgent(record);
  return record;
}

export function listStoredRemoteAgents(): StoredRemoteAgent[] {
  try {
    const value = JSON.parse(
      localStorage.getItem(REMOTE_AGENT_STORAGE_KEY) ?? "[]",
    ) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(isStoredRemoteAgent);
  } catch {
    return [];
  }
}

async function ensureOwnerConnection(): Promise<typeof active> {
  if (active) return active;
  if (connecting) return connecting;
  connecting = connectOwner();
  try {
    return await connecting;
  } finally {
    connecting = undefined;
  }
}

async function connectOwner(): Promise<NonNullable<typeof active>> {
  const [relayUrl, nsec] = await Promise.all([getRelayWsUrl(), getNsec()]);
  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
    throw new Error("Buzz identity key is unavailable");
  }
  const connection = new RemoteAgentOwnerConnection({
    allowInsecureLocalhost: isLoopbackRelay(relayUrl),
    ownerSecretKey: decoded.data,
    relayUrl,
  });
  const connected = new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error("remote-agent relay authentication timed out")),
      15_000,
    );
    const unsubscribe = connection.on((event) => {
      if (event.type === "connected") {
        window.clearTimeout(timeout);
        unsubscribe();
        resolve();
      } else if (event.type === "error") {
        window.clearTimeout(timeout);
        unsubscribe();
        reject(event.error);
      }
    });
  });
  connection.on((event) => {
    for (const listener of listeners) listener(event);
    if (event.type === "disconnected" && active?.connection === connection) {
      active = undefined;
    }
  });
  await connection.connect();
  await connected;
  active = {
    connection,
    ownerSecretKey: decoded.data,
    relayUrl,
  };
  return active;
}

function saveStoredRemoteAgent(record: StoredRemoteAgent): void {
  const records = listStoredRemoteAgents().filter(
    (candidate) => candidate.deploymentId !== record.deploymentId,
  );
  records.push(record);
  localStorage.setItem(REMOTE_AGENT_STORAGE_KEY, JSON.stringify(records));
}

function isStoredRemoteAgent(value: unknown): value is StoredRemoteAgent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<StoredRemoteAgent>;
  return (
    typeof record.agentPubkey === "string" &&
    /^[0-9a-f]{64}$/.test(record.agentPubkey) &&
    typeof record.workerPubkey === "string" &&
    /^[0-9a-f]{64}$/.test(record.workerPubkey) &&
    typeof record.deploymentId === "string" &&
    typeof record.personaId === "string" &&
    typeof record.name === "string" &&
    typeof record.relayUrl === "string" &&
    typeof record.createdAt === "number"
  );
}

function isLoopbackRelay(value: string): boolean {
  const hostname = new URL(value).hostname;
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
