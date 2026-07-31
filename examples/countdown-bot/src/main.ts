#!/usr/bin/env node
import { createHash } from "node:crypto";

import {
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  publicKeyFromSecret,
  type NostrEvent,
} from "@buzz/core";
import {
  buildAddMember,
  buildMessage,
  buildProfile,
  signTemplate,
} from "@buzz/sdk";
import { AuthenticatedRelayClient, type RelaySocket } from "@buzz/ws-client";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { nip19 } from "nostr-tools";
import WebSocket from "ws";

import {
  commandReply,
  eventMentionsPubkey,
  mentionCommandReply,
} from "./logic.js";

const BOT_NAME = "countdown-bot";
const BOT_DISPLAY_NAME = "Countdown Bot";
const BOT_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'%3E%3Crect width='128' height='128' rx='28' fill='%23131622'/%3E%3Ccircle cx='64' cy='64' r='42' fill='none' stroke='%237dd3fc' stroke-width='10'/%3E%3Cpath d='M64 32v32l22 14' fill='none' stroke='%23facc15' stroke-width='10' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M42 96h44' stroke='%23a78bfa' stroke-width='8' stroke-linecap='round'/%3E%3C/svg%3E";

type OwnerAuthTag = readonly ["auth", string, string, string];

type Config = {
  readonly relayUrl: string;
  readonly channelId: string;
  readonly botSecretKey: Uint8Array;
  readonly authTag?: OwnerAuthTag;
};

