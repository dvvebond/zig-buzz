import { createHash } from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import { KIND_HTTP_AUTH, signNostrEvent } from "@buzz/core";

import {
  authenticateNip98,
  authenticateNip98Identity,
  Nip98ReplayGuard,
} from "./nip98.js";

const NOW = 1_785_250_000;
const SCOPE = "f4f037c4-8e3c-4c16-82f4-7803105a3ef1";

describe("NIP-98 enrollment endpoint authentication", () => {
  it("bounds the replay window instead of growing without limit", async () => {
    const guard = new Nip98ReplayGuard(1);
    await guard.accept(SCOPE, "a".repeat(64), NOW + 120, NOW);
    await expect(
      guard.accept(SCOPE, "b".repeat(64), NOW + 120, NOW),
    ).rejects.toThrowError(expect.objectContaining({ code: "RATE_LIMITED" }));
  });

  it("binds signature to method, URL, body, freshness, and one use", async () => {
    const secret = generateSecretKey();
    const body = Buffer.from('{"capabilities":["status"]}', "utf8");
    const url = "https://buzz.example.com/api/remote-agents/enrollments";
    const event = signNostrEvent(
      {
        content: "",
        created_at: NOW,
        kind: KIND_HTTP_AUTH,
        tags: [
          ["u", url],
          ["method", "POST"],
          ["payload", createHash("sha256").update(body).digest("hex")],
        ],
      },
      secret,
    );
    const header = `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
    const replayGuard = new Nip98ReplayGuard();

    await expect(
      authenticateNip98({
        authorizationHeader: header,
        body,
        method: "POST",
        now: NOW,
        publicUrl: url,
        replayGuard,
        replayScope: SCOPE,
      }),
    ).resolves.toBe(event.pubkey);
    await expect(
      authenticateNip98({
        authorizationHeader: header,
        body,
        method: "POST",
        now: NOW,
        publicUrl: url,
        replayGuard,
        replayScope: SCOPE,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "REPLAY_DETECTED" }),
    );
  });

  it("rejects a body substituted after signing", async () => {
    const secret = generateSecretKey();
    const signedBody = Buffer.from("{}", "utf8");
    const event = signNostrEvent(
      {
        content: "",
        created_at: NOW,
        kind: KIND_HTTP_AUTH,
        tags: [
          ["u", "https://buzz.example.com/api/remote-agents/enrollments"],
          ["method", "POST"],
          ["payload", createHash("sha256").update(signedBody).digest("hex")],
        ],
      },
      secret,
    );

    await expect(
      authenticateNip98({
        authorizationHeader: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`,
        body: Buffer.from('{"lifetimeSeconds":300}', "utf8"),
        method: "POST",
        now: NOW,
        publicUrl: "https://buzz.example.com/api/remote-agents/enrollments",
        replayGuard: new Nip98ReplayGuard(),
        replayScope: SCOPE,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "AUTH_REQUIRED" }));
  });

  it("verifies an owner credential and exposes delegation separately from authorship", async () => {
    const ownerSecret = generateSecretKey();
    const agentSecret = generateSecretKey();
    const agentPubkey = getPublicKey(agentSecret);
    const ownerPubkey = getPublicKey(ownerSecret);
    const conditions = `kind=0&created_at<${NOW + 30}`;
    const digest = createHash("sha256")
      .update(`nostr:agent-auth:${agentPubkey}:${conditions}`)
      .digest();
    const ownerSignature = Buffer.from(
      schnorr.sign(digest, ownerSecret),
    ).toString("hex");
    const url = "https://buzz.example.com/query";
    const body = Buffer.from('[{"kinds":[0]}]');
    const event = signNostrEvent(
      {
        content: "",
        created_at: NOW,
        kind: KIND_HTTP_AUTH,
        tags: [
          ["u", url],
          ["method", "POST"],
          ["payload", createHash("sha256").update(body).digest("hex")],
          ["auth", ownerPubkey, conditions, ownerSignature],
        ],
      },
      agentSecret,
    );

    await expect(
      authenticateNip98Identity({
        authorizationHeader: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`,
        body,
        method: "POST",
        now: NOW,
        publicUrl: url,
        replayGuard: new Nip98ReplayGuard(),
        replayScope: SCOPE,
      }),
    ).resolves.toEqual({ ownerPubkey, pubkey: agentPubkey });
  });

  it("fails closed for a forged, duplicated, or expired owner credential", async () => {
    const ownerSecret = generateSecretKey();
    const agentSecret = generateSecretKey();
    const agentPubkey = getPublicKey(agentSecret);
    const ownerPubkey = getPublicKey(ownerSecret);
    const url = "https://buzz.example.com/query";
    const body = Buffer.from("[]");
    const attempt = async (
      conditions: string,
      signatures: readonly string[],
    ): Promise<void> => {
      const event = signNostrEvent(
        {
          content: "",
          created_at: NOW,
          kind: KIND_HTTP_AUTH,
          tags: [
            ["u", url],
            ["method", "POST"],
            ["payload", createHash("sha256").update(body).digest("hex")],
            ...signatures.map((signature) => [
              "auth",
              ownerPubkey,
              conditions,
              signature,
            ]),
          ],
        },
        agentSecret,
      );
      await expect(
        authenticateNip98Identity({
          authorizationHeader: `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`,
          body,
          method: "POST",
          now: NOW,
          publicUrl: url,
          replayGuard: new Nip98ReplayGuard(),
          replayScope: SCOPE,
        }),
      ).rejects.toThrowError(
        expect.objectContaining({ code: "SIGNATURE_INVALID" }),
      );
    };

    await attempt("", ["00".repeat(64)]);
    const expiredConditions = `created_at<${NOW}`;
    const expiredDigest = createHash("sha256")
      .update(`nostr:agent-auth:${agentPubkey}:${expiredConditions}`)
      .digest();
    const expiredSignature = Buffer.from(
      schnorr.sign(expiredDigest, ownerSecret),
    ).toString("hex");
    await attempt(expiredConditions, [expiredSignature]);
    await attempt("", ["00".repeat(64), "11".repeat(64)]);
  });
});
