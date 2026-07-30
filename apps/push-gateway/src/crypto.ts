import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import {
  EndpointGrantSchema,
  MAX_ENDPOINT_HEX_BYTES,
  MAX_GRANT_BYTES,
  type EndpointGrant,
} from "./model.js";

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export type KeyConfig = {
  readonly id: string;
  readonly key: Uint8Array;
};

export class GrantKeyring {
  readonly #ring: AesKeyring;

  public constructor(keys: readonly KeyConfig[]) {
    this.#ring = new AesKeyring(
      "buzz-stateful-delivery-capability-v1:",
      keys,
      MAX_GRANT_BYTES,
    );
  }

  public issue(grant: EndpointGrant): string {
    return this.#ring.seal(
      Buffer.from(JSON.stringify(EndpointGrantSchema.parse(grant))),
    );
  }

  public open(value: string): EndpointGrant {
    return EndpointGrantSchema.parse(
      strictJson(this.#ring.open(value).toString("utf8")),
    );
  }
}

export class TokenKeyring {
  readonly #ring: AesKeyring;

  public constructor(keys: readonly KeyConfig[]) {
    this.#ring = new AesKeyring("buzz-apns-token-v1:", keys, 2_048);
  }

  public seal(token: Uint8Array): Buffer {
    if (token.byteLength < 1 || token.byteLength > MAX_ENDPOINT_HEX_BYTES) {
      throw new Error("invalid APNs token");
    }
    return Buffer.from(this.#ring.seal(token));
  }

  public open(value: Uint8Array): Buffer {
    return this.#ring.open(Buffer.from(value).toString("utf8"));
  }
}

class AesKeyring {
  readonly #keys = new Map<string, Buffer>();
  readonly #current: KeyConfig;

  public constructor(
    private readonly aadPrefix: string,
    keys: readonly KeyConfig[],
    private readonly maximumEnvelopeBytes: number,
  ) {
    const [current] = keys;
    if (!current) throw new Error("keyring is empty");
    this.#current = current;
    for (const item of keys) {
      if (
        !KEY_ID.test(item.id) ||
        item.key.byteLength !== 32 ||
        this.#keys.has(item.id)
      ) {
        throw new Error("invalid or duplicate keyring entry");
      }
      this.#keys.set(item.id, Buffer.from(item.key));
    }
  }

  public seal(plaintext: Uint8Array): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#current.key, nonce);
    cipher.setAAD(Buffer.from(`${this.aadPrefix}${this.#current.id}`));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = Buffer.concat([
      nonce,
      encrypted,
      cipher.getAuthTag(),
    ]).toString("base64url");
    const encoded = `${this.#current.id}.${envelope}`;
    if (Buffer.byteLength(encoded) > this.maximumEnvelopeBytes) {
      throw new Error("encrypted envelope is too large");
    }
    return encoded;
  }

  public open(encoded: string): Buffer {
    if (Buffer.byteLength(encoded) > this.maximumEnvelopeBytes) {
      throw new Error("invalid encrypted envelope");
    }
    const separator = encoded.indexOf(".");
    if (separator < 1) throw new Error("invalid encrypted envelope");
    const id = encoded.slice(0, separator);
    const key = this.#keys.get(id);
    if (!key) throw new Error("unknown encryption key");
    const bytes = Buffer.from(encoded.slice(separator + 1), "base64url");
    if (bytes.byteLength < 29) throw new Error("invalid encrypted envelope");
    const nonce = bytes.subarray(0, 12);
    const tag = bytes.subarray(bytes.byteLength - 16);
    const ciphertext = bytes.subarray(12, bytes.byteLength - 16);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(`${this.aadPrefix}${id}`));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error("invalid encrypted envelope");
    }
  }
}

function strictJson(value: string): unknown {
  // JSON.parse cannot itself expose duplicate keys. The sealed plaintext is
  // produced only by this process, while the strict Zod schema closes fields.
  return JSON.parse(value) as unknown;
}
