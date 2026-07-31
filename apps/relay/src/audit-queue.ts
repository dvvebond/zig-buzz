import type { AuditService, NewAuditEntry } from "@buzz/audit";

const MAX_PENDING_ENTRIES = 1_000;

export class RelayAuditQueue {
  readonly #queue: NewAuditEntry[] = [];
  readonly #spaceWaiters: Array<() => void> = [];
  readonly #drainWaiters: Array<() => void> = [];
  #processing = false;
  #closing = false;
  #errors = 0;

  public constructor(private readonly service: Pick<AuditService, "log">) {}

  public get errorCount(): number {
    return this.#errors;
  }

  public async enqueue(entry: NewAuditEntry): Promise<void> {
    if (this.#closing) throw new Error("audit queue is closed");
    while (this.#queue.length >= MAX_PENDING_ENTRIES) {
      await new Promise<void>((resolve) => this.#spaceWaiters.push(resolve));
      if (this.#closing) throw new Error("audit queue is closed");
    }
    this.#queue.push(cloneNewEntry(entry));
    void this.#process();
  }

  public async close(timeoutMilliseconds = 5_000): Promise<void> {
    this.#closing = true;
    for (const wake of this.#spaceWaiters.splice(0)) wake();
    if (!this.#processing && this.#queue.length === 0) return;
    await Promise.race([
      new Promise<void>((resolve) => this.#drainWaiters.push(resolve)),
      new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, timeoutMilliseconds);
        timeout.unref();
      }),
    ]);
  }

  async #process(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;
    try {
      for (;;) {
        const entry = this.#queue.shift();
        if (!entry) return;
        this.#spaceWaiters.shift()?.();
        try {
          await this.service.log(entry);
        } catch {
          this.#errors += 1;
        }
      }
    } finally {
      this.#processing = false;
      if (this.#queue.length > 0) {
        void this.#process();
      } else {
        for (const resolve of this.#drainWaiters.splice(0)) resolve();
      }
    }
  }
}

function cloneNewEntry(entry: NewAuditEntry): NewAuditEntry {
  return {
    action: entry.action,
    ...(entry.actorPubkey !== undefined
      ? {
          actorPubkey: entry.actorPubkey
            ? Uint8Array.from(entry.actorPubkey)
            : null,
        }
      : {}),
    communityId: entry.communityId,
    detail: structuredClone(entry.detail),
    ...(entry.objectId !== undefined ? { objectId: entry.objectId } : {}),
  };
}
