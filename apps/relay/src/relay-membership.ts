import type { Pool, PoolClient } from "pg";
import {
  KIND_NIP43_LEAVE_REQUEST,
  KIND_NIP43_MEMBER_ADDED,
  KIND_NIP43_MEMBER_REMOVED,
  KIND_NIP43_MEMBERSHIP_LIST,
  RELAY_ADMIN_ADD_MEMBER,
  RELAY_ADMIN_CHANGE_ROLE,
  RELAY_ADMIN_REMOVE_MEMBER,
  RELAY_ADMIN_SET_WORKSPACE_PROFILE,
  signNostrEvent,
  type NostrEvent,
} from "@buzz/core";
import type { EventStore } from "@buzz/db";
import { RemoteProtocolError } from "@buzz/remote-agent-protocol";

type PublishEvent = (event: NostrEvent) => Promise<void>;

export class RelayMembershipCommands {
  #serial = Promise.resolve();

  public constructor(
    private readonly options: {
      readonly community: string;
      readonly eventStore: EventStore;
      readonly pool: Pool;
      readonly publishEvent: PublishEvent;
      readonly relaySecretKey: Uint8Array;
    },
  ) {}

  public handles(kind: number): boolean {
    return (
      kind === RELAY_ADMIN_ADD_MEMBER ||
      kind === RELAY_ADMIN_REMOVE_MEMBER ||
      kind === RELAY_ADMIN_CHANGE_ROLE ||
      kind === RELAY_ADMIN_SET_WORKSPACE_PROFILE ||
      kind === KIND_NIP43_LEAVE_REQUEST
    );
  }

  public async execute(event: NostrEvent): Promise<string> {
    const operation = this.#serial.then(() => this.#execute(event));
    this.#serial = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #execute(event: NostrEvent): Promise<string> {
    if (Math.abs(Math.floor(Date.now() / 1_000) - event.created_at) > 120) {
      invalid(
        "relay membership command timestamp is outside the 120 second window",
      );
    }
    if (
      event.kind === KIND_NIP43_LEAVE_REQUEST &&
      !event.tags.some((tag) => tag.length === 1 && tag[0] === "-")
    ) {
      invalid('leave request must include the exact NIP-70 tag ["-"]');
    }

    const client = await this.options.pool.connect();
    let outcome: MembershipOutcome;
    let snapshot: NostrEvent | undefined;
    try {
      await client.query("BEGIN");
      const communityId = await communityIdForUpdate(
        client,
        this.options.community,
      );
      await ensureNotBanned(client, communityId, event.pubkey);
      outcome = await mutateMembership(client, communityId, event);
      if (outcome.membershipChanged) {
        snapshot = await buildMembershipSnapshot(
          client,
          communityId,
          this.options.relaySecretKey,
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw protocolError(error);
    } finally {
      client.release();
    }

    if (outcome.deltaKind !== undefined && outcome.targetPubkey) {
      await this.#publishDelta(outcome.deltaKind, outcome.targetPubkey);
    }
    if (snapshot) await this.#publishSnapshot(snapshot);
    return outcome.message;
  }

  async #publishDelta(kind: number, targetPubkey: string): Promise<void> {
    const event = signNostrEvent(
      {
        content: "",
        created_at: Math.floor(Date.now() / 1_000),
        kind,
        tags: [["-"], ["p", targetPubkey]],
      },
      this.options.relaySecretKey,
    );
    const result = await this.options.eventStore.store(
      this.options.community,
      event,
    );
    if (result.status === "inserted") await this.options.publishEvent(event);
  }

  async #publishSnapshot(event: NostrEvent): Promise<void> {
    const stored = await this.options.eventStore.store(
      this.options.community,
      event,
    );
    if (stored.status === "inserted") {
      await this.options.publishEvent(event);
    }
  }
}

