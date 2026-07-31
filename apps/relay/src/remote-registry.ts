import {
  KIND_REMOTE_AGENT_ACK,
  KIND_REMOTE_AGENT_ENROLLMENT,
  verifyNostrEvent,
  type NostrEvent,
} from "@buzz/core";
import {
  mintEnrollmentToken,
  parseEnrollmentToken,
  RemoteProtocolError,
  verifyEnrollmentToken,
  type EnrollmentRecord,
  type MintedEnrollment,
  type RemoteCapability,
} from "@buzz/remote-agent-protocol";

export type RemoteWorkerBinding = {
  readonly enrollmentId: string;
  readonly ownerPubkey: string;
  readonly workerPubkey: string;
  readonly community: string;
  readonly capabilities: readonly RemoteCapability[];
  readonly enrollmentEventId: string;
  readonly approvedAt?: number;
  readonly revokedAt?: number;
};

export type RemoteRegistryContract = {
  mint(input: {
    readonly ownerPubkey: string;
    readonly community: string;
    readonly capabilities: readonly RemoteCapability[];
    readonly lifetimeSeconds?: number;
    readonly now: number;
  }): Promise<MintedEnrollment>;
  redeem(input: {
    readonly token: string;
    readonly event: unknown;
    readonly authenticatedPubkey: string;
    readonly community: string;
    readonly now: number;
  }): Promise<{
    readonly event: NostrEvent;
    readonly binding: RemoteWorkerBinding;
  }>;
  approve(input: {
    readonly enrollmentId: string;
    readonly workerPubkey: string;
    readonly authenticatedOwnerPubkey: string;
    readonly community: string;
    readonly event: unknown;
    readonly now: number;
  }): Promise<{
    readonly event: NostrEvent;
    readonly binding: RemoteWorkerBinding;
  }>;
  authorizedWorker(
    workerPubkey: string,
    community: string,
  ): Promise<RemoteWorkerBinding | undefined>;
  workerBinding(
    workerPubkey: string,
    community: string,
  ): Promise<RemoteWorkerBinding | undefined>;
  revoke(input: {
    readonly workerPubkey: string;
    readonly authenticatedOwnerPubkey: string;
    readonly community: string;
    readonly now: number;
  }): Promise<RemoteWorkerBinding>;
};

/**
 * Persistence boundary for BRAP enrollment and worker authorization.
 *
 * This in-memory implementation is for local development and tests. The
 * Postgres implementation uses the same atomic consume/approve contract.
 */
export class RemoteRegistry implements RemoteRegistryContract {
  readonly #enrollments = new Map<string, EnrollmentRecord>();
  readonly #workers = new Map<string, RemoteWorkerBinding>();

  public async mint(input: {
    readonly ownerPubkey: string;
    readonly community: string;
    readonly capabilities: readonly RemoteCapability[];
    readonly lifetimeSeconds?: number;
    readonly now: number;
  }): Promise<MintedEnrollment> {
    const minted = mintEnrollmentToken(input);
    this.#enrollments.set(minted.record.id, minted.record);
    return minted;
  }

  public async redeem(input: {
    readonly token: string;
    readonly event: unknown;
    readonly authenticatedPubkey: string;
    readonly community: string;
    readonly now: number;
  }): Promise<{
    readonly event: NostrEvent;
    readonly binding: RemoteWorkerBinding;
  }> {
    const token = parseEnrollmentToken(input.token);
    const record = this.#enrollments.get(token.id);
    if (!record) {
      throw new RemoteProtocolError(
        "ENROLLMENT_INVALID",
        "enrollment invitation does not exist",
      );
    }
    const existingBinding = this.#workers.get(input.authenticatedPubkey);
    const event = validateEnrollmentEvent(input, record, {
      allowUsed:
        record.usedAt !== undefined &&
        existingBinding?.enrollmentId === record.id &&
        existingBinding.workerPubkey === input.authenticatedPubkey &&
        existingBinding.revokedAt === undefined,
    });

    // Consume only after every token and signed-event check succeeds.
    if (record.usedAt === undefined) {
      this.#enrollments.set(record.id, { ...record, usedAt: input.now });
    }
    const binding: RemoteWorkerBinding = {
      ...existingBinding,
      capabilities: record.capabilities,
      community: record.community,
      enrollmentEventId: event.id,
      enrollmentId: record.id,
      ownerPubkey: record.ownerPubkey,
      workerPubkey: input.authenticatedPubkey,
    };
    this.#workers.set(input.authenticatedPubkey, binding);
    return { binding, event };
  }

  public async approve(input: {
    readonly enrollmentId: string;
    readonly workerPubkey: string;
    readonly authenticatedOwnerPubkey: string;
    readonly community: string;
    readonly event: unknown;
    readonly now: number;
  }): Promise<{
    readonly event: NostrEvent;
    readonly binding: RemoteWorkerBinding;
  }> {
    const current = this.#workers.get(input.workerPubkey);
    if (
      !current ||
      current.enrollmentId !== input.enrollmentId ||
      current.ownerPubkey !== input.authenticatedOwnerPubkey ||
      current.community !== input.community ||
      current.revokedAt !== undefined
    ) {
      throw new RemoteProtocolError(
        "OWNER_APPROVAL_REQUIRED",
        "pending worker enrollment was not found",
      );
    }
    const event = validateApprovalEvent(input);
    const binding: RemoteWorkerBinding = {
      ...current,
      approvedAt: input.now,
    };
    this.#workers.set(input.workerPubkey, binding);
    return { binding, event };
  }

