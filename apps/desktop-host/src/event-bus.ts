const MAX_EVENTS = 256;
const MAX_EVENT_BYTES = 256 * 1024;
const EVENT_NAME = /^[A-Za-z0-9_:/-]{1,128}$/;

export type DesktopEvent = {
  readonly event: string;
  readonly id: number;
  readonly payload: unknown;
};

export type DesktopEventBatch = {
  readonly cursor: number;
  readonly events: readonly DesktopEvent[];
};

/**
 * A bounded, process-local bridge for native-style host events.
 *
 * The browser polls with a monotonically increasing cursor. Payloads are
 * cloned through JSON at emission time so later mutation cannot change an
 * already-authorized event and non-serializable values never reach the IPC
 * boundary.
 */
export class DesktopEventBus {
  readonly #events: DesktopEvent[] = [];
  #cursor = 0;

  emit(event: string, payload: unknown = null): number {
    if (!EVENT_NAME.test(event)) {
      throw new Error("desktop event name has an invalid format");
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(payload ?? null);
    } catch {
      throw new Error("desktop event payload must be JSON serializable");
    }
    if (
      encoded === undefined ||
      Buffer.byteLength(encoded, "utf8") > MAX_EVENT_BYTES
    ) {
      throw new Error("desktop event payload exceeds the 256 KiB limit");
    }
    const id = ++this.#cursor;
    this.#events.push({
      event,
      id,
      payload: JSON.parse(encoded) as unknown,
    });
    if (this.#events.length > MAX_EVENTS) {
      this.#events.splice(0, this.#events.length - MAX_EVENTS);
    }
    return id;
  }

  poll(afterId: unknown): DesktopEventBatch {
    const cursor = parseCursor(afterId);
    return {
      cursor: this.#cursor,
      events: this.#events
        .filter((entry) => entry.id > cursor)
        .map((entry) => structuredClone(entry)),
    };
  }
}

function parseCursor(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("desktop event cursor must be a non-negative integer");
  }
  return value;
}
