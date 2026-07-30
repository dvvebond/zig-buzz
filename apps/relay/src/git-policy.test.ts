import { describe, expect, it } from "vitest";

import {
  evaluateGitPush,
  parseGitProtectionRules,
  signGitPolicyRequest,
  verifyGitPolicyRequest,
  ZERO_GIT_OID,
} from "./git-policy.js";

const commitA = "a".repeat(40);
const commitB = "b".repeat(40);

describe("Git push policy", () => {
  it("preserves built-in role floors and unions matching protections", () => {
    const rules = parseGitProtectionRules([
      ["buzz-protect", "refs/heads/*", "push:member", "no-force-push"],
      ["buzz-protect", "refs/heads/main", "push:admin", "no-delete"],
    ]);

    expect(
      evaluateGitPush(
        [
          {
            is_ancestor: true,
            new_oid: commitB,
            old_oid: commitA,
            ref_name: "refs/heads/main",
          },
        ],
        "member",
        rules,
      )[0]?.reason,
    ).toContain("admin");
    expect(
      evaluateGitPush(
        [
          {
            is_ancestor: false,
            new_oid: commitB,
            old_oid: commitA,
            ref_name: "refs/heads/feature",
          },
        ],
        "admin",
        rules,
      )[0]?.reason,
    ).toContain("no-force-push");
    expect(
      evaluateGitPush(
        [
          {
            is_ancestor: false,
            new_oid: ZERO_GIT_OID,
            old_oid: commitA,
            ref_name: "refs/heads/main",
          },
        ],
        "owner",
        rules,
      )[0]?.reason,
    ).toContain("no-delete");
  });

  it("authenticates a length-delimited callback without field ambiguity", () => {
    const secret = Buffer.alloc(32, 7);
    const request = {
      community_id: "019fa90c-55c4-7181-9e58-aa5eb4b51243",
      pusher_pubkey: "b".repeat(64),
      ref_updates: [
        {
          is_ancestor: false,
          new_oid: commitB,
          old_oid: commitA,
          ref_name: "refs/heads/main",
        },
      ],
      repo_id: "buzz",
      repo_owner: "a".repeat(64),
      timestamp: 1_785_280_000,
    } as const;
    const signature = signGitPolicyRequest(secret, request);

    expect(verifyGitPolicyRequest(secret, { ...request, signature })).toBe(
      true,
    );
    expect(
      verifyGitPolicyRequest(secret, {
        ...request,
        repo_id: "other",
        signature,
      }),
    ).toBe(false);
  });
});
