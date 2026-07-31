import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { nip19 } from "nostr-tools";

export const ARMOR_BEGIN = "-----BEGIN SIGNED MESSAGE-----";
export const ARMOR_END = "-----END SIGNED MESSAGE-----";
export const DOMAIN_SEPARATOR = "nostr:git:v1:";

export type OwnerAttestation = readonly [
  ownerPubkey: string,
  conditions: string,
  ownerSignature: string,
];

export interface SignatureEnvelope {
  readonly v: 1;
  readonly pk: string;
  readonly sig: string;
  readonly t: number;
  readonly oa?: OwnerAttestation;
}

export interface VerificationResult {
  readonly envelope: SignatureEnvelope;
  readonly ownerAttestationStatus:
    | "none"
    | "valid"
    | "invalid_signature"
    | "expired"
    | "kind_not_applicable";
}

export function parseSecretKey(raw: string): Uint8Array {
  const value = raw.trim();
  if (/^[0-9a-f]{64}$/.test(value)) {
    return Uint8Array.from(Buffer.from(value, "hex"));
  }
  const decoded = nip19.decode(value);
  if (decoded.type !== "nsec")
    throw new Error("expected nsec or lowercase hex key");
  return decoded.data;
}

export function normalizePublicKey(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
  try {
    const decoded = nip19.decode(trimmed);
    return decoded.type === "npub" ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

export function validateConditions(conditions: string): boolean {
  if (conditions === "") return true;
  return conditions.split("&").every((clause) => {
    const match = /^(kind=|created_at<|created_at>)(0|[1-9][0-9]*)$/.exec(
      clause,
    );
    if (!match?.[1] || !match[2]) return false;
    const value = BigInt(match[2]);
    return (
      value <= 4_294_967_295n && (match[1] !== "kind=" || value <= 65_535n)
    );
  });
}

export function enforceConditions(conditions: string, timestamp: number): void {
  for (const clause of conditions.split("&")) {
    if (clause.startsWith("created_at<")) {
      const limit = Number(clause.slice("created_at<".length));
      if (timestamp >= limit) throw new Error(`timestamp violates ${clause}`);
    } else if (clause.startsWith("created_at>")) {
      const limit = Number(clause.slice("created_at>".length));
      if (timestamp <= limit) throw new Error(`timestamp violates ${clause}`);
    }
  }
}

export function signingHash(
  timestamp: number,
  ownerAttestation: OwnerAttestation | undefined,
  payload: Uint8Array,
): Uint8Array {
  const hash = createHash("sha256");
  hash.update(DOMAIN_SEPARATOR);
  hash.update(String(timestamp));
  hash.update(":");
  if (ownerAttestation) {
    hash.update(ownerAttestation[0]);
    hash.update(":");
    hash.update(ownerAttestation[1]);
    hash.update(":");
    hash.update(ownerAttestation[2]);
    hash.update(":");
  }
  hash.update(payload);
  return hash.digest();
}

export function verifyOwnerAttestation(
  agentPubkey: string,
  ownerAttestation: OwnerAttestation,
): boolean {
  try {
    const digest = createHash("sha256")
      .update(`nostr:agent-auth:${agentPubkey}:${ownerAttestation[1]}`)
      .digest();
    return schnorr.verify(
      Buffer.from(ownerAttestation[2], "hex"),
      digest,
      Buffer.from(ownerAttestation[0], "hex"),
    );
  } catch {
    return false;
  }
}

export function signPayload(input: {
  readonly payload: Uint8Array;
  readonly secretKey: Uint8Array;
  readonly timestamp?: number;
  readonly keyId?: string;
  readonly ownerAttestation?: OwnerAttestation;
}): { readonly envelope: SignatureEnvelope; readonly armored: string } {
  if (input.payload.byteLength > 100 * 1024 * 1024) {
    throw new Error("payload exceeds 100 MB limit");
  }
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1_000);
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > 4_294_967_295
  ) {
    throw new Error("timestamp out of range");
  }
  const pubkey = Buffer.from(schnorr.getPublicKey(input.secretKey)).toString(
    "hex",
  );
  if (input.keyId) {
    const normalized = normalizePublicKey(input.keyId);
    if (!normalized || normalized !== pubkey) {
      throw new Error("signing key argument does not match loaded key");
    }
  }
  const oa = input.ownerAttestation;
  if (oa) {
    validateOwnerAttestationShape(oa);
    if (oa[0] === pubkey) throw new Error("owner must not self-attest");
    if (!verifyOwnerAttestation(pubkey, oa)) {
      throw new Error("owner attestation signature verification failed");
    }
    enforceConditions(oa[1], timestamp);
  }
  const signature = Buffer.from(
    schnorr.sign(signingHash(timestamp, oa, input.payload), input.secretKey),
  ).toString("hex");
  const envelope: SignatureEnvelope = {
    v: 1,
    pk: pubkey,
    sig: signature,
    t: timestamp,
    ...(oa ? { oa } : {}),
  };
  return { envelope, armored: armor(buildEnvelope(envelope)) };
}

