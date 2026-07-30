export const AUDIT_ACTIONS = [
  "event_created",
  "event_deleted",
  "channel_created",
  "channel_updated",
  "channel_deleted",
  "member_added",
  "member_removed",
  "auth_success",
  "auth_failure",
  "rate_limit_exceeded",
  "media_uploaded",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type AuditEntry = {
  readonly communityId: string;
  readonly seq: bigint;
  readonly hash: Uint8Array;
  readonly prevHash: Uint8Array | null;
  readonly action: AuditAction;
  readonly actorPubkey: Uint8Array | null;
  readonly objectId: string | null;
  readonly detail: JsonValue;
  /**
   * A UTC RFC3339 timestamp at PostgreSQL microsecond precision, formatted
   * with Chrono-compatible fractional digit width and a +00:00 suffix.
   */
  readonly createdAt: string;
};

export type NewAuditEntry = {
  readonly communityId: string;
  readonly action: AuditAction;
  readonly actorPubkey?: Uint8Array | null;
  readonly objectId?: string | null;
  readonly detail: JsonValue;
};

export class AuditIntegrityError extends Error {
  public constructor(
    public readonly code: "CHAIN_VIOLATION" | "HASH_MISMATCH",
    public readonly seq: bigint,
  ) {
    super(
      code === "CHAIN_VIOLATION"
        ? `hash chain integrity violation at seq ${seq}: prev_hash does not match preceding entry`
        : `hash mismatch at seq ${seq}: stored hash does not match recomputed hash`,
    );
    this.name = "AuditIntegrityError";
  }
}
