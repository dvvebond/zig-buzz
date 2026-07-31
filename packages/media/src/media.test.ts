import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateSecretKey } from "nostr-tools/pure";
import { afterEach, describe, expect, it } from "vitest";
import { KIND_BLOSSOM_AUTH, signNostrEvent } from "@buzz/core";

import {
  normalizeServerHost,
  verifyBlossomGetAuth,
  verifyBlossomUploadAuth,
} from "./auth.js";
import {
  BucketAggregate,
  classifyKey,
  foldBucketListing,
} from "./bucket-index.js";
import { DEFAULT_MEDIA_LIMITS, type MediaConfig } from "./config.js";
import { MediaError } from "./error.js";
import { FileMediaStorage, getSidecar, sidecarKey } from "./storage.js";
import { processImageUpload } from "./upload.js";
import { parsePort, parsePublicIp } from "./upload-record.js";
import {
  looksLikeIsoBmff,
  validateFileContent,
  validateImageContent,
  validateVideoFile,
} from "./validation.js";

const now = 1_800_000_000;
const secret = generateSecretKey();
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Blossom authorization", () => {
  it("binds the verb, hash, freshness, signature, and normalized tenant host", () => {
    const hash = "a".repeat(64);
    const event = authEvent("upload", hash, "HTTPS://Relay.Example:443/path");
    expect(() =>
      verifyBlossomUploadAuth({
        event,
        now,
        serverHost: "relay.example.",
        sha256: hash,
      }),
    ).not.toThrow();
    expect(() =>
      verifyBlossomUploadAuth({
        event,
        now,
        serverHost: "other.example",
        sha256: hash,
      }),
    ).toThrow(MediaError);
    expect(() =>
      verifyBlossomUploadAuth({
        event,
        now,
        serverHost: "relay.example",
        sha256: "b".repeat(64),
      }),
    ).toThrow(MediaError);
    expect(normalizeServerHost("https://Relay.Example:443/a")).toBe(
      "relay.example",
    );
  });

  it("requires either exact blob scope or the bound server scope for reads", () => {
    const hash = "c".repeat(64);
    const scoped = authEvent("get", hash);
    expect(() =>
      verifyBlossomGetAuth({
        event: scoped,
        now,
        serverHost: "relay.example",
        sha256: hash,
      }),
    ).not.toThrow();
    const unrelated = authEvent("get", "d".repeat(64));
    expect(() =>
      verifyBlossomGetAuth({
        event: unrelated,
        now,
        serverHost: "relay.example",
        sha256: hash,
      }),
    ).toThrow(MediaError);
  });
});

