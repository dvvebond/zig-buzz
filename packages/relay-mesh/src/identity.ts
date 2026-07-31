import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  ATTESTATION_CONTEXT,
  GossipRecordSchema,
  type GossipRecord,
  type ReadyRecord,
  type RuntimeId,
} from "./model.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class RuntimeIdentity {
  readonly #privateKey: KeyObject;
  readonly runtimeId: RuntimeId;

  private constructor(privateKey: KeyObject, runtimeId: RuntimeId) {
    this.#privateKey = privateKey;
    this.runtimeId = runtimeId;
  }

  public static generate(): RuntimeIdentity {
    const pair = generateKeyPairSync("ed25519");
    const der = pair.publicKey.export({ format: "der", type: "spki" });
    return new RuntimeIdentity(
      pair.privateKey,
      der.subarray(der.byteLength - 32).toString("hex") as RuntimeId,
    );
  }

  public static fromPkcs8(pem: string): RuntimeIdentity {
    const privateKey = createPrivateKey(pem);
    const der = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    });
    return new RuntimeIdentity(
      privateKey,
      der.subarray(der.byteLength - 32).toString("hex") as RuntimeId,
    );
  }

  public exportPkcs8(): string {
    return this.#privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  }

  public sign(message: string): string {
    return sign(null, Buffer.from(message), this.#privateKey).toString(
      "base64url",
    );
  }
}

export function verifyRuntimeSignature(
  runtimeId: RuntimeId,
  message: string,
  signature: string,
): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(runtimeId, "hex")]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(message),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export function attestationPreimage(
  runtimeId: RuntimeId,
  relayPubkey: RuntimeId,
): string {
  return `${ATTESTATION_CONTEXT}\nruntime_pubkey=${runtimeId}\nrelay_pubkey=${relayPubkey}`;
}

export function createReadyRecord(input: {
  readonly identity: RuntimeIdentity;
  readonly relaySecretKey: Uint8Array;
  readonly endpointUrls: readonly string[];
  readonly capabilities?: readonly string[];
}): ReadyRecord {
  const relayPubkey = Buffer.from(
    schnorr.getPublicKey(input.relaySecretKey),
  ).toString("hex") as RuntimeId;
  const digest = createHash("sha256")
    .update(attestationPreimage(input.identity.runtimeId, relayPubkey))
    .digest();
  const unsigned: Omit<ReadyRecord, "readyRuntimeSig"> = {
    runtimeId: input.identity.runtimeId,
    runtimePubkey: input.identity.runtimeId,
    relayPubkey,
    relaySig: Buffer.from(schnorr.sign(digest, input.relaySecretKey)).toString(
      "hex",
    ),
    endpointUrls: [...input.endpointUrls],
    protoVersion: 1,
    capabilities: [...(input.capabilities ?? [])],
  };
  return {
    ...unsigned,
    readyRuntimeSig: input.identity.sign(readyPreimage(unsigned)),
  };
}

export function verifyReadyRecord(
  record: ReadyRecord,
  expectedRelayPubkey: RuntimeId,
): boolean {
  if (
    record.runtimeId !== record.runtimePubkey ||
    record.relayPubkey !== expectedRelayPubkey
  ) {
    return false;
  }
  try {
    const digest = createHash("sha256")
      .update(attestationPreimage(record.runtimeId, record.relayPubkey))
      .digest();
    return (
      schnorr.verify(
        Buffer.from(record.relaySig, "hex"),
        digest,
        Buffer.from(record.relayPubkey, "hex"),
      ) &&
      verifyRuntimeSignature(
        record.runtimeId,
        readyPreimage({
          runtimeId: record.runtimeId,
          runtimePubkey: record.runtimePubkey,
          relayPubkey: record.relayPubkey,
          relaySig: record.relaySig,
          endpointUrls: record.endpointUrls,
          protoVersion: record.protoVersion,
          capabilities: record.capabilities,
        }),
        record.readyRuntimeSig,
      )
    );
  } catch {
    return false;
  }
}

export function readyPreimage(
  record: Omit<ReadyRecord, "readyRuntimeSig">,
): string {
  return [
    "buzz-relay-mesh-ready-runtime-v1",
    record.runtimeId,
    record.runtimePubkey,
    record.relayPubkey,
    record.relaySig,
    record.endpointUrls.join(","),
    record.protoVersion,
    record.capabilities.join(","),
  ].join("\n");
}

export function gossipPreimage(
  record: Omit<GossipRecord, "runtimeSig">,
): string {
  return [
    "buzz-relay-mesh-gossip-v1",
    record.runtimeId,
    record.endpointUrls.join(","),
    record.protoVersion,
    record.capabilities.join(","),
    record.readyRuntimeSig,
    record.load,
    record.draining ? 1 : 0,
    record.version,
    record.heartbeatMillis,
  ].join("\n");
}

export function signGossipRecord(
  identity: RuntimeIdentity,
  record: Omit<GossipRecord, "runtimeSig">,
): GossipRecord {
  return GossipRecordSchema.parse({
    ...record,
    runtimeSig: identity.sign(gossipPreimage(record)),
  });
}

export function verifyGossipRecord(
  record: GossipRecord,
  expectedRelayPubkey: RuntimeId,
): boolean {
  const {
    runtimeSig,
    load: _load,
    draining: _draining,
    version: _version,
    heartbeatMillis: _heartbeatMillis,
    ...ready
  } = record;
  return (
    verifyReadyRecord(ready, expectedRelayPubkey) &&
    verifyRuntimeSignature(
      record.runtimeId,
      gossipPreimage({
        ...ready,
        load: record.load,
        draining: record.draining,
        version: record.version,
        heartbeatMillis: record.heartbeatMillis,
      }),
      runtimeSig,
    )
  );
}

export function handshakeChallengePreimage(input: {
  readonly runtimeId: RuntimeId;
  readonly nonce: string;
  readonly timestamp: number;
}): string {
  return `buzz-relay-mesh-challenge-v1\n${input.runtimeId}\n${input.nonce}\n${input.timestamp}`;
}

export function handshakeAuthPreimage(input: {
  readonly clientRuntimeId: RuntimeId;
  readonly serverRuntimeId: RuntimeId;
  readonly clientNonce: string;
  readonly serverNonce: string;
  readonly timestamp: number;
}): string {
  return `buzz-relay-mesh-auth-v1\n${input.clientRuntimeId}\n${input.serverRuntimeId}\n${input.clientNonce}\n${input.serverNonce}\n${input.timestamp}`;
}

export function handshakeAcceptedPreimage(input: {
  readonly clientRuntimeId: RuntimeId;
  readonly serverRuntimeId: RuntimeId;
  readonly clientNonce: string;
  readonly serverNonce: string;
}): string {
  return `buzz-relay-mesh-accepted-v1\n${input.clientRuntimeId}\n${input.serverRuntimeId}\n${input.clientNonce}\n${input.serverNonce}`;
}
