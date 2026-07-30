import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { normalizeCandidateHost } from "./operator-http.js";

const MAX_CACHED_TENANTS = 1_024;
const CONTROL_PATH_PREFIX = "/operator/";
const GLOBAL_PATHS = new Set([
  "/_liveness",
  "/_mesh",
  "/_readiness",
  "/_status",
  "/health",
  "/health/ready",
  "/metrics",
  "/ready",
  "/status",
]);

export interface TenantGatewayBackend {
  address(): ReturnType<import("node:http").Server["address"]>;
  close(): Promise<void>;
  listen(): Promise<void>;
}

export interface ResolvedRelayTenant {
  readonly host: string;
  readonly id: string;
}

export interface TenantGatewayOptions {
  readonly controlAuthorities?: ReadonlySet<string>;
  readonly controlBackend: TenantGatewayBackend;
  readonly controlHost: string;
  readonly controlTenantId?: string;
  readonly createTenantBackend: (
    tenant: ResolvedRelayTenant,
  ) => Promise<TenantGatewayBackend> | TenantGatewayBackend;
  readonly host: string;
  readonly maxCachedTenants?: number;
  readonly port: number;
  readonly resolveTenant: (
    normalizedAuthority: string,
  ) => Promise<ResolvedRelayTenant | undefined>;
}

interface CachedBackend {
  active: number;
  readonly backend: TenantGatewayBackend;
  readonly host: string;
  readonly id: string;
  lastUsed: number;
}

/**
 * Row-zero multi-tenant listener.
 *
 * Every non-global request resolves its normalized Host against durable state
 * before any tenant backend sees bytes. Unknown hosts and lookup failures share
 * one generic 404 response, so callers cannot distinguish tenant existence from
 * resolver health. Backends bind loopback-only ephemeral ports and are never
 * directly exposed.
 */
