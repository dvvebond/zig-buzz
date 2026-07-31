import { createClient, type RedisClientType } from "redis";
import { type FencedHeader, type Profile, type RuntimeId } from "./model.js";

const ACQUIRE = `
local current = redis.call('GET', KEYS[1])
if current then return {'exists', current, redis.call('GET', KEYS[2]) or ''} end
local generation = redis.call('INCR', KEYS[2])
local value = ARGV[1] .. '|' .. tostring(generation) .. '|' .. ARGV[2]
redis.call('SET', KEYS[1], value, 'PX', ARGV[3])
return {'acquired', value, tostring(generation)}
`;
const RENEW = `
local current = redis.call('GET', KEYS[1])
if not current then return {'missing', '', redis.call('GET', KEYS[2]) or ''} end
local owner, generation = string.match(current, '^([^|]+)|([^|]+)|[^|]+$')
if owner == ARGV[1] and generation == ARGV[2] then
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return {'renewed', current, redis.call('GET', KEYS[2]) or generation}
end
return {'lost', current, redis.call('GET', KEYS[2]) or generation or ''}
`;
const RELEASE = `
local current = redis.call('GET', KEYS[1])
if not current then return {'missing', '', redis.call('GET', KEYS[2]) or ''} end
local owner, generation = string.match(current, '^([^|]+)|([^|]+)|[^|]+$')
if owner == ARGV[1] and generation == ARGV[2] then
  redis.call('DEL', KEYS[1])
  return {'released', current, redis.call('GET', KEYS[2]) or generation}
end
return {'lost', current, redis.call('GET', KEYS[2]) or generation or ''}
`;
const VALIDATE = `
return {redis.call('GET', KEYS[1]) or '', redis.call('GET', KEYS[2]) or ''}
`;

export interface SessionLease {
  readonly communityId: string;
  readonly sessionId: string;
  readonly ownerRuntimeId: RuntimeId;
  readonly generation: string;
  readonly profile: Profile;
}

export type AcquireResult =
  | { readonly status: "acquired"; readonly lease: SessionLease }
  | { readonly status: "exists"; readonly lease: SessionLease };
export type RenewResult =
  | { readonly status: "renewed"; readonly lease: SessionLease }
  | {
      readonly status: "lost";
      readonly current?: SessionLease;
      readonly knownGeneration?: string;
    };
export type ReleaseResult =
  | { readonly status: "released"; readonly lease: SessionLease }
  | {
      readonly status: "not_owner";
      readonly current?: SessionLease;
      readonly knownGeneration?: string;
    };
export type FenceVerdict =
  | { readonly ok: true; readonly lease: SessionLease }
  | {
      readonly ok: false;
      readonly reason:
        | "stale_generation"
        | "no_active_lease"
        | "owner_mismatch"
        | "future_generation";
      readonly knownGeneration: string;
    };

/** Fenced session-directory capability used by mesh application lanes. */
export interface SessionDirectory {
  readonly leaseTtlMs: number;
  acquire(
    communityId: string,
    sessionId: string,
    ownerRuntimeId: RuntimeId,
    profile: Profile,
  ): Promise<AcquireResult>;
  takeover(
    communityId: string,
    sessionId: string,
    ownerRuntimeId: RuntimeId,
    profile: Profile,
  ): Promise<AcquireResult>;
  renew(lease: SessionLease): Promise<RenewResult>;
  release(lease: SessionLease): Promise<ReleaseResult>;
  lookup(
    communityId: string,
    sessionId: string,
  ): Promise<SessionLease | undefined>;
  knownGeneration(
    communityId: string,
    sessionId: string,
  ): Promise<string | undefined>;
  validateFence(fenced: FencedHeader): Promise<FenceVerdict>;
  close(): Promise<void>;
}

export class RedisSessionDirectory implements SessionDirectory {
  readonly #client: RedisClientType;
  readonly #ownsClient: boolean;

