export type KeyClass =
  | { readonly kind: "thumb"; readonly sha256: string }
  | { readonly kind: "blob"; readonly sha256: string; readonly ext: string }
  | {
      readonly kind: "sidecar";
      readonly community: string;
      readonly sha256: string;
    }
  | {
      readonly kind: "auxiliary";
      readonly community: string;
      readonly sha256: string;
      readonly eventId: string;
    }
  | { readonly kind: "unknown" };

export type CommunityStorage = {
  readonly bytes: number;
  readonly objects: number;
};

export type BucketSnapshot = {
  readonly physicalBytes: number;
  readonly physicalObjects: number;
  readonly logicalBytes: number;
  readonly logicalObjects: number;
  readonly perCommunity: Readonly<Record<string, CommunityStorage>>;
  readonly orphanBlobBytes: number;
  readonly orphanBlobCount: number;
  readonly orphanSidecarCount: number;
  readonly multiVariantShas: number;
  readonly multiVariantBytes: number;
  readonly unknownKeyBytes: number;
  readonly unknownKeyObjects: number;
};

const SHA = "[0-9a-f]{64}";
const UUID =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";

export function classifyKey(key: string): KeyClass {
  let match = new RegExp(`^(${SHA})\\.thumb\\.jpg$`).exec(key);
  if (match?.[1]) return { kind: "thumb", sha256: match[1] };
  match = new RegExp(`^(${SHA})\\.([A-Za-z0-9]{1,8})$`).exec(key);
  if (match?.[1] && match[2]) {
    return { ext: match[2], kind: "blob", sha256: match[1] };
  }
  match = new RegExp(`^_meta\\/(${UUID})\\/(${SHA})\\.json$`).exec(key);
  if (match?.[1] && match[2]) {
    return { community: match[1], kind: "sidecar", sha256: match[2] };
  }
  match = new RegExp(
    `^_uploads\\/(${UUID})\\/(${SHA})\\/(${ULID})\\.json$`,
  ).exec(key);
  if (match?.[1] && match[2] && match[3]) {
    return {
      community: match[1],
      eventId: match[3],
      kind: "auxiliary",
      sha256: match[2],
    };
  }
  return { kind: "unknown" };
}

export class BucketAggregate {
  readonly #blobs = new Map<string, number[]>();
  readonly #thumbs = new Map<string, number>();
  readonly #sidecars = new Map<string, { community: string; sha256: string }>();
  #physicalBytes = 0;
  #physicalObjects = 0;
  #unknownBytes = 0;
  #unknownObjects = 0;

  public fold(key: string, size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("bucket object size must be a non-negative safe integer");
    }
    this.#physicalBytes += size;
    this.#physicalObjects += 1;
    assertSafeTotal(this.#physicalBytes);
    const classified = classifyKey(key);
    if (classified.kind === "blob") {
      const variants = this.#blobs.get(classified.sha256) ?? [];
      variants.push(size);
      this.#blobs.set(classified.sha256, variants);
    } else if (classified.kind === "thumb") {
      this.#thumbs.set(classified.sha256, size);
    } else if (classified.kind === "sidecar") {
      this.#sidecars.set(`${classified.community}:${classified.sha256}`, {
        community: classified.community,
        sha256: classified.sha256,
      });
    } else if (classified.kind === "unknown") {
      this.#unknownBytes += size;
      this.#unknownObjects += 1;
    }
  }

  public finish(): BucketSnapshot {
    const bound = new Set(
      [...this.#sidecars.values()].map((item) => item.sha256),
    );
    let orphanBlobBytes = 0;
    let orphanBlobCount = 0;
    let multiVariantShas = 0;
    let multiVariantBytes = 0;
    for (const [sha256, variants] of this.#blobs) {
      const bytes = variants.reduce((total, value) => total + value, 0);
      if (variants.length > 1) {
        multiVariantShas += 1;
        multiVariantBytes += bytes;
      }
      if (!bound.has(sha256)) {
        orphanBlobCount += 1;
        orphanBlobBytes += bytes;
      }
    }
    let orphanSidecarCount = 0;
    const perCommunity: Record<string, { bytes: number; objects: number }> = {};
    for (const { community, sha256 } of this.#sidecars.values()) {
      const variants = this.#blobs.get(sha256);
      if (!variants) orphanSidecarCount += 1;
      const current = perCommunity[community] ?? { bytes: 0, objects: 0 };
      current.bytes +=
        (variants?.reduce((total, value) => total + value, 0) ?? 0) +
        (this.#thumbs.get(sha256) ?? 0);
      current.objects += 1;
      perCommunity[community] = current;
    }
    const logicalBytes = Object.values(perCommunity).reduce(
      (total, value) => total + value.bytes,
      0,
    );
    const logicalObjects = Object.values(perCommunity).reduce(
      (total, value) => total + value.objects,
      0,
    );
    return {
      logicalBytes,
      logicalObjects,
      multiVariantBytes,
      multiVariantShas,
      orphanBlobBytes,
      orphanBlobCount,
      orphanSidecarCount,
      perCommunity,
      physicalBytes: this.#physicalBytes,
      physicalObjects: this.#physicalObjects,
      unknownKeyBytes: this.#unknownBytes,
      unknownKeyObjects: this.#unknownObjects,
    };
  }
}

export class BucketSweepError extends Error {
  public constructor(
    readonly code: "CAP_EXCEEDED" | "MALFORMED_PAGE",
    message: string,
  ) {
    super(message);
    this.name = "BucketSweepError";
  }
}

export async function foldBucketListing(
  cap: number,
  fetchPage: (continuationToken: string | undefined) => Promise<{
    readonly objects: readonly {
      readonly key: string;
      readonly size: number;
    }[];
    readonly isTruncated: boolean;
    readonly continuationToken?: string;
  }>,
): Promise<BucketSnapshot> {
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    throw new Error("bucket listing cap must be a positive safe integer");
  }
  const aggregate = new BucketAggregate();
  let token: string | undefined;
  let seen = 0;
  do {
    const page = await fetchPage(token);
    seen += page.objects.length;
    if (seen > cap) {
      throw new BucketSweepError(
        "CAP_EXCEEDED",
        `object cap exceeded: ${seen} > ${cap}`,
      );
    }
    for (const object of page.objects) aggregate.fold(object.key, object.size);
    if (!page.isTruncated) break;
    if (!page.continuationToken) {
      throw new BucketSweepError(
        "MALFORMED_PAGE",
        "truncated listing page has no continuation token",
      );
    }
    token = page.continuationToken;
  } while (true);
  return aggregate.finish();
}

function assertSafeTotal(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error("bucket aggregate exceeds JavaScript safe integer range");
  }
}
