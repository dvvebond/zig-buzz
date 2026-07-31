#!/usr/bin/env node
import { generateSecretKey, nip19 } from "nostr-tools";
import { getPublicKey } from "nostr-tools/pure";
import { BuzzTestClient } from "./index.js";

const args = parseArgs(process.argv.slice(2));
const relayUrl = args.url ?? "ws://localhost:3000";
const secretKey = process.env.BUZZ_PRIVATE_KEY
  ? parseKey(process.env.BUZZ_PRIVATE_KEY)
  : generateSecretKey();
process.stdout.write(`Using pubkey: ${getPublicKey(secretKey)}\n`);

try {
  const client = await BuzzTestClient.connect(relayUrl, secretKey, {
    allowInsecureLocalhost: true,
  });
  if (args.send !== undefined) {
    const result = await client.sendTextMessage({
      secretKey,
      channelId: args.channel ?? "default",
      content: args.send,
      kind: args.kind ?? 9,
    });
    if (!result.accepted) throw new Error(result.message);
    process.stdout.write(`Event accepted: ${result.eventId}\n`);
    client.disconnect();
  } else if (args.subscribe) {
    const subscription = client.subscribe([
      { kinds: [args.kind ?? 9], "#h": [args.channel ?? "default"] },
    ]);
    const stop = (): void => {
      subscription.close();
      client.disconnect();
      process.exitCode = 0;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    client.on((event) => {
      if (event.type === "event") {
        process.stdout.write(`${JSON.stringify(event.event)}\n`);
      }
    });
  } else {
    client.disconnect();
    throw new Error("use --send MESSAGE or --subscribe");
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

function parseArgs(values: readonly string[]): {
  url?: string;
  send?: string;
  channel?: string;
  kind?: number;
  subscribe: boolean;
} {
  const result: {
    url?: string;
    send?: string;
    channel?: string;
    kind?: number;
    subscribe: boolean;
  } = { subscribe: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--subscribe") result.subscribe = true;
    else if (value === "--url") result.url = required(values[++index], value);
    else if (value === "--send") result.send = required(values[++index], value);
    else if (value === "--channel") {
      result.channel = required(values[++index], value);
    } else if (value === "--kind") {
      const parsed = Number(required(values[++index], value));
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
        throw new Error("--kind must be an integer between 0 and 65535");
      }
      result.kind = parsed;
    } else throw new Error(`unknown argument: ${value}`);
  }
  return result;
}

function required(value: string | undefined, option: string): string {
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function parseKey(value: string): Uint8Array {
  if (/^[0-9a-f]{64}$/.test(value)) {
    return Uint8Array.from(Buffer.from(value, "hex"));
  }
  const decoded = nip19.decode(value);
  if (decoded.type !== "nsec") throw new Error("invalid BUZZ_PRIVATE_KEY");
  return decoded.data;
}
