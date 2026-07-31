#!/usr/bin/env node

import { Readable, Writable } from "node:stream";

import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";

import { BuzzAgent } from "./agent.js";
import { OpenAiResponsesRunner } from "./openai-runner.js";

const implementation = new BuzzAgent(new OpenAiResponsesRunner());
const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);
agent({ name: "buzz-agent-ts" })
  .onRequest(methods.agent.initialize, ({ params }) =>
    implementation.initialize(params),
  )
  .onRequest(methods.agent.session.new, ({ params }) =>
    implementation.newSession(params),
  )
  .onRequest(methods.agent.session.prompt, ({ params, client, signal }) =>
    implementation.prompt(params, client, signal),
  )
  .onNotification(methods.agent.session.cancel, ({ params }) => {
    implementation.cancel(params.sessionId);
  })
  .connect(stream);
