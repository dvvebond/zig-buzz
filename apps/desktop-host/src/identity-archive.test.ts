import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  type Event,
} from "nostr-tools";
import { describe, expect, it } from "vitest";

import { IdentityArchiveService } from "./identity-archive.js";
import { IdentityService } from "./identity.js";
import type { RelayFilter, RelayHttpClient } from "./relay-http.js";

describe("identity archival and owner attestations", () => {
  it("verifies a profile owner and attaches that credential to archive requests", async () => {
    const owner = IdentityService.create(undefined, async () => undefined);
    const agentSecret = generateSecretKey();
    const agentPubkey = getPublicKey(agentSecret);
    const authTag = owner.ownerAuthTag(agentPubkey);
    const profile = finalizeEvent(
      {
        content: JSON.stringify({ display_name: "Remote helper" }),
        created_at: 1_900_000_000,
        kind: 0,
        tags: [authTag],
      },
      agentSecret,
    );
    const published: Event[] = [];
    const service = new IdentityArchiveService({
      identity: owner,
      relay: fakeRelay([profile], published),
      relaySelf: async () => null,
    });

    await expect(service.resolveOwner(agentPubkey)).resolves.toEqual({
      is_me: true,
      owner: owner.info().pubkey,
    });
    await service.archive({
      req: {
        content: "Retired after rotation.",
        reason: "rotated",
        replacedBy: "a".repeat(64),
        targetPubkey: agentPubkey,
      },
    });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      kind: 9_035,
      pubkey: owner.info().pubkey,
    });
    expect(published[0]?.tags).toEqual(
      expect.arrayContaining([
        ["-"],
        ["p", agentPubkey],
        ["reason", "rotated"],
        ["replaced-by", "a".repeat(64)],
        authTag,
      ]),
    );
  });

  it("rejects forged owner credentials and trusts only the NIP-11 relay snapshot signer", async () => {
    const owner = IdentityService.create(undefined, async () => undefined);
    const agentSecret = generateSecretKey();
    const agentPubkey = getPublicKey(agentSecret);
    const forgedTag = owner.ownerAuthTag(agentPubkey);
    forgedTag[3] = "0".repeat(128);
    const forgedProfile = finalizeEvent(
      {
        content: "{}",
        created_at: 1_900_000_000,
        kind: 0,
        tags: [forgedTag],
      },
      agentSecret,
    );
    const relaySecret = generateSecretKey();
    const relaySelf = getPublicKey(relaySecret);
    const archived = "b".repeat(64);
    const snapshot = finalizeEvent(
      {
        content: "",
        created_at: 1_900_000_001,
        kind: 13_535,
        tags: [["-"], ["p", archived]],
      },
      relaySecret,
    );
    const service = new IdentityArchiveService({
      identity: owner,
      relay: fakeRelay([forgedProfile, snapshot], []),
      relaySelf: async () => relaySelf,
    });

    await expect(service.resolveOwner(agentPubkey)).resolves.toBeNull();
    await expect(service.list()).resolves.toEqual({ archived: [archived] });

    const untrusted = new IdentityArchiveService({
      identity: owner,
      relay: fakeRelay(
        [
          finalizeEvent(
            {
              content: "",
              created_at: 1_900_000_002,
              kind: 13_535,
              tags: [["p", archived]],
            },
            generateSecretKey(),
          ),
        ],
        [],
      ),
      relaySelf: async () => relaySelf,
    });
    await expect(untrusted.list()).resolves.toEqual({ archived: [] });
  });

  it("validates archive request bounds before publishing", async () => {
    const owner = IdentityService.create(undefined, async () => undefined);
    const service = new IdentityArchiveService({
      identity: owner,
      relay: fakeRelay([], []),
      relaySelf: async () => null,
    });
    await expect(
      service.archive({
        req: {
          reason: "bad\nreason",
          targetPubkey: owner.info().pubkey,
        },
      }),
    ).rejects.toThrow(/control/);
    await expect(
      service.archive({
        req: {
          replacedBy: owner.info().pubkey,
          targetPubkey: owner.info().pubkey,
        },
      }),
    ).rejects.toThrow(/must differ/);
  });
});

function fakeRelay(
  events: readonly Event[],
  published: Event[],
): RelayHttpClient {
  return {
    publish: async (event: Event) => {
      published.push(event);
      return { eventId: event.id, message: "stored" };
    },
    query: async (filters: readonly RelayFilter[]) =>
      events.filter((event) =>
        filters.some(
          (filter) =>
            (!Array.isArray(filter.authors) ||
              filter.authors.includes(event.pubkey)) &&
            (!Array.isArray(filter.kinds) || filter.kinds.includes(event.kind)),
        ),
      ),
  } as unknown as RelayHttpClient;
}