  public constructor(
    redis: string | RedisClientType,
    public readonly leaseTtlMs = 30_000,
  ) {
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1) {
      throw new Error("leaseTtlMs must be a positive safe integer");
    }
    this.#ownsClient = typeof redis === "string";
    this.#client =
      typeof redis === "string" ? createClient({ url: redis }) : redis;
  }

  public async acquire(
    communityId: string,
    sessionId: string,
    ownerRuntimeId: RuntimeId,
    profile: Profile,
  ): Promise<AcquireResult> {
    const keys = sessionKeys(communityId, sessionId);
    const values = await this.#eval(ACQUIRE, keys, [
      ownerRuntimeId,
      profileToRedis(profile),
      String(this.leaseTtlMs),
    ]);
    const lease = parseLease(communityId, sessionId, values[1] ?? "");
    if (values[0] === "acquired") return { status: "acquired", lease };
    if (values[0] === "exists") return { status: "exists", lease };
    throw new Error("unexpected acquire result");
  }

  public async takeover(
    communityId: string,
    sessionId: string,
    ownerRuntimeId: RuntimeId,
    profile: Profile,
  ): Promise<AcquireResult> {
    return await this.acquire(communityId, sessionId, ownerRuntimeId, profile);
  }

  public async renew(lease: SessionLease): Promise<RenewResult> {
    const values = await this.#eval(
      RENEW,
      sessionKeys(lease.communityId, lease.sessionId),
      [lease.ownerRuntimeId, lease.generation, String(this.leaseTtlMs)],
    );
    if (values[0] === "renewed") {
      return {
        status: "renewed",
        lease: parseLease(lease.communityId, lease.sessionId, values[1] ?? ""),
      };
    }
    if (values[0] === "missing" || values[0] === "lost") {
      return compactLost("lost", lease, values);
    }
    throw new Error("unexpected renew result");
  }

  public async release(lease: SessionLease): Promise<ReleaseResult> {
    const values = await this.#eval(
      RELEASE,
      sessionKeys(lease.communityId, lease.sessionId),
      [lease.ownerRuntimeId, lease.generation],
    );
    if (values[0] === "released") {
      return {
        status: "released",
        lease: parseLease(lease.communityId, lease.sessionId, values[1] ?? ""),
      };
    }
    if (values[0] === "missing" || values[0] === "lost") {
      const lost = compactLost("not_owner", lease, values);
      return lost;
    }
    throw new Error("unexpected release result");
  }

  public async lookup(
    communityId: string,
    sessionId: string,
  ): Promise<SessionLease | undefined> {
    await this.#ready();
    const raw = await this.#client.get(sessionKeys(communityId, sessionId)[0]);
    return raw ? parseLease(communityId, sessionId, raw) : undefined;
  }

  public async knownGeneration(
    communityId: string,
    sessionId: string,
  ): Promise<string | undefined> {
    await this.#ready();
    const raw = await this.#client.get(sessionKeys(communityId, sessionId)[1]);
    return raw ? parseGeneration(raw) : undefined;
  }

  public async validateFence(fenced: FencedHeader): Promise<FenceVerdict> {
    const [leaseRaw = "", generationRaw = ""] = await this.#eval(
      VALIDATE,
      sessionKeys(fenced.communityId, fenced.sessionId),
      [],
    );
    const current = leaseRaw
      ? parseLease(fenced.communityId, fenced.sessionId, leaseRaw)
      : undefined;
    const counter = generationRaw ? parseGeneration(generationRaw) : "0";
    const known = maxGeneration(current?.generation ?? "0", counter);
    if (BigInt(fenced.generation) < BigInt(known)) {
      return { ok: false, reason: "stale_generation", knownGeneration: known };
    }
    if (!current) {
      return { ok: false, reason: "no_active_lease", knownGeneration: known };
    }
    if (fenced.generation !== current.generation) {
      return {
        ok: false,
        reason: "future_generation",
        knownGeneration: current.generation,
      };
    }
    if (fenced.ownerRuntimeId !== current.ownerRuntimeId) {
      return {
        ok: false,
        reason: "owner_mismatch",
        knownGeneration: current.generation,
      };
    }
    return { ok: true, lease: current };
  }

  public async close(): Promise<void> {
    if (this.#ownsClient && this.#client.isOpen) await this.#client.quit();
  }

  async #ready(): Promise<void> {
    if (!this.#client.isOpen) await this.#client.connect();
  }

  async #eval(
    script: string,
    keys: readonly [string, string],
    args: readonly string[],
  ): Promise<string[]> {
    await this.#ready();
    const raw = await this.#client.eval(script, {
      keys: [...keys],
      arguments: [...args],
    });
    if (
      !Array.isArray(raw) ||
      !raw.every((value) => typeof value === "string")
    ) {
      throw new Error("malformed Redis session directory result");
    }
    return raw;
  }
}

