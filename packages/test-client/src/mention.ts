#!/usr/bin/env node
import { generateSecretKey } from "nostr-tools";
import { getPublicKey } from "nostr-tools/pure";
import { BuzzTestClient } from "./index.js";

const [channelId, targetPubkey, ...words] = process.argv.slice(2);
if (
  !channelId ||
  !targetPubkey ||
  !/^[0-9a-f]{64}$/.test(targetPubkey) ||
  words.length === 0
) {
  process.stderr.write(
    "Usage: buzz-mention-ts <channel_uuid> <target_pubkey_hex> <message>\n",
  );
  process.exit(2);
}
const key = generateSecretKey();
const client = await BuzzTestClient.connect(
  process.env.BUZZ_RELAY_URL ?? "ws://localhost:3000",
  key,
  { allowInsecureLocalhost: true },
);
const result = await client.sendTextMessage({
  secretKey: key,
  channelId,
  content: words.join(" "),
  tags: [["p", targetPubkey]],
});
client.disconnect();
process.stdout.write(
  `${result.accepted ? "sent" : "rejected"} ${result.eventId} by ${getPublicKey(key)}${result.message ? `: ${result.message}` : ""}\n`,
);
if (!result.accepted) process.exitCode = 1;
