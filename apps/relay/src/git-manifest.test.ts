import { describe, expect, it } from "vitest";

import {
  canonicalGitManifestBytes,
  gitObjectDigest,
  gitPointerKey,
  isSafeGitRefname,
  parseGitManifest,
  validateGitRepoName,
} from "./git-manifest.js";

describe("Git manifest", () => {
  it("uses the Rust-compatible canonical field order", () => {
    const bytes = canonicalGitManifestBytes({
      head: "refs/heads/main",
      packs: [],
      parent: null,
      refs: {
        "refs/heads/z": "b".repeat(40),
        "refs/heads/a": "a".repeat(40),
      },
      version: 1,
    });

    expect(bytes.toString("utf8")).toBe(
      `{"version":1,"head":"refs/heads/main","refs":{"refs/heads/a":"${"a".repeat(
        40,
      )}","refs/heads/z":"${"b".repeat(40)}"},"packs":[],"parent":null}`,
    );
    expect(gitObjectDigest(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects ambiguous refs, unknown fields, and unsafe repo names", () => {
    expect(isSafeGitRefname("refs/heads/feature/one")).toBe(true);
    expect(isSafeGitRefname("refs/heads/../admin")).toBe(false);
    expect(() =>
      parseGitManifest({
        extra: true,
        head: "refs/heads/main",
        packs: [],
        parent: null,
        refs: {},
        version: 1,
      }),
    ).toThrow("fields");
    expect(() => validateGitRepoName("../admin")).toThrow();
    expect(validateGitRepoName("project.git")).toBe("project");
  });

  it("binds mutable pointers to a tenant and owner", () => {
    expect(
      gitPointerKey(
        "019fa90c-55c4-7181-9e58-aa5eb4b51243",
        "a".repeat(64),
        "buzz.git",
      ),
    ).toBe(
      `repos/019fa90c-55c4-7181-9e58-aa5eb4b51243/${"a".repeat(
        64,
      )}/buzz/pointer`,
    );
  });
});
