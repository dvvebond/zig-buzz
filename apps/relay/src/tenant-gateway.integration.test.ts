import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createRelayServer } from "./server.js";
import { TenantGateway, type ResolvedRelayTenant } from "./tenant-gateway.js";

const gateways: TenantGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

describe("row-zero tenant gateway", () => {
  it("resolves every request by Host, caches runtimes, and fails closed", async () => {
    const base = tenant("base.example", "11111111-1111-4111-8111-111111111111");
    const first = tenant("one.example", "22222222-2222-4222-8222-222222222222");
    const second = tenant(
      "two.example",
      "33333333-3333-4333-8333-333333333333",
    );
    const available = new Map(
      [base, first, second].map((value) => [value.host, value]),
    );
    const control = relayBackend(base.host);
    const created = new Map<string, number>();
    let resolverFailure = false;
    const gateway = new TenantGateway({
      controlBackend: control,
      controlHost: base.host,
      controlTenantId: base.id,
      createTenantBackend: (resolved) => {
        created.set(resolved.id, (created.get(resolved.id) ?? 0) + 1);
        return relayBackend(resolved.host);
      },
      host: "127.0.0.1",
      port: 0,
      resolveTenant: async (authority) => {
        if (resolverFailure) throw new Error("database unavailable");
        return available.get(authority);
      },
    });
    gateways.push(gateway);
    await gateway.listen();
    const origin = gatewayOrigin(gateway);

    const one = await request(origin, first.host, "/api/join-policy");
    expect(one.status).toBe(200);
    expect(JSON.parse(one.body)).toMatchObject({
      policy: { terms_markdown: first.host },
    });
    const two = await request(origin, second.host, "/api/join-policy");
    expect(JSON.parse(two.body)).toMatchObject({
      policy: { terms_markdown: second.host },
    });
    await request(origin, first.host, "/api/join-policy");
    expect(created.get(first.id)).toBe(1);

    available.delete(first.host);
    expect((await request(origin, first.host, "/events")).status).toBe(404);
    resolverFailure = true;
    const failed = await request(origin, second.host, "/events");
    expect(failed.status).toBe(404);
    expect(failed.body).toBe('{"error":"relay unavailable"}');
  });

  it("proxies WebSocket upgrades only after tenant binding", async () => {
    const base = tenant("base.example", "11111111-1111-4111-8111-111111111111");
    const target = tenant(
      "socket.example",
      "44444444-4444-4444-8444-444444444444",
    );
    const gateway = new TenantGateway({
      controlBackend: relayBackend(base.host),
      controlHost: base.host,
      controlTenantId: base.id,
      createTenantBackend: (resolved) => relayBackend(resolved.host),
      host: "127.0.0.1",
      port: 0,
      resolveTenant: async (authority) =>
        authority === target.host
          ? target
          : authority === base.host
            ? base
            : undefined,
    });
    gateways.push(gateway);
    await gateway.listen();
    const origin = gatewayOrigin(gateway).replace("http:", "ws:");

    const socket = new WebSocket(origin, {
      headers: { Host: target.host },
    });
    const challenge = await new Promise<unknown[]>((resolve, reject) => {
      socket.once("message", (raw) =>
        resolve(JSON.parse(raw.toString()) as unknown[]),
      );
      socket.once("error", reject);
    });
    expect(challenge[0]).toBe("AUTH");
    expect(challenge[1]).toMatch(/^[0-9a-f]{64}$/);
    socket.close();

    const unknown = new WebSocket(origin, {
      headers: { Host: "unknown.example" },
    });
    const status = await new Promise<number>((resolve) => {
      unknown.once("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.destroy();
      });
      unknown.once("error", () => resolve(0));
    });
    expect(status).toBe(404);
  });

  it("keeps health and generic NIP-11 available without tenant disclosure", async () => {
    const base = tenant("base.example", "11111111-1111-4111-8111-111111111111");
    const gateway = new TenantGateway({
      controlBackend: relayBackend(base.host),
      controlHost: base.host,
      controlTenantId: base.id,
      createTenantBackend: (resolved) => relayBackend(resolved.host),
      host: "127.0.0.1",
      port: 0,
      resolveTenant: async () => undefined,
    });
    gateways.push(gateway);
    await gateway.listen();
    const origin = gatewayOrigin(gateway);

    const health = await request(origin, "unmapped.example", "/_liveness");
    expect(health.status).toBe(200);
    const nip11 = await request(origin, "unmapped.example", "/", {
      Accept: "application/nostr+json",
    });
    expect(nip11.status).toBe(200);
    expect(JSON.parse(nip11.body)).toMatchObject({
      name: "Buzz Relay",
    });
    expect((await request(origin, "unmapped.example", "/events")).status).toBe(
      404,
    );
  });
});

function relayBackend(host: string) {
  return createRelayServer({
    community: host,
    host: "127.0.0.1",
    joinPolicy: {
      ageAttestationRequired: false,
      privacyMarkdown: null,
      termsMarkdown: host,
      version: "test-policy",
    },
    ownerPubkeys: new Set(),
    port: 0,
    publicUrl: new URL(`wss://${host}/`),
  });
}

function tenant(host: string, id: string): ResolvedRelayTenant {
  return { host, id };
}

function gatewayOrigin(gateway: TenantGateway): string {
  const address = gateway.address();
  if (!address || typeof address === "string") {
    throw new Error("gateway did not bind TCP");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function request(
  origin: string,
  host: string,
  path: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<{ readonly body: string; readonly status: number }> {
  const url = new URL(path, origin);
  return await new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      url,
      {
        headers: { ...extraHeaders, Host: host },
        method: "GET",
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: response.statusCode ?? 0,
          }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}
