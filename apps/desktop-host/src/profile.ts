import type { Event } from "nostr-tools";

import type { IdentityService } from "./identity.js";
import type { RelayHttpClient } from "./relay-http.js";
import { RelayHttpClient as RelayClient } from "./relay-http.js";
import { verifiedOwnerAttestation } from "./nip-oa.js";
import { normalizeWorkspaceRelayUrl, relayHttpUrlFromWs } from "./workspace.js";

const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const MAX_PROFILE_FIELD_BYTES = 16 * 1024;

export type Profile = {
  about: string | null;
  avatar_url: string | null;
  display_name: string | null;
  has_profile_event: boolean;
  nip05_handle: string | null;
  owner_pubkey: string | null;
  pubkey: string;
};

export class ProfileService {
  readonly #identity: IdentityService;
  readonly #relay: RelayHttpClient;

  constructor(identity: IdentityService, relay: RelayHttpClient) {
    this.#identity = identity;
    this.#relay = relay;
  }

  async get(pubkey = this.#identity.info().pubkey): Promise<Profile> {
    requirePubkey(pubkey);
    const [event] = await this.#relay.query([
      { authors: [pubkey], kinds: [0], limit: 1 },
    ]);
    return event ? profileFromEvent(event) : emptyProfile(pubkey);
  }

  async update(args: Record<string, unknown>): Promise<Profile> {
    const prior = await this.get();
    const displayName = optionalProfileField(
      args.displayName,
      prior.display_name,
      "displayName",
    );
    const avatarUrl = optionalUrl(
      args.avatarUrl,
      prior.avatar_url,
      "avatarUrl",
    );
    const about = optionalProfileField(args.about, prior.about, "about");
    const nip05Handle = optionalProfileField(
      args.nip05Handle,
      prior.nip05_handle,
      "nip05Handle",
    );
    const content = JSON.stringify({
      ...(about !== null ? { about } : {}),
      ...(displayName !== null ? { display_name: displayName } : {}),
      ...(nip05Handle !== null ? { nip05: nip05Handle } : {}),
      ...(avatarUrl !== null ? { picture: avatarUrl } : {}),
    });
    const event = this.#identity.sign({ content, kind: 0, tags: [] });
    await this.#relay.publish(event);
    return profileFromEvent(event);
  }

  async updateAtRelay(args: Record<string, unknown>): Promise<Profile> {
    const relayUrl = normalizeWorkspaceRelayUrl(args.relayUrl);
    const expectedPubkey = requirePubkey(args.expectedPubkey);
    if (expectedPubkey !== this.#identity.info().pubkey) {
      throw new Error("profile identity changed before avatar save");
    }
    const expectedAvatarUrl =
      args.expectedAvatarUrl === undefined || args.expectedAvatarUrl === null
        ? null
        : optionalUrl(args.expectedAvatarUrl, null, "expectedAvatarUrl");
    const avatarUrl = optionalUrl(args.avatarUrl, null, "avatarUrl");
    if (!avatarUrl) throw new Error("avatarUrl is required");
    const relay = new RelayClient({
      baseUrl: relayHttpUrlFromWs(relayUrl),
      sign: (input) => this.#identity.sign(input),
    });
    const [prior] = await relay.query([
      { authors: [expectedPubkey], kinds: [0], limit: 1 },
    ]);
    const current = prior ? parseMetadata(prior.content) : {};
    const currentAvatar = textOrNull(current.picture);
    if (normalizedUrl(currentAvatar) !== normalizedUrl(expectedAvatarUrl)) {
      throw new Error("profile avatar changed before deferred save");
    }
    const content = JSON.stringify({
      ...(textOrNull(current.about) !== null
        ? { about: textOrNull(current.about) }
        : {}),
      ...(textOrNull(current.display_name) !== null
        ? { display_name: textOrNull(current.display_name) }
        : {}),
      ...(textOrNull(current.name) !== null
        ? { name: textOrNull(current.name) }
        : {}),
      ...(textOrNull(current.nip05) !== null
        ? { nip05: textOrNull(current.nip05) }
        : {}),
      picture: avatarUrl,
    });
    const event = this.#identity.sign({
      content,
      createdAt: Math.max(
        Math.floor(Date.now() / 1_000),
        (prior?.created_at ?? -1) + 1,
      ),
      kind: 0,
      tags: [],
    });
    await relay.publish(event);
    const [canonical] = await relay.query([
      { authors: [expectedPubkey], kinds: [0], limit: 1 },
    ]);
    return profileFromEvent(canonical ?? event);
  }

  async usersBatch(pubkeys: unknown): Promise<{
    missing: string[];
    profiles: Record<
      string,
      Omit<Profile, "about" | "has_profile_event" | "pubkey"> & {
        is_agent: boolean;
        name: string | null;
      }
    >;
  }> {
    if (!Array.isArray(pubkeys) || pubkeys.length > 500) {
      throw new Error("pubkeys must contain at most 500 keys");
    }
    const keys = pubkeys.map((value) => requirePubkey(value));
    if (keys.length === 0) return { missing: [], profiles: {} };
    const events = await this.#relay.query([{ authors: keys, kinds: [0] }]);
    const latest = latestByPubkey(events);
    const profiles: Record<
      string,
      Omit<Profile, "about" | "has_profile_event" | "pubkey"> & {
        is_agent: boolean;
        name: string | null;
      }
    > = {};
    for (const [pubkey, event] of latest) {
      const profile = profileFromEvent(event);
      const metadata = parseMetadata(event.content);
      profiles[pubkey] = {
        avatar_url: profile.avatar_url,
        display_name: profile.display_name,
        is_agent: profile.owner_pubkey !== null,
        name: textOrNull(metadata.name),
        nip05_handle: profile.nip05_handle,
        owner_pubkey: profile.owner_pubkey,
      };
    }
    return {
      missing: keys.filter((key) => profiles[key] === undefined),
      profiles,
    };
  }

  async search(
    query: unknown,
    limitValue: unknown,
  ): Promise<{ next_cursor: null; users: Array<Record<string, unknown>> }> {
    if (typeof query !== "string" || query.trim().length < 1) {
      return { next_cursor: null, users: [] };
    }
    const limit =
      typeof limitValue === "number" && Number.isSafeInteger(limitValue)
        ? Math.min(Math.max(limitValue, 1), 100)
        : 8;
    const events = await this.#relay.query([
      { kinds: [0], limit: Math.max(limit * 4, 32), search: query.trim() },
    ]);
    const users = [...latestByPubkey(events).values()]
      .map(profileFromEvent)
      .slice(0, limit)
      .map((profile) => ({
        avatar_url: profile.avatar_url,
        display_name: profile.display_name,
        is_agent: false,
        nip05_handle: profile.nip05_handle,
        owner_pubkey: profile.owner_pubkey,
        pubkey: profile.pubkey,
      }));
    return { next_cursor: null, users };
  }
}

