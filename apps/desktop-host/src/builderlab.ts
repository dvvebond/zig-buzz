import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { nip19 } from "nostr-tools";

import type { IdentityService } from "./identity.js";

const DEFAULT_API_BASE = "https://app.builderlab.xyz/api/goose";
const DEFAULT_ORIGIN = "https://app.builderlab.xyz";
const CREDENTIAL_HEADER = "X-BB-Session-Credential";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const RESPONSE_LIMIT = 1024 * 1024;
const COMMUNITY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;

type JsonObject = Record<string, unknown>;
type AuthInfo = {
  email?: string;
  expiresAt: string;
  name?: string;
};

type PendingLogin = {
  abort: AbortController;
  id: string;
  server: Server;
};

export class BuilderlabService {
  readonly #apiBase: URL;
  readonly #identity: IdentityService;
  readonly #openExternal: (url: string) => void | Promise<void>;
  readonly #origin: string;
  #credential: string | undefined;
  #pending: PendingLogin | undefined;

  constructor(input: {
    apiBaseUrl?: string;
    identity: IdentityService;
    openExternal: (url: string) => void | Promise<void>;
    origin?: string;
  }) {
    this.#apiBase = validateApiBase(input.apiBaseUrl ?? DEFAULT_API_BASE);
    this.#identity = input.identity;
    this.#openExternal = input.openExternal;
    this.#origin = validateOrigin(input.origin ?? DEFAULT_ORIGIN);
  }

