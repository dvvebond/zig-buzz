#!/usr/bin/env node

import { parseArgs } from "node:util";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

import { generateSecretKey } from "nostr-tools/pure";
import {
  parseEnrollmentToken,
  remoteCapabilities,
  validateRemoteRelayUrl,
} from "@buzz/remote-agent-protocol";

import { AgentProcessManager } from "./process-manager.js";
import { RelayConnection } from "./relay-connection.js";
import { EncryptedStateStore } from "./state.js";
import { RemoteWorker } from "./worker.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      "allow-insecure-localhost": { type: "boolean", default: false },
      "data-dir": { type: "string" },
      "enrollment-token": { type: "string" },
      help: { short: "h", type: "boolean", default: false },
      relay: { type: "string" },
      "worker-name": { type: "string" },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(
      [
        "Usage: buzz-remote-agent --relay <wss-url> [--enrollment-token <token>]",
        "",
        "The worker opens one outbound WebSocket connection. It never listens on a port.",
        "",
      ].join("\n"),
    );
    return;
  }
  if (!values.relay) throw new Error("--relay is required");

  const relayUrl = validateRemoteRelayUrl(
    values.relay,
    values["allow-insecure-localhost"],
  );
  const dataDirectory = resolve(
    values["data-dir"] ?? join(homedir(), ".config", "buzz", "remote-agent"),
  );
  const enrollment = values["enrollment-token"]
    ? parseEnrollmentToken(values["enrollment-token"])
    : undefined;

  const generatedSecret = generateSecretKey();
  const store = new EncryptedStateStore(dataDirectory);
  let state = await store.loadOrCreate({
    workerName: values["worker-name"] ?? hostname(),
    workerSecretKeyHex: Buffer.from(generatedSecret).toString("hex"),
  });
  if (state.revoked) {
    throw new Error(
      "this remote worker has been revoked; remove its data directory and create a new enrollment to trust it again",
    );
  }
  const ownerPubkey = state.ownerPubkey ?? enrollment?.ownerPubkey;
  if (!ownerPubkey) {
    throw new Error(
      "this worker is not enrolled; provide --enrollment-token once",
    );
  }
  if (!state.approved && !values["enrollment-token"]) {
    throw new Error(
      "worker enrollment is incomplete; provide the original enrollment token until approval succeeds",
    );
  }
  if (state.ownerPubkey && enrollment?.ownerPubkey !== undefined) {
    if (state.ownerPubkey !== enrollment.ownerPubkey) {
      throw new Error("enrollment token belongs to a different owner");
    }
  }
  if (!state.ownerPubkey) {
    state = {
      ...state,
      community: relayUrl.host,
      enrollmentId: enrollment?.id,
      ownerPubkey,
    };
    await store.save(state);
  }
  if (!state.enrollmentId) {
    if (!enrollment?.id) {
      throw new Error(
        "worker state is missing its enrollment ID; enroll this worker again",
      );
    }
    state = { ...state, enrollmentId: enrollment.id };
    await store.save(state);
  }

  const workerSecret = Uint8Array.from(
    Buffer.from(state.workerSecretKeyHex, "hex"),
  );
  const processManager = new AgentProcessManager({
    dataDirectory,
    ownerPubkey,
    relayUrl: relayUrl.toString(),
  });
  const worker = new RemoteWorker({
    processes: processManager,
    state,
    store,
  });
  const connection = new RelayConnection({
    approved: state.approved,
    capabilities: remoteCapabilities,
    community: state.community ?? relayUrl.host,
    enrollmentId: state.enrollmentId as string,
    ...(values["enrollment-token"]
      ? { enrollmentToken: values["enrollment-token"] }
      : {}),
    ownerPubkey,
    relayUrl,
    workerName: state.workerName,
    workerSecretKey: workerSecret,
    workerVersion: VERSION,
  });
  connection.on("approved", () => {
    state = { ...state, approved: true };
    void store.save(state);
    process.stdout.write(
      `Remote worker ${connection.workerPubkey()} approved and connected.\n`,
    );
  });
  connection.on("ready", () => {
    process.stdout.write(
      `Remote worker ${connection.workerPubkey()} secure session ready.\n`,
    );
  });
  connection.on("command", (payload) => {
    if (payload.type !== "command") return;
    void worker.handle(payload).then(async (result) => {
      connection.sendAck({
        command: payload,
        outcome: result.outcome,
        ...(result.code ? { code: result.code } : {}),
        ...(result.message ? { message: result.message } : {}),
        ...(result.agentPubkey ? { agentPubkey: result.agentPubkey } : {}),
      });
      if (payload.body.action === "revoke" && result.outcome === "completed") {
        state = {
          ...worker.state(),
          approved: false,
          revoked: true,
        };
        await store.save(state);
        setTimeout(() => connection.stop(), 250).unref();
      }
    });
  });
  connection.on("error", (error) => {
    process.stderr.write(`remote worker: ${safeErrorMessage(error)}\n`);
  });

  const stop = (): void => connection.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await connection.run();
}

function safeErrorMessage(error: Error): string {
  if (error.name === "RemoteProtocolError") return error.message;
  return "connection or worker operation failed";
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `buzz-remote-agent: ${error instanceof Error ? safeErrorMessage(error) : "startup failed"}\n`,
  );
  process.exitCode = 1;
});
