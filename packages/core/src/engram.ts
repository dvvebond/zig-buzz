import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { getPublicKey } from "nostr-tools/pure";
import { nip44 } from "nostr-tools";

import { signNostrEvent, verifyNostrEvent } from "./event.js";
import { KIND_AGENT_ENGRAM } from "./kinds.js";
import type { NostrEvent } from "./types.js";

export const ENGRAM_CORE_SLUG = "core";
export const ENGRAM_D_TAG_DOMAIN = "agent-memory/v1/d-tag";
export const ENGRAM_PLAINTEXT_MAX_BYTES = 65_535;
export const ENGRAM_SLUG_MAX_BYTES = 255;

const HEX_64_LOWER = /^[0-9a-f]{64}$/;
const MEMORY_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type EngramBody =
  | { readonly slug: "core"; readonly profile: string }
  | { readonly slug: string; readonly value: string | null };

export type ValidatedEngram = {
  readonly body: EngramBody;
  readonly event: NostrEvent;
};

export function normalizeEngramSlug(raw: string): string {
  const slug =
    raw === ENGRAM_CORE_SLUG || raw.startsWith("mem/") ? raw : `mem/${raw}`;
  validateEngramSlug(slug);
  return slug;
}

export function validateEngramSlug(slug: string): void {
  if (slug === ENGRAM_CORE_SLUG) return;
  if (utf8Length(slug) > ENGRAM_SLUG_MAX_BYTES || !slug.startsWith("mem/")) {
    throw new TypeError("engram slug must be core or a bounded mem/... path");
  }
  const segments = slug.slice(4).split("/");
  if (
    segments.length < 1 ||
    segments.some((segment) => !MEMORY_SEGMENT.test(segment))
  ) {
    throw new TypeError(
      "engram path segments must use 1-64 lowercase letters, digits, underscores, or hyphens and start alphanumeric",
    );
  }
}

export function engramConversationKey(
  mySecretKey: Uint8Array,
  theirPubkey: string,
): Uint8Array {
  assertPubkey(theirPubkey, "theirPubkey");
  return Uint8Array.from(
    nip44.v2.utils.getConversationKey(mySecretKey, theirPubkey),
  );
}

export function engramDTag(conversationKey: Uint8Array, slug: string): string {
  validateEngramSlug(slug);
  const domain = asciiBytes(ENGRAM_D_TAG_DOMAIN);
  const slugBytes = utf8Bytes(slug);
  const message = new Uint8Array(domain.length + 1 + slugBytes.length);
  message.set(domain);
  message.set(slugBytes, domain.length + 1);
  return hex(hmac(sha256, conversationKey, message));
}

export function serializeEngramBody(body: EngramBody): string {
  validateEngramBody(body);
  const serialized =
    "profile" in body
      ? `{"slug":"core","profile":${JSON.stringify(body.profile)}}`
      : `{"slug":${JSON.stringify(body.slug)},"value":${JSON.stringify(body.value)}}`;
  const size = utf8Length(serialized);
  if (size > ENGRAM_PLAINTEXT_MAX_BYTES) {
    throw new RangeError(
      `engram body exceeds ${ENGRAM_PLAINTEXT_MAX_BYTES} bytes (got ${size})`,
    );
  }
  return serialized;
}

export function parseEngramBody(plaintext: string): EngramBody {
  assertJsonObjectKeysUnique(plaintext);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new TypeError("engram body is invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("engram body must be an object");
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.slug !== "string") {
    throw new TypeError("engram body slug is required");
  }
  validateEngramSlug(value.slug);
  const body: EngramBody =
    value.slug === ENGRAM_CORE_SLUG
      ? typeof value.profile === "string"
        ? { profile: value.profile, slug: ENGRAM_CORE_SLUG }
        : (() => {
            throw new TypeError("core engram profile must be a string");
          })()
      : typeof value.value === "string" || value.value === null
        ? { slug: value.slug, value: value.value }
        : (() => {
            throw new TypeError("memory engram value must be string or null");
          })();
  return body;
}

export function buildEngramEvent(input: {
  readonly agentSecretKey: Uint8Array;
  readonly ownerPubkey: string;
  readonly body: EngramBody;
  readonly createdAt: number;
}): NostrEvent {
  assertPubkey(input.ownerPubkey, "ownerPubkey");
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new TypeError("createdAt must be a non-negative integer");
  }
  const plaintext = serializeEngramBody(input.body);
  const key = engramConversationKey(input.agentSecretKey, input.ownerPubkey);
  const content = nip44.v2.encrypt(plaintext, key);
  return signNostrEvent(
    {
      content,
      created_at: input.createdAt,
      kind: KIND_AGENT_ENGRAM,
      tags: [
        ["d", engramDTag(key, input.body.slug)],
        ["p", input.ownerPubkey.toLowerCase()],
      ],
    },
    input.agentSecretKey,
  );
}

