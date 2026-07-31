import { describe, expect, it } from "vitest";

import { DesktopEventBus } from "./event-bus.js";

describe("DesktopEventBus", () => {
  it("delivers immutable events after a monotonic cursor", () => {
    const bus = new DesktopEventBus();
    const payload = { sas: "123456" };
    bus.emit("pairing-sas-received", payload);
    payload.sas = "mutated";

    const first = bus.poll(0);
    expect(first).toEqual({
      cursor: 1,
      events: [
        {
          event: "pairing-sas-received",
          id: 1,
          payload: { sas: "123456" },
        },
      ],
    });
    expect(bus.poll(first.cursor)).toEqual({ cursor: 1, events: [] });
  });

  it("rejects invalid names, cursors, and oversized payloads", () => {
    const bus = new DesktopEventBus();
    expect(() => bus.emit("../escape", null)).toThrow(/name/);
    expect(() => bus.poll(-1)).toThrow(/cursor/);
    expect(() => bus.emit("large", "x".repeat(256 * 1024 + 1))).toThrow(
      /256 KiB/,
    );
  });

  it("retains only the bounded tail without reusing event IDs", () => {
    const bus = new DesktopEventBus();
    for (let index = 0; index < 300; index += 1) {
      bus.emit("tick", { index });
    }
    const batch = bus.poll(0);
    expect(batch.cursor).toBe(300);
    expect(batch.events).toHaveLength(256);
    expect(batch.events[0]?.id).toBe(45);
    expect(batch.events.at(-1)?.id).toBe(300);
  });
});
