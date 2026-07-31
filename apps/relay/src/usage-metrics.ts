import { randomInt } from "node:crypto";

import {
  foldBucketListing,
  type BucketSnapshot,
  type MediaStorage,
} from "@buzz/media";
import type { Pool, PoolClient, QueryResultRow } from "pg";

const USAGE_METRICS_LOCK_KEY = 0x4255_5a5a_4d45_5452n.toString();
const CHANNEL_TYPES = ["stream", "forum", "dm", "workflow"] as const;
const RELAY_ROLES = ["owner", "admin", "member"] as const;
const WORKFLOW_STATUSES = ["active", "disabled", "archived"] as const;
const USER_TYPES = ["human", "agent", "unknown"] as const;

export type UsageMetricsOptions = {
  readonly intervalMs: number;
  readonly perCommunity: boolean;
  readonly storage: {
    readonly enabled: boolean;
    readonly intervalMs: number;
    readonly maxObjects: number;
    readonly timeoutMs: number;
  };
};

type MetricSample = {
  readonly labels?: Readonly<Record<string, string>>;
  readonly name: string;
  readonly value: number;
};

type CommunityHostRow = QueryResultRow & {
  readonly host: string;
  readonly id: string;
};

type CountByCommunityRow = QueryResultRow & {
  readonly community_id: string;
  readonly count: string;
};

type TypedCountRow = CountByCommunityRow & {
  readonly type: string;
};

type UserCountRow = QueryResultRow & {
  readonly agent: string;
  readonly community_id: string;
  readonly human: string;
};

type ActiveUserRow = UserCountRow & {
  readonly unknown: string;
};

type StorageAttempt = {
  readonly durationSeconds: number;
  readonly result: BucketSnapshot | Error;
};

/**
 * Deployment-wide usage poller. A PostgreSQL session advisory lock elects
 * exactly one collector across pods; every relay backend may safely expose
 * the collector's atomic last-good Prometheus snapshot.
 */
export class UsageMetricsCollector {
  readonly #pool: Pool;
  readonly #storage: MediaStorage | undefined;
  readonly #options: UsageMetricsOptions;
  readonly #storageState = new StorageSweepState();
  #leader: PoolClient | undefined;
  #samples: readonly MetricSample[] = [];
  #timer: NodeJS.Timeout | undefined;
  #jitterTimer: NodeJS.Timeout | undefined;
  #tickPromise: Promise<void> | undefined;
  #started = false;
  #stopping = false;

  public constructor(
    pool: Pool,
    storage: MediaStorage | undefined,
    options: UsageMetricsOptions,
  ) {
    validateOptions(options);
    this.#pool = pool;
    this.#storage = storage;
    this.#options = options;
  }

