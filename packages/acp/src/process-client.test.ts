import { describe, expect, it } from "vitest";

import { AcpProcessClient } from "./process-client.js";

const FAKE_AGENT = String.raw`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: request.params.protocolVersion,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: "fake-agent", version: "1.0.0" }
    }});
  } else if (request.method === "session/new") {
    send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "session-1" }});
  } else if (request.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: request.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello from fake agent" }
      }
    }});
    send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" }});
  }
});
`;

describe("ACP process client", () => {
  it("initializes, creates a session, streams updates, and prompts", async () => {
    const processClient = new AcpProcessClient({
      args: ["-e", FAKE_AGENT],
      command: process.execPath,
      cwd: process.cwd(),
      inheritEnvironment: false,
      requestTimeoutMilliseconds: 5_000,
      turnTimeoutMilliseconds: 10_000,
    });
    const updates: string[] = [];
    processClient.on((event) => {
      if (
        event.type === "update" &&
        event.notification.update.sessionUpdate === "agent_message_chunk" &&
        event.notification.update.content.type === "text"
      ) {
        updates.push(event.notification.update.content.text);
      }
    });

    const initialized = await processClient.start();
    expect(initialized).toMatchObject({
      agentInfo: { name: "fake-agent" },
      protocolVersion: 2,
    });
    const session = await processClient.newSession();
    expect(session.sessionId).toBe("session-1");
    await expect(
      processClient.prompt(session.sessionId, "hello"),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(updates).toEqual(["hello from fake agent"]);
    await processClient.shutdown();
  });

  it("rejects private-key environment forwarding and invalid paths", () => {
    expect(
      () =>
        new AcpProcessClient({
          command: process.execPath,
          cwd: "relative",
        }),
    ).toThrow("absolute");
    expect(
      () =>
        new AcpProcessClient({
          command: process.execPath,
          cwd: process.cwd(),
          environment: { BUZZ_PRIVATE_KEY: "must-not-cross-boundary" },
        }),
    ).toThrow("not allowed");
  });
});
