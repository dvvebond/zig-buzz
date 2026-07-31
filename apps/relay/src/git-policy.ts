import { createHmac, timingSafeEqual } from "node:crypto";

export const MAX_GIT_PROTECTION_RULES = 50;
export const MAX_GIT_REF_UPDATES = 500;
export const ZERO_GIT_OID = "0".repeat(40);

/** Channel roles understood by the Git authorization policy. */
export type GitRole = "owner" | "admin" | "member" | "guest" | "bot";

/** One ref update reported by Git's pre-receive hook. */
export type GitRefUpdate = {
  readonly old_oid: string;
  readonly new_oid: string;
  readonly ref_name: string;
  readonly is_ancestor: boolean;
};

/** Authenticated localhost callback body emitted by the pre-receive hook. */
export type GitPolicyRequest = {
  readonly repo_id: string;
  readonly repo_owner: string;
  readonly community_id: string;
  readonly pusher_pubkey: string;
  readonly ref_updates: readonly GitRefUpdate[];
  readonly timestamp: number;
  readonly signature: string;
};

/** A ref-level push denial suitable for returning to Git. */
export type GitPolicyDenial = {
  readonly ref_name: string;
  readonly reason: string;
};

type GitUpdateKind = "create" | "fast-forward" | "non-fast-forward" | "delete";

type GitProtectionRule = {
  readonly pattern: readonly string[];
  readonly pushRole?: Exclude<GitRole, "guest" | "bot">;
  readonly noForcePush: boolean;
  readonly noDelete: boolean;
  readonly requirePatch: boolean;
};

/** Compute the exact length-delimited HMAC payload used by the hook protocol. */
export function gitPolicyHmacPayload(
  request: Omit<GitPolicyRequest, "signature">,
): Buffer {
  const updates = [...request.ref_updates].sort((left, right) =>
    Buffer.from(left.ref_name).compare(Buffer.from(right.ref_name)),
  );
  let value =
    `${Buffer.byteLength(request.repo_id, "utf8")}:${request.repo_id}|` +
    `${request.repo_owner}|${request.community_id}|${request.pusher_pubkey}|`;
  for (const update of updates) {
    value +=
      update.old_oid +
      update.new_oid +
      `${Buffer.byteLength(update.ref_name, "utf8")}:${update.ref_name}` +
      (update.is_ancestor ? "1" : "0");
  }
  value += `|${request.timestamp}`;
  return Buffer.from(value, "utf8");
}

/** Generate the HMAC-SHA256 signature for one hook callback. */
export function signGitPolicyRequest(
  secret: Uint8Array,
  request: Omit<GitPolicyRequest, "signature">,
): string {
  return createHmac("sha256", secret)
    .update(gitPolicyHmacPayload(request))
    .digest("hex");
}

/** Verify a hook signature without timing-dependent early comparison. */
export function verifyGitPolicyRequest(
  secret: Uint8Array,
  request: GitPolicyRequest,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(request.signature)) return false;
  const expected = Buffer.from(signGitPolicyRequest(secret, request), "hex");
  const actual = Buffer.from(request.signature, "hex");
  return (
    actual.byteLength === expected.byteLength &&
    timingSafeEqual(actual, expected)
  );
}

/**
 * Parse protection tags from kind:30617. Unknown rule names are ignored for
 * forward compatibility; malformed patterns and roles fail closed.
 */
export function parseGitProtectionRules(
  tags: readonly (readonly string[])[],
): readonly GitProtectionRule[] {
  const rules: GitProtectionRule[] = [];
  for (const tag of tags) {
    if (tag[0] !== "buzz-protect") continue;
    if (rules.length >= MAX_GIT_PROTECTION_RULES) {
      throw new Error("too many Git protection rules");
    }
    const pattern = parsePattern(tag[1]);
    if (tag.length < 3) {
      throw new Error("Git protection rule needs a constraint");
    }
    let pushRole: Exclude<GitRole, "guest" | "bot"> | undefined;
    let noForcePush = false;
    let noDelete = false;
    let requirePatch = false;
    for (const constraint of tag.slice(2)) {
      if (constraint?.startsWith("push:")) {
        const role = constraint.slice(5);
        if (role !== "member" && role !== "admin" && role !== "owner") {
          throw new Error("invalid Git protection role");
        }
        if (!pushRole || roleLevel(role) > roleLevel(pushRole)) {
          pushRole = role;
        }
      } else if (constraint === "no-force-push") {
        noForcePush = true;
      } else if (constraint === "no-delete") {
        noDelete = true;
      } else if (constraint === "require-patch") {
        requirePatch = true;
      }
    }
    rules.push({
      noDelete,
      noForcePush,
      pattern,
      ...(pushRole ? { pushRole } : {}),
      requirePatch,
    });
  }
  return rules;
}

