import { createHash } from "node:crypto";

import { KIND_HTTP_AUTH, verifyNostrEvent, type NostrEvent } from "@buzz/core";
import { RemoteProtocolError } from "@buzz/remote-agent-protocol";
import { schnorr } from "@noble/curves/secp256k1.js";

const MAX_AUTH_HEADER_BYTES = 8 * 1024;

export class Nip98ReplayGuard {
  readonly #seen = new Map<string, number>();

  public constructor(
    private readonly maximumEntries = 10_000,
    private readonly sharedClaim?: (
      scope: string,
      eventId: string,
      ttlSeconds: number,
    ) => Promise<boolean>,
  ) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new RangeError("maximum replay entries must be positive");
    }
  }

  public async accept(
    scope: string,
    id: string,
    expiresAt: number,
    now: number,
  ): Promise<void> {
    if (!/^[a-z0-9-]{1,128}$/.test(scope)) {
      throw new RemoteProtocolError(
        "AUTH_REQUIRED",
        "NIP-98 replay scope is invalid",
      );
    }
    if (this.sharedClaim) {
      let accepted: boolean;
      try {
        accepted = await this.sharedClaim(
          scope,
          id,
          Math.max(120, expiresAt - now),
        );
      } catch {
        throw new RemoteProtocolError(
          "AUTH_REQUIRED",
          "NIP-98 replay check is unavailable",
        );
      }
      if (!accepted) {
        throw new RemoteProtocolError(
          "REPLAY_DETECTED",
          "HTTP authentication event was already used",
        );
      }
      return;
    }
    for (const [eventId, expiry] of this.#seen) {
      if (expiry < now) this.#seen.delete(eventId);
    }
    const scopedId = `${scope}:${id}`;
    if (this.#seen.has(scopedId)) {
      throw new RemoteProtocolError(
        "REPLAY_DETECTED",
        "HTTP authentication event was already used",
      );
    }
    if (this.#seen.size >= this.maximumEntries) {
      throw new RemoteProtocolError(
        "RATE_LIMITED",
        "HTTP authentication replay window is full",
      );
    }
    this.#seen.set(scopedId, expiresAt);
  }
}

export async function authenticateNip98(input: {
  readonly authorizationHeader: string | undefined;
  readonly body: Buffer;
  readonly method: string;
  readonly publicUrl: string;
  readonly now: number;
  readonly replayGuard: Nip98ReplayGuard;
  readonly replayScope: string;
}): Promise<string> {
  return (await authenticateNip98Identity(input)).pubkey;
}

/**
 * Authenticate Git Smart HTTP's reusable repository-scoped credential.
 *
 * Git's credential protocol obtains one token for the initial GET and reuses
 * it for the following POST, so request-method, payload, and event-ID replay
 * checks cannot be applied without breaking normal clients. The token remains
 * signature-checked, exact-URL-bound, and limited to the ±60 second window.
 */
export function authenticateGitNip98(input: {
  readonly authorizationHeader: string | undefined;
  readonly now: number;
  readonly repositoryUrl: string;
}): { readonly ownerPubkey?: string; readonly pubkey: string } {
  const header = input.authorizationHeader;
  if (!header || Buffer.byteLength(header, "utf8") > MAX_AUTH_HEADER_BYTES) {
    throw new RemoteProtocolError(
      "AUTH_REQUIRED",
      "Git NIP-98 auth is required",
    );
  }
  const [scheme, encoded, ...extra] = header.trim().split(/\s+/);
  if (scheme !== "Nostr" || !encoded || extra.length > 0) {
    throw new RemoteProtocolError(
      "AUTH_REQUIRED",
      "invalid Git NIP-98 authorization header",
    );
  }
  let event: unknown;
  try {
    event = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as unknown;
  } catch {
    throw new RemoteProtocolError(
      "AUTH_REQUIRED",
      "invalid Git NIP-98 authorization event",
    );
  }
  if (!verifyNostrEvent(event) || event.kind !== KIND_HTTP_AUTH) {
    throw new RemoteProtocolError(
      "SIGNATURE_INVALID",
      "Git NIP-98 signature is invalid",
    );
  }
  if (event.created_at < input.now - 60 || event.created_at > input.now + 60) {
    throw new RemoteProtocolError(
      "MESSAGE_EXPIRED",
      "Git NIP-98 event is outside the freshness window",
    );
  }
  if (singleTag(event, "u") !== input.repositoryUrl) {
    throw new RemoteProtocolError(
      "AUTH_REQUIRED",
      "Git NIP-98 repository URL does not match",
    );
  }
  const method = singleTag(event, "method");
  if (method !== "GET" && method !== "POST") {
    throw new RemoteProtocolError(
      "AUTH_REQUIRED",
      "Git NIP-98 method tag is invalid",
    );
  }
  const ownerPubkey = verifyOwnerAttestation(event);
  if (
    event.tags.some((tag) => tag[0] === "auth") &&
    ownerPubkey === undefined
  ) {
    throw new RemoteProtocolError(
      "SIGNATURE_INVALID",
      "Git NIP-OA owner credential is invalid",
    );
  }
  return {
    ...(ownerPubkey ? { ownerPubkey } : {}),
    pubkey: event.pubkey,
  };
}

