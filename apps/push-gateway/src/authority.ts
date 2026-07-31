import type { AppProfile } from "./model.js";

export type Challenge = {
  readonly id: string;
  readonly value: Buffer;
  readonly expiresAt: number;
};
export type NewInstallation = {
  readonly id: string;
  readonly appAttestKeyId: Buffer;
  readonly appAttestPublicKey: Buffer;
  readonly assertionCounter: number;
  readonly profile: AppProfile;
  readonly tokenCiphertext: Buffer;
  readonly tokenFingerprint: Buffer;
  readonly endpointEpoch: number;
  readonly expiresAt: number;
};
export type Installation = NewInstallation & {
  revoked: boolean;
};
export type Delegation = {
  readonly id: string;
  readonly installationId: string;
  readonly relayPubkey: string;
  readonly endpointEpoch: number;
  generation: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  revoked: boolean;
};
export type DeliveryAuthority = {
  readonly delegationId: string;
  readonly installationId: string;
  readonly relayPubkey: string;
  readonly profile: AppProfile;
  readonly tokenCiphertext: Buffer;
  readonly endpointEpoch: number;
  readonly generation: number;
  readonly expiresAt: number;
};
export type DeliveryPermit = {
  readonly authority: DeliveryAuthority;
  readonly relayPubkey: string;
  readonly requestId: string;
};
export type DeliveryDisposition = "terminal" | "retryable";

export class AuthorityError extends Error {
  public constructor(readonly reason: "rejected" | "unavailable") {
    super(`authority ${reason}`);
    this.name = "AuthorityError";
  }
}

export interface AuthorityStore {
  ready(): Promise<void>;
  putChallenge(challenge: Challenge): Promise<void>;
  consumeChallenge(id: string, value: Uint8Array, now: number): Promise<void>;
  createInstallation(installation: NewInstallation): Promise<void>;
  installation(id: string, now: number): Promise<Installation>;
  advanceAssertionCounter(
    installationId: string,
    previous: number,
    next: number,
  ): Promise<void>;
  upsertDelegation(delegation: Delegation): Promise<void>;
  rotateEndpoint(
    installationId: string,
    expectedEpoch: number,
    newEpoch: number,
    tokenCiphertext: Buffer,
    tokenFingerprint: Buffer,
  ): Promise<void>;
  revokeDelegation(
    installationId: string,
    relayPubkey: string,
    newGeneration: number,
  ): Promise<void>;
  revokeInstallation(
    installationId: string,
    expectedEpoch: number,
    newEpoch: number,
  ): Promise<void>;
  authorizeDelivery(input: {
    readonly delegationId: string;
    readonly relayPubkey: string;
    readonly endpointEpoch: number;
    readonly generation: number;
    readonly authEventId: string;
    readonly requestId: string;
    readonly requestExpiresAt: number;
    readonly quotaWindowSeconds: number;
    readonly quotaMaxDeliveries: number;
    readonly now: number;
  }): Promise<DeliveryPermit>;
  finishDelivery(
    permit: DeliveryPermit,
    disposition: DeliveryDisposition,
  ): Promise<void>;
  reapExpired(now: number): Promise<void>;
}

export class MemoryAuthorityStore implements AuthorityStore {
  readonly #challenges = new Map<string, Challenge>();
  readonly #installations = new Map<string, Installation>();
  readonly #tokenOwners = new Map<string, string>();
  readonly #delegations = new Map<string, Delegation>();
  readonly #delegationIds = new Map<string, string>();
  readonly #authReplays = new Map<string, number>();
  readonly #requestReplays = new Map<string, number>();
  readonly #quotas = new Map<
    string,
    { windowStartedAt: number; admitted: number }
  >();

  public async ready(): Promise<void> {}

  public async putChallenge(challenge: Challenge): Promise<void> {
    if (
      challenge.value.byteLength !== 32 ||
      this.#challenges.has(challenge.id)
    ) {
      reject();
    }
    this.#challenges.set(challenge.id, cloneChallenge(challenge));
  }