  async startLogin(): Promise<AuthInfo> {
    await this.cancelLogin();
    const nonce = randomBytes(24).toString("base64url");
    const callback = deferred<string>();
    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        request.method !== "GET" ||
        requestUrl.pathname !== `/callback/${nonce}`
      ) {
        response.writeHead(404, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end("Not found");
        return;
      }
      const code = requestUrl.searchParams.get("code");
      const error =
        requestUrl.searchParams.get("error_description") ??
        requestUrl.searchParams.get("error");
      if (code && Buffer.byteLength(code, "utf8") <= 4_096) {
        callback.resolve(code);
      } else {
        callback.reject(
          new Error(
            error && Buffer.byteLength(error, "utf8") <= 4_096
              ? error
              : "Authentication callback did not include a valid code",
          ),
        );
      }
      response.writeHead(200, {
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      });
      response.end(AUTH_COMPLETE_HTML);
    });
    server.on("clientError", (_error, socket) => {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await closeServer(server);
      throw new Error("could not read local authentication callback");
    }
    const returnTo = `http://127.0.0.1:${address.port}/callback/${nonce}`;
    const loginUrl = this.#url("/v1/auth/login");
    loginUrl.searchParams.set("type", "cli");
    loginUrl.searchParams.set("product", "buzz");
    loginUrl.searchParams.set("returnTo", returnTo);
    const abort = new AbortController();
    const id = randomUUID();
    this.#pending = { abort, id, server };
    try {
      await this.#openExternal(loginUrl.toString());
      const code = await raceLogin(callback.promise, abort.signal);
      const exchange = await this.#request("/v1/auth/login/exchange", {
        body: { code },
        authenticated: false,
        timeoutMs: 30_000,
      });
      const credential = requiredText(
        exchange.session_credential,
        "session credential",
        16 * 1024,
      );
      const exchangeExpiry = requiredText(
        exchange.expires_at,
        "session expiry",
        128,
      );
      const me = await this.#authenticatedUser(credential);
      if (me.expiresAt !== exchangeExpiry) {
        throw new Error(
          "Builderlab session expiry did not match code exchange",
        );
      }
      if (this.#pending?.id !== id || abort.signal.aborted) {
        throw new Error("Builderlab authentication canceled");
      }
      this.#credential = credential;
      return me;
    } finally {
      if (this.#pending?.id === id) this.#pending = undefined;
      await closeServer(server);
    }
  }

  async getAuth(): Promise<AuthInfo | null> {
    const credential = this.#credential;
    if (!credential) return null;
    try {
      return await this.#authenticatedUser(credential);
    } catch (error) {
      this.#credential = undefined;
      throw error;
    }
  }

  async cancelLogin(): Promise<void> {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    pending.abort.abort(new Error("Builderlab authentication canceled"));
    await closeServer(pending.server);
  }

  clearAuth(): void {
    this.#credential = undefined;
  }

  currentIdentity(): Promise<JsonObject> {
    return this.#authenticatedJson("/v1/buzz/nostr-identities/current", {});
  }

  async bindIdentity(): Promise<JsonObject> {
    const challenge = await this.#authenticatedJson(
      "/v1/buzz/nostr-identities/challenge",
      { origin: this.#origin },
    );
    if (challenge.error !== undefined) return challenge;
    const challengeId = requiredText(
      challenge.challenge_id,
      "challenge_id",
      128,
    );
    const nonce = requiredText(challenge.nonce, "nonce", 128);
    const verificationCode = requiredText(
      challenge.verification_code,
      "verification_code",
      16,
    );
    const origin = requiredText(challenge.origin, "origin", 2_048);
    const expiresAt = requiredText(challenge.expires_at, "expires_at", 128);
    const signed = this.#identity.signIdentityBinding({
      challengeId,
      expiresAt,
      nonce,
      origin,
      verificationCode,
    });
    return this.#authenticatedJson("/v1/buzz/nostr-identities/verify", {
      challenge_id: challengeId,
      nonce,
      signed_payload: JSON.stringify(signed),
    });
  }

  deleteIdentity(): Promise<JsonObject> {
    return this.#authenticatedJson("/v1/buzz/nostr-identities/delete", {});
  }

  listCommunities(): Promise<JsonObject> {
    return this.#authenticatedJson("/v1/buzz/communities/list", {});
  }

  checkName(value: unknown): Promise<JsonObject> {
    return this.#authenticatedJson("/v1/buzz/communities/availability", {
      name: communityName(value),
    });
  }

  createCommunity(value: unknown): Promise<JsonObject> {
    return this.#authenticatedJson("/v1/buzz/communities", {
      name: communityName(value),
    });
  }

  archiveCommunity(value: unknown): Promise<JsonObject> {
    return this.#authenticatedJson("/v1/buzz/communities/archive", {
      community_id: opaqueId(value, "communityId"),
    });
  }

  unarchiveCommunity(value: unknown): Promise<JsonObject> {
    return this.#authenticatedJson("/v1/buzz/communities/unarchive", {
      community_id: opaqueId(value, "communityId"),
    });
  }

  transferCommunity(
    communityIdValue: unknown,
    transfereeNpubValue: unknown,
  ): Promise<JsonObject> {
    return this.#authenticatedJson("/v1/buzz/communities/transfer", {
      communityId: opaqueId(communityIdValue, "communityId"),
      transfereeNpub: validNpub(transfereeNpubValue),
    });
  }

  async shutdown(): Promise<void> {
    await this.cancelLogin();
    this.clearAuth();
  }

  async #authenticatedUser(credential: string): Promise<AuthInfo> {
    const value = await this.#request("/v1/auth/me", {
      authenticated: false,
      credential,
      method: "GET",
      timeoutMs: 30_000,
    });
    const expiresAt = requiredText(value.expires_at, "expires_at", 128);
    const email = optionalText(value.email, "email", 320);
    const name = optionalText(value.name, "name", 256);
    return {
      expiresAt,
      ...(email === undefined ? {} : { email }),
      ...(name === undefined ? {} : { name }),
    };
  }

  #authenticatedJson(path: string, body: JsonObject): Promise<JsonObject> {
    if (!this.#credential) {
      return Promise.reject(new Error("Sign in to Builderlab first"));
    }
    return this.#request(path, {
      authenticated: true,
      body,
      credential: this.#credential,
      timeoutMs: 60_000,
    });
  }

  async #request(
    path: string,
    input: {
      authenticated: boolean;
      body?: JsonObject;
      credential?: string;
      method?: "GET" | "POST";
      timeoutMs: number;
    },
  ): Promise<JsonObject> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (input.body) headers["Content-Type"] = "application/json";
    if (input.credential) headers[CREDENTIAL_HEADER] = input.credential;
    if (input.authenticated) headers.Origin = this.#origin;
    const response = await fetch(this.#url(path), {
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      headers,
      method: input.method ?? "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs),
    }).catch((error: unknown) => {
      throw new Error(
        `Builderlab request failed: ${error instanceof Error ? error.message : "network error"}`,
      );
    });
    const value = await responseObject(response);
    if (!response.ok && value.error === undefined) {
      throw new Error(`Builderlab request failed (HTTP ${response.status})`);
    }
    return value;
  }

  #url(relativePath: string): URL {
    if (!/^\/v1\/[a-z0-9_/-]+$/.test(relativePath)) {
      throw new Error("invalid Builderlab API path");
    }
    const url = new URL(this.#apiBase);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${relativePath}`;
    url.search = "";
    url.hash = "";
    return url;
  }
}

