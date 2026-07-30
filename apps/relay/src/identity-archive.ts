import {
  KIND_IA_ARCHIVED,
  KIND_IA_ARCHIVED_LIST,
  KIND_IA_ARCHIVE_REQUEST,
  KIND_IA_UNARCHIVED,
  KIND_IA_UNARCHIVE_REQUEST,
  KIND_PROFILE,
  signNostrEvent,
  unixNow,
  type NostrEvent,
} from "@buzz/core";
import type { EventStore } from "@buzz/db";
import { getPublicKey } from "nostr-tools/pure";
import type { Pool } from "pg";
import { RemoteProtocolError } from "@buzz/remote-agent-protocol";

import { verifyOwnerAttestation, verifyOwnerAuthTag } from "./nip98.js";

type ConsentPath = "admin" | "owner" | "self";

/** Executes tenant-local NIP-IA requests and publishes relay-authoritative state. */
export class IdentityArchiveService {
  readonly #relayPubkey: string;
  readonly #relaySecretKey: Uint8Array;

  public constructor(
    private readonly options: {
      readonly community: string;
      readonly eventStore: EventStore;
      readonly pool: Pool;
      readonly publishEvent: (event: NostrEvent) => Promise<void>;
      readonly relaySecretKey: Uint8Array;
    },
  ) {
    this.#relaySecretKey = Uint8Array.from(options.relaySecretKey);
    this.#relayPubkey = getPublicKey(this.#relaySecretKey);
  }

  public handles(kind: number): boolean {
    return (
      kind === KIND_IA_ARCHIVE_REQUEST || kind === KIND_IA_UNARCHIVE_REQUEST
    );
  }

  public async execute(event: NostrEvent): Promise<void> {
    if (!this.handles(event.kind)) return;
    if (Math.abs(event.created_at - unixNow()) > 120) {
      throw invalid("identity archive request timestamp is out of range");
    }
    requireProtectedTag(event);
    const target = exactHexTag(event, "p").toLowerCase();
    const replacedBy = optionalReplacedBy(event, target);
    if (event.kind === KIND_IA_UNARCHIVE_REQUEST && replacedBy !== undefined) {
      throw invalid("replaced-by is not valid on unarchive requests");
    }
    const reason = optionalTextTag(event, "reason", 4_096);
    const communityId = await this.#communityId();
    const consentPath = await this.#consentPath(communityId, event, target);
    const changed =
      event.kind === KIND_IA_ARCHIVE_REQUEST
        ? await this.options.pool.query(
            `INSERT INTO archived_identities (
               community_id, pubkey, consent_path, actor, reason,
               replaced_by, request_event_id
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (community_id, pubkey) DO NOTHING`,
            [
              communityId,
              target,
              consentPath,
              event.pubkey,
              reason ?? null,
              replacedBy ?? null,
              event.id,
            ],
          )
        : await this.options.pool.query(
            `DELETE FROM archived_identities
             WHERE community_id = $1 AND pubkey = $2`,
            [communityId, target],
          );
    if (changed.rowCount !== 1) return;
    await this.#publishDelta({
      actor: event.pubkey,
      consentPath,
      content: event.content,
      kind:
        event.kind === KIND_IA_ARCHIVE_REQUEST
          ? KIND_IA_ARCHIVED
          : KIND_IA_UNARCHIVED,
      ...(reason !== undefined ? { reason } : {}),
      ...(event.kind === KIND_IA_ARCHIVE_REQUEST && replacedBy !== undefined
        ? { replacedBy }
        : {}),
      requestEventId: event.id,
      target,
    }).catch(() => undefined);
    await this.#publishList(communityId).catch(() => undefined);
  }

  async #communityId(): Promise<string> {
    const result = await this.options.pool.query<{ readonly id: string }>(
      `SELECT id::text AS id
       FROM communities
       WHERE lower(host) = lower($1) AND archived_at IS NULL
       LIMIT 1`,
      [this.options.community],
    );
    const id = result.rows[0]?.id;
    if (!id) throw denied("community is unavailable");
    return id;
  }

  async #consentPath(
    communityId: string,
    event: NostrEvent,
    target: string,
  ): Promise<ConsentPath> {
    if (event.pubkey === target) return "self";
    const actor = await this.options.pool.query<{ readonly role: string }>(
      `SELECT role
       FROM relay_members
       WHERE community_id = $1 AND pubkey = $2
       LIMIT 1`,
      [communityId, event.pubkey],
    );
    if (actor.rows[0]?.role === "owner" || actor.rows[0]?.role === "admin") {
      return "admin";
    }

    const requestAuth = singleAuthTag(event);
    if (
      verifyOwnerAuthTag(requestAuth, target, event.created_at) !== event.pubkey
    ) {
      throw denied("identity archive owner credential is invalid");
    }
    const profiles = await this.options.eventStore.query(
      this.options.community,
      {
        authors: [target],
        kinds: [KIND_PROFILE],
        limit: 1,
      },
    );
    const profile = profiles[0];
    if (
      !profile ||
      profile.pubkey !== target ||
      verifyOwnerAttestation(profile) !== event.pubkey
    ) {
      throw denied(
        "live kind:0 profile no longer attests to the request signer",
      );
    }
    return "owner";
  }

  async #publishDelta(input: {
    readonly actor: string;
    readonly consentPath: ConsentPath;
    readonly content: string;
    readonly kind: typeof KIND_IA_ARCHIVED | typeof KIND_IA_UNARCHIVED;
    readonly reason?: string;
    readonly replacedBy?: string;
    readonly requestEventId: string;
    readonly target: string;
  }): Promise<void> {
    const tags: string[][] = [
      ["-"],
      ["p", input.target],
      ["consent", input.consentPath, input.actor],
      ["e", input.requestEventId],
    ];
    if (input.reason !== undefined) tags.push(["reason", input.reason]);
    if (input.replacedBy !== undefined) {
      tags.push(["replaced-by", input.replacedBy]);
    }
    await this.#storeAndPublish(
      signNostrEvent(
        {
          content: input.content,
          created_at: unixNow(),
          kind: input.kind,
          tags,
        },
        this.#relaySecretKey,
      ),
    );
  }

  async #publishList(communityId: string): Promise<void> {
    const archived = await this.options.pool.query<{
      readonly pubkey: string;
    }>(
      `SELECT pubkey
       FROM archived_identities
       WHERE community_id = $1
       ORDER BY archived_at, pubkey`,
      [communityId],
    );
    const current = await this.options.eventStore.query(
      this.options.community,
      {
        authors: [this.#relayPubkey],
        kinds: [KIND_IA_ARCHIVED_LIST],
        limit: 1,
      },
    );
    const createdAt = Math.max(unixNow(), (current[0]?.created_at ?? -1) + 1);
    await this.#storeAndPublish(
      signNostrEvent(
        {
          content: "",
          created_at: createdAt,
          kind: KIND_IA_ARCHIVED_LIST,
          tags: [["-"], ...archived.rows.map(({ pubkey }) => ["p", pubkey])],
        },
        this.#relaySecretKey,
      ),
    );
  }

  async #storeAndPublish(event: NostrEvent): Promise<void> {
    const stored = await this.options.eventStore.store(
      this.options.community,
      event,
    );
    if (stored.status === "inserted" || stored.status === "ephemeral") {
      await this.options.publishEvent(event);
    }
  }
}

