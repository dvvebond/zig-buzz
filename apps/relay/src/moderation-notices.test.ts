import { randomUUID } from "node:crypto";

import { MemoryEventStore } from "@buzz/db";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  moderationNoticeBody,
  RelayModerationNotices,
} from "./moderation-notices.js";

describe("relay moderation notices", () => {
  it("creates one private relay-authored notice per moderation source", async () => {
    const communityId = randomUUID();
    const channelId = randomUUID();
    const relaySecretKey = generateSecretKey();
    const recipientPubkey = getPublicKey(generateSecretKey());
    const reportId = randomUUID();
    const eventStore = new MemoryEventStore();
    const published: Array<{
      readonly content: string;
      readonly kind: number;
      readonly tags: readonly string[][];
    }> = [];
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM communities")) {
        return rows([{ id: communityId }]);
      }
      if (sql.includes("FROM channels")) {
        return rows([{ id: channelId }]);
      }
      if (sql.includes("clock_timestamp()")) {
        return rows([{ now: new Date("2026-07-28T00:00:00.000Z") }]);
      }
      return rows([]);
    });
    const client = {
      query,
      release: vi.fn(),
    } as unknown as PoolClient;
    const service = new RelayModerationNotices({
      community: "relay.example",
      eventStore,
      pool: {
        connect: vi.fn(async () => client),
      } as unknown as Pool,
      publishEvent: async (event) => {
        published.push(event);
      },
      relaySecretKey,
    });
    const delivery = {
      notice: {
        kind: "report-resolved" as const,
        reportId,
        status: "resolved" as const,
        summary: "The reported content was removed.",
      },
      recipientPubkey,
    };

    await service.deliver(delivery);
    await service.deliver(delivery);

    expect(published.map(({ kind }) => kind)).toEqual([0, 39_000, 39_002, 9]);
    const notice = published.at(-1);
    expect(notice?.content).toContain("reviewed and acted on");
    expect(notice?.content).not.toContain("reporter");
    expect(notice?.tags).toContainEqual(["h", channelId]);
    expect(notice?.tags).toContainEqual(["moderation_source", reportId]);
    expect(client.release).toHaveBeenCalledTimes(2);
  });

  it("renders only sanitized recipient-facing fields", () => {
    const actionId = randomUUID();
    expect(
      moderationNoticeBody(
        {
          actionId,
          kind: "restriction",
          publicReason: "Repeated spam.",
          restriction: "ban",
        },
        "relay.example",
      ),
    ).toBe(
      "You have been banned from relay.example.\n\nReason: Repeated spam.",
    );
    expect(
      moderationNoticeBody(
        {
          kind: "report-resolved",
          reportId: randomUUID(),
          status: "dismissed",
          summary: "No rule violation was found.",
        },
        "relay.example",
      ),
    ).toContain("no action was taken");
  });
});

function rows(values: readonly Record<string, unknown>[]): {
  readonly rowCount: number;
  readonly rows: readonly Record<string, unknown>[];
} {
  return { rowCount: values.length, rows: values };
}