async function buildMembershipSnapshot(
  client: PoolClient,
  communityId: string,
  relaySecretKey: Uint8Array,
): Promise<NostrEvent> {
  // The community row is already locked by communityIdForUpdate(). Persisting
  // this logical clock in Postgres makes snapshot ordering monotonic across
  // every relay pod, not merely within one Node process. If publication is
  // reordered after COMMIT, NIP-33 replacement ordering still selects the
  // snapshot representing the later committed mutation.
  const clock = await client.query<{ readonly created_at: string }>(
    `UPDATE communities
     SET relay_membership_snapshot_at = GREATEST(
       relay_membership_snapshot_at + 1,
       floor(extract(epoch FROM clock_timestamp()))::bigint
     )
     WHERE id = $1
     RETURNING relay_membership_snapshot_at::text AS created_at`,
    [communityId],
  );
  const createdAt = Number(clock.rows[0]?.created_at);
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error("failed to allocate relay membership snapshot timestamp");
  }
  const members = await client.query<{
    readonly pubkey: string;
    readonly role: string;
  }>(
    `SELECT pubkey, role
     FROM relay_members
     WHERE community_id = $1
     ORDER BY created_at, pubkey`,
    [communityId],
  );
  return signNostrEvent(
    {
      content: "",
      created_at: createdAt,
      kind: KIND_NIP43_MEMBERSHIP_LIST,
      tags: [
        ["-"],
        ...members.rows.map((row) => ["member", row.pubkey, row.role]),
      ],
    },
    relaySecretKey,
  );
}

type MembershipOutcome = {
  readonly deltaKind?: number;
  readonly membershipChanged: boolean;
  readonly message: string;
  readonly targetPubkey?: string;
};

async function mutateMembership(
  client: PoolClient,
  communityId: string,
  event: NostrEvent,
): Promise<MembershipOutcome> {
  const actor = await client.query<{ readonly role: string }>(
    `SELECT role
     FROM relay_members
     WHERE community_id = $1 AND pubkey = $2
     FOR UPDATE`,
    [communityId, event.pubkey],
  );
  const actorRole = actor.rows[0]?.role;

  if (event.kind === KIND_NIP43_LEAVE_REQUEST) {
    if (!actorRole) invalid("you are not a relay member");
    if (actorRole === "owner") invalid("the relay owner cannot leave");
    const removed = await client.query(
      `DELETE FROM relay_members
       WHERE community_id = $1 AND pubkey = $2 AND role <> 'owner'`,
      [communityId, event.pubkey],
    );
    if (removed.rowCount !== 1)
      invalid("relay membership changed concurrently");
    return {
      deltaKind: KIND_NIP43_MEMBER_REMOVED,
      membershipChanged: true,
      message: "info: you have left this relay",
      targetPubkey: event.pubkey,
    };
  }
  if (actorRole !== "owner" && actorRole !== "admin") {
    restricted("relay admin or owner role is required");
  }

  if (event.kind === RELAY_ADMIN_SET_WORKSPACE_PROFILE) {
    const icon = optionalSingleTag(event, "icon") ?? "";
    validateWorkspaceIcon(icon);
    await client.query(
      `UPDATE communities SET icon = NULLIF($2, '') WHERE id = $1`,
      [communityId, icon],
    );
    return { membershipChanged: false, message: "" };
  }

  const target = requiredHexTag(event, "p");
  if (event.kind === RELAY_ADMIN_ADD_MEMBER) {
    const role = optionalSingleTag(event, "role") ?? "member";
    if (role !== "member" && role !== "admin") {
      invalid("new relay member role must be member or admin");
    }
    if (role === "admin" && actorRole !== "owner") {
      restricted("only the relay owner may grant the admin role");
    }
    const inserted = await client.query(
      `INSERT INTO relay_members (community_id, pubkey, role, added_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (community_id, pubkey) DO NOTHING`,
      [communityId, target, role, event.pubkey],
    );
    return inserted.rowCount === 1
      ? {
          deltaKind: KIND_NIP43_MEMBER_ADDED,
          membershipChanged: true,
          message: "",
          targetPubkey: target,
        }
      : {
          membershipChanged: false,
          message: "duplicate: member already exists",
        };
  }

  if (target === event.pubkey) {
    invalid("relay administrators cannot remove or demote themselves");
  }
  if (event.kind === RELAY_ADMIN_REMOVE_MEMBER) {
    const removed = await client.query<{ readonly role: string }>(
      `DELETE FROM relay_members
       WHERE community_id = $1
         AND pubkey = $2
         AND role = ANY($3::text[])
       RETURNING role`,
      [
        communityId,
        target,
        actorRole === "owner" ? ["member", "admin"] : ["member"],
      ],
    );
    if (removed.rowCount !== 1) {
      const current = await client.query<{ readonly role: string }>(
        `SELECT role FROM relay_members
         WHERE community_id = $1 AND pubkey = $2`,
        [communityId, target],
      );
      if (!current.rows[0]) invalid("relay member not found");
      if (current.rows[0].role === "owner")
        invalid("the relay owner cannot be removed");
      restricted("relay admins may remove only ordinary members");
    }
    return {
      deltaKind: KIND_NIP43_MEMBER_REMOVED,
      membershipChanged: true,
      message: "",
      targetPubkey: target,
    };
  }

  if (event.kind !== RELAY_ADMIN_CHANGE_ROLE) {
    invalid("unsupported relay membership command");
  }
  if (actorRole !== "owner") {
    restricted("only the relay owner may change member roles");
  }
  const role = requiredSingleTag(event, "role");
  if (role !== "member" && role !== "admin") {
    invalid("relay member role must be member or admin");
  }
  const updated = await client.query(
    `UPDATE relay_members
     SET role = $3, updated_at = now()
     WHERE community_id = $1
       AND pubkey = $2
       AND role <> 'owner'`,
    [communityId, target, role],
  );
  if (updated.rowCount !== 1)
    invalid("relay member not found or protected owner");
  return { membershipChanged: true, message: "", targetPubkey: target };
}

