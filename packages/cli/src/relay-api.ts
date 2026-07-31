import WebSocket from "ws";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";

import {
  KIND_BLOSSOM_AUTH,
  signNostrEvent,
  type NostrEvent,
  type NostrFilter,
} from "@buzz/core";
import { nip98Authorization } from "@buzz/remote-agent-client";
import { AuthenticatedRelayClient, type RelaySocket } from "@buzz/ws-client";

export class RelayApi {
  #authTag: readonly [string, string, string, string] | undefined;
  readonly #client: AuthenticatedRelayClient;
  readonly #relayUrl: URL;
  readonly #secretKey: Uint8Array;

  public constructor(input: {
    readonly relayUrl: string;
    readonly secretKey: Uint8Array;
    readonly allowInsecureLocalhost: boolean;
    readonly authTag?: readonly [string, string, string, string];
  }) {
    this.#authTag = input.authTag ? [...input.authTag] : undefined;
    this.#relayUrl = new URL(input.relayUrl);
    this.#secretKey = Uint8Array.from(input.secretKey);
    this.#client = new AuthenticatedRelayClient({
      allowInsecureLocalhost: input.allowInsecureLocalhost,
      ...(input.authTag ? { authTag: input.authTag } : {}),
      relayUrl: input.relayUrl,
      secretKey: input.secretKey,
      socketFactory: (url) =>
        new WebSocket(url, {
          followRedirects: false,
          perMessageDeflate: false,
        }) as unknown as RelaySocket,
    });
  }

  public connect(): Promise<void> {
    return this.#client.connect();
  }

  public close(): void {
    this.#client.close();
    this.#secretKey.fill(0);
    this.#authTag = undefined;
  }

  public publish(event: NostrEvent): Promise<string> {
    return this.#client.publish(event);
  }

  public count(filter: NostrFilter): Promise<number> {
    return this.#client.count(filter);
  }

  public async info(): Promise<Record<string, unknown>> {
    const url = new URL(this.#relayUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    const response = await fetch(url, {
      headers: { accept: "application/nostr+json" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`relay info request failed with HTTP ${response.status}`);
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > 1024 * 1024) {
      throw new Error("relay info document exceeds 1 MiB");
    }
    const raw = await boundedResponseText(response, 1024 * 1024);
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("relay info document must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  }

  public async getAuthed(
    path: string,
    ownerAuthTag?: readonly string[],
  ): Promise<unknown> {
    const url = new URL(path, this.#relayUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    const structurallyValidAuth = validateAuthTag(
      ownerAuthTag ?? this.#authTag,
    );
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        Authorization: await nip98Authorization({
          body: new Uint8Array(),
          method: "GET",
          ...(structurallyValidAuth
            ? { ownerAuthTag: structurallyValidAuth }
            : {}),
          ownerSecretKey: this.#secretKey,
          url: url.toString(),
        }),
      },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const raw = await boundedResponseText(response, 4 * 1024 * 1024);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`relay returned invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
      const message =
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { readonly error?: unknown }).error === "string"
          ? (parsed as { readonly error: string }).error
          : `HTTP ${response.status}`;
      throw new Error(`relay request failed: ${message}`);
    }
    return parsed;
  }

  public async uploadFile(path: string): Promise<unknown> {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new TypeError("upload path is not a file");
    const bytes = await readFile(path);
    const mime = detectUploadMime(bytes);
    const maximum = mime === "video/mp4" ? 500 : 50;
    if (bytes.byteLength > maximum * 1024 * 1024) {
      throw new RangeError(`upload exceeds the ${maximum} MiB limit`);
    }
    const sha256 = createSha256(bytes);
    const primary = await this.#uploadToEndpoint(
      "/upload",
      bytes,
      mime,
      sha256,
    );
    if (primary.ok) return primary.value;
    if (primary.status !== 404 && primary.status !== 405) {
      throw new Error(`media upload failed (HTTP ${primary.status})`);
    }
    const legacy = await this.#uploadToEndpoint(
      "/media/upload",
      bytes,
      mime,
      sha256,
    );
    if (!legacy.ok) {
      throw new Error(`media upload failed (HTTP ${legacy.status})`);
    }
    return legacy.value;
  }

  public async downloadMedia(
    input: string,
    outputPath?: string,
  ): Promise<Uint8Array | { readonly size: number; readonly written: string }> {
    const endpoint = mediaUrl(this.#relayUrl, input);
    const sha256 = /^\/media\/([0-9a-f]{64})/.exec(endpoint.pathname)?.[1];
    if (!sha256) throw new TypeError("media URL does not contain a sha256");
    const response = await fetch(endpoint, {
      headers: {
        Authorization: this.#blossomAuthorization(
          "get",
          sha256,
          600,
          "Get media",
        ),
        ...this.#delegationHeaders(),
      },
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(`media download failed (HTTP ${response.status})`);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > 500 * 1024 * 1024) {
      throw new RangeError("media download exceeds 500 MiB");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 500 * 1024 * 1024) {
      throw new RangeError("media download exceeds 500 MiB");
    }
    if (outputPath && outputPath !== "-") {
      await writeFile(outputPath, bytes);
      return { size: bytes.byteLength, written: outputPath };
    }
    return bytes;
  }

  async #uploadToEndpoint(
    path: string,
    bytes: Uint8Array,
    mime: string,
    sha256: string,
  ): Promise<
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly status: number }
  > {
    const endpoint = new URL(path, this.#relayUrl);
    endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
    const response = await fetch(endpoint, {
      body: bytes,
      headers: {
        Authorization: this.#blossomAuthorization(
          "upload",
          sha256,
          mime === "video/mp4" ? 3_600 : 600,
          "Upload file",
        ),
        "Content-Type": mime,
        "X-SHA-256": sha256,
        ...this.#delegationHeaders(),
      },
      method: "PUT",
      redirect: "error",
      signal: AbortSignal.timeout(mime === "video/mp4" ? 600_000 : 120_000),
    });
    const raw = await boundedResponseText(response, 1024 * 1024);
    if (!response.ok) return { ok: false, status: response.status };
    try {
      return { ok: true, value: JSON.parse(raw) as unknown };
    } catch {
      throw new Error(
        `relay returned invalid upload JSON (HTTP ${response.status})`,
      );
    }
  }

  #delegationHeaders(): Record<string, string> {
    return this.#authTag ? { "x-auth-tag": JSON.stringify(this.#authTag) } : {};
  }

  #blossomAuthorization(
    verb: "upload" | "get",
    sha256: string,
    lifetimeSeconds: number,
    content: string,
  ): string {
    const now = Math.floor(Date.now() / 1_000);
    const host = normalizedServerHost(this.#relayUrl);
    const tags = [
      ["t", verb],
      ["x", sha256],
      ["expiration", String(now + lifetimeSeconds)],
      ["server", host],
    ];
    const event = signNostrEvent(
      {
        content,
        created_at: now,
        kind: KIND_BLOSSOM_AUTH,
        tags,
      },
      this.#secretKey,
    );
    return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64url")}`;
  }

  public query(
    filters: readonly NostrFilter[],
    timeoutMilliseconds = 15_000,
  ): Promise<NostrEvent[]> {
    if (filters.length < 1 || filters.length > 10) {
      throw new RangeError("query requires 1-10 filters");
    }
    const id = crypto.randomUUID();
    const events: NostrEvent[] = [];
    const seen = new Set<string>();
    return new Promise<NostrEvent[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        subscription.close();
        reject(new Error("relay query timed out"));
      }, timeoutMilliseconds);
      const unsubscribe = this.#client.on((event) => {
        if (event.type === "event" && event.subscriptionId === id) {
          if (!seen.has(event.event.id)) {
            seen.add(event.event.id);
            events.push(event.event);
          }
        } else if (event.type === "eose" && event.subscriptionId === id) {
          clearTimeout(timeout);
          unsubscribe();
          subscription.close();
          resolve(events);
        } else if (event.type === "closed" && event.subscriptionId === id) {
          clearTimeout(timeout);
          unsubscribe();
          subscription.close();
          reject(new Error(event.message));
        } else if (event.type === "disconnected") {
          clearTimeout(timeout);
          unsubscribe();
          reject(new Error("relay disconnected during query"));
        }
      });
      const subscription = this.#client.subscribe(filters, id);
    });
  }
}

