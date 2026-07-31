import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { RemoteCapability } from "./schema.js";
import { RemoteProtocolError } from "./errors.js";

const TOKEN_PREFIX = "brap1";
const TOKEN_PATTERN =
  /^brap1_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([0-9a-f]{64})_([A-Za-z0-9_-]{43})$/;

export type EnrollmentRecord = {
  readonly id: string;
  readonly secretHash: string;
  readonly ownerPubkey: string;
  readonly community: string;
  readonly capabilities: readonly RemoteCapability[];
  readonly expiresAt: number;
  readonly usedAt?: number;
};

export type MintedEnrollment = {
  readonly token: string;
  readonly record: EnrollmentRecord;
};

export function mintEnrollmentToken(input: {
  readonly ownerPubkey: string;
  readonly community: string;
  readonly capabilities: readonly RemoteCapability[];
  readonly now: number;
  readonly lifetimeSeconds?: number;
}): MintedEnrollment {
  const lifetimeSeconds = input.lifetimeSeconds ?? 600;
  if (
    !Number.isSafeInteger(lifetimeSeconds) ||
    lifetimeSeconds < 30 ||
    lifetimeSeconds > 3_600
  ) {
    throw new RangeError(
      "enrollment lifetime must be between 30 and 3600 seconds",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.ownerPubkey)) {
    throw new TypeError("ownerPubkey must be 32-byte lowercase hex");
  }
  if (input.community.length < 1 || input.community.length > 253) {
    throw new TypeError("community must be between 1 and 253 characters");
  }

  const id = randomUUID();
  const secret = randomBytes(32).toString("base64url");
  return {
    token: `${TOKEN_PREFIX}_${id}_${input.ownerPubkey}_${secret}`,
    record: {
      capabilities: [...new Set(input.capabilities)],
      community: input.community,
      expiresAt: input.now + lifetimeSeconds,
      id,
      ownerPubkey: input.ownerPubkey,
      secretHash: hashSecret(secret),
    },
  };
}

export function parseEnrollmentToken(token: string): {
  readonly id: string;
  readonly ownerPubkey: string;
  readonly secret: string;
} {
  const match = TOKEN_PATTERN.exec(token);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new RemoteProtocolError(
      "ENROLLMENT_INVALID",
      "enrollment token has an invalid format",
    );
  }
  return { id: match[1], ownerPubkey: match[2], secret: match[3] };
}

export function verifyEnrollmentToken(
  token: string,
  record: EnrollmentRecord,
  now: number,
): void {
  const parsed = parseEnrollmentToken(token);
  if (parsed.id !== record.id) {
    throw new RemoteProtocolError(
      "ENROLLMENT_INVALID",
      "enrollment token does not match this invitation",
    );
  }
  if (parsed.ownerPubkey !== record.ownerPubkey) {
    throw new RemoteProtocolError(
      "ENROLLMENT_INVALID",
      "enrollment token owner binding is invalid",
    );
  }
  if (record.usedAt !== undefined) {
    throw new RemoteProtocolError(
      "ENROLLMENT_USED",
      "enrollment token has already been used",
    );
  }
  if (record.expiresAt < now) {
    throw new RemoteProtocolError(
      "ENROLLMENT_EXPIRED",
      "enrollment token has expired",
    );
  }

  const expected = Buffer.from(record.secretHash, "hex");
  const actual = Buffer.from(hashSecret(parsed.secret), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new RemoteProtocolError(
      "ENROLLMENT_INVALID",
      "enrollment token is invalid",
    );
  }
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}
