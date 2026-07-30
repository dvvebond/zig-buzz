import { createHash } from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";
import type { Event } from "nostr-tools";

const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const HEX_SIGNATURE = /^[0-9a-f]{128}$/;

export type VerifiedOwnerAttestation = {
  readonly ownerPubkey: string;
  readonly tag: [string, string, string, string];
};

export function verifiedOwnerAttestation(
  event: Event,
): VerifiedOwnerAttestation | null {
  for (const candidate of event.tags) {
    if (
      candidate.length !== 4 ||
      candidate[0] !== "auth" ||
      !HEX_PUBKEY.test(candidate[1] ?? "") ||
      candidate[1] === event.pubkey ||
      !validConditions(candidate[2] ?? "") ||
      !HEX_SIGNATURE.test(candidate[3] ?? "")
    ) {
      continue;
    }
    const ownerPubkey = candidate[1] as string;
    const conditions = candidate[2] as string;
    const signature = candidate[3] as string;
    const digest = createHash("sha256")
      .update(`nostr:agent-auth:${event.pubkey}:${conditions}`, "utf8")
      .digest();
    try {
      if (
        schnorr.verify(
          Buffer.from(signature, "hex"),
          digest,
          Buffer.from(ownerPubkey, "hex"),
        )
      ) {
        return {
          ownerPubkey,
          tag: ["auth", ownerPubkey, conditions, signature],
        };
      }
    } catch {
      // Continue past malformed curve points or signatures.
    }
  }
  return null;
}

function validConditions(value: string): boolean {
  if (value === "") return true;
  if (Buffer.byteLength(value, "utf8") > 1_024) return false;
  for (const clause of value.split("&")) {
    let match = /^kind=(0|[1-9][0-9]{0,4})$/.exec(clause);
    if (match) {
      if (Number(match[1]) > 65_535) return false;
      continue;
    }
    match = /^created_at[<>](0|[1-9][0-9]{0,9})$/.exec(clause);
    if (!match || Number(match[1]) > 4_294_967_295) return false;
  }
  return true;
}