/** Linearizable in-process directory for deterministic mesh integration tests. */
export class InMemorySessionDirectory implements SessionDirectory {
  readonly #leases = new Map<
    string,
    { readonly expiresAt: number; readonly lease: SessionLease }
  >();
  readonly #generations = new Map<string, bigint>();

  public constructor(public readonly leaseTtlMs = 30_000) {
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1) {
      throw new Error("leaseTtlMs must be a positive safe integer");
    }
  }

  public async acquire(
    communityId: string,
    sessionId: string,
    ownerRuntimeId: RuntimeId,
    profile: Profile,
  ): Promise<AcquireResult> {
    const key = memoryKey(communityId, sessionId);
    const current = this.live(key);
    if (current) return { lease: current, status: "exists" };
    const generation = (this.#generations.get(key) ?? 0n) + 1n;
    this.#generations.set(key, generation);
    const lease: SessionLease = {
      communityId,
      generation: String(generation),
      ownerRuntimeId,
      profile,
      sessionId,
    };
    this.#leases.set(key, {
      expiresAt: Date.now() + this.leaseTtlMs,
      lease,
    });
    return { lease, status: "acquired" };
  }

  public async takeover(
    communityId: string,
    sessionId: string,
    ownerRuntimeId: RuntimeId,
    profile: Profile,
  ): Promise<AcquireResult> {
    return await this.acquire(communityId, sessionId, ownerRuntimeId, profile);
  }

  public async renew(lease: SessionLease): Promise<RenewResult> {
    const key = memoryKey(lease.communityId, lease.sessionId);
    const current = this.live(key);
    if (
      !current ||
      current.ownerRuntimeId !== lease.ownerRuntimeId ||
      current.generation !== lease.generation
    ) {
      return {
        ...(current ? { current } : {}),
        ...(this.#generations.has(key)
          ? { knownGeneration: String(this.#generations.get(key)) }
          : {}),
        status: "lost",
      };
    }
    this.#leases.set(key, {
      expiresAt: Date.now() + this.leaseTtlMs,
      lease: current,
    });
    return { lease: current, status: "renewed" };
  }

  public async release(lease: SessionLease): Promise<ReleaseResult> {
    const key = memoryKey(lease.communityId, lease.sessionId);
    const current = this.live(key);
    if (
      !current ||
      current.ownerRuntimeId !== lease.ownerRuntimeId ||
      current.generation !== lease.generation
    ) {
      return {
        ...(current ? { current } : {}),
        ...(this.#generations.has(key)
          ? { knownGeneration: String(this.#generations.get(key)) }
          : {}),
        status: "not_owner",
      };
    }
    this.#leases.delete(key);
    return { lease: current, status: "released" };
  }

  public async lookup(
    communityId: string,
    sessionId: string,
  ): Promise<SessionLease | undefined> {
    return this.live(memoryKey(communityId, sessionId));
  }

  public async knownGeneration(
    communityId: string,
    sessionId: string,
  ): Promise<string | undefined> {
    const generation = this.#generations.get(memoryKey(communityId, sessionId));
    return generation === undefined ? undefined : String(generation);
  }

  public async validateFence(fenced: FencedHeader): Promise<FenceVerdict> {
    const key = memoryKey(fenced.communityId, fenced.sessionId);
    const current = this.live(key);
    const known = this.#generations.get(key) ?? 0n;
    if (BigInt(fenced.generation) < known) {
      return {
        knownGeneration: String(known),
        ok: false,
        reason: "stale_generation",
      };
    }
    if (!current) {
      return {
        knownGeneration: String(known),
        ok: false,
        reason: "no_active_lease",
      };
    }
    if (fenced.generation !== current.generation) {
      return {
        knownGeneration: current.generation,
        ok: false,
        reason: "future_generation",
      };
    }
    if (fenced.ownerRuntimeId !== current.ownerRuntimeId) {
      return {
        knownGeneration: current.generation,
        ok: false,
        reason: "owner_mismatch",
      };
    }
    return { lease: current, ok: true };
  }

  public async close(): Promise<void> {
    this.#leases.clear();
    this.#generations.clear();
  }

  private live(key: string): SessionLease | undefined {
    const current = this.#leases.get(key);
    if (!current) return undefined;
    if (current.expiresAt <= Date.now()) {
      this.#leases.delete(key);
      return undefined;
    }
    return current.lease;
  }
}

export function fencedHeader(lease: SessionLease): FencedHeader {
  return {
    communityId: lease.communityId,
    sessionId: lease.sessionId,
    generation: lease.generation,
    ownerRuntimeId: lease.ownerRuntimeId,
  };
}

function sessionKeys(
  communityId: string,
  sessionId: string,
): readonly [string, string] {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      communityId,
    )
  ) {
    throw new Error("invalid community id");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      sessionId,
    )
  ) {
    throw new Error("invalid session id");
  }
  const base = `buzz:${communityId}:tunnel:${sessionId.toLowerCase()}`;
  return [`${base}:lease`, `${base}:generation`];
}

