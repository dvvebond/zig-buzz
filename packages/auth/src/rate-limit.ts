export type TokenBucketOptions = {
  readonly capacity: number;
  readonly refillPerSecond: number;
  readonly maximumKeys?: number;
  readonly idleLifetimeMilliseconds?: number;
};

type Bucket = {
  tokens: number;
  updatedAt: number;
  lastUsedAt: number;
};

export class TokenBucketRateLimiter {
  readonly #capacity: number;
  readonly #refillPerMillisecond: number;
  readonly #maximumKeys: number;
  readonly #idleLifetimeMilliseconds: number;
  readonly #buckets = new Map<string, Bucket>();

  public constructor(options: TokenBucketOptions) {
    if (
      !Number.isFinite(options.capacity) ||
      options.capacity <= 0 ||
      !Number.isFinite(options.refillPerSecond) ||
      options.refillPerSecond <= 0
    ) {
      throw new RangeError("rate-limit capacity and refill must be positive");
    }
    this.#capacity = options.capacity;
    this.#refillPerMillisecond = options.refillPerSecond / 1_000;
    this.#maximumKeys = options.maximumKeys ?? 100_000;
    this.#idleLifetimeMilliseconds =
      options.idleLifetimeMilliseconds ?? 15 * 60_000;
    if (
      !Number.isSafeInteger(this.#maximumKeys) ||
      this.#maximumKeys < 1 ||
      !Number.isSafeInteger(this.#idleLifetimeMilliseconds) ||
      this.#idleLifetimeMilliseconds < 1_000
    ) {
      throw new RangeError("rate-limit bounds are invalid");
    }
  }

  public consume(key: string, cost = 1, now = Date.now()): boolean {
    if (
      key.length < 1 ||
      key.length > 512 ||
      !Number.isFinite(cost) ||
      cost <= 0 ||
      !Number.isFinite(now)
    ) {
      return false;
    }
    this.#prune(now);
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      if (this.#buckets.size >= this.#maximumKeys) return false;
      bucket = {
        lastUsedAt: now,
        tokens: this.#capacity,
        updatedAt: now,
      };
      this.#buckets.set(key, bucket);
    }
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(
      this.#capacity,
      bucket.tokens + elapsed * this.#refillPerMillisecond,
    );
    bucket.updatedAt = now;
    bucket.lastUsedAt = now;
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  public keyCount(): number {
    return this.#buckets.size;
  }

  #prune(now: number): void {
    if (this.#buckets.size < this.#maximumKeys / 2) return;
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.lastUsedAt >= this.#idleLifetimeMilliseconds) {
        this.#buckets.delete(key);
      }
    }
  }
}
