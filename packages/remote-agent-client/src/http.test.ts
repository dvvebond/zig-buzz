import { createHash } from "node:crypto";

import { generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";
import { KIND_HTTP_AUTH, verifyNostrEvent } from "@buzz/core";

import { createEnrollmentInvitation, revokeRemoteWorker } from "./http.js";

describe("remote-agent HTTP control", () => {
  it("mints an invitation with an exact body-bound NIP-98 signature", async () => {
    const secret = generateSecretKey();
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      const body = String(init?.body);
      const header = new Headers(init?.headers).get("Authorization");
      const event = decodeAuthorization(header);
      expect(verifyNostrEvent(event)).toBe(true);
      if (!verifyNostrEvent(event)) throw new Error("event did not verify");
      expect(event.kind).toBe(KIND_HTTP_AUTH);
      expect(tag(event.tags, "method")).toBe("POST");
      expect(tag(event.tags, "payload")).toBe(
        createHash("sha256").update(body).digest("hex"),
      );
      return Response.json(
        {
          enrollmentId: "c15e3cf6-d2ea-4b27-8e9e-2d2a0df4a92b",
          expiresAt: 1_785_250_600,
          token:
            "brap1_c15e3cf6-d2ea-4b27-8e9e-2d2a0df4a92b_" +
            `${event.pubkey}_${"A".repeat(43)}`,
        },
        { status: 201 },
      );
    });

    const invitation = await createEnrollmentInvitation({
      allowInsecureLocalhost: true,
      capabilities: ["deploy", "status"],
      fetchImplementation,
      ownerSecretKey: secret,
      relayUrl: "ws://localhost:3000/",
    });

    expect(invitation.enrollmentId).toBe(
      "c15e3cf6-d2ea-4b27-8e9e-2d2a0df4a92b",
    );
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("signs offline revocation without a request payload", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
      const event = decodeAuthorization(
        new Headers(init?.headers).get("Authorization"),
      );
      expect(verifyNostrEvent(event)).toBe(true);
      if (!verifyNostrEvent(event)) throw new Error("event did not verify");
      expect(tag(event.tags, "method")).toBe("DELETE");
      expect(event.tags.some((value) => value[0] === "payload")).toBe(false);
      return new Response(null, { status: 204 });
    });
    await revokeRemoteWorker({
      allowInsecureLocalhost: true,
      fetchImplementation,
      ownerSecretKey: generateSecretKey(),
      relayUrl: "ws://127.0.0.1:3000/",
      workerPubkey: "a".repeat(64),
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });
});

function decodeAuthorization(header: string | null): unknown {
  if (!header?.startsWith("Nostr ")) throw new Error("missing auth header");
  return JSON.parse(
    Buffer.from(header.slice("Nostr ".length), "base64").toString("utf8"),
  ) as unknown;
}

function tag(tags: readonly string[][], name: string): string | undefined {
  return tags.find((value) => value[0] === name)?.[1];
}
