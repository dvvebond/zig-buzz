import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { KIND_HTTP_AUTH, verifyNostrEvent, type NostrEvent } from "@buzz/core";
import { z } from "zod";

import type {
  AppleAppAttestVerifier,
  VerifiedAttestation,
} from "./app-attest.js";
import type {
  AuthorityStore,
  DeliveryDisposition,
  Installation,
} from "./authority.js";
import type { DeliveryOutcome, PushTransport } from "./apns.js";
import {
  DelegationRequestSchema,
  DeliveryRequestSchema,
  InstallationChallengeRequestSchema,
  InstallationEnrollRequestSchema,
  MAX_REQUEST_BYTES,
  RevokeDelegationRequestSchema,
  RevokeInstallationRequestSchema,
  RotateEndpointRequestSchema,
  type AppProfile,
} from "./model.js";
import type { GrantKeyring, TokenKeyring } from "./crypto.js";
import { AuthorityError } from "./authority.js";
import { parseStrictJson } from "./strict-json.js";

export type AppAttestBoundary = Pick<
  AppleAppAttestVerifier,
  "verifyAttestation" | "verifyAssertion"
>;

export type PushGatewayState = {
  readonly grantKeyring: GrantKeyring;
  readonly tokenKeyring: TokenKeyring;
  readonly appAttest: AppAttestBoundary;
  readonly authority: AuthorityStore;
  readonly transport: PushTransport;
  readonly deliveryUrl: string;
  readonly maxGrantLifetimeSeconds: number;
  readonly maxInstallationLifetimeSeconds: number;
  readonly endpointQuotaWindowSeconds: number;
  readonly endpointQuotaMaxDeliveries: number;
  readonly enabledProfiles: ReadonlySet<AppProfile>;
  readonly now?: () => number;
  readonly accepting?: () => boolean;
};

export class PushGatewayHttp {
  readonly #public: Server;
  readonly #health: Server;
  #active = 0;