export function validateAndDecryptEngram(input: {
  readonly event: NostrEvent;
  readonly expectedAgent: string;
  readonly expectedOwner: string;
  readonly mySecretKey: Uint8Array;
  readonly theirPubkey: string;
}): EngramBody {
  const expectedAgent = assertPubkey(input.expectedAgent, "expectedAgent");
  const expectedOwner = assertPubkey(input.expectedOwner, "expectedOwner");
  assertPubkey(input.theirPubkey, "theirPubkey");
  if (!verifyNostrEvent(input.event)) {
    throw new TypeError("engram signature is invalid");
  }
  if (
    input.event.kind !== KIND_AGENT_ENGRAM ||
    input.event.pubkey.toLowerCase() !== expectedAgent
  ) {
    throw new TypeError("engram kind or author is invalid");
  }
  const dTags = input.event.tags.filter((tag) => tag[0] === "d");
  const pTags = input.event.tags.filter((tag) => tag[0] === "p");
  if (
    dTags.length !== 1 ||
    dTags[0]?.length !== 2 ||
    !HEX_64_LOWER.test(dTags[0][1] ?? "") ||
    pTags.length !== 1 ||
    pTags[0]?.length !== 2 ||
    pTags[0]?.[1]?.toLowerCase() !== expectedOwner
  ) {
    throw new TypeError("engram addressing envelope is invalid");
  }
  const key = engramConversationKey(input.mySecretKey, input.theirPubkey);
  let plaintext: string;
  try {
    plaintext = nip44.v2.decrypt(input.event.content, key);
  } catch {
    throw new TypeError("engram decryption failed");
  }
  if (utf8Length(plaintext) > ENGRAM_PLAINTEXT_MAX_BYTES) {
    throw new RangeError("decrypted engram exceeds the plaintext limit");
  }
  const body = parseEngramBody(plaintext);
  if (engramDTag(key, body.slug) !== dTags[0]?.[1]) {
    throw new TypeError("engram slug does not match its d tag");
  }
  return body;
}

export function selectEngramHead(
  values: readonly ValidatedEngram[],
): ValidatedEngram | undefined {
  return [...values].sort(
    (left, right) =>
      right.event.created_at - left.event.created_at ||
      left.event.id.localeCompare(right.event.id),
  )[0];
}

export function monotonicEngramCreatedAt(
  now: number,
  priorCreatedAt?: number,
): number {
  return Math.max(now, priorCreatedAt === undefined ? 0 : priorCreatedAt + 1);
}

export function engramAgentPubkey(secretKey: Uint8Array): string {
  return getPublicKey(secretKey);
}

function validateEngramBody(body: EngramBody): void {
  validateEngramSlug(body.slug);
  if ("profile" in body) {
    if (body.slug !== ENGRAM_CORE_SLUG) {
      throw new TypeError("core engram must use the core slug");
    }
    if (typeof body.profile !== "string") {
      throw new TypeError("core engram profile must be a string");
    }
  } else {
    if (body.slug === ENGRAM_CORE_SLUG) {
      throw new TypeError("core engram must contain a profile");
    }
    if (typeof body.value !== "string" && body.value !== null) {
      throw new TypeError("memory engram value must be string or null");
    }
  }
}

function assertPubkey(value: string, name: string): string {
  if (!HEX_64_LOWER.test(value.toLowerCase())) {
    throw new TypeError(`${name} must be a 64-character hexadecimal pubkey`);
  }
  return value.toLowerCase();
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from(
    [...value].map((character) => character.charCodeAt(0)),
  );
}

function utf8Bytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of value) {
    const point = character.codePointAt(0) as number;
    if (point <= 0x7f) bytes.push(point);
    else if (point <= 0x7ff) {
      bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    } else if (point <= 0xffff) {
      bytes.push(
        0xe0 | (point >> 12),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function utf8Length(value: string): number {
  return utf8Bytes(value).byteLength;
}

function assertJsonObjectKeysUnique(value: string): void {
  let offset = 0;
  const whitespace = () => {
    while (/\s/.test(value[offset] ?? "")) offset += 1;
  };
  const stringToken = (): string => {
    const start = offset;
    if (value[offset] !== '"') throw new TypeError("expected JSON string");
    offset += 1;
    while (offset < value.length) {
      if (value[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (value[offset] === '"') {
        offset += 1;
        try {
          return JSON.parse(value.slice(start, offset)) as string;
        } catch {
          throw new TypeError("invalid JSON string");
        }
      }
      offset += 1;
    }
    throw new TypeError("unterminated JSON string");
  };
  const parseValue = (): void => {
    whitespace();
    if (value[offset] === "{") {
      offset += 1;
      const keys = new Set<string>();
      whitespace();
      if (value[offset] === "}") {
        offset += 1;
        return;
      }
      for (;;) {
        whitespace();
        const key = stringToken();
        if (keys.has(key))
          throw new TypeError(`duplicate object member: ${key}`);
        keys.add(key);
        whitespace();
        if (value[offset] !== ":") throw new TypeError("expected JSON colon");
        offset += 1;
        parseValue();
        whitespace();
        if (value[offset] === "}") {
          offset += 1;
          return;
        }
        if (value[offset] !== ",") throw new TypeError("expected JSON comma");
        offset += 1;
      }
    }
    if (value[offset] === "[") {
      offset += 1;
      whitespace();
      if (value[offset] === "]") {
        offset += 1;
        return;
      }
      for (;;) {
        parseValue();
        whitespace();
        if (value[offset] === "]") {
          offset += 1;
          return;
        }
        if (value[offset] !== ",") throw new TypeError("expected JSON comma");
        offset += 1;
      }
    }
    if (value[offset] === '"') {
      stringToken();
      return;
    }
    const start = offset;
    while (offset < value.length && !/[\s,\]}]/.test(value[offset] as string)) {
      offset += 1;
    }
    if (start === offset) throw new TypeError("invalid JSON token");
    try {
      JSON.parse(value.slice(start, offset));
    } catch {
      throw new TypeError("invalid JSON token");
    }
  };
  parseValue();
  whitespace();
  if (offset !== value.length) throw new TypeError("trailing JSON data");
}
