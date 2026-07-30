import { generateKeyPairSync } from "node:crypto";
import {
  createServer,
  type Http2ServerRequest,
  type Http2ServerResponse,
} from "node:http2";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { APNS_RECONNECT_PAYLOAD } from "./model.js";
import { ApnsTransport, classifyApns } from "./apns.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe("APNs response classification", () => {
  it("never invalidates endpoints for provider configuration faults", () => {
    expect(classifyApns(410, "Unregistered", 7)).toEqual({
      type: "invalid_endpoint",
      unregisteredAt: 7,
    });
    expect(classifyApns(403, "InvalidProviderToken")).toEqual({
      type: "configuration_fault",
    });
    expect(classifyApns(429, "TooManyRequests")).toEqual({
      type: "retry",
    });
    expect(classifyApns(400, "BadTopic")).toEqual({
      type: "permanent_request_fault",
    });
  });

  it("sends only the compiled-in reconnect payload over HTTP/2", async () => {
    const bodies: Buffer[] = [];
    const headers: Array<Record<string, string | string[] | undefined>> = [];
    const server = createServer(
      (request: Http2ServerRequest, response: Http2ServerResponse) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          bodies.push(Buffer.concat(chunks));
          headers.push(request.headers);
          response.writeHead(200);
          response.end();
        });
      },
    );
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const { privateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const transport = new ApnsTransport(
      Buffer.from(privateKey.export({ format: "pem", type: "pkcs8" })),
      "kid",
      "team",
      "app.topic",
      origin,
      origin,
    );
    await expect(
      transport.send(
        {
          expiresAt: 1_234,
          requestId: "00000000-0000-0000-0000-000000000001",
        },
        "buzz-ios-production",
        "aabb",
      ),
    ).resolves.toEqual({ type: "accepted" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual(APNS_RECONNECT_PAYLOAD);
    expect(headers[0]).toMatchObject({
      "apns-expiration": "1234",
      "apns-id": "00000000-0000-0000-0000-000000000001",
      "apns-push-type": "alert",
      "apns-topic": "app.topic",
      ":path": "/3/device/aabb",
    });
  });
});
