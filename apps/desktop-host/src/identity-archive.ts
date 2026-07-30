import type { Event } from "nostr-tools";

import type { IdentityService } from "./identity.js";
import { verifiedOwnerAttestation } from "./nip-oa.js";
import type { RelayHttpClient } from "./relay-http.js";

const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_REASON_BYTES = 64;

export class IdentityArchiveService {
  readonly #identity: IdentityService;
  readonly #relay: RelayHttpClient;
  readonly #relaySelf: () => Promise<string | null>;

  constructor(input: {
    identity: IdentityService;
    relay: RelayHttpClient;
    relaySelf: () => Promise<string | null>;
  }) {
    this.#identity = input.identity;
    this.#relay = input.relay;
    this.#relaySelf = input.relaySelf;
  }

  async resolveOwner(targetPubkeyValue: unknown): Promise<{
    is_me: boolean;
    owner: string;
  } | null> {
    const targetPubkey = requirePubkey(targetPubkeyValue, "targetPubkey");
    const event = await this.#profile(targetPubkey);
    if (!event) return null;
    const attestation = verifiedOwnerAttestation(event);
    if (!attestation) return null;
    return {
      is_me: attestation.ownerPubkey === this.#identity.info().pubkey,
      owner: attestation.ownerPubkey,
    };
  }

  async archive(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.#submit(args.req, true);
  }

  async unarchive(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.#submit(args.req, false);
  }

  async list(): Promise<{ archived: string[] }> {
    const relaySelf = await this.#relaySelf();
    if (!relaySelf || !HEX_PUBKEY.test(relaySelf)) return { archived: [] };
    const [snapshot] = await this.#relay.query([
      { authors: [relaySelf], kinds: [13_535], limit: 1 },
    ]);
    if (!snapshot || snapshot.pubkey !== relaySelf) return { archived: [] };
    return {
      archived: snapshot.tags
        .filter(
          (tag) =>
            tag.length >= 2 &&
            tag[0] === "p" &&
            HEX_PUBKEY.test((tag[1] ?? "").toLowerCase()),
        )
        .map((tag) => (tag[1] as string).toLowerCase()),
    };
  }

  async #submit(
    requestValue: unknown,
    archive: boolean,
  ): Promise<Record<string, unknown>> {
    const request = requireObject(requestValue, "req");
    const target = requirePubkey(request.targetPubkey, "targetPubkey");
    const content =
      optionalText(request.content, "content", MAX_CONTENT_BYTES) ?? "";
    const reason = optionalReason(request.reason);
    const replacedBy =
      archive && request.replacedBy !== undefined && request.replacedBy !== null
        ? requirePubkey(request.replacedBy, "replacedBy")
        : null;
    if (replacedBy === target) {
      throw new Error("replacedBy must differ from targetPubkey");
    }
    const ownerTag = await this.#ownerTag(target);
    const event = this.#identity.sign({
      content,
      kind: archive ? 9_035 : 9_036,
      tags: [
        ["-"],
        ["p", target],
        ...(reason ? [["reason", reason]] : []),
        ...(replacedBy ? [["replaced-by", replacedBy]] : []),
        ...(ownerTag ? [ownerTag] : []),
      ],
    });
    const result = await this.#relay.publish(event);
    return {
      event_id: result.eventId,
      message: result.message,
    };
  }

  async #ownerTag(
    targetPubkey: string,
  ): Promise<[string, string, string, string] | null> {
    const owner = this.#identity.info().pubkey;
    if (targetPubkey === owner) return null;
    const profile = await this.#profile(targetPubkey);
    const attestation = profile ? verifiedOwnerAttestation(profile) : null;
    return attestation?.ownerPubkey === owner ? attestation.tag : null;
  }

  async #profile(pubkey: string): Promise<Event | undefined> {
    const events = await this.#relay.query([
      { authors: [pubkey], kinds: [0], limit: 1 },
    ]);
    return events[0];
  }
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requirePubkey(value: unknown, name: string): string {
  if (typeof value !== "string" || !HEX_PUBKEY.test(value.toLowerCase())) {
    throw new Error(`${name} must be a 64-character hexadecimal pubkey`);
  }
  return value.toLowerCase();
}

function optionalText(
  value: unknown,
  name: string,
  maximumBytes: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${name} exceeds ${maximumBytes} bytes`);
  }
  return value;
}

function optionalReason(value: unknown): string | null {
  const reason = optionalText(value, "reason", MAX_REASON_BYTES);
  if (reason === null || reason === "") return null;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(reason)) {
    throw new Error("reason may not contain control characters");
  }
  return reason;
}