  public async consumeChallenge(
    id: string,
    value: Uint8Array,
    now: number,
  ): Promise<void> {
    const challenge = this.#challenges.get(id);
    this.#challenges.delete(id);
    if (
      !challenge ||
      challenge.expiresAt < now ||
      !challenge.value.equals(value)
    ) {
      reject();
    }
  }

  public async createInstallation(value: NewInstallation): Promise<void> {
    const tokenKey = tokenOwnerKey(value.profile, value.tokenFingerprint);
    if (
      value.tokenFingerprint.byteLength !== 32 ||
      this.#installations.has(value.id) ||
      this.#tokenOwners.has(tokenKey)
    ) {
      reject();
    }
    this.#tokenOwners.set(tokenKey, value.id);
    this.#installations.set(value.id, {
      ...cloneInstallation(value),
      revoked: false,
    });
  }

  public async installation(id: string, now: number): Promise<Installation> {
    const value = this.#installations.get(id);
    if (!value || value.revoked || value.expiresAt < now) reject();
    return cloneInstallation(value as Installation);
  }

  public async advanceAssertionCounter(
    id: string,
    previous: number,
    next: number,
  ): Promise<void> {
    const value = this.#installations.get(id);
    if (
      !value ||
      value.revoked ||
      value.assertionCounter !== previous ||
      next <= previous ||
      next > 0xffff_ffff
    ) {
      reject();
    }
    this.#installations.set(id, { ...value, assertionCounter: next });
  }

  public async upsertDelegation(value: Delegation): Promise<void> {
    const installation = this.#installations.get(value.installationId);
    const key = delegationKey(value.installationId, value.relayPubkey);
    const old = this.#delegations.get(key);
    if (
      !installation ||
      installation.revoked ||
      installation.endpointEpoch !== value.endpointEpoch ||
      value.generation < 1 ||
      value.notBefore >= value.expiresAt ||
      value.expiresAt > installation.expiresAt ||
      (old !== undefined && value.generation <= old.generation) ||
      this.#delegationIds.has(value.id)
    ) {
      reject();
    }
    if (old) this.#delegationIds.delete(old.id);
    const saved = { ...value };
    this.#delegations.set(key, saved);
    this.#delegationIds.set(value.id, key);
  }

  public async rotateEndpoint(
    id: string,
    expected: number,
    next: number,
    ciphertext: Buffer,
    fingerprint: Buffer,
  ): Promise<void> {
    const installation = this.#installations.get(id);
    if (
      !installation ||
      installation.revoked ||
      installation.endpointEpoch !== expected ||
      next !== expected + 1 ||
      fingerprint.byteLength !== 32
    ) {
      reject();
    }
    const ownerKey = tokenOwnerKey(installation.profile, fingerprint);
    const owner = this.#tokenOwners.get(ownerKey);
    if (owner && owner !== id) reject();
    this.#tokenOwners.delete(
      tokenOwnerKey(installation.profile, installation.tokenFingerprint),
    );
    this.#tokenOwners.set(ownerKey, id);
    this.#installations.set(id, {
      ...installation,
      endpointEpoch: next,
      tokenCiphertext: Buffer.from(ciphertext),
      tokenFingerprint: Buffer.from(fingerprint),
    });
  }

  public async revokeDelegation(
    id: string,
    relay: string,
    generation: number,
  ): Promise<void> {
    const key = delegationKey(id, relay);
    const value = this.#delegations.get(key);
    if (!value || generation <= value.generation) reject();
    this.#delegations.set(key, {
      ...value,
      generation,
      revoked: true,
    });
  }

  public async revokeInstallation(
    id: string,
    expected: number,
    next: number,
  ): Promise<void> {
    const value = this.#installations.get(id);
    if (
      !value ||
      value.revoked ||
      value.endpointEpoch !== expected ||
      next !== expected + 1
    ) {
      reject();
    }
    this.#installations.set(id, {
      ...value,
      endpointEpoch: next,
      revoked: true,
    });
  }

  public async authorizeDelivery(
    input: Parameters<AuthorityStore["authorizeDelivery"]>[0],
  ): Promise<DeliveryPermit> {
    const key = this.#delegationIds.get(input.delegationId);
    const delegation = key ? this.#delegations.get(key) : undefined;
    const installation = delegation
      ? this.#installations.get(delegation.installationId)
      : undefined;
    if (
      !delegation ||
      !installation ||
      delegation.revoked ||
      installation.revoked ||
      delegation.id !== input.delegationId ||
      delegation.relayPubkey !== input.relayPubkey ||
      delegation.endpointEpoch !== input.endpointEpoch ||
      delegation.generation !== input.generation ||
      installation.endpointEpoch !== input.endpointEpoch ||
      input.now < delegation.notBefore ||
      input.now > delegation.expiresAt ||
      input.now > installation.expiresAt ||
      input.requestExpiresAt < input.now ||
      input.requestExpiresAt > delegation.expiresAt
    ) {
      reject();
    }
    const authKey = `${input.relayPubkey}:${input.authEventId}`;
    const requestKey = `${input.relayPubkey}:${input.requestId}`;
    if (
      this.#authReplays.has(authKey) ||
      this.#requestReplays.has(requestKey)
    ) {
      reject();
    }
    const fingerprint = installation.tokenFingerprint.toString("hex");
    let quota = this.#quotas.get(fingerprint) ?? {
      admitted: 0,
      windowStartedAt: input.now,
    };
    if (input.now - quota.windowStartedAt >= input.quotaWindowSeconds) {
      quota = { admitted: 0, windowStartedAt: input.now };
    }
    if (quota.admitted >= input.quotaMaxDeliveries) reject();
    this.#quotas.set(fingerprint, {
      ...quota,
      admitted: quota.admitted + 1,
    });
    this.#authReplays.set(authKey, input.requestExpiresAt);
    this.#requestReplays.set(requestKey, input.requestExpiresAt);
    return {
      authority: {
        delegationId: delegation.id,
        endpointEpoch: input.endpointEpoch,
        expiresAt: delegation.expiresAt,
        generation: input.generation,
        installationId: installation.id,
        profile: installation.profile,
        relayPubkey: input.relayPubkey,
        tokenCiphertext: Buffer.from(installation.tokenCiphertext),
      },
      relayPubkey: input.relayPubkey,
      requestId: input.requestId,
    };
  }

  public async finishDelivery(
    permit: DeliveryPermit,
    disposition: DeliveryDisposition,
  ): Promise<void> {
    if (disposition === "retryable") {
      this.#requestReplays.delete(`${permit.relayPubkey}:${permit.requestId}`);
    }
  }

  public async reapExpired(now: number): Promise<void> {
    for (const [id, value] of this.#challenges) {
      if (value.expiresAt < now) this.#challenges.delete(id);
    }
    for (const [id, expiresAt] of this.#authReplays) {
      if (expiresAt < now) this.#authReplays.delete(id);
    }
    for (const [id, expiresAt] of this.#requestReplays) {
      if (expiresAt < now) this.#requestReplays.delete(id);
    }
    for (const [id, quota] of this.#quotas) {
      if (now - quota.windowStartedAt >= 86_400) this.#quotas.delete(id);
    }
  }
}

function cloneChallenge(value: Challenge): Challenge {
  return { ...value, value: Buffer.from(value.value) };
}

function cloneInstallation<T extends NewInstallation>(value: T): T {
  return {
    ...value,
    appAttestKeyId: Buffer.from(value.appAttestKeyId),
    appAttestPublicKey: Buffer.from(value.appAttestPublicKey),
    tokenCiphertext: Buffer.from(value.tokenCiphertext),
    tokenFingerprint: Buffer.from(value.tokenFingerprint),
  };
}

function tokenOwnerKey(profile: AppProfile, fingerprint: Uint8Array): string {
  return `${profile}:${Buffer.from(fingerprint).toString("hex")}`;
}

function delegationKey(installationId: string, relayPubkey: string): string {
  return `${installationId}:${relayPubkey}`;
}

function reject(): never {
  throw new AuthorityError("rejected");
}
