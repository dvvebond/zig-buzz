import {
  KIND_REMOTE_AGENT_ACK,
  KIND_REMOTE_AGENT_COMMAND,
  KIND_REMOTE_AGENT_ENROLLMENT,
  KIND_REMOTE_AGENT_STATUS,
  signNostrEvent,
  unixNow,
  verifyNostrEvent,
  type NostrEvent,
} from "@buzz/core";
import { nip44 } from "nostr-tools";

import { RemoteProtocolError } from "./errors.js";
import type { ReplayGuard } from "./replay.js";
import {
  DEFAULT_CLOCK_SKEW_SECONDS,
  MAX_CONTROL_PLAINTEXT_BYTES,
  MAX_OUTER_EVENT_BYTES,
  PROTOCOL_TAG,
  remotePayloadSchema,
  type RemotePayload,
} from "./schema.js";

const TYPE_TO_KIND = {
  ack: KIND_REMOTE_AGENT_ACK,
  command: KIND_REMOTE_AGENT_COMMAND,
  enrollment: KIND_REMOTE_AGENT_ENROLLMENT,
  status: KIND_REMOTE_AGENT_STATUS,
} as const;

export type CreateEnvelopeInput = {
  readonly payload: RemotePayload;
  readonly recipientPubkey: string;
  readonly workerPubkey: string;
  readonly senderSecretKey: Uint8Array;
};

export type OpenEnvelopeInput = {
  readonly event: unknown;
  readonly recipientSecretKey: Uint8Array;
  readonly recipientPubkey: string;
  readonly expectedSenderPubkey: string;
  readonly expectedWorkerPubkey: string;
  readonly expectedDeploymentId?: string;
  readonly expectedSessionId?: string;
  readonly replayGuard: ReplayGuard;
  readonly now?: number;
  readonly clockSkewSeconds?: number;
};

export function createRemoteEnvelope(input: CreateEnvelopeInput): NostrEvent {
  const payload = remotePayloadSchema.parse(input.payload);
  validatePayloadLifetime(payload);
  const plaintext = JSON.stringify(payload);
  if (Buffer.byteLength(plaintext, "utf8") > MAX_CONTROL_PLAINTEXT_BYTES) {
    throw new RemoteProtocolError(
      "MESSAGE_TOO_LARGE",
      "control payload exceeds the plaintext limit",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.recipientPubkey)) {
    throw new RemoteProtocolError(
      "RECIPIENT_MISMATCH",
      "recipient public key is invalid",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.workerPubkey)) {
    throw new RemoteProtocolError(
      "TAG_INVALID",
      "worker public key is invalid",
    );
  }

  const conversationKey = nip44.v2.utils.getConversationKey(
    input.senderSecretKey,
    input.recipientPubkey,
  );
  const content = nip44.v2.encrypt(plaintext, conversationKey);
  const event = signNostrEvent(
    {
      content,
      created_at: payload.issuedAt,
      kind: TYPE_TO_KIND[payload.type],
      tags: [
        ["p", input.recipientPubkey],
        ["worker", input.workerPubkey],
        ["deployment", payload.deploymentId],
        ["session", payload.sessionId],
        ["sequence", String(payload.sequence)],
        ["message", payload.messageId],
        ["expires", String(payload.expiresAt)],
        ["protocol", PROTOCOL_TAG],
      ],
    },
    input.senderSecretKey,
  );

  if (
    Buffer.byteLength(JSON.stringify(event), "utf8") > MAX_OUTER_EVENT_BYTES
  ) {
    throw new RemoteProtocolError(
      "MESSAGE_TOO_LARGE",
      "signed control event exceeds the event limit",
    );
  }
  return event;
}