/** Evaluate every ref atomically and return all policy denials. */
export function evaluateGitPush(
  updates: readonly GitRefUpdate[],
  role: GitRole,
  rules: readonly GitProtectionRule[],
): readonly GitPolicyDenial[] {
  const effectiveRole = role === "bot" ? "member" : role;
  const denials: GitPolicyDenial[] = [];
  for (const update of updates) {
    const kind = classifyUpdate(update);
    const matching = rules.filter((rule) =>
      patternMatches(rule.pattern, update.ref_name),
    );
    if (matching.length === 0) {
      const required = defaultRole(update.ref_name, kind);
      if (roleLevel(effectiveRole) < roleLevel(required)) {
        denials.push({
          reason: `requires ${required} role (you have ${effectiveRole}), using built-in defaults`,
          ref_name: update.ref_name,
        });
      }
      continue;
    }
    if (matching.some((rule) => rule.requirePatch)) {
      denials.push({
        reason:
          "direct push denied: require-patch is set, submit a NIP-34 patch",
        ref_name: update.ref_name,
      });
      continue;
    }
    const defaultMinimum = defaultRole(update.ref_name, kind);
    const explicitMinimum = matching
      .flatMap((rule) => (rule.pushRole ? [rule.pushRole] : []))
      .sort((left, right) => roleLevel(right) - roleLevel(left))[0];
    const required =
      explicitMinimum && roleLevel(explicitMinimum) > roleLevel(defaultMinimum)
        ? explicitMinimum
        : defaultMinimum;
    if (roleLevel(effectiveRole) < roleLevel(required)) {
      denials.push({
        reason: `requires ${required} role (you have ${effectiveRole})`,
        ref_name: update.ref_name,
      });
      continue;
    }
    if (
      kind === "non-fast-forward" &&
      matching.some((rule) => rule.noForcePush)
    ) {
      denials.push({
        reason: "non-fast-forward update denied: no-force-push is set",
        ref_name: update.ref_name,
      });
    } else if (kind === "delete" && matching.some((rule) => rule.noDelete)) {
      denials.push({
        reason: "ref deletion denied: no-delete is set",
        ref_name: update.ref_name,
      });
    }
  }
  return denials;
}

/** Validate the complete structural surface before HMAC/DB work. */
export function validateGitPolicyRequest(value: unknown): GitPolicyRequest {
  if (!isRecord(value)) throw new Error("invalid Git policy request");
  if (
    typeof value.repo_id !== "string" ||
    value.repo_id.length < 1 ||
    value.repo_id.length > 64 ||
    typeof value.repo_owner !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.repo_owner) ||
    typeof value.community_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.community_id,
    ) ||
    typeof value.pusher_pubkey !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.pusher_pubkey) ||
    !Number.isSafeInteger(value.timestamp) ||
    (value.timestamp as number) < 0 ||
    typeof value.signature !== "string" ||
    !Array.isArray(value.ref_updates) ||
    value.ref_updates.length < 1 ||
    value.ref_updates.length > MAX_GIT_REF_UPDATES
  ) {
    throw new Error("invalid Git policy request");
  }
  const refUpdates = value.ref_updates.map((update) => {
    if (
      !isRecord(update) ||
      typeof update.old_oid !== "string" ||
      !/^[0-9a-f]{40}$/.test(update.old_oid) ||
      typeof update.new_oid !== "string" ||
      !/^[0-9a-f]{40}$/.test(update.new_oid) ||
      typeof update.ref_name !== "string" ||
      update.ref_name.length < 1 ||
      update.ref_name.length > 256 ||
      !update.ref_name.startsWith("refs/") ||
      update.ref_name.includes("..") ||
      /[\x00-\x20\x7f]/.test(update.ref_name) ||
      typeof update.is_ancestor !== "boolean"
    ) {
      throw new Error("invalid Git ref update");
    }
    return {
      is_ancestor: update.is_ancestor,
      new_oid: update.new_oid,
      old_oid: update.old_oid,
      ref_name: update.ref_name,
    };
  });
  return {
    community_id: value.community_id,
    pusher_pubkey: value.pusher_pubkey,
    ref_updates: refUpdates,
    repo_id: value.repo_id,
    repo_owner: value.repo_owner,
    signature: value.signature,
    timestamp: value.timestamp as number,
  };
}

function parsePattern(value: unknown): readonly string[] {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    !value.startsWith("refs/")
  ) {
    throw new Error("invalid Git protection pattern");
  }
  const segments = value.split("/");
  let wildcards = 0;
  for (const [index, segment] of segments.entries()) {
    if (segment === "*" || segment === "**") {
      wildcards += 1;
      if (
        wildcards > 3 ||
        (segment === "**" && index !== segments.length - 1)
      ) {
        throw new Error("invalid Git protection wildcard");
      }
    } else if (segment.length < 1 || !/^[A-Za-z0-9._-]+$/.test(segment)) {
      throw new Error("invalid Git protection pattern segment");
    }
  }
  return segments;
}

function patternMatches(pattern: readonly string[], refName: string): boolean {
  const segments = refName.split("/");
  if (pattern.at(-1) === "**") {
    const prefix = pattern.slice(0, -1);
    return (
      segments.length > prefix.length &&
      prefix.every((value, index) => value === "*" || value === segments[index])
    );
  }
  return (
    pattern.length === segments.length &&
    pattern.every((value, index) => value === "*" || value === segments[index])
  );
}

function classifyUpdate(update: GitRefUpdate): GitUpdateKind {
  if (update.old_oid === ZERO_GIT_OID) return "create";
  if (update.new_oid === ZERO_GIT_OID) return "delete";
  return update.is_ancestor ? "fast-forward" : "non-fast-forward";
}

function defaultRole(
  refName: string,
  kind: GitUpdateKind,
): Exclude<GitRole, "guest" | "bot"> {
  if (kind === "create") {
    return refName.startsWith("refs/heads/") || refName.startsWith("refs/tags/")
      ? "member"
      : "admin";
  }
  if (kind === "fast-forward" && refName.startsWith("refs/heads/")) {
    return "member";
  }
  return "admin";
}

function roleLevel(role: GitRole): number {
  return { admin: 3, bot: 0, guest: 1, member: 2, owner: 4 }[role];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