describe("media validation and storage", () => {
  it("rejects active content and ISO-BMFF from the generic attachment path", async () => {
    await expect(
      validateFileContent(Buffer.from("<svg onload=alert(1)>"), config()),
    ).rejects.toMatchObject({ code: "DISALLOWED_CONTENT_TYPE" });
    const mp4 = Buffer.alloc(24);
    mp4.writeUInt32BE(24, 0);
    mp4.write("ftyp", 4, "ascii");
    mp4.write("isom", 8, "ascii");
    expect(looksLikeIsoBmff(mp4)).toBe(true);
    await expect(validateFileContent(mp4, config())).rejects.toMatchObject({
      code: "DISALLOWED_CONTENT_TYPE",
    });
  });

  it("matches the canonical iOS and Android sanitizer boundary", async () => {
    const accepted = [
      "android/bitmap-srgb.png",
      "android/sanitized/bitmap-srgb-sanitized.png",
      "android/sanitized/bitmap-srgb-sanitized.jpg",
      "android/sanitized/bitmap-display-p3-sanitized.png",
      "android/sanitized/bitmap-display-p3-sanitized.jpg",
      "ios/uikit-sanitized.png",
      "ios/uikit-sanitized.jpg",
    ];
    const rejected = [
      "android/bitmap-srgb.jpg",
      "android/bitmap-display-p3.png",
      "android/bitmap-display-p3.jpg",
      "ios/uikit-encoded.png",
      "ios/uikit-encoded.jpg",
    ];
    for (const fixture of accepted) {
      const bytes = await readFile(
        new URL(`../tests/fixtures/${fixture}`, import.meta.url),
      );
      await expect(
        validateImageContent(bytes, config()),
        `expected sanitized fixture ${fixture} to pass`,
      ).resolves.toMatchObject({
        height: expect.any(Number),
        width: expect.any(Number),
      });
    }
    for (const fixture of rejected) {
      const bytes = await readFile(
        new URL(`../tests/fixtures/${fixture}`, import.meta.url),
      );
      await expect(
        validateImageContent(bytes, config()),
        `expected metadata-bearing fixture ${fixture} to fail`,
      ).rejects.toMatchObject({ code: "INVALID_CONTENT" });
    }
  });

  it("accepts only fast-start H.264/AAC MP4 tracks without private boxes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buzz-video-test-"));
    directories.push(directory);
    const file = join(directory, "canonical.mp4");
    const canonical = canonicalMp4();
    await writeFile(file, canonical);
    await expect(
      validateVideoFile(file, canonical.length, config()),
    ).resolves.toMatchObject({
      durationSecs: 5,
      hasAudio: false,
      height: 360,
      width: 640,
    });

    const lateMoov = canonicalMp4({ moovAfterMedia: true });
    await writeFile(file, lateMoov);
    await expect(
      validateVideoFile(file, lateMoov.length, config()),
    ).rejects.toThrow(/fast-start/);

    const privateBox = canonicalMp4({ privateBox: true });
    await writeFile(file, privateBox);
    await expect(
      validateVideoFile(file, privateBox.length, config()),
    ).rejects.toThrow(/private metadata/);

    const wrongCodec = canonicalMp4({ codec: "hvc1" });
    await writeFile(file, wrongCodec);
    await expect(
      validateVideoFile(file, wrongCodec.length, config()),
    ).rejects.toThrow(/H.264/);
  });

  it("publishes the tenant sidecar last and preserves tenant isolation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "buzz-media-test-"));
    directories.push(directory);
    const storage = new FileMediaStorage(directory);
    const bytes = await readFile(
      new URL(
        "../tests/fixtures/android/sanitized/bitmap-srgb-sanitized.png",
        import.meta.url,
      ),
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const communityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const otherCommunityId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const descriptor = await processImageUpload({
      authEvent: authEvent("upload", sha256, "relay.example"),
      bytes,
      communityHost: "relay.example",
      communityId,
      config: config(),
      now,
      storage,
    });
    expect(descriptor).toMatchObject({
      dim: "3x2",
      sha256,
      type: "image/png",
    });
    await expect(
      getSidecar(storage, communityId, sha256),
    ).resolves.toMatchObject({
      ext: "png",
    });
    await expect(
      getSidecar(storage, otherCommunityId, sha256),
    ).resolves.toBeUndefined();
    await expect(
      storage.head(sidecarKey(communityId, sha256)),
    ).resolves.toBeDefined();
  });

  it("records only single public addresses and valid nonzero ports", () => {
    expect(parsePublicIp("8.8.8.8")).toBe("8.8.8.8");
    for (const value of [
      "127.0.0.1",
      "10.0.0.1",
      "100.64.0.1",
      "192.0.2.1",
      "2001:db8::1",
      "8.8.8.8, 1.1.1.1",
    ]) {
      expect(parsePublicIp(value)).toBeUndefined();
    }
    expect(parsePort("443")).toBe(443);
    expect(parsePort("0")).toBeUndefined();
    expect(parsePort("65536")).toBeUndefined();
  });
});