export function openRemoteEnvelope(input: OpenEnvelopeInput): RemotePayload {
  const now = input.now ?? unixNow();
  const clockSkew = input.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;

  if (
    Buffer.byteLength(JSON.stringify(input.event), "utf8") >
    MAX_OUTER_EVENT_BYTES
  ) {
    throw new RemoteProtocolError(
      "MESSAGE_TOO_LARGE",
      "signed control event exceeds the event limit",
    );
  }
  if (!verifyNostrEvent(input.event)) {
    throw new RemoteProtocolError(
      "SIGNATURE_INVALID",
      "event ID or signature is invalid",
    );
  }
  const event = input.event;
  if (event.pubkey !== input.expectedSenderPubkey) {
    throw new RemoteProtocolError(
      "SENDER_MISMATCH",
      "event was not signed by the expected sender",
    );
  }
  if (
    event.created_at < now - clockSkew ||
    event.created_at > now + clockSkew
  ) {
    throw new RemoteProtocolError(
      "MESSAGE_EXPIRED",
      "event timestamp is outside the allowed clock window",
    );
  }

  const recipient = requireSingleTag(event, "p");
  if (recipient !== input.recipientPubkey) {
    throw new RemoteProtocolError(
      "RECIPIENT_MISMATCH",
      "event is addressed to a different recipient",
    );
  }
  const worker = requireSingleTag(event, "worker");
  if (worker !== input.expectedWorkerPubkey) {
    throw new RemoteProtocolError(
      "TAG_INVALID",
      "worker binding does not match",
    );
  }
  if (requireSingleTag(event, "protocol") !== PROTOCOL_TAG) {
    throw new RemoteProtocolError(
      "PROTOCOL_VERSION_UNSUPPORTED",
      "unsupported remote-agent protocol version",
    );
  }

  const deploymentId = requireSingleTag(event, "deployment");
  const sessionId = requireSingleTag(event, "session");
  const messageId = requireSingleTag(event, "message");
  const sequence = parseUnsignedIntegerTag(event, "sequence");
  const expiresAt = parseUnsignedIntegerTag(event, "expires");
  if (
    input.expectedDeploymentId &&
    deploymentId !== input.expectedDeploymentId
  ) {
    throw new RemoteProtocolError(
      "TAG_INVALID",
      "deployment binding does not match",
    );
  }
  if (input.expectedSessionId && sessionId !== input.expectedSessionId) {
    throw new RemoteProtocolError(
      "TAG_INVALID",
      "session binding does not match",
    );
  }
  if (expiresAt < now) {
    throw new RemoteProtocolError("MESSAGE_EXPIRED", "message has expired");
  }

  const conversationKey = nip44.v2.utils.getConversationKey(
    input.recipientSecretKey,
    event.pubkey,
  );
  let plaintext: string;
  try {
    plaintext = nip44.v2.decrypt(event.content, conversationKey);
  } catch {
    throw new RemoteProtocolError(
      "SIGNATURE_INVALID",
      "encrypted control payload could not be authenticated",
    );
  }
  if (Buffer.byteLength(plaintext, "utf8") > MAX_CONTROL_PLAINTEXT_BYTES) {
    throw new RemoteProtocolError(
      "MESSAGE_TOO_LARGE",
      "decrypted control payload exceeds the limit",
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(plaintext) as unknown;
  } catch {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "decrypted control payload is not valid JSON",
    );
  }
  const parsed = remotePayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "decrypted control payload has an invalid schema",
    );
  }
  const payload = parsed.data;
  validatePayloadLifetime(payload);
  if (
    TYPE_TO_KIND[payload.type] !== event.kind ||
    payload.messageId !== messageId ||
    payload.deploymentId !== deploymentId ||
    payload.sessionId !== sessionId ||
    payload.sequence !== sequence ||
    payload.issuedAt !== event.created_at ||
    payload.expiresAt !== expiresAt
  ) {
    throw new RemoteProtocolError(
      "TAG_INVALID",
      "signed tags and encrypted payload do not match",
    );
  }

  input.replayGuard.accept({ expiresAt, messageId, sequence, sessionId }, now);
  return payload;
}

function validatePayloadLifetime(payload: RemotePayload): void {
  if (
    payload.expiresAt < payload.issuedAt ||
    payload.expiresAt - payload.issuedAt > 300
  ) {
    throw new RemoteProtocolError(
      "MESSAGE_EXPIRED",
      "control payload lifetime is invalid",
    );
  }
}

function requireSingleTag(event: NostrEvent, name: string): string {
  const matches = event.tags.filter((tag) => tag[0] === name);
  if (matches.length !== 1 || matches[0]?.length !== 2 || !matches[0][1]) {
    throw new RemoteProtocolError(
      "TAG_INVALID",
      `event must contain exactly one ${name} tag`,
    );
  }
  return matches[0][1];
}

function parseUnsignedIntegerTag(event: NostrEvent, name: string): number {
  const raw = requireSingleTag(event, name);
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new RemoteProtocolError("TAG_INVALID", `${name} tag is invalid`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new RemoteProtocolError("TAG_INVALID", `${name} tag is too large`);
  }
  return value;
}
