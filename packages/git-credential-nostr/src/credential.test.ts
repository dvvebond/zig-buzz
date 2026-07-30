import { generateSecretKey, verifyEvent } from "nostr-tools";
import { describe, expect, it } from "vitest";
import {
  canonicalRepositoryUrl,
  createNip98Credential,
  parseChallengeMethod,
  parseCredentialRequest,
} from "./index.js";

describe("git credential nostr", () => {
  it("parses Git's authtype request and Nostr challenge", () => {
    const request = parseCredentialRequest(
      [
        "capability[]=authtype",
        "protocol=https",
        "host=relay.example",
        "path=git/alice/repo.git/info/refs?service=git-upload-pack",
        'wwwauth[]=Nostr realm="buzz", method="GET"',
        "",
      ].join("\n"),
    );
    expect(parseChallengeMethod(request.wwwauth ?? "")).toBe("GET");
    expect(
      canonicalRepositoryUrl({
        protocol: request.protocol ?? "",
        host: request.host ?? "",
        path: request.path ?? "",
      }),
    ).toBe("https://relay.example/git/alice/repo.git");
  });

  it("creates a verifiable kind-27235 event with optional owner auth", () => {
    const result = createNip98Credential({
      secretKey: generateSecretKey(),
      url: "https://relay.example/git/alice/repo.git",
      method: "POST",
      authTag: ["auth", "owner", "conditions", "signature"],
      now: 1_700_000_000,
    });
    expect(verifyEvent(result.event)).toBe(true);
    expect(result.event.kind).toBe(27_235);
    expect(result.event.tags).toContainEqual(["method", "POST"]);
    expect(
      JSON.parse(Buffer.from(result.credential, "base64").toString("utf8")),
    ).toEqual(JSON.parse(JSON.stringify(result.event)));
  });

  it("rejects path confusion", () => {
    expect(() =>
      canonicalRepositoryUrl({
        protocol: "https",
        host: "relay.example",
        path: "../admin",
      }),
    ).toThrow();
  });
});