  public start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopping = false;
    const jitter = randomInt(
      Math.min(Math.max(1, this.#options.intervalMs), 281_474_976_710_655),
    );
    this.#jitterTimer = setTimeout(() => {
      this.#jitterTimer = undefined;
      void this.tick();
      this.#timer = setInterval(
        () => void this.tick(),
        this.#options.intervalMs,
      );
      this.#timer.unref();
    }, jitter);
    this.#jitterTimer.unref();
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    if (this.#jitterTimer) clearTimeout(this.#jitterTimer);
    if (this.#timer) clearInterval(this.#timer);
    this.#jitterTimer = undefined;
    this.#timer = undefined;
    await this.#tickPromise?.catch(() => undefined);
    this.#releaseLeader();
  }

  /** Run or join one coalesced collection tick. Exposed for deterministic tests. */
  public tick(): Promise<void> {
    if (this.#tickPromise) return this.#tickPromise;
    this.#tickPromise = this.#runTick().finally(() => {
      this.#tickPromise = undefined;
    });
    return this.#tickPromise;
  }

  public render(): string {
    const leader: MetricSample = {
      name: "buzz_usage_poller_is_leader",
      value: this.#leader ? 1 : 0,
    };
    return renderSamples([leader, ...this.#samples]);
  }

  async #runTick(): Promise<void> {
    if (this.#stopping) return;
    try {
      if (this.#leader) {
        await this.#leader.query("SELECT 1");
      } else {
        const candidate = await this.#pool.connect();
        try {
          const result = await candidate.query<{ readonly acquired: boolean }>(
            "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
            [USAGE_METRICS_LOCK_KEY],
          );
          if (result.rows[0]?.acquired) this.#leader = candidate;
          else candidate.release();
        } catch (error) {
          candidate.release(error instanceof Error ? error : undefined);
          throw error;
        }
      }
      if (!this.#leader || this.#stopping) return;
      const { hosts, samples } = await collectDatabaseMetrics(
        this.#leader,
        this.#options.perCommunity,
      );
      await reapExpiredInvites(this.#leader);
      const storageSamples =
        this.#storage && this.#options.storage.enabled
          ? this.#storageState.tick(
              this.#storage,
              hosts,
              this.#options.perCommunity,
              this.#options.storage,
            )
          : [];
      this.#samples = [...samples, ...storageSamples];
    } catch {
      this.#releaseLeader();
    }
  }

  #releaseLeader(): void {
    if (!this.#leader) return;
    // Destroy rather than pool a session that held a session-scoped advisory
    // lock. Closing the PostgreSQL session is the unambiguous unlock path.
    this.#leader.release(true);
    this.#leader = undefined;
  }
}

class StorageSweepState {
  #cached:
    | { readonly completedAt: number; readonly snapshot: BucketSnapshot }
    | undefined;
  #completed: StorageAttempt | undefined;
  #failures = 0;
  #inFlight: Promise<void> | undefined;
  #lastAttempt:
    | { readonly durationSeconds: number; readonly ok: boolean }
    | undefined;

  public tick(
    storage: MediaStorage,
    hosts: ReadonlyMap<string, string>,
    perCommunity: boolean,
    options: UsageMetricsOptions["storage"],
  ): readonly MetricSample[] {
    this.#harvest();
    const now = Date.now();
    if (
      !this.#inFlight &&
      (!this.#lastAttempt ||
        !this.#lastAttempt.ok ||
        !this.#cached ||
        now - this.#cached.completedAt >= options.intervalMs)
    ) {
      this.#spawn(storage, options);
    }
    return this.#samples(hosts, perCommunity, now);
  }

  #spawn(storage: MediaStorage, options: UsageMetricsOptions["storage"]): void {
    const startedAt = performance.now();
    const abort = new AbortController();
    const timeout = setTimeout(
      () => abort.abort(new Error("storage sweep timed out")),
      options.timeoutMs,
    );
    timeout.unref();
    this.#inFlight = foldBucketListing(
      options.maxObjects,
      async (continuationToken) => {
        const page = await storage.list("", continuationToken, abort.signal);
        return {
          ...(page.continuationToken
            ? { continuationToken: page.continuationToken }
            : {}),
          isTruncated: page.continuationToken !== undefined,
          objects: page.objects,
        };
      },
    )
      .then((snapshot) => {
        this.#completed = {
          durationSeconds: (performance.now() - startedAt) / 1_000,
          result: snapshot,
        };
      })
      .catch((error: unknown) => {
        this.#completed = {
          durationSeconds: (performance.now() - startedAt) / 1_000,
          result:
            error instanceof Error ? error : new Error("storage sweep failed"),
        };
      })
      .finally(() => {
        clearTimeout(timeout);
        this.#inFlight = undefined;
      });
  }

  #harvest(): void {
    const attempt = this.#completed;
    if (!attempt) return;
    this.#completed = undefined;
    if (attempt.result instanceof Error) {
      this.#failures += 1;
      this.#lastAttempt = {
        durationSeconds: attempt.durationSeconds,
        ok: false,
      };
      return;
    }
    this.#cached = {
      completedAt: Date.now(),
      snapshot: attempt.result,
    };
    this.#lastAttempt = {
      durationSeconds: attempt.durationSeconds,
      ok: true,
    };
  }

  #samples(
    hosts: ReadonlyMap<string, string>,
    perCommunity: boolean,
    now: number,
  ): readonly MetricSample[] {
    const samples: MetricSample[] = [
      {
        name: "buzz_storage_sweep_ok",
        value: this.#lastAttempt?.ok ? 1 : 0,
      },
      { name: "buzz_storage_sweep_failures", value: this.#failures },
    ];
    if (this.#lastAttempt) {
      samples.push({
        name: "buzz_storage_sweep_duration_seconds",
        value: this.#lastAttempt.durationSeconds,
      });
    }
    if (!this.#cached) return samples;
    const { snapshot } = this.#cached;
    samples.push(
      {
        name: "buzz_storage_sweep_age_seconds",
        value: Math.max(0, (now - this.#cached.completedAt) / 1_000),
      },
      metric("buzz_total_storage_bytes", snapshot.physicalBytes, {
        kind: "physical",
      }),
      metric("buzz_total_storage_objects", snapshot.physicalObjects, {
        kind: "physical",
      }),
      metric("buzz_total_storage_bytes", snapshot.logicalBytes, {
        kind: "logical",
      }),
      metric("buzz_total_storage_objects", snapshot.logicalObjects, {
        kind: "logical",
      }),
      metric("buzz_storage_orphan_blob_bytes", snapshot.orphanBlobBytes),
      metric("buzz_storage_orphan_blobs", snapshot.orphanBlobCount),
      metric("buzz_storage_orphan_sidecars", snapshot.orphanSidecarCount),
      metric("buzz_storage_multi_variant_shas", snapshot.multiVariantShas),
      metric("buzz_storage_multi_variant_bytes", snapshot.multiVariantBytes),
      metric("buzz_storage_unknown_key_bytes", snapshot.unknownKeyBytes),
      metric("buzz_storage_unknown_key_objects", snapshot.unknownKeyObjects),
    );
    let unmappedBytes = 0;
    for (const [communityId, storage] of Object.entries(
      snapshot.perCommunity,
    )) {
      const host = hosts.get(communityId);
      if (!host) {
        unmappedBytes += storage.bytes;
      } else if (perCommunity) {
        samples.push(
          metric("buzz_community_storage_bytes", storage.bytes, {
            community: host,
          }),
          metric("buzz_community_storage_objects", storage.objects, {
            community: host,
          }),
        );
      }
    }
    samples.push(
      metric("buzz_storage_unmapped_community_bytes", unmappedBytes),
    );
    return samples;
  }
}

async function collectDatabaseMetrics(
  client: PoolClient,
  perCommunity: boolean,
): Promise<{
  readonly hosts: ReadonlyMap<string, string>;
  readonly samples: readonly MetricSample[];
}> {
  // Collect every row before publishing a replacement snapshot. A failed
  // query therefore leaves the entire previous snapshot intact.
  const hostRows = (
    await client.query<CommunityHostRow>(
      "SELECT id::text AS id, host FROM communities ORDER BY id",
    )
  ).rows;
  const communityTotal = safeCount(
    (
      await client.query<{ readonly count: string }>(
        "SELECT COUNT(*)::text AS count FROM communities",
      )
    ).rows[0]?.count,
  );
  const users = (
    await client.query<UserCountRow>(
      `SELECT community_id::text,
              COUNT(*) FILTER (
                WHERE agent_owner_pubkey IS NULL
              )::text AS human,
              COUNT(*) FILTER (
                WHERE agent_owner_pubkey IS NOT NULL
              )::text AS agent
       FROM users
       WHERE deactivated_at IS NULL
       GROUP BY community_id`,
    )
  ).rows;
  const channels = await typedCounts(
    client,
    `SELECT community_id::text,
            channel_type::text AS type,
            COUNT(*)::text AS count
     FROM channels
     WHERE deleted_at IS NULL
     GROUP BY community_id, channel_type`,
  );
  const messages = await communityCounts(
    client,
    `SELECT community_id::text, COUNT(*)::text AS count
     FROM events
     WHERE kind = 9 AND deleted_at IS NULL
     GROUP BY community_id`,
  );
  const relayMembers = await typedCounts(
    client,
    `SELECT community_id::text,
            role::text AS type,
            COUNT(*)::text AS count
     FROM relay_members
     GROUP BY community_id, role`,
  );
  const workflows = await typedCounts(
    client,
    `SELECT community_id::text,
            status::text AS type,
            COUNT(*)::text AS count
     FROM workflows
     GROUP BY community_id, status`,
  );
  const gitRepositories = await communityCounts(
    client,
    `SELECT community_id::text, COUNT(*)::text AS count
     FROM git_repo_names
     GROUP BY community_id`,
  );
  const activeUsers = new Map<string, readonly ActiveUserRow[]>();
  for (const [window, interval] of [
    ["1d", "1 day"],
    ["7d", "7 days"],
    ["30d", "30 days"],
  ] as const) {
    activeUsers.set(
      window,
      (
        await client.query<ActiveUserRow>(
          `SELECT e.community_id::text,
                  COUNT(DISTINCT e.pubkey) FILTER (
                    WHERE u.pubkey IS NOT NULL
                      AND u.agent_owner_pubkey IS NULL
                  )::text AS human,
                  COUNT(DISTINCT e.pubkey) FILTER (
                    WHERE u.pubkey IS NOT NULL
                      AND u.agent_owner_pubkey IS NOT NULL
                  )::text AS agent,
                  COUNT(DISTINCT e.pubkey) FILTER (
                    WHERE u.pubkey IS NULL
                  )::text AS unknown
           FROM events e
           LEFT JOIN users u
             ON u.community_id = e.community_id
            AND u.pubkey = e.pubkey
           WHERE e.created_at >= NOW() - $1::interval
             AND e.deleted_at IS NULL
           GROUP BY e.community_id`,
          [interval],
        )
      ).rows,
    );
  }
  const activeChannels = new Map<string, ReadonlyMap<string, number>>();
  for (const [window, interval] of [
    ["1d", "1 day"],
    ["7d", "7 days"],
  ] as const) {
    activeChannels.set(
      window,
      await communityCounts(
        client,
        `SELECT community_id::text,
                COUNT(DISTINCT channel_id)::text AS count
         FROM events
         WHERE kind = 9
           AND channel_id IS NOT NULL
           AND created_at >= NOW() - $1::interval
           AND deleted_at IS NULL
         GROUP BY community_id`,
        [interval],
      ),
    );
  }

  const hosts = new Map(hostRows.map((row) => [row.id, row.host]));
  const samples: MetricSample[] = [
    metric("buzz_communities_total", communityTotal),
  ];
  const userMap = new Map(
    users.map((row) => [
      row.community_id,
      { agent: safeCount(row.agent), human: safeCount(row.human) },
    ]),
  );
  const totalUsers = sumValues(userMap.values(), (value) => value.human);
  const totalAgents = sumValues(userMap.values(), (value) => value.agent);
  samples.push(
    metric("buzz_total_users", totalUsers, { type: "human" }),
    metric("buzz_total_users", totalAgents, { type: "agent" }),
  );
  if (perCommunity) {
    for (const [id, host] of hosts) {
      const row = userMap.get(id) ?? { agent: 0, human: 0 };
      samples.push(
        metric("buzz_community_users", row.human, {
          community: host,
          type: "human",
        }),
        metric("buzz_community_users", row.agent, {
          community: host,
          type: "agent",
        }),
      );
    }
  }
  addTypedMetrics(
    samples,
    hosts,
    channels,
    CHANNEL_TYPES,
    "buzz_total_channels",
    "buzz_community_channels",
    "type",
    perCommunity,
  );
  addCountMetrics(
    samples,
    hosts,
    messages,
    "buzz_total_messages",
    "buzz_community_messages",
    perCommunity,
  );
  addTypedMetrics(
    samples,
    hosts,
    relayMembers,
    RELAY_ROLES,
    "buzz_total_relay_members",
    "buzz_community_relay_members",
    "role",
    perCommunity,
  );
  addTypedMetrics(
    samples,
    hosts,
    workflows,
    WORKFLOW_STATUSES,
    "buzz_total_workflows",
    "buzz_community_workflows",
    "status",
    perCommunity,
  );
  addCountMetrics(
    samples,
    hosts,
    gitRepositories,
    "buzz_total_git_repos",
    "buzz_community_git_repos",
    perCommunity,
  );
  for (const [window, rows] of activeUsers) {
    const mapped = new Map(
      rows.map((row) => [
        row.community_id,
        {
          agent: safeCount(row.agent),
          human: safeCount(row.human),
          unknown: safeCount(row.unknown),
        },
      ]),
    );
    for (const type of USER_TYPES) {
      samples.push(
        metric(
          "buzz_total_active_users",
          sumValues(mapped.values(), (row) => row[type]),
          { type, window },
        ),
      );
    }
    if (perCommunity) {
      for (const [id, host] of hosts) {
        const row = mapped.get(id) ?? { agent: 0, human: 0, unknown: 0 };
        for (const type of USER_TYPES) {
          samples.push(
            metric("buzz_community_active_users", row[type], {
              community: host,
              type,
              window,
            }),
          );
        }
      }
    }
  }
  for (const [window, rows] of activeChannels) {
    samples.push(
      metric(
        "buzz_total_active_channels",
        sumValues(rows.values(), (value) => value),
        { window },
      ),
    );
    if (perCommunity) {
      for (const [id, host] of hosts) {
        samples.push(
          metric("buzz_community_active_channels", rows.get(id) ?? 0, {
            community: host,
            window,
          }),
        );
      }
    }
  }
  return { hosts, samples };
}

async function typedCounts(
  client: PoolClient,
  sql: string,
): Promise<ReadonlyMap<string, ReadonlyMap<string, number>>> {
  const result = await client.query<TypedCountRow>(sql);
  const output = new Map<string, Map<string, number>>();
  for (const row of result.rows) {
    const current = output.get(row.community_id) ?? new Map<string, number>();
    current.set(row.type, safeCount(row.count));
    output.set(row.community_id, current);
  }
  return output;
}

async function communityCounts(
  client: PoolClient,
  sql: string,
  values: readonly unknown[] = [],
): Promise<ReadonlyMap<string, number>> {
  const result = await client.query<CountByCommunityRow>(sql, [...values]);
  return new Map(
    result.rows.map((row) => [row.community_id, safeCount(row.count)]),
  );
}

function addTypedMetrics(
  samples: MetricSample[],
  hosts: ReadonlyMap<string, string>,
  rows: ReadonlyMap<string, ReadonlyMap<string, number>>,
  types: readonly string[],
  totalName: string,
  communityName: string,
  labelName: string,
  perCommunity: boolean,
): void {
  for (const type of types) {
    samples.push(
      metric(
        totalName,
        sumValues(hosts.keys(), (id) => rows.get(id)?.get(type) ?? 0),
        { [labelName]: type },
      ),
    );
  }
  if (!perCommunity) return;
  for (const [id, host] of hosts) {
    for (const type of types) {
      samples.push(
        metric(communityName, rows.get(id)?.get(type) ?? 0, {
          community: host,
          [labelName]: type,
        }),
      );
    }
  }
}

function addCountMetrics(
  samples: MetricSample[],
  hosts: ReadonlyMap<string, string>,
  rows: ReadonlyMap<string, number>,
  totalName: string,
  communityName: string,
  perCommunity: boolean,
): void {
  samples.push(
    metric(
      totalName,
      sumValues(rows.values(), (value) => value),
    ),
  );
  if (!perCommunity) return;
  for (const [id, host] of hosts) {
    samples.push(metric(communityName, rows.get(id) ?? 0, { community: host }));
  }
}

async function reapExpiredInvites(client: PoolClient): Promise<void> {
  await client.query(
    `DELETE FROM relay_invites
     WHERE (community_id, id) IN (
       SELECT community_id, id
       FROM relay_invites
       WHERE expires_at < NOW() - INTERVAL '30 days'
       ORDER BY expires_at
       LIMIT 1000
     )`,
  );
}

function metric(
  name: string,
  value: number,
  labels?: Readonly<Record<string, string>>,
): MetricSample {
  assertMetricValue(value);
  return { ...(labels ? { labels } : {}), name, value };
}

function safeCount(value: string | undefined): number {
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    throw new Error("database returned an invalid usage count");
  }
  const parsed = Number(value);
  assertMetricValue(parsed);
  return parsed;
}

function assertMetricValue(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("usage metric exceeds the JavaScript safe integer range");
  }
}

function sumValues<T>(
  values: Iterable<T>,
  select: (value: T) => number,
): number {
  let total = 0;
  for (const value of values) {
    total += select(value);
    assertMetricValue(total);
  }
  return total;
}

function renderSamples(samples: readonly MetricSample[]): string {
  return (
    samples
      .map((sample) => {
        const labels = sample.labels
          ? `{${Object.entries(sample.labels)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(
                ([name, value]) => `${name}="${escapePrometheusLabel(value)}"`,
              )
              .join(",")}}`
          : "";
        return `${sample.name}${labels} ${sample.value}`;
      })
      .sort()
      .join("\n") + "\n"
  );
}

function escapePrometheusLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

function validateOptions(options: UsageMetricsOptions): void {
  for (const [name, value, minimum] of [
    ["usage interval", options.intervalMs, 5_000],
    ["storage interval", options.storage.intervalMs, 60_000],
    ["storage timeout", options.storage.timeoutMs, 1],
    ["storage object cap", options.storage.maxObjects, 1],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new RangeError(`${name} must be at least ${minimum}`);
    }
  }
}
