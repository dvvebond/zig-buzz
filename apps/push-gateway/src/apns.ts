import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { connect, constants, type ClientHttp2Session } from "node:http2";

import { APNS_RECONNECT_PAYLOAD, type AppProfile } from "./model.js";

export type DeliveryAttempt = {
  readonly requestId: string;
  readonly expiresAt: number;
};
export type DeliveryOutcome =
  | { readonly type: "accepted" }
  | {
      readonly type: "invalid_endpoint";
      readonly unregisteredAt?: number;
    }
  | { readonly type: "retry"; readonly retryAfterSeconds?: number }
  | { readonly type: "refresh_credential" }
  | { readonly type: "configuration_fault" }
  | { readonly type: "permanent_request_fault" };

export interface PushTransport {
  send(
    attempt: DeliveryAttempt,
    profile: AppProfile,
    endpoint: string,
  ): Promise<DeliveryOutcome>;
  refreshCredential?(): void;
}

export function classifyApns(
  code: number,
  reason?: string,
  timestamp?: number,
): DeliveryOutcome {
  if (code === 200) return { type: "accepted" };
  if (code === 410 && reason === "Unregistered") {
    return {
      type: "invalid_endpoint",
      ...(timestamp === undefined ? {} : { unregisteredAt: timestamp }),
    };
  }
  if (
    code === 400 &&
    (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic")
  ) {
    return { type: "invalid_endpoint" };
  }
  if (code === 403 && reason === "ExpiredProviderToken") {
    return { type: "refresh_credential" };
  }
  if (
    code === 403 ||
    (code === 429 && reason === "TooManyProviderTokenUpdates")
  ) {
    return { type: "configuration_fault" };
  }
  if (
    [429, 500, 503].includes(code) ||
    [
      "IdleTimeout",
      "InternalServerError",
      "ServiceUnavailable",
      "Shutdown",
      "TooManyRequests",
    ].includes(reason ?? "")
  ) {
    return { type: "retry" };
  }
  return { type: "permanent_request_fault" };
}

export class ApnsTransport implements PushTransport {
  readonly #key: KeyObject;
  #cached: { readonly token: string; readonly issuedAt: number } | undefined;

  public constructor(
    p8: Uint8Array,
    private readonly keyId: string,
    private readonly teamId: string,
    private readonly topic: string,
    private readonly productionOrigin = "https://api.push.apple.com",
    private readonly sandboxOrigin = "https://api.sandbox.push.apple.com",
  ) {
    this.#key = createPrivateKey(Buffer.from(p8));
    if (!keyId || !teamId || !topic || this.#key.asymmetricKeyType !== "ec") {
      throw new Error("invalid APNs credential configuration");
    }
  }

  public refreshCredential(): void {
    this.#cached = undefined;
  }

  public async send(
    attempt: DeliveryAttempt,
    profile: AppProfile,
    endpoint: string,
  ): Promise<DeliveryOutcome> {
    const origin =
      profile === "buzz-ios-production"
        ? this.productionOrigin
        : this.sandboxOrigin;
    let result: {
      readonly status: number;
      readonly headers: Record<string, string | string[] | undefined>;
      readonly body: Buffer;
    };
    try {
      result = await this.#request(
        origin,
        endpoint,
        attempt,
        this.#providerToken(Math.floor(Date.now() / 1_000)),
      );
    } catch {
      return { type: "retry" };
    }
    if (result.status === 200) return { type: "accepted" };
    let detail: { reason?: string; timestamp?: number } = {};
    try {
      const parsed = JSON.parse(result.body.toString("utf8")) as unknown;
      if (parsed && typeof parsed === "object") {
        const item = parsed as Record<string, unknown>;
        detail = {
          ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
          ...(typeof item.timestamp === "number"
            ? { timestamp: item.timestamp }
            : {}),
        };
      }
    } catch {
      // Provider bodies are advisory and never leave this trust boundary.
    }
    const classified = classifyApns(
      result.status,
      detail.reason,
      detail.timestamp,
    );
    const retryHeader = result.headers["retry-after"];
    const retry = Number(
      Array.isArray(retryHeader) ? retryHeader[0] : retryHeader,
    );
    if (
      classified.type === "retry" &&
      Number.isSafeInteger(retry) &&
      retry >= 1
    ) {
      return {
        retryAfterSeconds: Math.min(retry, 3_600),
        type: "retry",
      };
    }
    return classified;
  }

  #providerToken(now: number): string {
    if (this.#cached && now - this.#cached.issuedAt < 50 * 60) {
      return this.#cached.token;
    }
    const header = Buffer.from(
      JSON.stringify({ alg: "ES256", kid: this.keyId }),
    ).toString("base64url");
    const claims = Buffer.from(
      JSON.stringify({ iat: now, iss: this.teamId }),
    ).toString("base64url");
    const signingInput = `${header}.${claims}`;
    const signer = createSign("SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign({
      dsaEncoding: "ieee-p1363",
      key: this.#key,
    });
    const token = `${signingInput}.${signature.toString("base64url")}`;
    this.#cached = { issuedAt: now, token };
    return token;
  }

  #request(
    origin: string,
    endpoint: string,
    attempt: DeliveryAttempt,
    token: string,
  ): Promise<{
    readonly status: number;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly body: Buffer;
  }> {
    return new Promise((resolve, reject) => {
      let session: ClientHttp2Session;
      try {
        session = connect(origin);
      } catch (error) {
        reject(error);
        return;
      }
      const timer = setTimeout(() => {
        session.destroy();
        reject(new Error("APNs request timed out"));
      }, 15_000);
      timer.unref();
      session.once("error", reject);
      const stream = session.request({
        [constants.HTTP2_HEADER_AUTHORIZATION]: `bearer ${token}`,
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: `/3/device/${endpoint}`,
        "apns-expiration": String(attempt.expiresAt),
        "apns-id": attempt.requestId,
        "apns-priority": "10",
        "apns-push-type": "alert",
        "apns-topic": this.topic,
        "content-type": "application/json",
      });
      const chunks: Buffer[] = [];
      let status = 0;
      let headers: Record<string, string | string[] | undefined> = {};
      stream.once("response", (incoming) => {
        status = Number(incoming[constants.HTTP2_HEADER_STATUS] ?? 0);
        headers = incoming as Record<string, string | string[] | undefined>;
      });
      stream.on("data", (chunk: Buffer) => {
        if (chunks.reduce((sum, item) => sum + item.byteLength, 0) < 8_192) {
          chunks.push(Buffer.from(chunk));
        }
      });
      stream.once("error", (error) => {
        clearTimeout(timer);
        session.destroy();
        reject(error);
      });
      stream.once("end", () => {
        clearTimeout(timer);
        session.close();
        resolve({ body: Buffer.concat(chunks), headers, status });
      });
      stream.end(APNS_RECONNECT_PAYLOAD);
    });
  }
}
