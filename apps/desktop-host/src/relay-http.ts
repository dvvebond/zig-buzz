import { createHash, randomBytes } from "node:crypto";

import { verifyEvent, type Event } from "nostr-tools";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

export type RelayFilter = Record<string, unknown>;

export class RelayHttpClient {
  #baseUrl: URL;
  readonly #sign: (input: Record<string, unknown>) => Event;
  readonly #fetch: typeof fetch;
  readonly #authTag: readonly [string, string, string, string] | undefined;

  constructor(input: {
    baseUrl: string;
    fetch?: typeof fetch;
    sign: (input: Record<string, unknown>) => Event;
    authTag?: readonly [string, string, string, string];
  }) {
    this.#baseUrl = validateBaseUrl(input.baseUrl);
    this.#sign = input.sign;
    this.#fetch = input.fetch ?? fetch;
    this.#authTag = input.authTag
      ? validateOwnerAuthTag(input.authTag)
      : undefined;
  }

  setBaseUrl(baseUrl: string): void {
    this.#baseUrl = validateBaseUrl(baseUrl);
  }

  async query(filters: readonly RelayFilter[]): Promise<Event[]> {
    if (filters.length === 0 || filters.length > 100) {
      throw new Error("relay query requires 1 to 100 filters");
    }
    const body = JSON.stringify(filters);
    const response = await this.#post("/query", body);
    const parsed: unknown = JSON.parse(response);
    if (!Array.isArray(parsed) || parsed.length > 10_000) {
      throw new Error("relay query returned an invalid event list");
    }
    return parsed.map((event, index) => {
      if (!isEvent(event) || !verifyEvent(event)) {
        throw new Error(`relay query returned invalid event at index ${index}`);
      }
      return event;
    });
  }

  async publish(event: Event): Promise<{
    eventId: string;
    message: string;
  }> {
    if (!verifyEvent(event)) throw new Error("cannot publish an invalid event");
    const response = await this.#post("/events", JSON.stringify(event));
    const parsed: unknown = JSON.parse(response);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("accepted" in parsed) ||
      parsed.accepted !== true ||
      !("event_id" in parsed) ||
      parsed.event_id !== event.id ||
      ("message" in parsed && typeof parsed.message !== "string")
    ) {
      throw new Error("relay did not acknowledge the published event");
    }
    return {
      eventId: event.id,
      message:
        "message" in parsed && typeof parsed.message === "string"
          ? parsed.message
          : "",
    };
  }

  async #post(pathname: "/events" | "/query", body: string): Promise<string> {
    const bodyBytes = Buffer.from(body, "utf8");
    if (bodyBytes.byteLength > MAX_REQUEST_BYTES) {
      throw new Error("relay HTTP request exceeds the 1 MiB limit");
    }
    const url = new URL(pathname, this.#baseUrl).toString();
    const payloadHash = createHash("sha256").update(bodyBytes).digest("hex");
    const authEvent = this.#sign({
      content: "",
      kind: 27_235,
      tags: [
        ["u", url],
        ["method", "POST"],
        ["payload", payloadHash],
        ["nonce", randomBytes(16).toString("hex")],
        ...(this.#authTag ? [[...this.#authTag]] : []),
      ],
    });
    const authorization = `Nostr ${Buffer.from(
      JSON.stringify(authEvent),
      "utf8",
    ).toString("base64")}`;
    const abort = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await this.#fetch(url, {
      body,
      headers: {
        Accept: "application/json",
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: abort,
    });
    const responseText = await readBoundedText(response, MAX_RESPONSE_BYTES);
    if (!response.ok) {
      let detail = responseText;
      try {
        const parsed: unknown = JSON.parse(responseText);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "error" in parsed &&
          typeof parsed.error === "string"
        ) {
          detail = parsed.error;
        }
      } catch {
        // Preserve the bounded raw response.
      }
      throw new Error(`relay request failed (${response.status}): ${detail}`);
    }
    return responseText;
  }
}

function validateOwnerAuthTag(
  value: readonly [string, string, string, string],
): readonly [string, string, string, string] {
  if (
    value.length !== 4 ||
    value[0] !== "auth" ||
    !/^[0-9a-f]{64}$/.test(value[1]) ||
    Buffer.byteLength(value[2], "utf8") > 1_024 ||
    !/^[0-9a-f]{128}$/.test(value[3])
  ) {
    throw new TypeError("authTag must be a structurally valid NIP-OA auth tag");
  }
  return [...value] as [string, string, string, string];
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximumBytes) {
    throw new Error("relay response exceeds the 8 MiB limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("relay response exceeds the 8 MiB limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function validateBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("relay HTTP URL must use http: or https:");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("relay HTTP URL may not contain credentials or a fragment");
  }
  if (
    url.protocol === "http:" &&
    !["127.0.0.1", "::1", "localhost"].includes(url.hostname)
  ) {
    throw new Error("remote relay HTTP URLs must use TLS");
  }
  return url;
}

function isEvent(value: unknown): value is Event {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "pubkey" in value &&
    typeof value.pubkey === "string" &&
    "created_at" in value &&
    typeof value.created_at === "number" &&
    "kind" in value &&
    typeof value.kind === "number" &&
    "tags" in value &&
    Array.isArray(value.tags) &&
    "content" in value &&
    typeof value.content === "string" &&
    "sig" in value &&
    typeof value.sig === "string"
  );
}
