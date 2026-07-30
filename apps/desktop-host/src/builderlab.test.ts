import { createServer } from "node:http";

import { verifyEvent } from "nostr-tools";
import { afterEach, describe, expect, it } from "vitest";

import { BuilderlabService } from "./builderlab.js";
import { IdentityService } from "./identity.js";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((close) => close()));
});

describe("BuilderlabService", () => {
  it("completes loopback OAuth and signs the identity challenge locally", async () => {
    const requests: Array<{
      body: Record<string, unknown>;
      credential: string | undefined;
      origin: string | undefined;
      path: string;
    }> = [];
    const expiry = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const api = createServer((request, response) => {
      void readBody(request).then((body) => {
        const path = request.url ?? "";
        requests.push({
          body,
          credential:
            typeof request.headers["x-bb-session-credential"] === "string"
              ? request.headers["x-bb-session-credential"]
              : undefined,
          origin: request.headers.origin,
          path,
        });
        let result: Record<string, unknown>;
        if (path.endsWith("/v1/auth/login/exchange")) {
          result = {
            expires_at: expiry,
            session_credential: "session-secret",
          };
        } else if (path.endsWith("/v1/auth/me")) {
          result = {
            email: "dev@example.test",
            expires_at: expiry,
            name: "Developer",
          };
        } else if (path.endsWith("/v1/buzz/nostr-identities/challenge")) {
          result = {
            challenge_id: "123e4567-e89b-42d3-a456-426614174000",
            expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
            nonce: "A".repeat(43),
            origin: "https://app.builderlab.xyz",
            verification_code: "123456",
          };
        } else if (path.endsWith("/v1/buzz/nostr-identities/verify")) {
          result = {
            identity: { pubkey_hex: "accepted" },
          };
        } else if (path.endsWith("/v1/buzz/communities/list")) {
          result = { communities: [] };
        } else {
          result = { ok: true };
        }
        const encoded = JSON.stringify(result);
        response.writeHead(200, {
          "Content-Length": Buffer.byteLength(encoded),
          "Content-Type": "application/json",
        });
        response.end(encoded);
      });
    });
    await listen(api);
    cleanup.push(() => close(api));
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const identity = IdentityService.create(undefined, async () => undefined);
    let openedUrl: string | undefined;
    const service = new BuilderlabService({
      apiBaseUrl: `http://127.0.0.1:${address.port}/api/goose`,
      identity,
      openExternal: (url) => {
        openedUrl = url;
      },
    });
    cleanup.push(() => service.shutdown());

    const login = service.startLogin();
    await waitFor(() => openedUrl !== undefined);
    const authorization = new URL(openedUrl as string);
    expect(authorization.searchParams.get("type")).toBe("cli");
    expect(authorization.searchParams.get("product")).toBe("buzz");
    const returnTo = authorization.searchParams.get("returnTo");
    if (!returnTo) throw new Error("missing returnTo");
    const callback = new URL(returnTo);
    callback.searchParams.set("code", "one-time-code");
    const callbackResponse = await fetch(callback);
    expect(callbackResponse.status).toBe(200);
    expect(await callbackResponse.text()).toContain("return to Buzz");

    await expect(login).resolves.toEqual({
      email: "dev@example.test",
      expiresAt: expiry,
      name: "Developer",
    });
    await expect(service.getAuth()).resolves.toMatchObject({
      email: "dev@example.test",
    });
    await expect(service.listCommunities()).resolves.toEqual({
      communities: [],
    });
    await expect(service.bindIdentity()).resolves.toEqual({
      identity: { pubkey_hex: "accepted" },
    });

    const verifyRequest = requests.find((entry) =>
      entry.path.endsWith("/v1/buzz/nostr-identities/verify"),
    );
    expect(verifyRequest?.credential).toBe("session-secret");
    expect(verifyRequest?.origin).toBe("https://app.builderlab.xyz");
    const signedPayload = verifyRequest?.body.signed_payload;
    expect(typeof signedPayload).toBe("string");
    const signed = JSON.parse(String(signedPayload)) as Parameters<
      typeof verifyEvent
    >[0];
    expect(verifyEvent(signed)).toBe(true);
    expect(signed.pubkey).toBe(identity.info().pubkey);
    expect(signed.kind).toBe(24_243);
  });

  it("cancels an outstanding login and validates mutation inputs locally", async () => {
    const identity = IdentityService.create(undefined, async () => undefined);
    let openedUrl: string | undefined;
    const service = new BuilderlabService({
      identity,
      openExternal: (url) => {
        openedUrl = url;
      },
    });
    cleanup.push(() => service.shutdown());
    const login = service.startLogin();
    await waitFor(() => openedUrl !== undefined);
    await service.cancelLogin();
    await expect(login).rejects.toThrow(/canceled/);
    expect(() => service.createCommunity("UPPER CASE")).toThrow(/lowercase/);
    expect(() => service.transferCommunity("../escape", "not-an-npub")).toThrow(
      /communityId/,
    );
  });
});

async function readBody(
  request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function listen(server: import("node:http").Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: import("node:http").Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("test timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
