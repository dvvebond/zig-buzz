import { schnorr } from "@noble/curves/secp256k1.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { parseAndVerifyAuthTag, parseCli } from "./main.js";

describe("Buzz CLI parser", () => {
  it("maps repeated and boolean Rust-compatible flags", () => {
    expect(
      parseCli([
        "repos",
        "protect",
        "set",
        "--id",
        "buzz",
        "--ref",
        "refs/heads/main",
        "--no-force-push",
        "--no-delete",
      ]),
    ).toMatchObject({
      action: "protect-set",
      flags: {
        id: "buzz",
        noDelete: true,
        noForcePush: true,
        ref: "refs/heads/main",
      },
      resource: "repos",
    });
    expect(
      parseCli([
        "pr",
        "open",
        "--clone",
        "https://one.example/repo",
        "--clone",
        "https://two.example/repo",
        "--label",
        "bug",
      ]).flags,
    ).toMatchObject({
      cloneUrls: ["https://one.example/repo", "https://two.example/repo"],
      labels: ["bug"],
    });
  });

  it("maps positional media and memory arguments", () => {
    expect(parseCli(["media", "get", `${"a".repeat(64)}.png`]).flags).toEqual({
      input: `${"a".repeat(64)}.png`,
    });
    expect(parseCli(["mem", "set", "notes/today", "hello"]).flags).toEqual({
      slug: "notes/today",
      value: "hello",
    });
    expect(
      parseCli(["media", "get", "abc.png", "-o", "saved.png"]),
    ).toMatchObject({ flags: { input: "abc.png", output: "saved.png" } });
  });

  it("accepts stdin sentinels and explicit owner auth tags", () => {
    expect(
      parseCli([
        "--auth-tag",
        '["auth","owner","","signature"]',
        "messages",
        "send",
        "--content",
        "-",
      ]),
    ).toMatchObject({
      authTag: '["auth","owner","","signature"]',
      flags: { content: "-" },
    });
  });

  it("cryptographically verifies NIP-OA owner attestations", () => {
    const ownerSecret = schnorr.utils.randomSecretKey();
    const agentSecret = schnorr.utils.randomSecretKey();
    const owner = Buffer.from(schnorr.getPublicKey(ownerSecret)).toString(
      "hex",
    );
    const agent = Buffer.from(schnorr.getPublicKey(agentSecret)).toString(
      "hex",
    );
    const conditions = "kind=9&created_at>1";
    const digest = createHash("sha256")
      .update(`nostr:agent-auth:${agent}:${conditions}`, "utf8")
      .digest();
    const signature = Buffer.from(
      schnorr.sign(Uint8Array.from(digest), ownerSecret),
    ).toString("hex");
    const encoded = JSON.stringify(["auth", owner, conditions, signature]);
    expect(parseAndVerifyAuthTag(encoded, agentSecret)).toEqual([
      "auth",
      owner,
      conditions,
      signature,
    ]);
    expect(() =>
      parseAndVerifyAuthTag(
        JSON.stringify(["auth", owner, conditions, "0".repeat(128)]),
        agentSecret,
      ),
    ).toThrow("verification failed");
  });

  it("rejects unexpected positional values", () => {
    expect(() => parseCli(["feed", "get", "unexpected"])).toThrow(
      "unexpected positional",
    );
  });
});
