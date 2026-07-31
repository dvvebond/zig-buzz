#!/usr/bin/env node

import { nip19 } from "nostr-tools";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import WebSocket from "ws";

import { parseArguments } from "./cli-args.js";
import { AcpHarness, type RespondTo } from "./harness.js";

const args = parseArguments(process.argv.slice(2));
const privateKey = process.env.BUZZ_PRIVATE_KEY;
if (!privateKey) throw new Error("BUZZ_PRIVATE_KEY is required");
const decoded = nip19.decode(privateKey);
if (decoded.type !== "nsec") throw new Error("BUZZ_PRIVATE_KEY must be nsec");
const secretKey = Uint8Array.from(decoded.data);
const relayUrl =
  flag(args, "relay-url") ??
  process.env.BUZZ_RELAY_URL ??
  "ws://localhost:3000/";
const ownerPubkey =
  flag(args, "agent-owner") ?? process.env.BUZZ_ACP_AGENT_OWNER;
const authTag = parseOwnerAuthTag(process.env.BUZZ_AUTH_TAG);
const respondTo = (flag(args, "respond-to") ??
  process.env.BUZZ_ACP_RESPOND_TO ??
  "owner-only") as RespondTo;
if (!["owner-only", "allowlist", "anyone", "nobody"].includes(respondTo)) {
  throw new Error(
    "respond-to must be owner-only, allowlist, anyone, or nobody",
  );
}
const command =
  flag(args, "agent-command") ?? process.env.BUZZ_ACP_AGENT_COMMAND ?? "goose";
const rawAgentArgs =
  flag(args, "agent-args") ?? process.env.BUZZ_ACP_AGENT_ARGS ?? "acp";
const agentArgs = rawAgentArgs === "" ? [] : rawAgentArgs.split(",");
const parallelism = integerFlag(args, "parallelism", 1, 32, 1);
const initialChannelIds = (
  flag(args, "channel-ids") ??
  process.env.BUZZ_ACP_CHANNEL_IDS ??
  ""
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const maximumTurnSeconds = integerFlag(
  args,
  "max-turn-duration",
  10,
  604_800,
  7_200,
);
const publishAgentText = booleanFlag(
  args,
  "publish-agent-text",
  process.env.BUZZ_ACP_PUBLISH_AGENT_TEXT,
  ["buzz-agent", "buzz-agent-ts"].includes(basename(command)),
);
const noBasePrompt = booleanFlag(
  args,
  "no-base-prompt",
  process.env.BUZZ_ACP_NO_BASE_PROMPT,
  false,
);
const basePromptFile =
  flag(args, "base-prompt-file") ?? process.env.BUZZ_ACP_BASE_PROMPT_FILE;
if (noBasePrompt && basePromptFile) {
  throw new Error(
    "--no-base-prompt and --base-prompt-file may not be used together",
  );
}
const basePrompt = noBasePrompt
  ? null
  : basePromptFile
    ? await readBoundedPrompt(basePromptFile)
    : undefined;
const harness = new AcpHarness({
  agent: {
    args: agentArgs,
    command,
    cwd: process.cwd(),
    turnTimeoutMilliseconds: maximumTurnSeconds * 1_000,
  },
  allowInsecureLocalhost: isLoopbackRelay(relayUrl),
  ...(basePrompt !== undefined ? { basePrompt } : {}),
  ...(authTag ? { authTag } : {}),
  ...(ownerPubkey ? { ownerPubkey } : {}),
  initialChannelIds,
  parallelism,
  publishAgentText,
  relayUrl,
  respondTo,
  respondToAllowlist: (process.env.BUZZ_ACP_RESPOND_TO_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  secretKey,
  ...(process.env.BUZZ_ACP_SESSION_TITLE
    ? { sessionTitle: process.env.BUZZ_ACP_SESSION_TITLE }
    : {}),
  socketFactory: (url) =>
    new WebSocket(url, {
      perMessageDeflate: false,
    }) as unknown as import("@buzz/ws-client").RelaySocket,
  ...(process.env.BUZZ_ACP_SYSTEM_PROMPT
    ? { systemPrompt: process.env.BUZZ_ACP_SYSTEM_PROMPT }
    : {}),
});
harness.on((event) => {
  if (event.type === "error") {
    process.stderr.write(`buzz-acp: ${safeError(event.error)}\n`);
  }
});
await harness.start();
process.stdout.write("buzz-acp ready\n");

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void harness.stop().finally(() => {
    secretKey.fill(0);
    process.exitCode = 0;
  });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

function flag(
  values: ReadonlyMap<string, string>,
  name: string,
): string | undefined {
  return values.get(name);
}

function integerFlag(
  values: ReadonlyMap<string, string>,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const raw = flag(values, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function booleanFlag(
  values: ReadonlyMap<string, string>,
  name: string,
  environmentValue: string | undefined,
  fallback: boolean,
): boolean {
  const raw = flag(values, name) ?? environmentValue;
  if (raw === undefined) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`--${name} must be true or false`);
}

function isLoopbackRelay(value: string): boolean {
  const hostname = new URL(value).hostname;
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

function safeError(error: Error): string {
  return error.message
    .slice(0, 1_024)
    .replaceAll(/(?:nsec1|brap1_)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replaceAll(/[\r\n\t]/g, " ");
}

function parseOwnerAuthTag(
  raw: string | undefined,
): [string, string, string, string] | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("BUZZ_AUTH_TAG must contain JSON");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value[0] !== "auth" ||
    typeof value[1] !== "string" ||
    !/^[0-9a-f]{64}$/.test(value[1]) ||
    typeof value[2] !== "string" ||
    Buffer.byteLength(value[2], "utf8") > 1_024 ||
    typeof value[3] !== "string" ||
    !/^[0-9a-f]{128}$/.test(value[3])
  ) {
    throw new Error("BUZZ_AUTH_TAG must contain a valid NIP-OA auth tag");
  }
  return [value[0], value[1], value[2], value[3]];
}

async function readBoundedPrompt(file: string): Promise<string> {
  const details = await stat(file);
  if (!details.isFile() || details.size > 1024 * 1024) {
    throw new Error(
      "ACP base prompt file must be a regular file at most 1 MiB",
    );
  }
  const value = await readFile(file, "utf8");
  if (Buffer.byteLength(value, "utf8") > 1024 * 1024) {
    throw new Error("ACP base prompt file exceeds 1 MiB");
  }
  return value;
}