export class TenantGateway {
  readonly #cache = new Map<string, CachedBackend>();
  readonly #creating = new Map<string, Promise<CachedBackend>>();
  readonly #controlAuthorities: ReadonlySet<string>;
  readonly #controlHost: string;
  readonly #maxCachedTenants: number;
  readonly #options: TenantGatewayOptions;
  readonly #server = createServer((request, response) => {
    void this.#handleHttp(request, response);
  });
  #closing = false;

  public constructor(options: TenantGatewayOptions) {
    if (
      !Number.isSafeInteger(options.port) ||
      options.port < 0 ||
      options.port > 65_535
    ) {
      throw new TypeError("tenant gateway port is invalid");
    }
    this.#maxCachedTenants = options.maxCachedTenants ?? MAX_CACHED_TENANTS;
    if (
      !Number.isSafeInteger(this.#maxCachedTenants) ||
      this.#maxCachedTenants < 1
    ) {
      throw new TypeError(
        "tenant gateway cache limit must be a positive safe integer",
      );
    }
    this.#controlAuthorities = new Set(
      [...(options.controlAuthorities ?? [])].map(normalizeAuthority),
    );
    this.#controlHost = normalizeAuthority(options.controlHost);
    this.#options = options;
    this.#server.on("upgrade", (request, socket, head) => {
      void this.#handleUpgrade(request, socket, head);
    });
  }

  public address(): ReturnType<import("node:http").Server["address"]> {
    return this.#server.address();
  }

  public async listen(): Promise<void> {
    await this.#options.controlBackend.listen();
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#options.port, this.#options.host, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
  }

  public async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
    const backends = new Set<TenantGatewayBackend>([
      this.#options.controlBackend,
      ...[...this.#cache.values()].map((entry) => entry.backend),
    ]);
    await Promise.allSettled([...backends].map((backend) => backend.close()));
    this.#cache.clear();
    this.#creating.clear();
  }

  async #handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const target = await this.#resolveRequest(request, false);
      if (!target) {
        rejectUnknownHttp(response);
        return;
      }
      target.active += 1;
      const release = once(() => {
        target.active = Math.max(0, target.active - 1);
        target.lastUsed = Date.now();
      });
      proxyHttp(request, response, target.backend, target.host, release);
    } catch {
      rejectUnknownHttp(response);
    }
  }

  async #handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    try {
      const target = await this.#resolveRequest(request, true);
      if (!target) {
        rejectUnknownUpgrade(socket);
        return;
      }
      target.active += 1;
      const release = once(() => {
        target.active = Math.max(0, target.active - 1);
        target.lastUsed = Date.now();
      });
      proxyUpgrade(request, socket, head, target.backend, target.host, release);
    } catch {
      rejectUnknownUpgrade(socket);
    }
  }

  async #resolveRequest(
    request: IncomingMessage,
    upgrade: boolean,
  ): Promise<CachedBackend | undefined> {
    if (this.#closing) return undefined;
    const authority = safeNormalizeAuthority(request.headers.host);
    const pathname = safePathname(request.url);
    if (
      !upgrade &&
      isControlRequest(authority, pathname, this.#controlAuthorities)
    ) {
      return {
        active: 0,
        backend: this.#options.controlBackend,
        host: GLOBAL_PATHS.has(pathname) ? this.#controlHost : authority,
        id: "control",
        lastUsed: Date.now(),
      };
    }
    if (!authority) return undefined;

    let tenant: ResolvedRelayTenant | undefined;
    try {
      tenant = await this.#options.resolveTenant(authority);
    } catch {
      return undefined;
    }
    if (!tenant) {
      if (!upgrade && isFailOpenGlobalRequest(request, pathname)) {
        return {
          active: 0,
          backend: this.#options.controlBackend,
          host: authority,
          id: "control",
          lastUsed: Date.now(),
        };
      }
      return undefined;
    }
    const canonicalHost = normalizeAuthority(tenant.host);
    if (canonicalHost !== authority) return undefined;
    return await this.#backendFor({ ...tenant, host: canonicalHost });
  }

  async #backendFor(tenant: ResolvedRelayTenant): Promise<CachedBackend> {
    if (
      this.#options.controlTenantId === tenant.id &&
      tenant.host === this.#controlHost
    ) {
      return {
        active: 0,
        backend: this.#options.controlBackend,
        host: tenant.host,
        id: tenant.id,
        lastUsed: Date.now(),
      };
    }
    const cached = this.#cache.get(tenant.id);
    if (cached && cached.host === tenant.host) {
      cached.lastUsed = Date.now();
      return cached;
    }
    const existing = this.#creating.get(tenant.id);
    if (existing) return await existing;
    const creating = this.#createBackend(tenant);
    this.#creating.set(tenant.id, creating);
    try {
      return await creating;
    } finally {
      this.#creating.delete(tenant.id);
    }
  }

  async #createBackend(tenant: ResolvedRelayTenant): Promise<CachedBackend> {
    await this.#makeRoom();
    const backend = await this.#options.createTenantBackend(tenant);
    try {
      await backend.listen();
    } catch (error) {
      await backend.close().catch(() => undefined);
      throw error;
    }
    const entry: CachedBackend = {
      active: 0,
      backend,
      host: tenant.host,
      id: tenant.id,
      lastUsed: Date.now(),
    };
    const raced = this.#cache.get(tenant.id);
    if (raced) {
      await backend.close().catch(() => undefined);
      raced.lastUsed = Date.now();
      return raced;
    }
    this.#cache.set(tenant.id, entry);
    return entry;
  }

  async #makeRoom(): Promise<void> {
    if (this.#cache.size < this.#maxCachedTenants) return;
    const oldest = [...this.#cache.values()]
      .filter((entry) => entry.active === 0)
      .sort((left, right) => left.lastUsed - right.lastUsed)[0];
    if (!oldest) throw new Error("tenant runtime capacity exceeded");
    this.#cache.delete(oldest.id);
    await oldest.backend.close();
  }
}

function isControlRequest(
  authority: string,
  pathname: string,
  controlAuthorities: ReadonlySet<string>,
): boolean {
  return (
    pathname.startsWith(CONTROL_PATH_PREFIX) ||
    GLOBAL_PATHS.has(pathname) ||
    controlAuthorities.has(authority)
  );
}

function isFailOpenGlobalRequest(
  request: IncomingMessage,
  pathname: string,
): boolean {
  if (GLOBAL_PATHS.has(pathname)) return true;
  if (request.method !== "GET" || (pathname !== "/" && pathname !== "/info")) {
    return false;
  }
  return (request.headers.accept ?? "")
    .toLowerCase()
    .includes("application/nostr+json");
}