function requireProtectedTag(event: NostrEvent): void {
  const tags = event.tags.filter((tag) => tag[0] === "-");
  if (tags.length !== 1 || tags[0]?.length !== 1) {
    throw invalid(
      "identity archive request requires exactly one protected tag",
    );
  }
}

function exactHexTag(event: NostrEvent, name: string): string {
  const tags = event.tags.filter((tag) => tag[0] === name);
  const value = tags[0]?.[1];
  if (
    tags.length !== 1 ||
    tags[0]?.length !== 2 ||
    !value ||
    !/^[0-9a-fA-F]{64}$/.test(value)
  ) {
    throw invalid(
      `identity archive request requires exactly one valid ${name} tag`,
    );
  }
  return value;
}

function optionalReplacedBy(
  event: NostrEvent,
  target: string,
): string | undefined {
  const tags = event.tags.filter((tag) => tag[0] === "replaced-by");
  if (tags.length === 0) return undefined;
  const value = tags[0]?.[1];
  if (
    tags.length !== 1 ||
    tags[0]?.length !== 2 ||
    !value ||
    !/^[0-9a-f]{64}$/.test(value) ||
    value === target
  ) {
    throw invalid("identity archive request has invalid replaced-by tag");
  }
  return value;
}

function optionalTextTag(
  event: NostrEvent,
  name: string,
  maximumBytes: number,
): string | undefined {
  const tags = event.tags.filter((tag) => tag[0] === name);
  if (tags.length === 0) return undefined;
  const value = tags[0]?.[1];
  if (
    tags.length !== 1 ||
    tags[0]?.length !== 2 ||
    value === undefined ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw invalid(`identity archive request has invalid ${name} tag`);
  }
  return value;
}

function singleAuthTag(event: NostrEvent): readonly string[] {
  const tags = event.tags.filter((tag) => tag[0] === "auth");
  if (tags.length !== 1 || tags[0]?.length !== 4) {
    throw invalid("identity archive owner path requires exactly one auth tag");
  }
  return tags[0];
}

function invalid(message: string): RemoteProtocolError {
  return new RemoteProtocolError("CONFIG_INVALID", message);
}

function denied(message: string): RemoteProtocolError {
  return new RemoteProtocolError("CAPABILITY_DENIED", message);
}
