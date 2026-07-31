import { generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import {
  KIND_AUTH,
  signNostrEvent,
  unixNow,
  verifyNostrEvent,
} from "@buzz/core";

import {
  AuthenticatedRelayClient,
  validateRelayUrl,
  type RelaySocket,
} from "./relay-client.js";

class FakeSocket implements RelaySocket {
  public readonly sent: unknown[][] = [];
  public readyState = 1;
  readonly #listeners = new Map<string, Array<(value?: unknown) => void>>();

  public addEventListener(type: "open", listener: () => void): void;
  public addEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  public addEventListener(
    type: "close",
    listener: (event?: {
      readonly code?: number;
      readonly reason?: string;
    }) => void,
  ): void;
  public addEventListener(type: "error", listener: () => void): void;
  public addEventListener(
    type: "open" | "message" | "close" | "error",
    listener:
      | (() => void)
      | ((event: { readonly data: unknown }) => void)
      | ((event?: {
          readonly code?: number;
          readonly reason?: string;
        }) => void),
  ): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener as unknown as (value?: unknown) => void);
    this.#listeners.set(type, listeners);
  }

  public send(data: string): void {
    this.sent.push(JSON.parse(data) as unknown[]);
  }

  public close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  public emit(type: string, value?: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(value);
  }
}

describe("authenticated relay client", () => {
  it("binds NIP-42 auth, receives events, and resolves acknowledgements", async () => {
    const socket = new FakeSocket();
    const secretKey = generateSecretKey();
    const authTag = ["auth", "1".repeat(64), "", "2".repeat(128)] as const;
    const client = new AuthenticatedRelayClient({
      allowInsecureLocalhost: true,
      authTag,
      relayUrl: "ws://localhost:3000/",
      secretKey,
      socketFactory: () => socket,
    });
    const connected = client.connect();
    socket.emit("open");
    await Promise.resolve();
    socket.emit("message", { data: JSON.stringify(["AUTH", "c".repeat(64)]) });
    const authMessage = socket.sent.at(-1);
    expect(authMessage?.[0]).toBe("AUTH");
    expect(verifyNostrEvent(authMessage?.[1])).toBe(true);
    if (!verifyNostrEvent(authMessage?.[1])) throw new Error("auth failed");
    expect(authMessage[1].kind).toBe(KIND_AUTH);
    expect(authMessage[1].tags).toContainEqual([
      "relay",
      "ws://localhost:3000/",
    ]);
    expect(authMessage[1].tags).toContainEqual(authTag);
    socket.emit("message", {
      data: JSON.stringify(["OK", authMessage[1].id, true, ""]),
    });
    await connected;

    const received: string[] = [];
    client.on((event) => {
      if (event.type === "event") received.push(event.event.id);
    });
    client.subscribe([{ kinds: [1] }], "notes");
    const note = signNostrEvent(
      {
        content: "hello",
        created_at: unixNow(),
        kind: 1,
        tags: [],
      },
      secretKey,
    );
    socket.emit("message", {
      data: JSON.stringify(["EVENT", "notes", note]),
    });
    expect(received).toEqual([note.id]);

    const published = client.publish(note);
    socket.emit("message", {
      data: JSON.stringify(["OK", note.id, true, "stored"]),
    });
    await expect(published).resolves.toBe("stored");
    client.close();
  });

  it("rejects insecure remote endpoints and pending work on disconnect", async () => {
    expect(() => validateRelayUrl("ws://example.com/", true)).toThrow(
      "must use wss",
    );
    const socket = new FakeSocket();
    const client = new AuthenticatedRelayClient({
      allowInsecureLocalhost: true,
      relayUrl: "ws://127.0.0.1:3000/",
      secretKey: generateSecretKey(),
      socketFactory: () => socket,
    });
    const connected = client.connect();
    socket.emit("open");
    await Promise.resolve();
    socket.emit("message", { data: JSON.stringify(["AUTH", "a".repeat(64)]) });
    const authEvent = socket.sent.at(-1)?.[1] as { readonly id: string };
    socket.emit("message", {
      data: JSON.stringify(["OK", authEvent.id, true, ""]),
    });
    await connected;
    const note = signNostrEvent(
      {
        content: "pending",
        created_at: unixNow(),
        kind: 1,
        tags: [],
      },
      generateSecretKey(),
    );
    const pending = client.publish(note);
    socket.emit("close");
    await expect(pending).rejects.toThrow("disconnected");
  });

  it("surfaces relay CLOSED frames without waiting for request timeouts", async () => {
    const socket = new FakeSocket();
    const client = new AuthenticatedRelayClient({
      allowInsecureLocalhost: true,
      relayUrl: "ws://127.0.0.1:3000/",
      secretKey: generateSecretKey(),
      socketFactory: () => socket,
    });
    const connected = client.connect();
    socket.emit("open");
    await Promise.resolve();
    socket.emit("message", { data: JSON.stringify(["AUTH", "a".repeat(64)]) });
    const authEvent = socket.sent.at(-1)?.[1] as { readonly id: string };
    socket.emit("message", {
      data: JSON.stringify(["OK", authEvent.id, true, ""]),
    });
    await connected;

    const closed: string[] = [];
    client.on((event) => {
      if (event.type === "closed") closed.push(event.message);
    });
    client.subscribe([{ kinds: [1] }], "blocked-query");
    socket.emit("message", {
      data: JSON.stringify([
        "CLOSED",
        "blocked-query",
        "rate-limited: shared admission unavailable",
      ]),
    });
    expect(closed).toEqual(["rate-limited: shared admission unavailable"]);

    const count = client.count({ kinds: [1] });
    const countId = socket.sent.at(-1)?.[1];
    socket.emit("message", {
      data: JSON.stringify(["CLOSED", countId, "rate-limited: quota exceeded"]),
    });
    await expect(count).rejects.toThrow("rate-limited: quota exceeded");
    client.close();
  });
});
