import { createHash, randomUUID } from "node:crypto";

import {
  P_GATED_KINDS,
  eventMatchesFilter,
  KIND_GIFT_WRAP,
  KIND_HTTP_AUTH,
  signNostrEvent,
  unixNow,
  type NostrEvent,
} from "@buzz/core";
import type { Pool } from "pg";

import {
  PUSH_CLASSES,
  PUSH_KINDS,
  URGENT_PUSH_KINDS,
  PushLeaseService,
  type PushClass,
  type PushLeaseAcceptOutcome,
  type PushSubscription,
} from "./push-lease.js";

const MATCH_BATCH_LIMIT = 64;
const CLAIM_SECONDS = 30;
const EVENT_USEFUL_SECONDS = 3_600;
const MAX_ATTEMPTS = 8;

type MatchLease = {
  readonly appProfile: string;
  readonly author: string;
  readonly endpointGrant: string;
  readonly endpointHash: string;
  readonly expiresAt: number;
  readonly generation: number;
  readonly installationId: string;
  readonly subscriptions: readonly PushSubscription[];
};

type LoadedEvent = {
  readonly channelId?: string;
  readonly event: NostrEvent;
  readonly attempt: number;
};

type WakeRequest = {
  readonly author: string;
  readonly class: PushClass;
  readonly eventId: string;
  readonly expiresAt: number;
  readonly generation: number;
  readonly installationId: string;
};

type ClaimedWake = {
  readonly attempt: number;
  readonly author: string;
  readonly channelId?: string;
  readonly claimId: string;
  readonly endpointGrant: string;
  readonly eventId: string;
  readonly expiresAt: number;
  readonly generation: number;
  readonly id: string;
  readonly installationId: string;
};

/** Complete configuration for one tenant-scoped NIP-PL runtime. */
export type RelayPushOptions = {
  /** Server-resolved tenant UUID. */
  readonly communityId: string;
  /** Exact host used in the encrypted origin binding. */
  readonly communityHost: string;
  /** Exact HTTPS push-gateway delivery endpoint. */
  readonly deliveryUrl: URL;
  /** NIP-44 executor key id advertised in NIP-11. */
  readonly executorKeyId: string;
  /** Request timeout for the stateless delivery gateway. */
  readonly gatewayTimeoutMs: number;
  /** Durable relay database. */
  readonly pool: Pool;
  /** Tenant relay signing/decryption secret. */
  readonly relaySecretKey: Uint8Array;
  /** Public tenant relay URL. */
  readonly publicUrl: URL;
};

/** Tenant-scoped durable NIP-PL lease, matcher, and delivery runtime. */
export class RelayPushRuntime {
  readonly #leaseService: PushLeaseService;
  readonly #abort = new AbortController();
  #tasks: Promise<void>[] = [];
  #started = false;

