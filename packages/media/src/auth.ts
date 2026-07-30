import {
  KIND_BLOSSOM_AUTH,
  verifyNostrEvent,
  type NostrEvent,
} from "@buzz/core";

import { mediaError } from "./error.js";

export type BlossomVerb = "upload" | "get";

const HEX_64 = /^[0-9a-f]{64}$/;

export function normalizeServerHost(value: string): string {
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return "";
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) return "";
  const defaultPort =
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80");
  return `${hostname}${url.port && !defaultPort ? `:${url.port}` : ""}`;
}

export function parseBlossomAuthorization(
  header: string | undefined,
): NostrEvent {
  if (!header) throw mediaError("AUTHENTICATION_FAILED");
  const match = /^Nostr\s+([A-Za-z0-9+/_=-]+)$/i.exec(header.trim());
  if (!match?.[1]) throw mediaError("AUTHENTICATION_FAILED");
  try {
    const encoded = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const value = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as unknown;
    if (!verifyNostrEvent(value)) throw new Error("invalid event");
    return value;
  } catch {
    throw mediaError("AUTHENTICATION_FAILED");
  }
}

export function verifyBlossomAuth(input: {
  readonly event: NostrEvent;
  readonly verb: BlossomVerb;
  readonly serverHost?: string;
  readonly maxAgeSeconds: number;
  readonly now?: number;
}): void {
  const { event } = input;
  if (!verifyNostrEvent(event) || event.kind !== KIND_BLOSSOM_AUTH) {
    throw mediaError("AUTHENTICATION_FAILED");
  }
  if (!event.content.trim()) throw mediaError("AUTHENTICATION_FAILED");
  const verbs = exactTagValues(event, "t");
  const expirations = exactTagValues(event, "expiration");
  if (
    verbs.length !== 1 ||
    verbs[0] !== input.verb ||
    expirations.length !== 1 ||
    !/^[0-9]{1,20}$/.test(expirations[0] as string)
  ) {
    throw mediaError("AUTHENTICATION_FAILED");
  }
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  const expiration = Number(expirations[0]);
  if (
    !Number.isSafeInteger(expiration) ||
    expiration <= now ||
    event.created_at > now + 5 ||
    event.created_at < now - input.maxAgeSeconds
  ) {
    throw mediaError("AUTHENTICATION_FAILED");
  }
  const serverTags = exactTagValues(event, "server");
  if (serverTags.length > 0) {
    const expected = input.serverHost
      ? normalizeServerHost(input.serverHost)
      : "";
    if (
      !expected ||
      !serverTags.some((value) => normalizeServerHost(value) === expected)
    ) {
      throw mediaError("AUTHENTICATION_FAILED");
    }
  }
}

export function verifyBlossomUploadAuth(input: {
  readonly event: NostrEvent;
  readonly sha256: string;
  readonly serverHost: string;
  readonly maxAgeSeconds?: number;
  readonly now?: number;
}): void {
  if (!HEX_64.test(input.sha256)) throw mediaError("HASH_MISMATCH");
  verifyBlossomAuth({
    event: input.event,
    maxAgeSeconds: input.maxAgeSeconds ?? 600,
    ...(input.now === undefined ? {} : { now: input.now }),
    serverHost: input.serverHost,
    verb: "upload",
  });
  if (!exactTagValues(input.event, "x").includes(input.sha256)) {
    throw mediaError("HASH_MISMATCH");
  }
}

export function verifyBlossomGetAuth(input: {
  readonly event: NostrEvent;
  readonly sha256: string;
  readonly serverHost: string;
  readonly maxAgeSeconds?: number;
  readonly now?: number;
}): void {
  if (!HEX_64.test(input.sha256)) throw mediaError("AUTHENTICATION_FAILED");
  verifyBlossomAuth({
    event: input.event,
    maxAgeSeconds: input.maxAgeSeconds ?? 600,
    ...(input.now === undefined ? {} : { now: input.now }),
    serverHost: input.serverHost,
    verb: "get",
  });
  const blobScoped = exactTagValues(input.event, "x").includes(input.sha256);
  const expected = normalizeServerHost(input.serverHost);
  const serverScoped = exactTagValues(input.event, "server").some(
    (value) => normalizeServerHost(value) === expected,
  );
  if (!blobScoped && !serverScoped) {
    throw mediaError("INSUFFICIENT_SCOPE");
  }
}

function exactTagValues(event: NostrEvent, name: string): string[] {
  return event.tags
    .filter(
      (tag) =>
        tag[0] === name &&
        tag.length === 2 &&
        typeof tag[1] === "string" &&
        tag[1].length > 0,
    )
    .map((tag) => tag[1] as string);
}
