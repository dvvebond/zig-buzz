import {
  isClientIngestEventKind,
  isEphemeralKind,
  KIND_AUTH,
  KIND_GIFT_WRAP,
  KIND_PRESENCE_UPDATE,
  REMOTE_AGENT_KINDS,
  requiresChannelScope,
  verifyNostrEvent,
  type NostrEvent,
} from "@buzz/core";
import { eventChannelId } from "@buzz/db";
import { RemoteProtocolError } from "@buzz/remote-agent-protocol";

export const MAX_EVENT_CONTENT_BYTES = 256 * 1024;
export const MAX_EVENT_TIMESTAMP_DRIFT_SECONDS = 15 * 60;

export type EventIngestTransport = "http" | "websocket";

/**
 * Verify the signed envelope and enforce the transport-neutral client ingest
 * boundary before authorization or any side effect is attempted.
 */
export function validateClientEventIngest(
  value: unknown,
  input: {
    readonly now: number;
    readonly principalPubkey: string;
    readonly transport: EventIngestTransport;
  },
): asserts value is NostrEvent {
  if (!verifyNostrEvent(value)) {
    throw new RemoteProtocolError(
      "SIGNATURE_INVALID",
      "event ID or signature is invalid",
    );
  }
  if (value.kind === KIND_AUTH) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "AUTH events cannot be submitted via EVENT",
    );
  }
  if (REMOTE_AGENT_KINDS.has(value.kind)) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "remote-agent events require the BRAP route",
    );
  }

  const ephemeral = isEphemeralKind(value.kind);
  if (
    input.transport === "http" &&
    (value.kind === KIND_GIFT_WRAP ||
      value.kind === KIND_PRESENCE_UPDATE ||
      (ephemeral && !isClientIngestEventKind(value.kind)))
  ) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      `kind ${value.kind} is only accepted via WebSocket`,
    );
  }
  if (!ephemeral && !isClientIngestEventKind(value.kind)) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      `event kind ${value.kind} is restricted or unknown`,
    );
  }

  // The WebSocket ephemeral lane is bounded by maxPayload and intentionally
  // accepts the complete NIP-16 range. Durable events and the HTTP lane match
  // the source relay's stricter shared ingest contract.
  if (!ephemeral || input.transport === "http") {
    if (
      Math.abs(value.created_at - input.now) > MAX_EVENT_TIMESTAMP_DRIFT_SECONDS
    ) {
      throw new RemoteProtocolError(
        "MESSAGE_EXPIRED",
        "event timestamp is too far from server time",
      );
    }
    if (Buffer.byteLength(value.content, "utf8") > MAX_EVENT_CONTENT_BYTES) {
      throw new RemoteProtocolError(
        "CONFIG_INVALID",
        `event content exceeds ${MAX_EVENT_CONTENT_BYTES} bytes`,
      );
    }
  }

  if (
    value.pubkey !== input.principalPubkey &&
    !(input.transport === "websocket" && value.kind === KIND_GIFT_WRAP)
  ) {
    throw new RemoteProtocolError(
      "SENDER_MISMATCH",
      "authenticated identity does not own this event",
    );
  }
  if (requiresChannelScope(value.kind) && !eventChannelId(value)) {
    throw new RemoteProtocolError(
      "CONFIG_INVALID",
      "channel-scoped events must include exactly one valid h tag",
    );
  }
}