  public constructor(private readonly options: RelayPushOptions) {
    validateDeliveryUrl(options.deliveryUrl);
    if (
      !Number.isSafeInteger(options.gatewayTimeoutMs) ||
      options.gatewayTimeoutMs < 100 ||
      options.gatewayTimeoutMs > 10_000
    ) {
      throw new Error("push gateway timeout must be between 100 and 10000ms");
    }
    this.#leaseService = new PushLeaseService({
      communityHost: options.communityHost,
      communityId: options.communityId,
      executorKeyId: options.executorKeyId,
      pool: options.pool,
      publicUrl: options.publicUrl,
      pushConfigured: true,
      relaySecretKey: options.relaySecretKey,
    });
  }

  /** NIP-11 executor descriptor bound to this exact tenant and relay key. */
  public get descriptor(): Record<string, unknown> {
    return {
      app_profiles: [
        { id: "buzz-ios-production", transport: "apns" },
        { id: "buzz-ios-sandbox", transport: "apns" },
      ],
      class_support: { apns: [...PUSH_CLASSES] },
      h_grammar: "uuid-v4-lowercase",
      keys: [
        {
          current: true,
          id: this.options.executorKeyId,
          pubkey: publicKey(this.options.relaySecretKey),
        },
      ],
      limitation: {
        max_authors: 20,
        max_content_len: 65_536,
        max_endpoint_len: 4_096,
        max_h: 50,
        max_ignore: 8,
        max_kinds: 16,
        max_lease_ttl: 2_592_000,
        max_leases_per_pubkey: 16,
        max_plaintext_len: 32_768,
        max_string_len: 512,
        max_subscriptions_per_lease: 16,
        max_tag_values: 20,
      },
      origin: `${this.options.publicUrl.protocol}//${this.options.communityHost}`,
      push_kinds: [...PUSH_KINDS],
      urgent_kinds: [...URGENT_PUSH_KINDS],
    };
  }

  /** Atomically accept one already-authorized signed lease event. */
  public async acceptLease(event: NostrEvent): Promise<PushLeaseAcceptOutcome> {
    return await this.#leaseService.accept(event);
  }

  /** Start one matcher and one delivery loop for this tenant. */
  public start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#tasks = [this.matcherLoop(), this.deliveryLoop()];
  }

  /** Stop background claims and wait for both loops to settle. */
  public async close(): Promise<void> {
    if (!this.#started) return;
    this.#abort.abort();
    await Promise.allSettled(this.#tasks);
    this.#tasks = [];
    this.#started = false;
  }

  /** Claim and process at most one durable matcher batch. */
  public async runMatcherOnce(): Promise<number> {
    await this.options.pool.query(
      `DELETE FROM push_match_queue
       WHERE community_id = $1::uuid
         AND attempts >= $2
         AND (
           state = 'pending' OR
           (state = 'matching' AND lease_until < now())
         )`,
      [this.options.communityId, MAX_ATTEMPTS],
    );
    const claimId = randomUUID();
    const claimed = await this.options.pool.query<{
      readonly attempts: number;
      readonly event_id: Buffer;
    }>(
      `WITH candidates AS (
         SELECT event_id
         FROM push_match_queue
         WHERE community_id = $1::uuid
           AND attempts < $4
           AND next_attempt_at <= now()
           AND (
             state = 'pending' OR
             (state = 'matching' AND lease_until < now())
           )
         ORDER BY next_attempt_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE push_match_queue q
       SET state = 'matching',
           claim_id = $3::uuid,
           lease_until = now() + make_interval(secs => $5),
           attempts = q.attempts + 1
       FROM candidates c
       WHERE q.community_id = $1::uuid AND q.event_id = c.event_id
       RETURNING q.event_id, q.attempts`,
      [
        this.options.communityId,
        MATCH_BATCH_LIMIT,
        claimId,
        MAX_ATTEMPTS,
        CLAIM_SECONDS,
      ],
    );
    if (claimed.rows.length === 0) return 0;
    const attempts = new Map(
      claimed.rows.map((row) => [
        row.event_id.toString("hex"),
        Number(row.attempts),
      ]),
    );
    let events: LoadedEvent[];
    try {
      events = await this.loadEvents(attempts);
    } catch {
      return claimed.rows.length;
    }
    const loadedIds = new Set(events.map((item) => item.event.id));
    const missing = [...attempts.keys()].filter((id) => !loadedIds.has(id));
    if (missing.length > 0) {
      await this.completeMatches(claimId, missing);
    }
    if (events.length === 0) return claimed.rows.length;
    try {
      const leases = await this.loadLeases();
      const memberships = await this.loadMemberships(events, leases);
      const completed: string[] = [];
      const retry: string[] = [];
      const wakes: WakeRequest[] = [];
      for (const job of events) {
        try {
          const matched = matchPushEvent(
            job.event,
            job.channelId,
            leases,
            memberships,
            unixNow(),
          );
          wakes.push(...matched);
          completed.push(job.event.id);
        } catch {
          if (job.attempt >= MAX_ATTEMPTS) completed.push(job.event.id);
          else retry.push(job.event.id);
        }
      }
      if (wakes.length > 0) await this.enqueueWakes(wakes);
      await this.completeMatches(claimId, completed);
      await this.retryMatches(claimId, retry);
    } catch {
      await this.retryMatches(
        claimId,
        events
          .filter((job) => job.attempt < MAX_ATTEMPTS)
          .map((job) => job.event.id),
      );
      await this.completeMatches(
        claimId,
        events
          .filter((job) => job.attempt >= MAX_ATTEMPTS)
          .map((job) => job.event.id),
      );
    }
    return claimed.rows.length;
  }

  /** Claim and deliver at most one durable wake batch. */
  public async runDeliveryOnce(): Promise<number> {
    const claimId = randomUUID();
    const claimed = await this.options.pool.query<ClaimedWakeRow>(
      `WITH candidates AS (
         SELECT o.id, e.channel_id
         FROM push_wake_outbox o
         JOIN push_leases l
           ON l.community_id = o.community_id
          AND l.author = o.author
          AND l.installation_id = o.installation_id
          AND l.generation = o.lease_generation
          AND l.endpoint_hash = o.endpoint_hash
         JOIN events e
           ON e.community_id = o.community_id
          AND e.id = o.event_id
          AND e.deleted_at IS NULL
         WHERE o.community_id = $1::uuid
           AND o.expires_at > EXTRACT(EPOCH FROM now())::bigint
           AND o.next_attempt_at <= now()
           AND (
             o.state = 'pending' OR
             (o.state = 'sending' AND o.lease_until < now())
           )
           AND l.active
           AND l.endpoint_enabled
           AND l.expires_at > EXTRACT(EPOCH FROM now())::bigint
         ORDER BY o.next_attempt_at, o.created_at, o.id
         FOR UPDATE OF o SKIP LOCKED
         LIMIT 16
       )
       UPDATE push_wake_outbox o
       SET state = 'sending',
           claim_id = $2::uuid,
           lease_until = now() + make_interval(secs => $3),
           attempts = o.attempts + 1
       FROM candidates c, push_leases l
       WHERE o.community_id = $1::uuid
         AND o.id = c.id
         AND l.community_id = o.community_id
         AND l.author = o.author
         AND l.installation_id = o.installation_id
         AND l.generation = o.lease_generation
         AND l.endpoint_hash = o.endpoint_hash
       RETURNING o.id, o.claim_id, o.event_id, c.channel_id, o.author,
                 o.installation_id, o.lease_generation, l.endpoint_grant,
                 o.expires_at, o.attempts`,
      [this.options.communityId, claimId, CLAIM_SECONDS],
    );
    for (const row of claimed.rows) {
      await this.deliverOne(wakeFromRow(row));
    }
    return claimed.rows.length;
  }

  async matcherLoop(): Promise<void> {
    let idle = 250;
    while (!this.#abort.signal.aborted) {
      try {
        const found = await this.runMatcherOnce();
        idle = found > 0 ? 250 : Math.min(2_000, idle * 2);
      } catch {
        idle = 2_000;
      }
      await abortableDelay(idle, this.#abort.signal);
    }
  }

  async deliveryLoop(): Promise<void> {
    let idle = 500;
    while (!this.#abort.signal.aborted) {
      try {
        const found = await this.runDeliveryOnce();
        idle = found > 0 ? 500 : Math.min(5_000, idle * 2);
      } catch {
        idle = 2_000;
      }
      await abortableDelay(idle, this.#abort.signal);
    }
  }

  async loadEvents(
    attempts: ReadonlyMap<string, number>,
  ): Promise<LoadedEvent[]> {
    const result = await this.options.pool.query<{
      readonly channel_id: string | null;
      readonly content: string;
      readonly created_at: string | number;
      readonly id: string;
      readonly kind: number;
      readonly pubkey: string;
      readonly sig: string;
      readonly tags: unknown;
    }>(
      `SELECT encode(id, 'hex') AS id,
              encode(pubkey, 'hex') AS pubkey,
              EXTRACT(EPOCH FROM created_at)::bigint AS created_at,
              kind, tags, content, encode(sig, 'hex') AS sig, channel_id
       FROM events
       WHERE community_id = $1::uuid
         AND id = ANY($2::bytea[])
         AND deleted_at IS NULL`,
      [
        this.options.communityId,
        [...attempts.keys()].map((id) => Buffer.from(id, "hex")),
      ],
    );
    return result.rows.map((row) => {
      const event: NostrEvent = {
        content: row.content,
        created_at: Number(row.created_at),
        id: row.id,
        kind: Number(row.kind),
        pubkey: row.pubkey,
        sig: row.sig,
        tags: parseStoredTags(row.tags),
      };
      return {
        ...(row.channel_id ? { channelId: row.channel_id } : {}),
        attempt: attempts.get(event.id) ?? 1,
        event,
      };
    });
  }

  async loadLeases(): Promise<MatchLease[]> {
    const result = await this.options.pool.query<{
      readonly app_profile: string;
      readonly author: string;
      readonly endpoint_grant: string;
      readonly endpoint_hash: string;
      readonly expires_at: string | number;
      readonly generation: string | number;
      readonly installation_id: string;
      readonly subscriptions: unknown;
    }>(
      `SELECT encode(author, 'hex') AS author, installation_id, generation,
              app_profile, encode(endpoint_hash, 'hex') AS endpoint_hash,
              endpoint_grant, subscriptions, expires_at
       FROM push_leases
       WHERE community_id = $1::uuid
         AND active
         AND endpoint_enabled
         AND expires_at > EXTRACT(EPOCH FROM now())::bigint`,
      [this.options.communityId],
    );
    return result.rows.map((row) => ({
      appProfile: row.app_profile,
      author: row.author,
      endpointGrant: row.endpoint_grant,
      endpointHash: row.endpoint_hash,
      expiresAt: Number(row.expires_at),
      generation: Number(row.generation),
      installationId: row.installation_id,
      subscriptions: parseStoredSubscriptions(row.subscriptions),
    }));
  }

  async loadMemberships(
    events: readonly LoadedEvent[],
    leases: readonly MatchLease[],
  ): Promise<Set<string>> {
    const channels = [
      ...new Set(events.flatMap((event) => event.channelId ?? [])),
    ];
    const authors = [...new Set(leases.map((lease) => lease.author))];
    if (channels.length === 0 || authors.length === 0) return new Set();
    const result = await this.options.pool.query<{
      readonly channel_id: string;
      readonly pubkey: string;
    }>(
      `SELECT channel_id, encode(pubkey, 'hex') AS pubkey
       FROM channel_members
       WHERE community_id = $1::uuid
         AND channel_id = ANY($2::uuid[])
         AND pubkey = ANY($3::bytea[])
         AND removed_at IS NULL`,
      [
        this.options.communityId,
        channels,
        authors.map((author) => Buffer.from(author, "hex")),
      ],
    );
    return new Set(result.rows.map((row) => `${row.channel_id}:${row.pubkey}`));
  }

  async enqueueWakes(wakes: readonly WakeRequest[]): Promise<void> {
    if (wakes.length === 0) return;
    await this.options.pool.query(
      `WITH requested AS (
         SELECT decode(author, 'hex') AS author, installation_id, generation,
                decode(event_id, 'hex') AS event_id, class, expires_at
         FROM UNNEST(
           $2::text[], $3::text[], $4::bigint[], $5::text[], $6::text[],
           $7::bigint[]
         ) AS r(author, installation_id, generation, event_id, class, expires_at)
       )
       INSERT INTO push_wake_outbox (
         community_id, author, installation_id, lease_generation,
         endpoint_hash, event_id, class, expires_at
       )
       SELECT $1::uuid, r.author, r.installation_id, r.generation,
              l.endpoint_hash, r.event_id, r.class, r.expires_at
       FROM requested r
       JOIN push_leases l
         ON l.community_id = $1::uuid
        AND l.author = r.author
        AND l.installation_id = r.installation_id
        AND l.generation = r.generation
        AND l.active
        AND l.endpoint_enabled
        AND l.expires_at > EXTRACT(EPOCH FROM now())::bigint
       ON CONFLICT (community_id, endpoint_hash, event_id) DO NOTHING`,
      [
        this.options.communityId,
        wakes.map((wake) => wake.author),
        wakes.map((wake) => wake.installationId),
        wakes.map((wake) => wake.generation),
        wakes.map((wake) => wake.eventId),
        wakes.map((wake) => wake.class),
        wakes.map((wake) => wake.expiresAt),
      ],
    );
  }

  async completeMatches(
    claimId: string,
    eventIds: readonly string[],
  ): Promise<void> {
    if (eventIds.length === 0) return;
    await this.options.pool.query(
      `DELETE FROM push_match_queue
       WHERE community_id = $1::uuid
         AND claim_id = $2::uuid
         AND state = 'matching'
         AND event_id = ANY($3::bytea[])`,
      [
        this.options.communityId,
        claimId,
        eventIds.map((id) => Buffer.from(id, "hex")),
      ],
    );
  }

  async retryMatches(
    claimId: string,
    eventIds: readonly string[],
  ): Promise<void> {
    if (eventIds.length === 0) return;
    await this.options.pool.query(
      `UPDATE push_match_queue
       SET state = 'pending',
           claim_id = NULL,
           lease_until = NULL,
           next_attempt_at = now() + interval '2 seconds'
       WHERE community_id = $1::uuid
         AND claim_id = $2::uuid
         AND state = 'matching'
         AND event_id = ANY($3::bytea[])`,
      [
        this.options.communityId,
        claimId,
        eventIds.map((id) => Buffer.from(id, "hex")),
      ],
    );
  }

  async deliverOne(claimed: ClaimedWake): Promise<void> {
    let wake = await this.revalidateWake(claimed.id, claimed.claimId);
    if (!wake) {
      await this.failWake(claimed);
      return;
    }
    if (wake.channelId) {
      const member = await this.options.pool.query(
        `SELECT 1
         FROM channel_members
         WHERE community_id = $1::uuid
           AND channel_id = $2::uuid
           AND pubkey = decode($3, 'hex')
           AND removed_at IS NULL
         LIMIT 1`,
        [this.options.communityId, wake.channelId, wake.author],
      );
      if (member.rowCount !== 1) {
        await this.failWake(wake);
        return;
      }
    }
    wake = await this.revalidateWake(wake.id, wake.claimId);
    if (!wake) {
      await this.failWake(claimed);
      return;
    }
    const body = Buffer.from(
      JSON.stringify({
        endpoint_grant: wake.endpointGrant,
        expires_at: wake.expiresAt,
        request_id: wake.id,
        v: 1,
      }),
    );
    const authorization = nip98Header(
      this.options.relaySecretKey,
      this.options.deliveryUrl.toString(),
      body,
    );
    let response: Response;
    try {
      response = await fetch(this.options.deliveryUrl, {
        body,
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.any([
          this.#abort.signal,
          AbortSignal.timeout(this.options.gatewayTimeoutMs),
        ]),
      });
    } catch {
      await this.retryOrFail(wake, 2);
      return;
    }
    const payload = await readGatewayJson(response);
    if (response.ok && isObject(payload) && payload.status === "accepted") {
      await this.completeWake(wake);
      return;
    }
    if (
      response.status === 410 &&
      isObject(payload) &&
      payload.status === "invalid_endpoint" &&
      payload.generation === wake.generation
    ) {
      await this.options.pool.query(
        `UPDATE push_leases
         SET endpoint_enabled = false, updated_at = now()
         WHERE community_id = $1::uuid
           AND author = decode($2, 'hex')
           AND installation_id = $3
           AND generation = $4
           AND active
           AND endpoint_enabled`,
        [
          this.options.communityId,
          wake.author,
          wake.installationId,
          wake.generation,
        ],
      );
      await this.failWake(wake);
      return;
    }
    if (response.status === 503 || response.status === 429) {
      const delay =
        isObject(payload) &&
        typeof payload.retry_after_seconds === "number" &&
        Number.isSafeInteger(payload.retry_after_seconds) &&
        payload.retry_after_seconds > 0
          ? payload.retry_after_seconds
          : 2;
      await this.retryOrFail(wake, delay);
      return;
    }
    if (response.status === 404 && wake.attempt > 1) {
      await this.completeWake(wake);
      return;
    }
    await this.failWake(wake);
  }

  async revalidateWake(
    id: string,
    claimId: string,
  ): Promise<ClaimedWake | undefined> {
    const result = await this.options.pool.query<ClaimedWakeRow>(
      `SELECT o.id, o.claim_id, o.event_id, e.channel_id, o.author,
              o.installation_id, o.lease_generation, l.endpoint_grant,
              o.expires_at, o.attempts
       FROM push_wake_outbox o
       JOIN push_leases l
         ON l.community_id = o.community_id
        AND l.author = o.author
        AND l.installation_id = o.installation_id
        AND l.generation = o.lease_generation
        AND l.endpoint_hash = o.endpoint_hash
       JOIN events e
         ON e.community_id = o.community_id
        AND e.id = o.event_id
        AND e.deleted_at IS NULL
       WHERE o.community_id = $1::uuid
         AND o.id = $2::uuid
         AND o.claim_id = $3::uuid
         AND o.state = 'sending'
         AND o.lease_until >= now()
         AND o.expires_at > EXTRACT(EPOCH FROM now())::bigint
         AND l.active
         AND l.endpoint_enabled
         AND l.expires_at > EXTRACT(EPOCH FROM now())::bigint
       LIMIT 1`,
      [this.options.communityId, id, claimId],
    );
    const row = result.rows[0];
    return row ? wakeFromRow(row) : undefined;
  }

  async completeWake(wake: ClaimedWake): Promise<void> {
    await this.updateWake(wake, "delivered");
  }

  async failWake(wake: ClaimedWake): Promise<void> {
    await this.updateWake(wake, "failed");
  }

  async retryOrFail(wake: ClaimedWake, delay: number): Promise<void> {
    if (wake.attempt >= MAX_ATTEMPTS) {
      await this.failWake(wake);
      return;
    }
    const seconds = Math.min(3_600, delay * 2 ** Math.min(6, wake.attempt - 1));
    await this.options.pool.query(
      `UPDATE push_wake_outbox
       SET state = 'pending',
           next_attempt_at = now() + make_interval(secs => $4),
           claim_id = NULL,
           lease_until = NULL
       WHERE community_id = $1::uuid
         AND id = $2::uuid
         AND claim_id = $3::uuid
         AND state = 'sending'`,
      [this.options.communityId, wake.id, wake.claimId, seconds],
    );
  }

  async updateWake(
    wake: ClaimedWake,
    state: "delivered" | "failed",
  ): Promise<void> {
    await this.options.pool.query(
      `UPDATE push_wake_outbox
       SET state = $4, claim_id = NULL, lease_until = NULL
       WHERE community_id = $1::uuid
         AND id = $2::uuid
         AND claim_id = $3::uuid
         AND state = 'sending'`,
      [this.options.communityId, wake.id, wake.claimId, state],
    );
  }
}

/**
 * Pure push matching gate. It combines filter matching with recipient,
 * private-channel membership, ignore, suppression, and lease expiry checks.
 */
export function matchPushSubscriptions(input: {
  /** Lease owner whose wake timing is being considered. */
  readonly author: string;
  /** Source event already loaded from durable storage. */
  readonly event: NostrEvent;
  /** Whether the lease owner currently belongs to the event's channel. */
  readonly member: boolean;
  /** Current effective lease expiry. */
  readonly leaseExpiresAt: number;
  /** Match evaluation time in Unix seconds. */
  readonly now: number;
  /** Strict subscriptions stored with the accepted lease. */
  readonly subscriptions: readonly PushSubscription[];
}): { readonly class: PushClass; readonly expiresAt: number } | undefined {
  if (
    P_GATED_KINDS.has(input.event.kind) &&
    input.event.pubkey !== input.author &&
    !input.event.tags.some((tag) => tag[0] === "p" && tag[1] === input.author)
  ) {
    return undefined;
  }
  if (!input.member) return undefined;
  let best: PushClass | undefined;
  for (const subscription of input.subscriptions) {
    if (
      input.event.kind === KIND_GIFT_WRAP &&
      (!subscription.filter["#p"] ||
        subscription.filter["#p"].some((value) => value !== input.author))
    ) {
      continue;
    }
    if (!eventMatchesFilter(input.event, subscription.filter)) continue;
    if (
      subscription.ignore.some((filter) =>
        eventMatchesFilter(input.event, filter),
      )
    ) {
      continue;
    }
    const pCount = input.event.tags.filter((tag) => tag[0] === "p").length;
    if (subscription.suppress && pCount > subscription.suppress.p_tags_max) {
      continue;
    }
    if (!best || classRank(subscription.class) > classRank(best)) {
      best = subscription.class;
    }
  }
  if (!best) return undefined;
  const expiresAt = Math.min(
    input.leaseExpiresAt,
    input.event.created_at + EVENT_USEFUL_SECONDS,
  );
  return expiresAt > input.now ? { class: best, expiresAt } : undefined;
}

function matchPushEvent(
  event: NostrEvent,
  channelId: string | undefined,
  leases: readonly MatchLease[],
  memberships: ReadonlySet<string>,
  now: number,
): WakeRequest[] {
  const wakes: WakeRequest[] = [];
  for (const lease of leases) {
    const match = matchPushSubscriptions({
      author: lease.author,
      event,
      leaseExpiresAt: lease.expiresAt,
      member:
        channelId === undefined ||
        memberships.has(`${channelId}:${lease.author}`),
      now,
      subscriptions: lease.subscriptions,
    });
    if (!match) continue;
    wakes.push({
      author: lease.author,
      class: match.class,
      eventId: event.id,
      expiresAt: match.expiresAt,
      generation: lease.generation,
      installationId: lease.installationId,
    });
  }
  return wakes;
}

type ClaimedWakeRow = {
  readonly attempts: string | number;
  readonly author: Buffer;
  readonly channel_id: string | null;
  readonly claim_id: string;
  readonly endpoint_grant: string;
  readonly event_id: Buffer;
  readonly expires_at: string | number;
  readonly id: string;
  readonly installation_id: string;
  readonly lease_generation: string | number;
};

function wakeFromRow(row: ClaimedWakeRow): ClaimedWake {
  return {
    attempt: Number(row.attempts),
    author: row.author.toString("hex"),
    ...(row.channel_id ? { channelId: row.channel_id } : {}),
    claimId: row.claim_id,
    endpointGrant: row.endpoint_grant,
    eventId: row.event_id.toString("hex"),
    expiresAt: Number(row.expires_at),
    generation: Number(row.lease_generation),
    id: row.id,
    installationId: row.installation_id,
  };
}

function parseStoredTags(value: unknown): string[][] {
  if (
    !Array.isArray(value) ||
    value.some(
      (tag) =>
        !Array.isArray(tag) || tag.some((part) => typeof part !== "string"),
    )
  ) {
    throw new Error("stored event has malformed tags");
  }
  return value as string[][];
}

function parseStoredSubscriptions(value: unknown): PushSubscription[] {
  if (!Array.isArray(value)) {
    throw new Error("stored push lease has malformed subscriptions");
  }
  return value as PushSubscription[];
}

function classRank(value: PushClass): number {
  return PUSH_CLASSES.indexOf(value);
}

function publicKey(secretKey: Uint8Array): string {
  // signNostrEvent uses the same BIP-340 x-only key derivation; an empty
  // signed throwaway would expose it but direct noble derivation avoids work.
  return signNostrEvent(
    { content: "", created_at: 0, kind: 1, tags: [] },
    secretKey,
  ).pubkey;
}

function nip98Header(
  relaySecretKey: Uint8Array,
  url: string,
  body: Uint8Array,
): string {
  const event = signNostrEvent(
    {
      content: "",
      created_at: unixNow(),
      kind: KIND_HTTP_AUTH,
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", createHash("sha256").update(body).digest("hex")],
        ["nonce", randomUUID()],
      ],
    },
    relaySecretKey,
  );
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

async function readGatewayJson(response: Response): Promise<unknown> {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > 8 * 1024) return undefined;
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateDeliveryUrl(url: URL): void {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/v1/deliveries/apns" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "push delivery URL must be an exact HTTPS /v1/deliveries/apns URL",
    );
  }
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    timer.unref();
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