describe("bucket accounting", () => {
  it("classifies strict keys and computes physical, logical, and orphan totals", async () => {
    const sha = "e".repeat(64);
    const orphan = "f".repeat(64);
    const community = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(classifyKey(`${sha}.thumb.jpg`)).toEqual({
      kind: "thumb",
      sha256: sha,
    });
    expect(classifyKey(`_meta/${community}/${sha}.json`)).toMatchObject({
      community,
      kind: "sidecar",
      sha256: sha,
    });
    expect(classifyKey(`_meta/${community}/${sha}.JSON`)).toEqual({
      kind: "unknown",
    });
    const aggregate = new BucketAggregate();
    aggregate.fold(`${sha}.png`, 100);
    aggregate.fold(`${sha}.thumb.jpg`, 10);
    aggregate.fold(`_meta/${community}/${sha}.json`, 5);
    aggregate.fold(`${orphan}.bin`, 7);
    aggregate.fold("garbage", 3);
    expect(aggregate.finish()).toMatchObject({
      logicalBytes: 110,
      logicalObjects: 1,
      orphanBlobBytes: 7,
      orphanBlobCount: 1,
      physicalBytes: 125,
      physicalObjects: 5,
      unknownKeyBytes: 3,
      unknownKeyObjects: 1,
    });
    await expect(
      foldBucketListing(1, async () => ({
        isTruncated: false,
        objects: [
          { key: `${sha}.png`, size: 1 },
          { key: `${orphan}.bin`, size: 1 },
        ],
      })),
    ).rejects.toMatchObject({ code: "CAP_EXCEEDED" });
  });
});

function authEvent(verb: "upload" | "get", sha256: string, server?: string) {
  return signNostrEvent(
    {
      content: `${verb} blob`,
      created_at: now,
      kind: KIND_BLOSSOM_AUTH,
      tags: [
        ["t", verb],
        ["expiration", String(now + 300)],
        ["x", sha256],
        ...(server ? [["server", server] as [string, string]] : []),
      ],
    },
    secret,
  );
}

function config(): MediaConfig {
  return {
    ...DEFAULT_MEDIA_LIMITS,
    publicBaseUrl: "https://relay.example/media",
    uploadRecordsEnabled: false,
  };
}

function canonicalMp4(
  options: {
    codec?: string;
    moovAfterMedia?: boolean;
    privateBox?: boolean;
  } = {},
): Buffer {
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(640 * 65_536, tkhd.length - 8);
  tkhd.writeUInt32BE(360 * 65_536, tkhd.length - 4);
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(1_000, 12);
  mdhd.writeUInt32BE(5_000, 16);
  const hdlr = Buffer.alloc(24);
  hdlr.write("vide", 8, "ascii");
  const stsd = Buffer.alloc(16);
  stsd.writeUInt32BE(1, 4);
  stsd.writeUInt32BE(8, 8);
  stsd.write(options.codec ?? "avc1", 12, "ascii");
  const track = mp4Box(
    "trak",
    Buffer.concat([
      mp4Box("tkhd", tkhd),
      mp4Box(
        "mdia",
        Buffer.concat([
          mp4Box("mdhd", mdhd),
          mp4Box("hdlr", hdlr),
          mp4Box("minf", mp4Box("stbl", mp4Box("stsd", stsd))),
        ]),
      ),
    ]),
  );
  const moov = mp4Box(
    "moov",
    Buffer.concat([
      mp4Box("mvhd", Buffer.alloc(16)),
      track,
      ...(options.privateBox ? [mp4Box("uuid", Buffer.alloc(16))] : []),
    ]),
  );
  const ftypPayload = Buffer.alloc(16);
  ftypPayload.write("isom", 0, "ascii");
  ftypPayload.write("isom", 8, "ascii");
  ftypPayload.write("avc1", 12, "ascii");
  const ftyp = mp4Box("ftyp", ftypPayload);
  const mdat = mp4Box("mdat", Buffer.from([0, 1, 2, 3]));
  return Buffer.concat(
    options.moovAfterMedia ? [ftyp, mdat, moov] : [ftyp, moov, mdat],
  );
}

function mp4Box(type: string, payload: Buffer): Buffer {
  const output = Buffer.alloc(8 + payload.length);
  output.writeUInt32BE(output.length, 0);
  output.write(type, 4, 4, "latin1");
  payload.copy(output, 8);
  return output;
}