  public constructor(
    private readonly state: PushGatewayState,
    private readonly maximumConcurrency = 256,
  ) {
    this.#public = createServer((request, response) => {
      void this.#publicRequest(request, response);
    });
    this.#health = createServer((request, response) => {
      void this.#healthRequest(request, response);
    });
    for (const server of [this.#public, this.#health]) {
      server.headersTimeout = 5_000;
      server.requestTimeout = 20_000;
      server.keepAliveTimeout = 5_000;
    }
  }

  public async listen(input: {
    readonly publicHost: string;
    readonly publicPort: number;
    readonly healthHost: string;
    readonly healthPort: number;
  }): Promise<{
    readonly publicUrl: string;
    readonly healthUrl: string;
  }> {
    await listen(this.#public, input.publicPort, input.publicHost);
    try {
      await listen(this.#health, input.healthPort, input.healthHost);
    } catch (error) {
      await close(this.#public);
      throw error;
    }
    return {
      healthUrl: localUrl(this.#health),
      publicUrl: localUrl(this.#public),
    };
  }

  public async close(): Promise<void> {
    await Promise.all([close(this.#public), close(this.#health)]);
  }

  async #publicRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (this.#active >= this.maximumConcurrency) {
      json(response, 503, { error: "temporarily_unavailable" });
      return;
    }
    this.#active += 1;
    try {
      if (request.method !== "POST") {
        json(response, 404, { error: "not_found" });
        return;
      }
      const body = await readBody(request);
      const path = new URL(request.url ?? "/", "http://push.invalid").pathname;
      switch (path) {
        case "/v1/installations/challenges":
          await this.#challenge(response, body);
          return;
        case "/v1/installations":
          await this.#enroll(response, body);
          return;
        case "/v1/delegations":
          await this.#delegate(response, body);
          return;
        case "/v1/delegations/revoke":
          await this.#revokeDelegation(response, body);
          return;
        case "/v1/installations/endpoint":
          await this.#rotate(response, body);
          return;
        case "/v1/installations/revoke":
          await this.#revokeInstallation(response, body);
          return;
        case "/v1/deliveries/apns":
          await this.#deliver(request, response, body);
          return;
        default:
          json(response, 404, { error: "not_found" });
      }
    } catch (error) {
      if (error instanceof RequestBodyError) {
        json(response, error.status, { error: "invalid_request" });
      } else {
        json(response, 503, { error: "temporarily_unavailable" });
      }
    } finally {
      this.#active -= 1;
    }
  }

  async #healthRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const path = new URL(request.url ?? "/", "http://health.invalid").pathname;
    if (request.method === "GET" && path === "/_liveness") {
      json(response, 200, { status: "alive" });
      return;
    }
    if (request.method === "GET" && path === "/_readiness") {
      try {
        if (this.state.accepting?.() === false) throw new Error("draining");
        await this.state.authority.ready();
        json(response, 200, { status: "ready" });
      } catch {
        json(response, 503, { error: "not_ready" });
      }
      return;
    }
    json(response, 404, { error: "not_found" });
  }

  async #challenge(response: ServerResponse, body: Buffer): Promise<void> {
    if (!parse(InstallationChallengeRequestSchema, body)) {
      invalid(response);
      return;
    }
    const now = this.#now();
    const challenge = randomBytes(32);
    const id = randomUUID();
    const expiresAt = now + 300;
    try {
      await this.state.authority.putChallenge({
        expiresAt,
        id,
        value: challenge,
      });
    } catch (error) {
      authorityResponse(response, error);
      return;
    }
    json(response, 200, {
      challenge: challenge.toString("base64url"),
      challenge_id: id,
      expires_at: expiresAt,
    });
  }

  async #enroll(response: ServerResponse, body: Buffer): Promise<void> {
    const request = parse(InstallationEnrollRequestSchema, body);
    if (!request) {
      invalid(response);
      return;
    }
    const now = this.#now();
    const endpoint = endpointBytes(request.endpoint);
    if (
      !endpoint ||
      request.expires_at <= now ||
      request.expires_at > now + this.state.maxInstallationLifetimeSeconds ||
      !this.state.enabledProfiles.has(request.app_profile)
    ) {
      invalid(response);
      return;
    }
    const challenge = challengeBytes(request.challenge);
    if (!challenge) {
      invalid(response);
      return;
    }
    const signed = {
      v: request.v,
      audience: "https://push.buzz.xyz/v1/installations",
      challenge_id: request.challenge_id,
      challenge: request.challenge,
      key_id: request.key_id,
      app_profile: request.app_profile,
      endpoint: request.endpoint,
      endpoint_epoch: request.endpoint_epoch,
      expires_at: request.expires_at,
    };
    let verified: VerifiedAttestation;
    try {
      verified = this.state.appAttest.verifyAttestation(
        request.attestation,
        request.key_id,
        transcript("buzz.push.enroll.v1", signed),
      );
    } catch {
      json(response, 401, { error: "invalid_attestation" });
      return;
    }
    try {
      await this.state.authority.consumeChallenge(
        request.challenge_id,
        challenge,
        now,
      );
      const id = randomUUID();
      await this.state.authority.createInstallation({
        appAttestKeyId: verified.keyId,
        appAttestPublicKey: verified.publicKey,
        assertionCounter: 0,
        endpointEpoch: 1,
        expiresAt: request.expires_at,
        id,
        profile: request.app_profile,
        tokenCiphertext: this.state.tokenKeyring.seal(endpoint),
        tokenFingerprint: endpointFingerprint(request.app_profile, endpoint),
      });
      json(response, 201, {
        endpoint_epoch: 1,
        expires_at: request.expires_at,
        installation_handle: id,
      });
    } catch (error) {
      authorityResponse(response, error);
    } finally {
      endpoint.fill(0);
    }
  }

  async #delegate(response: ServerResponse, body: Buffer): Promise<void> {
    const request = parse(DelegationRequestSchema, body);
    const now = this.#now();
    if (
      !request ||
      request.not_before > now + 300 ||
      request.expires_at <= request.not_before ||
      request.expires_at > now + this.state.maxGrantLifetimeSeconds
    ) {
      invalid(response);
      return;
    }
    const signed = {
      v: request.v,
      audience: "https://push.buzz.xyz/v1/delegations",
      challenge_id: request.challenge_id,
      challenge: request.challenge,
      installation_handle: request.installation_handle,
      endpoint_epoch: request.endpoint_epoch,
      generation: request.generation,
      relay_pubkey: request.relay_pubkey,
      not_before: request.not_before,
      expires_at: request.expires_at,
    };
    if (
      !(await this.#verifyAssertion(
        response,
        request,
        "buzz.push.delegate.v1",
        signed,
      ))
    ) {
      return;
    }
    try {
      const delegationId = randomUUID();
      await this.state.authority.upsertDelegation({
        endpointEpoch: request.endpoint_epoch,
        expiresAt: request.expires_at,
        generation: request.generation,
        id: delegationId,
        installationId: request.installation_handle,
        notBefore: request.not_before,
        relayPubkey: request.relay_pubkey,
        revoked: false,
      });
      const installation = await this.state.authority.installation(
        request.installation_handle,
        now,
      );
      const endpointGrant = this.state.grantKeyring.issue({
        app_profile: installation.profile,
        delegation_id: delegationId,
        endpoint_epoch: request.endpoint_epoch,
        expires_at: request.expires_at,
        generation: request.generation,
        relay_pubkey: request.relay_pubkey,
        v: 1,
      });
      json(response, 201, { endpoint_grant: endpointGrant });
    } catch (error) {
      authorityResponse(response, error);
    }
  }

  async #rotate(response: ServerResponse, body: Buffer): Promise<void> {
    const request = parse(RotateEndpointRequestSchema, body);
    const endpoint = request ? endpointBytes(request.endpoint) : undefined;
    if (
      !request ||
      !endpoint ||
      request.new_endpoint_epoch !== request.endpoint_epoch + 1
    ) {
      endpoint?.fill(0);
      invalid(response);
      return;
    }
    let installation: Installation;
    try {
      installation = await this.state.authority.installation(
        request.installation_handle,
        this.#now(),
      );
    } catch (error) {
      endpoint.fill(0);
      authorityResponse(response, error);
      return;
    }
    const signed = {
      v: request.v,
      audience: "https://push.buzz.xyz/v1/installations/endpoint",
      challenge_id: request.challenge_id,
      challenge: request.challenge,
      installation_handle: request.installation_handle,
      endpoint_epoch: request.endpoint_epoch,
      new_endpoint_epoch: request.new_endpoint_epoch,
      endpoint: request.endpoint,
    };
    if (
      !(await this.#verifyAssertion(
        response,
        request,
        "buzz.push.rotate-endpoint.v1",
        signed,
      ))
    ) {
      endpoint.fill(0);
      return;
    }
    try {
      await this.state.authority.rotateEndpoint(
        request.installation_handle,
        request.endpoint_epoch,
        request.new_endpoint_epoch,
        this.state.tokenKeyring.seal(endpoint),
        endpointFingerprint(installation.profile, endpoint),
      );
      json(response, 200, { status: "rotated" });
    } catch (error) {
      authorityResponse(response, error);
    } finally {
      endpoint.fill(0);
    }
  }

  async #revokeDelegation(
    response: ServerResponse,
    body: Buffer,
  ): Promise<void> {
    const request = parse(RevokeDelegationRequestSchema, body);
    if (!request) {
      invalid(response);
      return;
    }
    const signed = {
      v: request.v,
      audience: "https://push.buzz.xyz/v1/delegations/revoke",
      challenge_id: request.challenge_id,
      challenge: request.challenge,
      installation_handle: request.installation_handle,
      relay_pubkey: request.relay_pubkey,
      generation: request.generation,
    };
    if (
      !(await this.#verifyAssertion(
        response,
        request,
        "buzz.push.revoke-delegation.v1",
        signed,
      ))
    ) {
      return;
    }
    try {
      await this.state.authority.revokeDelegation(
        request.installation_handle,
        request.relay_pubkey,
        request.generation,
      );
      json(response, 200, { status: "revoked" });
    } catch (error) {
      authorityResponse(response, error);
    }
  }

  async #revokeInstallation(
    response: ServerResponse,
    body: Buffer,
  ): Promise<void> {
    const request = parse(RevokeInstallationRequestSchema, body);
    if (!request || request.new_endpoint_epoch !== request.endpoint_epoch + 1) {
      invalid(response);
      return;
    }
    const signed = {
      v: request.v,
      audience: "https://push.buzz.xyz/v1/installations/revoke",
      challenge_id: request.challenge_id,
      challenge: request.challenge,
      installation_handle: request.installation_handle,
      endpoint_epoch: request.endpoint_epoch,
      new_endpoint_epoch: request.new_endpoint_epoch,
    };
    if (
      !(await this.#verifyAssertion(
        response,
        request,
        "buzz.push.revoke-installation.v1",
        signed,
      ))
    ) {
      return;
    }
    try {
      await this.state.authority.revokeInstallation(
        request.installation_handle,
        request.endpoint_epoch,
        request.new_endpoint_epoch,
      );
      json(response, 200, { status: "revoked" });
    } catch (error) {
      authorityResponse(response, error);
    }
  }

  async #deliver(
    incoming: IncomingMessage,
    response: ServerResponse,
    body: Buffer,
  ): Promise<void> {
    const request = parse(DeliveryRequestSchema, body);
    if (!request) {
      invalid(response);
      return;
    }
    const authenticated = authenticateNip98({
      authorization: incoming.headers.authorization,
      body,
      method: "POST",
      now: this.#now(),
      publicUrl: this.state.deliveryUrl,
    });
    if (!authenticated) {
      json(response, 401, { error: "invalid_auth" });
      return;
    }
    let grant;
    try {
      grant = this.state.grantKeyring.open(request.endpoint_grant);
    } catch {
      json(response, 404, { error: "invalid_grant" });
      return;
    }
    const now = this.#now();
    if (
      grant.relay_pubkey !== authenticated.pubkey ||
      grant.expires_at < now ||
      request.expires_at < now ||
      request.expires_at > grant.expires_at
    ) {
      json(response, 404, { error: "invalid_grant" });
      return;
    }
    let permit;
    try {
      permit = await this.state.authority.authorizeDelivery({
        authEventId: authenticated.eventId,
        delegationId: grant.delegation_id,
        endpointEpoch: grant.endpoint_epoch,
        generation: grant.generation,
        now,
        quotaMaxDeliveries: this.state.endpointQuotaMaxDeliveries,
        quotaWindowSeconds: this.state.endpointQuotaWindowSeconds,
        relayPubkey: authenticated.pubkey,
        requestExpiresAt: request.expires_at,
        requestId: request.request_id,
      });
    } catch (error) {
      if (error instanceof AuthorityError && error.reason === "rejected") {
        json(response, 404, { error: "invalid_grant" });
      } else {
        json(response, 503, { error: "temporarily_unavailable" });
      }
      return;
    }
    if (permit.authority.profile !== grant.app_profile) {
      await safelyFinish(this.state.authority, permit, "terminal");
      json(response, 404, { error: "invalid_grant" });
      return;
    }
    let endpoint: Buffer;
    try {
      endpoint = this.state.tokenKeyring.open(permit.authority.tokenCiphertext);
    } catch {
      await safelyFinish(this.state.authority, permit, "retryable");
      json(response, 503, { error: "temporarily_unavailable" });
      return;
    }
    let outcome: DeliveryOutcome;
    try {
      outcome = await this.state.transport.send(
        {
          expiresAt: request.expires_at,
          requestId: request.request_id,
        },
        permit.authority.profile,
        endpoint.toString("hex"),
      );
      if (outcome.type === "refresh_credential") {
        this.state.transport.refreshCredential?.();
        outcome = await this.state.transport.send(
          {
            expiresAt: request.expires_at,
            requestId: request.request_id,
          },
          permit.authority.profile,
          endpoint.toString("hex"),
        );
      }
    } catch {
      outcome = { type: "retry" };
    } finally {
      endpoint.fill(0);
    }
    const disposition: DeliveryDisposition = [
      "retry",
      "configuration_fault",
      "refresh_credential",
    ].includes(outcome.type)
      ? "retryable"
      : "terminal";
    try {
      await this.state.authority.finishDelivery(permit, disposition);
    } catch {
      json(response, 503, { error: "temporarily_unavailable" });
      return;
    }
    switch (outcome.type) {
      case "accepted":
        json(response, 200, { status: "accepted" });
        return;
      case "invalid_endpoint":
        json(response, 410, {
          generation: grant.generation,
          invalid_at: outcome.unregisteredAt ?? null,
          status: "invalid_endpoint",
        });
        return;
      case "retry":
        json(response, 503, {
          retry_after_seconds: outcome.retryAfterSeconds ?? null,
          status: "retry",
        });
        return;
      case "configuration_fault":
      case "refresh_credential":
        json(response, 503, { error: "configuration_fault" });
        return;
      case "permanent_request_fault":
        invalid(response);
    }
  }

  async #verifyAssertion(
    response: ServerResponse,
    request: {
      readonly assertion: string;
      readonly challenge: string;
      readonly challenge_id: string;
      readonly installation_handle: string;
    },
    domain: string,
    signed: unknown,
  ): Promise<boolean> {
    const challenge = challengeBytes(request.challenge);
    if (!challenge) {
      invalid(response);
      return false;
    }
    let installation: Installation;
    try {
      installation = await this.state.authority.installation(
        request.installation_handle,
        this.#now(),
      );
    } catch (error) {
      authorityResponse(response, error);
      return false;
    }
    let counter: number;
    try {
      ({ counter } = this.state.appAttest.verifyAssertion({
        assertionBase64: request.assertion,
        challenge: request.challenge,
        clientData: transcript(domain, signed),
        previousCounter: installation.assertionCounter,
        publicKey: installation.appAttestPublicKey,
        storedChallenge: request.challenge,
      }));
    } catch {
      json(response, 401, { error: "invalid_attestation" });
      return false;
    }
    try {
      await this.state.authority.consumeChallenge(
        request.challenge_id,
        challenge,
        this.#now(),
      );
      await this.state.authority.advanceAssertionCounter(
        request.installation_handle,
        installation.assertionCounter,
        counter,
      );
      return true;
    } catch (error) {
      authorityResponse(response, error);
      return false;
    }
  }

  #now(): number {
    return this.state.now?.() ?? Math.floor(Date.now() / 1_000);
  }
}