export function verifyArmored(
  armored: string,
  payload: Uint8Array,
): VerificationResult {
  if (payload.byteLength > 100 * 1024 * 1024) {
    throw new Error("payload exceeds 100 MB limit");
  }
  const json = parseArmor(armored);
  if (Buffer.byteLength(json) > 2_048)
    throw new Error("envelope exceeds 2 KiB");
  if (whitespaceOutsideStrings(json)) {
    throw new Error("JSON contains whitespace outside string values");
  }
  const envelope = parseEnvelope(json);
  if (buildEnvelope(envelope) !== json)
    throw new Error("JSON is not canonical");
  if (
    !schnorr.verify(
      Buffer.from(envelope.sig, "hex"),
      signingHash(envelope.t, envelope.oa, payload),
      Buffer.from(envelope.pk, "hex"),
    )
  ) {
    throw new Error("BIP-340 signature verification failed");
  }
  let ownerAttestationStatus: VerificationResult["ownerAttestationStatus"] =
    "none";
  if (envelope.oa) {
    if (!verifyOwnerAttestation(envelope.pk, envelope.oa)) {
      ownerAttestationStatus = "invalid_signature";
    } else {
      try {
        enforceConditions(envelope.oa[1], envelope.t);
        ownerAttestationStatus = envelope.oa[1]
          .split("&")
          .some((clause) => clause.startsWith("kind="))
          ? "kind_not_applicable"
          : "valid";
      } catch {
        ownerAttestationStatus = "expired";
      }
    }
  }
  return { envelope, ownerAttestationStatus };
}

export function buildEnvelope(envelope: SignatureEnvelope): string {
  const base = `{"v":1,"pk":"${envelope.pk}","sig":"${envelope.sig}","t":${envelope.t}`;
  return envelope.oa
    ? `${base},"oa":["${envelope.oa[0]}","${envelope.oa[1]}","${envelope.oa[2]}"]}`
    : `${base}}`;
}

export function armor(json: string): string {
  return `${ARMOR_BEGIN}\n${Buffer.from(json).toString("base64")}\n${ARMOR_END}\n`;
}

export function parseArmor(input: string): string {
  if (!input.endsWith("\n")) throw new Error("armor must end with a newline");
  const lines = input.slice(0, -1).split("\n");
  if (
    lines.length !== 3 ||
    lines[0] !== ARMOR_BEGIN ||
    lines[2] !== ARMOR_END ||
    !lines[1] ||
    lines.some((line) => /[ \t\r]$/.test(line))
  ) {
    throw new Error("malformed signature armor");
  }
  if (lines[1].length > 4_096 || !/^[A-Za-z0-9+/]*={0,2}$/.test(lines[1])) {
    throw new Error("invalid signature base64");
  }
  const decoded = Buffer.from(lines[1], "base64");
  if (decoded.toString("base64") !== lines[1])
    throw new Error("non-canonical base64");
  return decoded.toString("utf8");
}

function parseEnvelope(json: string): SignatureEnvelope {
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("envelope must be an object");
  }
  const value = parsed as Record<string, unknown>;
  const allowed = new Set(["v", "pk", "sig", "t", "oa"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("unknown envelope key");
  }
  if (
    value.v !== 1 ||
    typeof value.pk !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.pk) ||
    typeof value.sig !== "string" ||
    !/^[0-9a-f]{128}$/.test(value.sig) ||
    !Number.isSafeInteger(value.t) ||
    (value.t as number) < 0 ||
    (value.t as number) > 4_294_967_295
  ) {
    throw new Error("invalid envelope fields");
  }
  // This also proves the x-only key is on curve.
  schnorr.verify(
    new Uint8Array(64),
    new Uint8Array(32),
    Buffer.from(value.pk, "hex"),
  );
  let oa: OwnerAttestation | undefined;
  if (value.oa !== undefined) {
    if (
      !Array.isArray(value.oa) ||
      value.oa.length !== 3 ||
      !value.oa.every((item) => typeof item === "string")
    ) {
      throw new Error("oa must contain three strings");
    }
    oa = value.oa as unknown as OwnerAttestation;
    validateOwnerAttestationShape(oa);
    if (oa[0] === value.pk) throw new Error("owner must not self-attest");
  }
  return {
    v: 1,
    pk: value.pk,
    sig: value.sig,
    t: value.t as number,
    ...(oa ? { oa } : {}),
  };
}

function validateOwnerAttestationShape(oa: OwnerAttestation): void {
  if (
    !/^[0-9a-f]{64}$/.test(oa[0]) ||
    !/^[0-9a-f]{128}$/.test(oa[2]) ||
    !validateConditions(oa[1])
  ) {
    throw new Error("invalid owner attestation");
  }
  schnorr.verify(
    new Uint8Array(64),
    new Uint8Array(32),
    Buffer.from(oa[0], "hex"),
  );
}

function whitespaceOutsideStrings(value: string): boolean {
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) escaped = false;
    else if (inString && character === "\\") escaped = true;
    else if (character === '"') inString = !inString;
    else if (!inString && /\s/.test(character)) return true;
  }
  return false;
}
