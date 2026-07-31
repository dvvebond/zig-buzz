import { describe, expect, it } from "vitest";
import { client, methods } from "@agentclientprotocol/sdk";

import { BuzzAgent, type ModelRunner, type ModelTurnInput } from "./agent.js";

class FakeRunner implements ModelRunner {
  public readonly prompts: string[] = [];

  public async run(input: ModelTurnInput) {
    this.prompts.push(input.prompt);
    await input.onText("hello ");
    await input.onText("world");
    return {
      text: "hello world",
      usage: { inputTokens: 7, outputTokens: 2 },
    };
  }
}

describe("built-in Buzz ACP agent", () => {
  it("negotiates, creates a session, streams text, and retains history", async () => {
    const runner = new FakeRunner();
    const implementation = new BuzzAgent(runner);
    const updates: string[] = [];
    const clientApp = client({ name: "agent-test-client" }).onNotification(
      methods.client.session.update,
      ({ params }) => {
        if (
          params.update.sessionUpdate === "agent_message_chunk" &&
          params.update.content.type === "text"
        ) {
          updates.push(params.update.content.text);
        }
      },
    );
    const agentApp = (await import("@agentclientprotocol/sdk"))
      .agent({ name: "agent-test" })
      .onRequest(methods.agent.initialize, ({ params }) =>
        implementation.initialize(params),
      )
      .onRequest(methods.agent.session.new, ({ params }) =>
        implementation.newSession(params),
      )
      .onRequest(
        methods.agent.session.prompt,
        ({ params, client: agentClient, signal }) =>
          implementation.prompt(params, agentClient, signal),
      )
      .onNotification(methods.agent.session.cancel, ({ params }) => {
        implementation.cancel(params.sessionId);
      });
    const connection = clientApp.connect(agentApp);
    const initialized = await connection.agent.request(
      methods.agent.initialize,
      {
        clientCapabilities: {},
        protocolVersion: 2,
      },
    );
    expect(initialized.protocolVersion).toBe(2);
    const session = await connection.agent.request(methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    await expect(
      connection.agent.request(methods.agent.session.prompt, {
        prompt: [{ text: "first", type: "text" }],
        sessionId: session.sessionId,
      }),
    ).resolves.toMatchObject({
      stopReason: "end_turn",
      usage: { inputTokens: 7, outputTokens: 2 },
    });
    await connection.agent.request(methods.agent.session.prompt, {
      prompt: [{ text: "second", type: "text" }],
      sessionId: session.sessionId,
    });
    expect(updates).toEqual(["hello ", "world", "hello ", "world"]);
    expect(runner.prompts).toEqual(["first", "second"]);
    connection.close();
  });
});