function validateApiBase(value: string): URL {
  const url = new URL(value);
  const loopback = isLoopback(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Builderlab API base must use HTTPS without credentials");
  }
  return url;
}

function validateOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.origin !== value.replace(/\/+$/, "") ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback(url.hostname))) ||
    url.username ||
    url.password
  ) {
    throw new Error("Builderlab origin is invalid");
  }
  return url.origin;
}

async function responseObject(response: Response): Promise<JsonObject> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT) {
    throw new Error("Builderlab response exceeds the 1 MiB limit");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new Error("Builderlab response exceeds the 1 MiB limit");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("invalid Builderlab JSON response");
  }
  if (!isRecord(value)) throw new Error("invalid Builderlab response shape");
  return value;
}

function communityName(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("community name must be a string");
  const name = value.trim().toLowerCase();
  if (name.length > 63 || !COMMUNITY_NAME.test(name)) {
    throw new Error(
      "community name must use lowercase letters, numbers, and hyphens",
    );
  }
  return name;
}

function opaqueId(value: unknown, name: string): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function validNpub(value: unknown): string {
  if (typeof value !== "string" || value.length > 128) {
    throw new Error("transfereeNpub is invalid");
  }
  let decoded;
  try {
    decoded = nip19.decode(value.trim().toLowerCase());
  } catch {
    throw new Error("transfereeNpub is invalid");
  }
  if (decoded.type !== "npub" || typeof decoded.data !== "string") {
    throw new Error("transfereeNpub is invalid");
  }
  return value.trim().toLowerCase();
}

function requiredText(value: unknown, name: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new Error(`invalid Builderlab ${name}`);
  }
  return value;
}

function optionalText(
  value: unknown,
  name: string,
  maxBytes: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredText(value, name, maxBytes);
}

function isLoopback(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return value === "localhost" || value === "::1" || value.startsWith("127.");
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deferred<T>(): {
  promise: Promise<T>;
  reject(error: Error): void;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function raceLogin(
  promise: Promise<string>,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Builderlab authentication timed out")),
      LOGIN_TIMEOUT_MS,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error("Builderlab authentication canceled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const AUTH_COMPLETE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Buzz authentication complete</title><style>
:root{color-scheme:light;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#231e1e;background:#d7d72e}
*{box-sizing:border-box}body{min-height:100dvh;margin:0;display:grid;place-items:center;padding:24px;background:#d7d72e}
main{width:min(100%,560px);padding:56px;border:2px solid #231e1e;border-radius:28px;background:#d7e7f6;box-shadow:8px 8px 0 #231e1e}
h1{margin:0;font-size:clamp(40px,9vw,64px);letter-spacing:-.055em;line-height:.95}p{margin:24px 0 0;font-size:18px;line-height:1.45}
</style></head><body><main><h1>You&rsquo;re signed in.</h1><p>You can close this window and return to Buzz.</p></main></body></html>`;
