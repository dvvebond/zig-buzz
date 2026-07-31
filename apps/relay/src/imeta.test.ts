import { generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import { signNostrEvent } from "@buzz/core";
import {
  blobKey,
  sidecarKey,
  type MediaStorage,
  type ObjectPage,
  type StoredObject,
  type StoredObjectHead,
} from "@buzz/media";

import { validateEventMedia } from "./imeta.js";

const COMMUNITY_ID = "00000000-0000-4000-8000-000000000001";
const HASH = "ab".repeat(32);

describe("imeta ingest proof", () => {
  it("accepts a tenant-local claim only when sidecar and blob agree", async () => {
    const storage = mediaStorage();
    const event = message([
      "imeta",
      `url /media/${HASH}.png`,
      "m image/png",
      `x ${HASH}`,
      "size 4",
      "filename diagram.png",
    ]);
    await expect(
      validateEventMedia(event, {
        communityId: COMMUNITY_ID,
        publicBaseUrl: "https://relay.example/media",
        storage,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects remote URLs, duplicate singleton claims, and missing blobs", async () => {
    const media = {
      communityId: COMMUNITY_ID,
      publicBaseUrl: "https://relay.example/media",
      storage: mediaStorage(),
    };
    await expect(
      validateEventMedia(
        message([
          "imeta",
          `url https://attacker.example/media/${HASH}.png`,
          "m image/png",
          `x ${HASH}`,
          "size 4",
        ]),
        media,
      ),
    ).rejects.toThrow(/local primary/);
    await expect(
      validateEventMedia(
        message([
          "imeta",
          `url /media/${HASH}.png`,
          "m image/png",
          "m image/jpeg",
          `x ${HASH}`,
          "size 4",
        ]),
        media,
      ),
    ).rejects.toThrow(/duplicate/);
    await expect(
      validateEventMedia(
        message([
          "imeta",
          `url /media/${"cd".repeat(32)}.png`,
          "m image/png",
          `x ${"cd".repeat(32)}`,
          "size 4",
        ]),
        media,
      ),
    ).rejects.toThrow(/nonexistent/);
  });
});

function message(imeta: string[]) {
  return signNostrEvent(
    {
      content: "with media",
      created_at: 100,
      kind: 9,
      tags: [["h", "00000000-0000-4000-8000-000000000002"], imeta],
    },
    generateSecretKey(),
  );
}

function mediaStorage(): MediaStorage {
  const sidecar = Buffer.from(
    JSON.stringify({
      blurhash: "",
      dim: "1x1",
      ext: "png",
      mimeType: "image/png",
      size: 4,
      thumbUrl: "",
      uploadedAt: 100,
    }),
  );
  const objects = new Map<string, Uint8Array>([
    [sidecarKey(COMMUNITY_ID, HASH), sidecar],
    [blobKey(HASH, "png"), Buffer.from("test")],
  ]);
  return {
    async delete(key: string): Promise<void> {
      objects.delete(key);
    },
    async get(key: string): Promise<StoredObject> {
      const bytes = objects.get(key);
      if (!bytes) {
        const error = new Error("not found") as Error & { code: string };
        error.code = "NOT_FOUND";
        throw error;
      }
      return { bytes, size: bytes.byteLength };
    },
    async head(key: string): Promise<StoredObjectHead | undefined> {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.byteLength } : undefined;
    },
    async list(): Promise<ObjectPage> {
      return { objects: [] };
    },
    async put(
      key: string,
      bytes: Uint8Array,
      _contentType: string,
    ): Promise<void> {
      objects.set(key, bytes);
    },
    async putFile(): Promise<void> {
      throw new Error("not implemented");
    },
  };
}