function safePathname(value: string | undefined): string {
  try {
    return new URL(value ?? "", "http://gateway.invalid").pathname;
  } catch {
    return "";
  }
}

function safeNormalizeAuthority(value: string | undefined): string {
  if (!value) return "";
  try {
    return normalizeAuthority(value);
  } catch {
    return "";
  }
}

function normalizeAuthority(value: string): string {
  return normalizeCandidateHost(value);
}

function backendAddress(backend: TenantGatewayBackend): AddressInfo {
  const address = backend.address();
  if (!address || typeof address === "string") {
    throw new Error("tenant backend is not listening on TCP");
  }
  return address;
}

function proxyHttp(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  backend: TenantGatewayBackend,
  canonicalHost: string,
  onDone: () => void,
): void {
  const address = backendAddress(backend);
  const headers = proxyHeaders(incoming.headers, canonicalHost);
  const proxied = httpRequest({
    headers,
    host: loopbackFor(address),
    method: incoming.method,
    path: incoming.url,
    port: address.port,
  });
  proxied.once("response", (response) => {
    if (outgoing.headersSent || outgoing.destroyed) {
      response.destroy();
      return;
    }
    outgoing.writeHead(
      response.statusCode ?? 502,
      response.statusMessage,
      response.headers,
    );
    response.pipe(outgoing);
    response.once("end", onDone);
    response.once("error", onDone);
  });
  proxied.once("error", () => {
    onDone();
    if (!outgoing.headersSent && !outgoing.destroyed) {
      genericJson(outgoing, 502, "relay backend unavailable");
    } else {
      outgoing.destroy();
    }
  });
  incoming.once("aborted", () => proxied.destroy());
  incoming.pipe(proxied);
}

function proxyUpgrade(
  incoming: IncomingMessage,
  outgoing: Duplex,
  head: Buffer,
  backend: TenantGatewayBackend,
  canonicalHost: string,
  onDone: () => void,
): void {
  const address = backendAddress(backend);
  const proxied = httpRequest({
    headers: proxyHeaders(incoming.headers, canonicalHost, true),
    host: loopbackFor(address),
    method: incoming.method,
    path: incoming.url,
    port: address.port,
  });
  proxied.once("upgrade", (response, backendSocket, backendHead) => {
    const status = response.statusCode ?? 101;
    const statusMessage = response.statusMessage ?? "Switching Protocols";
    outgoing.write(`HTTP/1.1 ${status} ${statusMessage}\r\n`);
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) outgoing.write(`${name}: ${item}\r\n`);
      } else {
        outgoing.write(`${name}: ${value}\r\n`);
      }
    }
    outgoing.write("\r\n");
    if (backendHead.byteLength > 0) outgoing.write(backendHead);
    if (head.byteLength > 0) backendSocket.write(head);
    backendSocket.pipe(outgoing);
    outgoing.pipe(backendSocket);
    backendSocket.once("close", onDone);
  });
  proxied.once("response", (response) => {
    onDone();
    outgoing.write(
      `HTTP/1.1 ${response.statusCode ?? 404} ${response.statusMessage ?? "Not Found"}\r\nConnection: close\r\n\r\n`,
    );
    outgoing.destroy();
    response.destroy();
  });
  proxied.once("error", () => {
    onDone();
    rejectUnknownUpgrade(outgoing);
  });
  outgoing.once("error", () => proxied.destroy());
  outgoing.once("close", () => proxied.destroy());
  proxied.end();
}

function proxyHeaders(
  incoming: IncomingHttpHeaders,
  canonicalHost: string,
  upgrade = false,
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = { ...incoming, host: canonicalHost };
  delete headers["proxy-connection"];
  if (!upgrade) {
    delete headers.connection;
    delete headers.upgrade;
    headers.connection = "close";
  }
  return headers;
}

function loopbackFor(address: AddressInfo): string {
  return address.family === "IPv6" ? "::1" : "127.0.0.1";
}

function rejectUnknownHttp(response: ServerResponse): void {
  genericJson(response, 404, "relay unavailable");
}

function genericJson(
  response: ServerResponse,
  status: number,
  error: string,
): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify({ error }));
}

function rejectUnknownUpgrade(socket: Duplex): void {
  if (socket.destroyed) return;
  socket.end(
    "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
  );
}

function once(callback: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    callback();
  };
}