function detectUploadMime(bytes: Uint8Array): string {
  const matches = (signature: readonly number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (matches([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (
    Buffer.from(bytes.subarray(0, 6)).toString("ascii") === "GIF87a" ||
    Buffer.from(bytes.subarray(0, 6)).toString("ascii") === "GIF89a"
  )
    return "image/gif";
  if (
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (Buffer.from(bytes.subarray(4, 8)).toString("ascii") === "ftyp")
    return "video/mp4";
  throw new TypeError(
    "unsupported upload type; use JPEG, PNG, GIF, WebP, or MP4",
  );
}

function createSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateAuthTag(
  value: readonly string[] | undefined,
): readonly [string, string, string, string] | undefined {
  return value?.length === 4 &&
    value[0] === "auth" &&
    /^[0-9a-f]{64}$/.test(value[1] ?? "") &&
    typeof value[2] === "string" &&
    Buffer.byteLength(value[2] ?? "", "utf8") <= 4_096 &&
    /^[0-9a-f]{128}$/.test(value[3] ?? "")
    ? (value as readonly [string, string, string, string])
    : undefined;
}

async function boundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new RangeError(`relay response exceeds ${maximumBytes} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new RangeError(`relay response exceeds ${maximumBytes} bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) =>
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    ),
    size,
  ).toString("utf8");
}

function normalizedServerHost(url: URL): string {
  const defaultPort =
    (url.protocol === "wss:" && url.port === "443") ||
    (url.protocol === "ws:" && url.port === "80");
  return `${url.hostname.toLowerCase()}${
    url.port && !defaultPort ? `:${url.port}` : ""
  }`;
}

function mediaUrl(relayUrl: URL, input: string): URL {
  const segment = input.trim().replace(/^\/?media\//, "");
  let url: URL;
  if (/^https?:\/\//.test(input)) {
    url = new URL(input);
    const relayHttp = new URL(relayUrl);
    relayHttp.protocol = relayHttp.protocol === "wss:" ? "https:" : "http:";
    if (
      url.origin !== relayHttp.origin ||
      !url.pathname.startsWith("/media/")
    ) {
      throw new TypeError("media URL must be on the configured relay origin");
    }
  } else {
    if (!/^[0-9a-f]{64}(?:\.[a-z0-9]{1,8}|\.thumb\.jpg)?$/.test(segment)) {
      throw new TypeError(
        "media input must be sha256, sha256.ext, or sha256.thumb.jpg",
      );
    }
    url = new URL(`/media/${segment}`, relayUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  }
  if (
    !/^\/media\/[0-9a-f]{64}(?:\.[a-z0-9]{1,8}|\.thumb\.jpg)?$/.test(
      url.pathname,
    )
  ) {
    throw new TypeError("media path is invalid");
  }
  return url;
}