export async function authenticateNip98Identity(input: {
  readonly authorizationHeader: string | undefined;
  readonly body: Buffer;
  readonly method: string;
  readonly publicUrl: string;
  readonly now: number;
  readonly replayGuard: Nip98ReplayGuard;
  readonly replayScope: string;
}): Promise<{
  readonly pubkey: string;
  readonly ownerPubkey?: string;
}> {
  const header = input.authorizationHeader;
  if (!header || Buffer.byteLength(header, "utf8") > MAX_AUTH_HEADER_BYTES) {
    throw new RemoteProtocolError("AUTH_REQUIRED", "NIP-98 auth is required");
  }
  const [scheme, encoded, ...extra] = header.trim().split(/\s+/);
  if (scheme !== "Nostr" || !encoded || extra.length > 0) {
    throw new RemoteProtocolError(
      "AUTH_REQUIRED",
      "invalid NIP-98 authorization header",
    );
  }

  let event: unknown;
  try {
    event = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as unknown;
  } catch {
    throw new RemoteProtocolError(
      "AUTH_REQUIRED",
      "invalid NIP-98 authorization event",
    );
  }
  if (!verifyNostrEvent(event) || event.kind !== KIND_HTTP_AUTH) {
    throw new RemoteProtocolError(
      "SIGNATURE_INVALID",
      "NIP-98 event signature is invalid",
    );
  }
  if (event.created_at < input.now - 60 || event.created_at > input.now + 60) {
    throw new RemoteProtocolError(
      "MESSAGE_EXPIRED",
      "NIP-98 event is outside the freshness window",
    );
  }
  if (singleTag(event, "u") !== input.publicUrl) {
    throw new RemoteProtocolError(
      "AUTH_REQUIRED",
      "NIP-98 URL binding does not match",
    );
  }
  if (singleTag(event, "method") !== input.method.toUpperCase()) {
    throw new RemoteProtocolError(
      "AUTH_REQUIRED",
      "NIP-98 method binding does not match",
    );
  }
  if (input.body.length > 0) {
    const expectedPayload = createHash("sha256")
      .update(input.body)
      .digest("hex");
    if (singleTag(event, "payload") !== expectedPayload) {
      throw new RemoteProtocolError(
        "AUTH_REQUIRED",
        "NIP-98 body hash does not match",
      );
    }
  }
  const ownerPubkey = verifyOwnerAttestation(event);
  if (
    event.tags.some((tag) => tag[0] === "auth") &&
    ownerPubkey === undefined
  ) {
    throw new RemoteProtocolError(
      "SIGNATURE_INVALID",
      "NIP-OA owner credential is invalid",
    );
  }
  await input.replayGuard.accept(
    input.replayScope,
    event.id,
    input.now + 120,
    input.now,
  );
  return {
    ...(ownerPubkey ? { ownerPubkey } : {}),
    pubkey: event.pubkey,
  };
}

/**
 * Verify a reusable NIP-OA credential using NIP-AA admission semantics.
 * Timestamp clauses bind the presentation event; kind clauses are validated
 * but intentionally do not broaden channel, group, or administrative roles.
 */
export function verifyOwnerAttestation(event: NostrEvent): string | undefined {
  const tags = event.tags.filter((tag) => tag[0] === "auth");
  if (tags.length !== 1) return undefined;
  return verifyOwnerAuthTag(tags[0], event.pubkey, event.created_at);
}

/**
 * Verify one NIP-OA tag for an explicit subject. This is used by archive
 * requests, whose signer is the owner while the delegated subject is the
 * `p`-tagged identity.
 */
export function verifyOwnerAuthTag(
  tag: readonly string[] | undefined,
  subjectPubkey: string,
  createdAt: number,
): string | undefined {
  if (
    !tag ||
    tag.length !== 4 ||
    !tag[1] ||
    !/^[0-9a-f]{64}$/.test(tag[1]) ||
    tag[1] === subjectPubkey ||
    tag[2] === undefined ||
    !validOwnerConditions(tag[2], createdAt) ||
    !tag[3] ||
    !/^[0-9a-f]{128}$/.test(tag[3])
  ) {
    return undefined;
  }
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${subjectPubkey}:${tag[2]}`, "utf8")
    .digest();
  try {
    return schnorr.verify(
      Buffer.from(tag[3], "hex"),
      digest,
      Buffer.from(tag[1], "hex"),
    )
      ? tag[1]
      : undefined;
  } catch {
    return undefined;
  }
}

function validOwnerConditions(value: string, createdAt: number): boolean {
  if (value === "") return true;
  for (const clause of value.split("&")) {
    let match = /^kind=(0|[1-9][0-9]{0,4})$/.exec(clause);
    if (match) {
      if (Number(match[1]) > 65_535) return false;
      continue;
    }
    match = /^created_at([<>])(0|[1-9][0-9]{0,9})$/.exec(clause);
    if (!match || Number(match[2]) > 4_294_967_295) return false;
    const threshold = Number(match[2]);
    if (
      (match[1] === "<" && createdAt >= threshold) ||
      (match[1] === ">" && createdAt <= threshold)
    ) {
      return false;
    }
  }
  return true;
}

function singleTag(event: NostrEvent, name: string): string {
  const values = event.tags.filter((tag) => tag[0] === name);
  if (values.length !== 1 || values[0]?.length !== 2 || !values[0][1]) {
    throw new RemoteProtocolError(
      "TAG_INVALID",
      `NIP-98 event requires exactly one ${name} tag`,
    );
  }
  return values[0][1];
}