async function main(): Promise<void> {
  const config = loadConfig();
  const botPubkey = publicKeyFromSecret(config.botSecretKey);
  const client = new AuthenticatedRelayClient({
    allowInsecureLocalhost: true,
    ...(config.authTag ? { authTag: config.authTag } : {}),
    relayUrl: config.relayUrl,
    secretKey: config.botSecretKey,
    socketFactory: (url) =>
      new WebSocket(url, {
        followRedirects: false,
        handshakeTimeout: 15_000,
        maxPayload: 512 * 1024,
        perMessageDeflate: false,
      }) as unknown as RelaySocket,
  });

  process.stderr.write(`countdown-bot pubkey: ${botPubkey}\n`);
  process.stderr.write(`connecting to ${config.relayUrl}\n`);
  await client.connect();
  await client.publish(
    signTemplate(
      buildProfile({
        about:
          "A tiny non-AI Buzz bot that replies to !countdown and countdown-style !fib.",
        displayName: BOT_DISPLAY_NAME,
        name: BOT_NAME,
        picture: BOT_ICON,
      }),
      config.botSecretKey,
    ),
  );

  try {
    await client.publish(
      signTemplate(
        buildAddMember(config.channelId, botPubkey, "bot"),
        config.botSecretKey,
      ),
    );
  } catch (error) {
    process.stderr.write(
      `channel self-add was rejected; an owner/admin may need to add ${botPubkey}: ${safeError(error)}\n`,
    );
  }

  const startedAt = Math.floor(Date.now() / 1_000);
  let work = Promise.resolve();
  const finished = new Promise<void>((resolve, reject) => {
    const unsubscribe = client.on((event) => {
      if (event.type === "event") {
        work = work
          .then(() =>
            maybeReply(client, config, botPubkey, startedAt, event.event),
          )
          .catch((error: unknown) => {
            process.stderr.write(`reply failed: ${safeError(error)}\n`);
          });
      } else if (event.type === "notice") {
        process.stderr.write(`relay notice: ${event.message}\n`);
      } else if (event.type === "closed") {
        reject(new Error(`subscription closed: ${event.message}`));
      } else if (event.type === "disconnected") {
        reject(new Error("relay disconnected"));
      }
    });
    const stop = (): void => {
      unsubscribe();
      client.close();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

  client.subscribe(
    [
      {
        "#h": [config.channelId],
        kinds: [KIND_STREAM_MESSAGE, KIND_STREAM_MESSAGE_V2],
        since: startedAt,
      },
    ],
    "countdown-bot",
  );
  process.stderr.write(
    `listening in channel ${config.channelId} for !countdown, !fib, and @mention commands\n`,
  );
  await finished;
  await work;
}

async function maybeReply(
  client: AuthenticatedRelayClient,
  config: Config,
  botPubkey: string,
  startedAt: number,
  event: NostrEvent,
): Promise<void> {
  if (event.pubkey === botPubkey || event.created_at < startedAt) return;
  const reply =
    commandReply(event.content) ??
    (eventMentionsPubkey(event, botPubkey)
      ? mentionCommandReply(event.content)
      : undefined);
  if (!reply) return;
  const signed = signTemplate(
    buildMessage({
      channelId: config.channelId,
      content: reply,
      mentions: [event.pubkey],
    }),
    config.botSecretKey,
  );
  await client.publish(signed);
  process.stderr.write(`replied to ${event.id} with ${signed.id}\n`);
}

function loadConfig(): Config {
  const relayUrl = process.env.BUZZ_RELAY_URL?.trim() || "ws://localhost:3000";
  const channelId = requiredEnvironment("BUZZ_CHANNEL_ID");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      channelId,
    )
  ) {
    throw new Error("BUZZ_CHANNEL_ID must be a UUID");
  }
  const botSecretKey = decodeSecret(
    requiredEnvironment("BUZZ_BOT_PRIVATE_KEY"),
  );
  const authMode = process.env.BUZZ_BOT_AUTH_MODE?.trim() || "standalone";
  if (authMode === "standalone") {
    return { botSecretKey, channelId, relayUrl };
  }
  if (authMode !== "owner-attested") {
    throw new Error(
      "BUZZ_BOT_AUTH_MODE must be 'standalone' or 'owner-attested'",
    );
  }
  const botPubkey = publicKeyFromSecret(botSecretKey);
  const authTag = process.env.BUZZ_AUTH_TAG?.trim()
    ? parseAuthTag(process.env.BUZZ_AUTH_TAG, botPubkey)
    : createAuthTag(
        decodeSecret(requiredEnvironment("BUZZ_OWNER_PRIVATE_KEY")),
        botPubkey,
      );
  return { authTag, botSecretKey, channelId, relayUrl };
}

function createAuthTag(
  ownerSecretKey: Uint8Array,
  botPubkey: string,
): OwnerAuthTag {
  const conditions = "";
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${botPubkey}:${conditions}`, "utf8")
    .digest();
  return [
    "auth",
    publicKeyFromSecret(ownerSecretKey),
    conditions,
    bytesToHex(schnorr.sign(digest, ownerSecretKey)),
  ];
}

function parseAuthTag(value: string, botPubkey: string): OwnerAuthTag {
  if (Buffer.byteLength(value, "utf8") > 2_048) {
    throw new Error("BUZZ_AUTH_TAG exceeds 2 KiB");
  }
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    parsed[0] !== "auth" ||
    typeof parsed[1] !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed[1]) ||
    typeof parsed[2] !== "string" ||
    Buffer.byteLength(parsed[2], "utf8") > 1_024 ||
    typeof parsed[3] !== "string" ||
    !/^[0-9a-f]{128}$/.test(parsed[3])
  ) {
    throw new Error("BUZZ_AUTH_TAG must be a valid NIP-OA tag");
  }
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${botPubkey}:${parsed[2]}`, "utf8")
    .digest();
  if (
    !schnorr.verify(
      Buffer.from(parsed[3], "hex"),
      digest,
      Buffer.from(parsed[1], "hex"),
    )
  ) {
    throw new Error("BUZZ_AUTH_TAG signature is invalid for this bot");
  }
  return ["auth", parsed[1], parsed[2], parsed[3]];
}

function decodeSecret(value: string): Uint8Array {
  const normalized = value.trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(normalized)) {
    return Uint8Array.from(Buffer.from(normalized, "hex"));
  }
  const decoded = nip19.decode(normalized);
  if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
    throw new Error("private key must be 64 hex characters or nsec");
  }
  return Uint8Array.from(decoded.data);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "operation failed";
}

main().catch((error: unknown) => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
});