export function profileFromEvent(event: Event): Profile {
  const metadata = parseMetadata(event.content);
  const owner = verifiedOwnerAttestation(event);
  return {
    about: textOrNull(metadata.about),
    avatar_url: textOrNull(metadata.picture),
    display_name: textOrNull(metadata.display_name),
    has_profile_event: true,
    nip05_handle: textOrNull(metadata.nip05),
    owner_pubkey: owner?.ownerPubkey ?? null,
    pubkey: event.pubkey,
  };
}

function emptyProfile(pubkey: string): Profile {
  return {
    about: null,
    avatar_url: null,
    display_name: null,
    has_profile_event: false,
    nip05_handle: null,
    owner_pubkey: null,
    pubkey,
  };
}

function parseMetadata(content: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(content);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function latestByPubkey(events: Event[]): Map<string, Event> {
  const latest = new Map<string, Event>();
  for (const event of events) {
    const previous = latest.get(event.pubkey);
    if (
      !previous ||
      event.created_at > previous.created_at ||
      (event.created_at === previous.created_at && event.id > previous.id)
    ) {
      latest.set(event.pubkey, event);
    }
  }
  return latest;
}

function optionalProfileField(
  value: unknown,
  fallback: string | null,
  name: string,
): string | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (Buffer.byteLength(value, "utf8") > MAX_PROFILE_FIELD_BYTES) {
    throw new Error(`${name} exceeds the 16 KiB limit`);
  }
  return value;
}

function optionalUrl(
  value: unknown,
  fallback: string | null,
  name: string,
): string | null {
  const candidate = optionalProfileField(value, fallback, name);
  if (!candidate) return candidate;
  const url = new URL(candidate);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must use http: or https:`);
  }
  return candidate;
}

function requirePubkey(value: unknown): string {
  if (typeof value !== "string" || !HEX_PUBKEY.test(value)) {
    throw new Error("pubkey must be 64 lowercase hexadecimal characters");
  }
  return value;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizedUrl(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
