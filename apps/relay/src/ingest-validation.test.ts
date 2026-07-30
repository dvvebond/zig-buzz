import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import {
  KIND_GIFT_WRAP,
  KIND_NIP43_LEAVE_REQUEST,
  KIND_PRESENCE_UPDATE,
  KIND_STREAM_MESSAGE,
  signNostrEvent,
  unixNow,
} from "@buzz/core";

import {
  MAX_EVENT_CONTENT_BYTES,
  validateClientEventIngest,
} from "./ingest-validation.js";

describe("client event ingest validation", () => {
  it("rejects unknown durable kinds and malformed channel coordinates", () => {
    const secret = generateSecretKey();
    const principalPubkey = getPublicKey(secret);
    const event = (kind: number, tags: string[][] = []) =>
      signNostrEvent(
        {
          content: "",
          created_at: unixNow(),
          kind,
          tags,
        },
        secret,
      );

    expect(() =>
      validateClientEventIngest(event(65_000), {
        now: unixNow(),
        principalPubkey,
        transport: "websocket",
      }),
    ).toThrow(/restricted or unknown/);
    expect(() =>
      validateClientEventIngest(event(KIND_STREAM_MESSAGE), {
        now: unixNow(),
        principalPubkey,
        transport: "websocket",
      }),
    ).toThrow(/exactly one valid h tag/);
  });

  it("bounds persistent timestamps and UTF-8 content bytes", () => {
    const secret = generateSecretKey();
    const principalPubkey = getPublicKey(secret);
    const now = unixNow();
    const stale = signNostrEvent(
      {
        content: "",
        created_at: now - 901,
        kind: 1,
        tags: [],
      },
      secret,
    );
    const oversized = signNostrEvent(
      {
        content: `é${"a".repeat(MAX_EVENT_CONTENT_BYTES - 1)}`,
        created_at: now,
        kind: 1,
        tags: [],
      },
      secret,
    );

    expect(() =>
      validateClientEventIngest(stale, {
        now,
        principalPubkey,
        transport: "websocket",
      }),
    ).toThrow(/too far from server time/);
    expect(() =>
      validateClientEventIngest(oversized, {
        now,
        principalPubkey,
        transport: "http",
      }),
    ).toThrow(/exceeds 262144 bytes/);
  });

  it("keeps generic NIP-16 events WebSocket-only while retaining HTTP leave requests", () => {
    const secret = generateSecretKey();
    const principalPubkey = getPublicKey(secret);
    const event = (kind: number) =>
      signNostrEvent(
        {
          content: "online",
          created_at: unixNow(),
          kind,
          tags: [],
        },
        secret,
      );

    expect(() =>
      validateClientEventIngest(event(KIND_PRESENCE_UPDATE), {
        now: unixNow(),
        principalPubkey,
        transport: "websocket",
      }),
    ).not.toThrow();
    expect(() =>
      validateClientEventIngest(event(KIND_PRESENCE_UPDATE), {
        now: unixNow(),
        principalPubkey,
        transport: "http",
      }),
    ).toThrow(/only accepted via WebSocket/);
    expect(() =>
      validateClientEventIngest(event(KIND_NIP43_LEAVE_REQUEST), {
        now: unixNow(),
        principalPubkey,
        transport: "http",
      }),
    ).not.toThrow();
  });

  it("allows a WebSocket gift wrap's unlinkable envelope signer only", () => {
    const principal = getPublicKey(generateSecretKey());
    const event = signNostrEvent(
      {
        content: "opaque",
        created_at: unixNow(),
        kind: KIND_GIFT_WRAP,
        tags: [["p", getPublicKey(generateSecretKey())]],
      },
      generateSecretKey(),
    );

    expect(() =>
      validateClientEventIngest(event, {
        now: unixNow(),
        principalPubkey: principal,
        transport: "websocket",
      }),
    ).not.toThrow();
    expect(() =>
      validateClientEventIngest(event, {
        now: unixNow(),
        principalPubkey: principal,
        transport: "http",
      }),
    ).toThrow(/only accepted via WebSocket/);
  });
});