function authenticateNip98(input: {
  readonly authorization: string | undefined;
  readonly body: Buffer;
  readonly method: string;
  readonly now: number;
  readonly publicUrl: string;
}): { readonly pubkey: string; readonly eventId: string } | undefined {
  const match = /^Nostr ([A-Za-z0-9+/]+={0,2})$/.exec(
    input.authorization ?? "",
  );
  if (!match?.[1] || Buffer.byteLength(match[1]) > 8 * 1_024) return undefined;
  let event: unknown;
  try {
    event = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  if (
    !verifyNostrEvent(event) ||
    event.kind !== KIND_HTTP_AUTH ||
    Math.abs(event.created_at - input.now) > 60 ||
    exactTag(event, "u") !== input.publicUrl ||
    exactTag(event, "method") !== input.method ||
    exactTag(event, "payload") !==
      createHash("sha256").update(input.body).digest("hex")
  ) {
    return undefined;
  }
  return { eventId: event.id, pubkey: event.pubkey };
}

function exactTag(event: NostrEvent, name: string): string | undefined {
  const tags = event.tags.filter((tag) => tag[0] === name);
  return tags.length === 1 && tags[0]?.length === 2 ? tags[0][1] : undefined;
}

function parse<T>(schema: z.ZodType<T>, body: Buffer): T | undefined {
  try {
    return schema.parse(parseStrictJson(body.toString("utf8")));
  } catch {
    return undefined;
  }
}

function transcript(domain: string, value: unknown): Buffer {
  return Buffer.from(`${domain}\n${JSON.stringify(value)}`);
}

function challengeBytes(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 ? decoded : undefined;
}

function endpointBytes(value: string): Buffer | undefined {
  if (
    value.length < 2 ||
    value.length > 2 * 512 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(value)
  ) {
    return undefined;
  }
  return Buffer.from(value, "hex");
}

function endpointFingerprint(profile: AppProfile, token: Uint8Array): Buffer {
  return createHash("sha256")
    .update("buzz-apns-endpoint-v1\0")
    .update(profile)
    .update(Buffer.from([0]))
    .update(token)
    .digest();
}

async function safelyFinish(
  authority: AuthorityStore,
  permit: Parameters<AuthorityStore["finishDelivery"]>[0],
  disposition: DeliveryDisposition,
): Promise<void> {
  try {
    await authority.finishDelivery(permit, disposition);
  } catch {
    // The caller already returns a closed error and never retries inline.
  }
}

function authorityResponse(response: ServerResponse, error: unknown): void {
  if (error instanceof AuthorityError && error.reason === "rejected") {
    json(response, 404, { error: "not_authorized" });
  } else {
    json(response, 503, { error: "temporarily_unavailable" });
  }
}

function invalid(response: ServerResponse): void {
  json(response, 400, { error: "invalid_request" });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(encoded.byteLength),
    "Content-Security-Policy": "default-src 'none'",
    "Content-Type": "application/json",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(encoded);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (
    !Number.isSafeInteger(declared) ||
    declared < 0 ||
    declared > MAX_REQUEST_BYTES
  ) {
    throw new RequestBodyError(413);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > MAX_REQUEST_BYTES) throw new RequestBodyError(413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

class RequestBodyError extends Error {
  public constructor(readonly status: number) {
    super("invalid request body");
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function close(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function localUrl(server: Server): string {
  const address = server.address() as AddressInfo;
  const host = address.address.includes(":")
    ? `[${address.address}]`
    : address.address;
  return `http://${host}:${address.port}`;
}
