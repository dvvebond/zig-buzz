import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KIND_PRODUCT_FEEDBACK, signNostrEvent } from "@buzz/core";
import { blobKey, FileMediaStorage, putSidecar } from "@buzz/media";
import { generateSecretKey } from "nostr-tools/pure";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProductFeedbackService,
  validateProductFeedback,
} from "./product-feedback.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { force: true, recursive: true })),
  );
});

describe("product feedback", () => {
  it("validates body/category limits and preserves signed tags", () => {
    const valid = feedback("This is useful.", [["category", "bug"]]);
    expect(validateProductFeedback(valid)).toEqual({
      body: "This is useful.",
      category: "bug",
      tags: [["category", "bug"]],
    });
    expect(() => validateProductFeedback(feedback(" \n"))).toThrow(/nonempty/);
    expect(() =>
      validateProductFeedback(
        feedback("body", [
          ["category", "bug"],
          ["category", "praise"],
        ]),
      ),
    ).toThrow(/at most one/);
    expect(() =>
      validateProductFeedback(feedback("body", [["category", "idea"]])),
    ).toThrow(/unsupported/);
  });

  it("checks tenant-local imeta against the sidecar and blob before insert", async () => {
    const root = await mkdtemp(join(tmpdir(), "buzz-feedback-"));
    temporaryDirectories.push(root);
    const storage = new FileMediaStorage(root);
    const communityId = randomUUID();
    const hash = "ab".repeat(32);
    const bytes = Buffer.from("image");
    await storage.put(blobKey(hash, "png"), bytes, "image/png");
    await putSidecar(storage, communityId, hash, {
      blurhash: "",
      dim: "1x1",
      ext: "png",
      mimeType: "image/png",
      size: bytes.byteLength,
      thumbUrl: "",
      uploadedAt: 1,
    });
    const queries: { readonly sql: string; readonly values: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, values: unknown[]) => {
        queries.push({ sql, values });
        return { rowCount: 1, rows: [] };
      },
    } as unknown as Pool;
    const service = new ProductFeedbackService({
      communityHost: "tenant.example",
      communityId,
      mediaStorage: storage,
      pool,
      publicUrl: new URL("wss://tenant.example/"),
    });
    const event = feedback("Screenshot attached.", [
      [
        "imeta",
        `url https://tenant.example/media/${hash}.png`,
        "m image/png",
        `x ${hash}`,
        `size ${bytes.byteLength}`,
      ],
    ]);
    await service.accept(event);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.sql).toContain("ON CONFLICT (event_id) DO NOTHING");
    expect(queries[0]?.values.slice(0, 3)).toEqual([
      communityId,
      event.id,
      event.pubkey,
    ]);

    await expect(
      service.accept({
        ...event,
        tags: [
          [
            "imeta",
            `url https://other.example/media/${hash}.png`,
            "m image/png",
            `x ${hash}`,
            `size ${bytes.byteLength}`,
          ],
        ],
      }),
    ).rejects.toThrow(/local to the tenant/);
    expect(queries).toHaveLength(1);
  });
});

function feedback(content: string, tags: string[][] = []) {
  return signNostrEvent(
    {
      content,
      created_at: 1_700_000_000,
      kind: KIND_PRODUCT_FEEDBACK,
      tags,
    },
    generateSecretKey(),
  );
}
