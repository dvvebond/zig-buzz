import type { ExpiredChannelOutcome } from "@buzz/db";

export type ExpiredChannelReaper = (
  limit: number,
) => Promise<readonly ExpiredChannelOutcome[]>;

/**
 * Periodically archives expired TTL channels through a row-locking database
 * claim, then performs live publication and access revocation post-commit.
 */
export class ChannelReaper {
  readonly #batchLimit: number;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #tick: Promise<number> | undefined;

  public constructor(
    private readonly reap: ExpiredChannelReaper,
    private readonly onArchived: (
      outcome: ExpiredChannelOutcome,
    ) => Promise<void>,
    options: {
      readonly batchLimit?: number;
      readonly intervalMs?: number;
    } = {},
  ) {
    this.#batchLimit = boundedInteger(
      options.batchLimit ?? 100,
      1,
      1_000,
      "channel reaper batch limit",
    );
    this.#intervalMs = boundedInteger(
      options.intervalMs ?? 60_000,
      100,
      3_600_000,
      "channel reaper interval",
    );
  }

  public start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.#intervalMs);
    this.#timer.unref();
  }

  public stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  public async tick(): Promise<number> {
    if (this.#tick) return this.#tick;
    this.#tick = this.#runTick().finally(() => {
      this.#tick = undefined;
    });
    return this.#tick;
  }

  async #runTick(): Promise<number> {
    const expired = await this.reap(this.#batchLimit);
    for (const outcome of expired) await this.onArchived(outcome);
    return expired.length;
  }
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
