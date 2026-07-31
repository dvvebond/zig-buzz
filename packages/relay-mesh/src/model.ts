import { z } from "zod";

/** WebSocket subprotocol token (HTTP token grammar does not permit `/`). */
export const MESH_PROTOCOL = "buzz.mesh.ts.v1";
export const WIRE_VERSION = 1;
export const MAX_WIRE_BYTES = 16 * 1024 * 1024;
export const MAX_DATAGRAM_PAYLOAD = 1_024;
export const READY_KEY_PREFIX = "mesh:ready:";
export const ATTESTATION_CONTEXT = "buzz-relay-mesh-ready-v1";

export const RuntimeIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export type RuntimeId = z.infer<typeof RuntimeIdSchema>;

const UintString = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const FencedHeaderSchema = z
  .object({
    communityId: z.uuid(),
    sessionId: z.string().uuid(),
    generation: UintString,
    ownerRuntimeId: RuntimeIdSchema,
  })
  .strict();
export type FencedHeader = z.infer<typeof FencedHeaderSchema>;

export const ProfileSchema = z.enum([
  "reliable_stream",
  "realtime_media",
  "huddle_control",
]);
export type Profile = z.infer<typeof ProfileSchema>;

export const GoodbyeReasonSchema = z.enum([
  "session_ended",
  "draining",
  "stale_generation",
]);
export type GoodbyeReason = z.infer<typeof GoodbyeReasonSchema>;

export const ReadyRecordSchema = z
  .object({
    runtimeId: RuntimeIdSchema,
    runtimePubkey: RuntimeIdSchema,
    relayPubkey: RuntimeIdSchema,
    relaySig: z.string().regex(/^[0-9a-f]{128}$/),
    readyRuntimeSig: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    endpointUrls: z.array(z.string().url()).min(1).max(8),
    protoVersion: z.literal(WIRE_VERSION),
    capabilities: z.array(z.string().min(1).max(64)).max(32),
  })
  .strict();
export type ReadyRecord = z.infer<typeof ReadyRecordSchema>;

export const GossipRecordSchema = ReadyRecordSchema.extend({
  load: z.number().finite().min(0).max(1_000),
  draining: z.boolean(),
  version: UintString,
  heartbeatMillis: UintString,
  runtimeSig: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();
export type GossipRecord = z.infer<typeof GossipRecordSchema>;

const DigestEntrySchema = z
  .object({ runtimeId: RuntimeIdSchema, version: UintString })
  .strict();

export const WireFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      v: z.literal(WIRE_VERSION),
      type: z.literal("challenge"),
      runtimeId: RuntimeIdSchema,
      nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      timestamp: z.number().int().nonnegative(),
      signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    })
    .strict(),
  z
    .object({
      v: z.literal(WIRE_VERSION),
      type: z.literal("authenticate"),
      runtimeId: RuntimeIdSchema,
      nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      challengeNonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      timestamp: z.number().int().nonnegative(),
      signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    })
    .strict(),
  z
    .object({
      v: z.literal(WIRE_VERSION),
      type: z.literal("accepted"),
      signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    })
    .strict(),
  z
    .object({
      v: z.literal(WIRE_VERSION),
      type: z.literal("gossip_digest"),
      entries: z.array(DigestEntrySchema).max(4_096),
    })
    .strict(),
  z
    .object({
      v: z.literal(WIRE_VERSION),
      type: z.literal("gossip_delta"),
      records: z.array(GossipRecordSchema).max(512),
    })
    .strict(),
  z
    .object({
      v: z.literal(WIRE_VERSION),
      type: z.literal("stream_open"),
      streamId: z.string().uuid(),
      fenced: FencedHeaderSchema,
      profile: z.enum(["reliable_stream", "huddle_control"]),
    })
    .strict(),
  z
    .object({
      v: z.literal(WIRE_VERSION),
      type: z.literal("stream_data"),
      streamId: z.string().uuid(),
      fenced: FencedHeaderSchema,
      payload: z.string().max(Math.ceil((MAX_WIRE_BYTES * 4) / 3) + 4),
    })
    .strict(),
  z
    .object({
      v: z.literal(WIRE_VERSION),
      type: z.literal("stream_close"),
      streamId: z.string().uuid(),
      fenced: FencedHeaderSchema,
      reason: GoodbyeReasonSchema,
    })
    .strict(),
  z
    .object({
      v: z.literal(WIRE_VERSION),
      type: z.literal("datagram"),
      fenced: FencedHeaderSchema,
      seq: UintString,
      payload: z.string().max(Math.ceil((MAX_DATAGRAM_PAYLOAD * 4) / 3) + 4),
    })
    .strict(),
]);
export type WireFrame = z.infer<typeof WireFrameSchema>;

export interface MeshPeerInfo {
  readonly runtimeId: RuntimeId;
  readonly draining: boolean;
  readonly load: number;
  readonly connected: boolean;
  readonly lastHeartbeatMillis: number;
}

export interface MeshStatus {
  readonly enabled: boolean;
  readonly localRuntimeId: RuntimeId;
  readonly draining: boolean;
  readonly peerCount: number;
  readonly peers: readonly MeshPeerInfo[];
  readonly counters: Readonly<Record<string, number>>;
}

export function encodeFrame(frame: WireFrame): string {
  const encoded = JSON.stringify(frame);
  if (Buffer.byteLength(encoded) > MAX_WIRE_BYTES) {
    throw new MeshProtocolError("frame_too_large");
  }
  return encoded;
}

export function decodeFrame(raw: unknown): WireFrame {
  const bytes =
    typeof raw === "string"
      ? Buffer.byteLength(raw)
      : Buffer.isBuffer(raw)
        ? raw.byteLength
        : raw instanceof ArrayBuffer
          ? raw.byteLength
          : MAX_WIRE_BYTES + 1;
  if (bytes > MAX_WIRE_BYTES) throw new MeshProtocolError("frame_too_large");
  const text =
    typeof raw === "string"
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString("utf8")
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString("utf8")
          : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MeshProtocolError("invalid_json");
  }
  const result = WireFrameSchema.safeParse(parsed);
  if (!result.success) throw new MeshProtocolError("invalid_frame");
  return result.data;
}

export class MeshProtocolError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "MeshProtocolError";
  }
}