function memoryKey(communityId: string, sessionId: string): string {
  sessionKeys(communityId, sessionId);
  return `${communityId.toLowerCase()}:${sessionId.toLowerCase()}`;
}

function parseLease(
  communityId: string,
  sessionId: string,
  value: string,
): SessionLease {
  const parts = value.split("|");
  if (parts.length !== 3) throw new Error("malformed session lease");
  const [owner, generation, rawProfile] = parts;
  if (!owner || !/^[0-9a-f]{64}$/.test(owner)) {
    throw new Error("malformed session lease owner");
  }
  const profile = profileFromRedis(rawProfile ?? "");
  return {
    communityId,
    sessionId,
    ownerRuntimeId: owner as RuntimeId,
    generation: parseGeneration(generation ?? ""),
    profile,
  };
}

function parseGeneration(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value))
    throw new Error("malformed session generation");
  return value;
}

function maxGeneration(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}

function profileToRedis(profile: Profile): string {
  return profile.replaceAll("_", "-");
}

function profileFromRedis(value: string): Profile {
  if (value === "reliable-stream") return "reliable_stream";
  if (value === "realtime-media") return "realtime_media";
  if (value === "huddle-control") return "huddle_control";
  throw new Error("malformed session lease profile");
}

function compactLost<T extends "lost" | "not_owner">(
  status: T,
  lease: SessionLease,
  values: readonly string[],
): T extends "lost" ? RenewResult : ReleaseResult {
  const current = values[1]
    ? parseLease(lease.communityId, lease.sessionId, values[1])
    : undefined;
  const knownGeneration = values[2] ? parseGeneration(values[2]) : undefined;
  return {
    status,
    ...(current ? { current } : {}),
    ...(knownGeneration ? { knownGeneration } : {}),
  } as T extends "lost" ? RenewResult : ReleaseResult;
}