  public async authorizedWorker(
    workerPubkey: string,
    community: string,
  ): Promise<RemoteWorkerBinding | undefined> {
    const binding = this.#workers.get(workerPubkey);
    return binding?.community === community &&
      binding.approvedAt !== undefined &&
      binding.revokedAt === undefined
      ? binding
      : undefined;
  }

  public async workerBinding(
    workerPubkey: string,
    community: string,
  ): Promise<RemoteWorkerBinding | undefined> {
    const binding = this.#workers.get(workerPubkey);
    return binding?.community === community ? binding : undefined;
  }

  public async revoke(input: {
    readonly workerPubkey: string;
    readonly authenticatedOwnerPubkey: string;
    readonly community: string;
    readonly now: number;
  }): Promise<RemoteWorkerBinding> {
    const current = this.#workers.get(input.workerPubkey);
    if (
      !current ||
      current.community !== input.community ||
      current.ownerPubkey !== input.authenticatedOwnerPubkey ||
      current.approvedAt === undefined ||
      current.revokedAt !== undefined
    ) {
      throw new RemoteProtocolError(
        "CAPABILITY_DENIED",
        "approved remote worker was not found",
      );
    }
    const revoked = { ...current, revokedAt: input.now };
    this.#workers.set(input.workerPubkey, revoked);
    return revoked;
  }
}

export function validateEnrollmentEvent(
  input: {
    readonly token: string;
    readonly event: unknown;
    readonly authenticatedPubkey: string;
    readonly community: string;
    readonly now: number;
  },
  record: EnrollmentRecord,
  options: { readonly allowUsed: boolean },
): NostrEvent {
  if (options.allowUsed) {
    // Idempotent retry for the exact already-bound worker. This lets a pending
    // worker reconnect without making the one-time token usable by anyone else.
    const { usedAt: _usedAt, ...unusedRecord } = record;
    verifyEnrollmentToken(input.token, unusedRecord, input.now);
  } else {
    verifyEnrollmentToken(input.token, record, input.now);
  }
  if (record.community !== input.community) {
    throw new RemoteProtocolError(
      "ENROLLMENT_INVALID",
      "enrollment invitation belongs to another community",
    );
  }
  if (!verifyNostrEvent(input.event)) {
    throw new RemoteProtocolError(
      "SIGNATURE_INVALID",
      "enrollment event signature is invalid",
    );
  }
  const event = input.event;
  if (
    event.kind !== KIND_REMOTE_AGENT_ENROLLMENT ||
    event.pubkey !== input.authenticatedPubkey ||
    singleTag(event, "p") !== record.ownerPubkey ||
    singleTag(event, "worker") !== input.authenticatedPubkey ||
    singleTag(event, "deployment") !== record.id ||
    singleTag(event, "protocol") !== "brap/1"
  ) {
    throw new RemoteProtocolError(
      "ENROLLMENT_INVALID",
      "enrollment event binding is invalid",
    );
  }
  if (event.created_at < input.now - 60 || event.created_at > input.now + 60) {
    throw new RemoteProtocolError(
      "ENROLLMENT_EXPIRED",
      "enrollment event is outside the freshness window",
    );
  }
  return event;
}

export function validateApprovalEvent(input: {
  readonly enrollmentId: string;
  readonly workerPubkey: string;
  readonly authenticatedOwnerPubkey: string;
  readonly community: string;
  readonly event: unknown;
  readonly now: number;
}): NostrEvent {
  if (!verifyNostrEvent(input.event)) {
    throw new RemoteProtocolError(
      "SIGNATURE_INVALID",
      "approval event signature is invalid",
    );
  }
  const event = input.event;
  if (
    event.kind !== KIND_REMOTE_AGENT_ACK ||
    event.pubkey !== input.authenticatedOwnerPubkey ||
    singleTag(event, "p") !== input.workerPubkey ||
    singleTag(event, "worker") !== input.workerPubkey ||
    singleTag(event, "deployment") !== input.enrollmentId ||
    singleTag(event, "protocol") !== "brap/1"
  ) {
    throw new RemoteProtocolError(
      "OWNER_APPROVAL_REQUIRED",
      "approval event binding is invalid",
    );
  }
  if (event.created_at < input.now - 60 || event.created_at > input.now + 60) {
    throw new RemoteProtocolError(
      "MESSAGE_EXPIRED",
      "approval event is outside the freshness window",
    );
  }
  const expiresAt = parseUnsignedTag(event, "expires");
  if (expiresAt < input.now || expiresAt - event.created_at > 300) {
    throw new RemoteProtocolError(
      "MESSAGE_EXPIRED",
      "approval event has expired",
    );
  }
  return event;
}

function parseUnsignedTag(event: NostrEvent, name: string): number {
  const raw = singleTag(event, name);
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new RemoteProtocolError("TAG_INVALID", `${name} tag is invalid`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new RemoteProtocolError("TAG_INVALID", `${name} tag is too large`);
  }
  return value;
}

function singleTag(event: NostrEvent, name: string): string {
  const values = event.tags.filter((tag) => tag[0] === name);
  if (values.length !== 1 || values[0]?.length !== 2 || !values[0][1]) {
    throw new RemoteProtocolError(
      "TAG_INVALID",
      `event must contain exactly one ${name} tag`,
    );
  }
  return values[0][1];
}