async function communityIdForUpdate(
  client: PoolClient,
  host: string,
): Promise<string> {
  const result = await client.query<{ readonly id: string }>(
    `SELECT id
     FROM communities
     WHERE lower(host) = lower($1) AND archived_at IS NULL
     FOR SHARE`,
    [host],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("community is unavailable");
  return id;
}

async function ensureNotBanned(
  client: PoolClient,
  communityId: string,
  pubkey: string,
): Promise<void> {
  const result = await client.query(
    `SELECT 1
     FROM community_bans
     WHERE community_id = $1
       AND pubkey = decode($2, 'hex')
       AND banned = true
       AND (ban_expires_at IS NULL OR ban_expires_at > now())
     LIMIT 1`,
    [communityId, pubkey],
  );
  if (result.rowCount === 1) restricted("you are banned from this community");
}

export function validateWorkspaceIcon(icon: string): void {
  if (icon.length === 0) return;
  if ([...icon].some((character) => /\s|\p{Cc}/u.test(character))) {
    invalid("workspace icon contains whitespace or control characters");
  }
  if (icon.startsWith("data:image/")) {
    if (Buffer.byteLength(icon, "utf8") > 98_304) {
      invalid("workspace icon data URL exceeds 98304 bytes");
    }
    return;
  }
  let protocol: string | undefined;
  try {
    protocol = new URL(icon).protocol;
  } catch {
    // Rejected below.
  }
  if (protocol !== "http:" && protocol !== "https:") {
    invalid("workspace icon must be an http(s) or data:image URL");
  }
  if (Buffer.byteLength(icon, "utf8") > 2_048) {
    invalid("workspace icon URL exceeds 2048 bytes");
  }
}

function requiredHexTag(event: NostrEvent, name: string): string {
  const value = requiredSingleTag(event, name).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(value)) invalid(`${name} tag must be a pubkey`);
  return value;
}

function requiredSingleTag(event: NostrEvent, name: string): string {
  const value = optionalSingleTag(event, name);
  if (value === undefined) invalid(`exactly one ${name} tag is required`);
  return value;
}

function optionalSingleTag(
  event: NostrEvent,
  name: string,
): string | undefined {
  const tags = event.tags.filter((tag) => tag[0] === name);
  if (tags.length === 0) return undefined;
  if (tags.length !== 1 || tags[0]?.length !== 2) {
    invalid(`at most one exact ${name} tag is allowed`);
  }
  return tags[0]?.[1];
}

function protocolError(error: unknown): RemoteProtocolError {
  if (error instanceof RemoteProtocolError) return error;
  return new RemoteProtocolError(
    "CONFIG_INVALID",
    error instanceof Error ? error.message : "relay membership command failed",
  );
}

function invalid(message: string): never {
  throw new RemoteProtocolError("CONFIG_INVALID", message);
}

function restricted(message: string): never {
  throw new RemoteProtocolError("CAPABILITY_DENIED", message);
}
