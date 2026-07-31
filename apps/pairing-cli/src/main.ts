#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import {
  deriveEcdhShared,
  deriveSas,
  deriveSessionId,
  deriveTranscriptHash,
  formatSas,
  type PayloadType,
} from "@buzz/pairing";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

import { runSourceFlow, runTargetFlow } from "./flow.js";

const command = process.argv[2];
const args = process.argv.slice(3);

try {
  switch (command) {
    case "source":
      await source(args);
      break;
    case "target":
      await target(args);
      break;
    case "test-vectors":
      testVectors();
      break;
    default:
      usage();
      process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  process.stderr.write(
    `error: ${error instanceof Error ? error.message : "pairing failed"}\n`,
  );
  process.exitCode = 1;
}

async function source(args: string[]): Promise<void> {
  const relay = option(args, "--relay") ?? "ws://127.0.0.1:5000/pair";
  const type = (option(args, "--type") ?? "nsec") as PayloadType;
  if (!["nsec", "bunker", "connect", "custom"].includes(type)) {
    throw new Error("--type must be nsec, bunker, connect, or custom");
  }
  const payload = await resolvePayload(args, type);
  await runSourceFlow({
    confirmSas: confirm,
    onQr(uri) {
      process.stdout.write(
        "QR URI (contains a one-time session secret; share only with the target):\n",
      );
      process.stdout.write(`${uri}\n`);
    },
    payload,
    payloadType: type,
    relay,
  });
  process.stdout.write("Transfer complete.\n");
}

async function target(args: string[]): Promise<void> {
  const relayOverride = option(args, "--relay");
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  let uri: string;
  try {
    uri = process.stdin.isTTY
      ? await prompt.question("Paste the QR URI: ")
      : (await readStdin()).trim();
  } finally {
    prompt.close();
  }
  const result = await runTargetFlow({
    confirmSas: confirm,
    qrUri: uri,
    ...(relayOverride === undefined ? {} : { relayOverride }),
  });
  process.stdout.write(`Received ${result.type} payload.\n`);
  if (args.includes("--show-secret")) {
    process.stdout.write(`${result.payload}\n`);
  } else {
    process.stdout.write(
      "Secret hidden. Re-run with --show-secret only in a private terminal if required.\n",
    );
  }
}

async function resolvePayload(
  args: string[],
  type: PayloadType,
): Promise<string> {
  const environmentName = option(args, "--payload-env");
  const file = option(args, "--payload-file");
  const direct = option(args, "--nsec");
  const configured = [environmentName, file, direct].filter(
    (value) => value !== undefined,
  );
  if (configured.length > 1) {
    throw new Error("use only one of --payload-env, --payload-file, or --nsec");
  }
  let payload: string;
  if (environmentName) {
    payload = process.env[environmentName] ?? "";
    if (!payload)
      throw new Error(`environment variable ${environmentName} is empty`);
  } else if (file) {
    payload = (await readFile(file, "utf8")).trim();
  } else if (direct) {
    process.stderr.write(
      "warning: --nsec can be exposed in process listings; prefer --payload-env or --payload-file\n",
    );
    payload = direct;
  } else if (type === "nsec") {
    const generated = generateSecretKey();
    payload = nip19.nsecEncode(generated);
    generated.fill(0);
    process.stderr.write("No payload supplied; using a generated test key.\n");
  } else {
    throw new Error("a payload is required for non-nsec transfers");
  }
  if (type === "nsec") {
    const decoded = nip19.decode(payload);
    if (decoded.type !== "nsec") throw new Error("payload is not a valid nsec");
    if (decoded.data instanceof Uint8Array) decoded.data.fill(0);
  }
  return payload;
}

async function confirm(sas: string): Promise<boolean> {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await prompt.question(
      `SAS code ${sas}. Does the other device show the same code? [y/N]: `,
    );
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

function testVectors(): void {
  const sessionSecret = bytes(
    "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
  );
  const sourceSecret = bytes(
    "7f4c11a9c9d1e3b5a7f2e4d6c8b0a2f4e6d8c0b2a4f6e8d0c2b4a6f8e0d2c4b5",
  );
  const targetSecret = bytes(
    "3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c5d7e9f1a3b5c7d9e1f3a5b",
  );
  const sourcePubkey = getPublicKey(sourceSecret);
  const targetPubkey = getPublicKey(targetSecret);
  const shared = deriveEcdhShared(sourceSecret, targetPubkey);
  const sessionId = deriveSessionId(sessionSecret);
  const sas = deriveSas(shared, sessionSecret);
  const transcript = deriveTranscriptHash({
    sasInput: sas.input,
    sessionId,
    sessionSecret,
    sourcePubkey: bytes(sourcePubkey),
    targetPubkey: bytes(targetPubkey),
  });
  const rows = {
    ecdh_shared: hex(shared),
    sas_code: formatSas(sas.code),
    sas_input: hex(sas.input),
    session_id: hex(sessionId),
    session_secret: hex(sessionSecret),
    source_priv: hex(sourceSecret),
    source_pubkey: sourcePubkey,
    target_priv: hex(targetSecret),
    target_pubkey: targetPubkey,
    transcript_hash: hex(transcript),
  };
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  for (const value of [
    sessionSecret,
    sourceSecret,
    targetSecret,
    shared,
    sessionId,
    sas.input,
    transcript,
  ]) {
    value.fill(0);
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function usage(): void {
  process.stdout.write(
    [
      "buzz-pair source [--relay URL] [--type TYPE] [--payload-env NAME|--payload-file PATH|--nsec VALUE]",
      "buzz-pair target [--relay URL] [--show-secret]  # QR URI on stdin",
      "buzz-pair test-vectors",
      "",
    ].join("\n"),
  );
}
