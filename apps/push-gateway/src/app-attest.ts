import {
  X509Certificate,
  createHash,
  createPublicKey,
  createVerify,
  timingSafeEqual,
  type JsonWebKey,
} from "node:crypto";

import { decode } from "cbor-x";

const APPLE_ROOT_PEM_SHA256 =
  "c778d09ac341f7fd9f8f3b19e2b815af6aed4ad4490e1e92c05cb355212a5013";
const CREDENTIAL_CERT_OID = Buffer.from([
  0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02,
]);

export type VerifiedAttestation = {
  readonly keyId: Buffer;
  readonly publicKey: Buffer;
};

export class AppleAppAttestVerifier {
  readonly #appId: string;
  readonly #root: X509Certificate;

  public constructor(appId: string, rootPem: Uint8Array) {
    if (
      !appId ||
      createHash("sha256").update(rootPem).digest("hex") !==
        APPLE_ROOT_PEM_SHA256
    ) {
      throw new Error("invalid Apple App Attest configuration");
    }
    this.#appId = appId;
    this.#root = new X509Certificate(rootPem);
  }

  public verifyAttestation(
    attestationBase64: string,
    keyIdBase64: string,
    clientData: Uint8Array,
  ): VerifiedAttestation {
    const encoded = strictBase64(attestationBase64, 16 * 1_024);
    const root = cborRecord(encoded);
    if (root.fmt !== "apple-appattest") {
      throw new Error("invalid App Attest format");
    }
    const statement = asRecord(root.attStmt);
    const chain = asByteArray(statement.x5c);
    const receipt = asBytes(statement.receipt);
    const authData = asBytes(root.authData);
    if (
      chain.length < 2 ||
      chain.length > 3 ||
      receipt.byteLength === 0 ||
      authData.byteLength < 87
    ) {
      throw new Error("invalid App Attest object");
    }
    const certificates = chain.map(
      (certificate) => new X509Certificate(certificate),
    );
    verifyCertificateChain(certificates, this.#root);
    const keyId = strictBase64(keyIdBase64, 32);
    if (keyId.byteLength !== 32) {
      throw new Error("invalid App Attest key id");
    }
    const publicKey = rawP256PublicKey(certificates[0] as X509Certificate);
    if (
      !timingSafeEqual(createHash("sha256").update(publicKey).digest(), keyId)
    ) {
      throw new Error("App Attest public key does not match key id");
    }
    const expectedNonce = createHash("sha256")
      .update(authData)
      .update(createHash("sha256").update(clientData).digest())
      .digest();
    const certificateNonce = credentialCertificateNonce(certificates[0]!.raw);
    if (!timingSafeEqual(expectedNonce, certificateNonce)) {
      throw new Error("App Attest nonce does not match");
    }
    verifyAuthenticatorData(authData, this.#appId, keyId, true);
    return { keyId: Buffer.from(keyId), publicKey };
  }

  public verifyAssertion(input: {
    readonly assertionBase64: string;
    readonly clientData: Uint8Array;
    readonly publicKey: Uint8Array;
    readonly previousCounter: number;
    readonly challenge: string;
    readonly storedChallenge: string;
  }): { readonly counter: number } {
    const encoded = strictBase64(input.assertionBase64, 1_024);
    const assertion = cborRecord(encoded);
    if (
      Object.keys(assertion).sort().join(",") !== "authenticatorData,signature"
    ) {
      throw new Error("invalid App Attest assertion shape");
    }
    const authData = asBytes(assertion.authenticatorData);
    const signature = asBytes(assertion.signature);
    if (
      authData.byteLength !== 37 ||
      signature.byteLength < 64 ||
      signature.byteLength > 80 ||
      input.publicKey.byteLength !== 65
    ) {
      throw new Error("invalid App Attest assertion");
    }
    const nonce = createHash("sha256")
      .update(authData)
      .update(createHash("sha256").update(input.clientData).digest())
      .digest();
    const verifier = createVerify("SHA256");
    verifier.update(nonce);
    verifier.end();
    if (!verifier.verify(publicKeyObject(input.publicKey), signature)) {
      throw new Error("invalid App Attest assertion signature");
    }
    const counter = verifyAuthenticatorData(
      authData,
      this.#appId,
      undefined,
      false,
    );
    if (
      counter <= input.previousCounter ||
      input.challenge !== input.storedChallenge
    ) {
      throw new Error("invalid App Attest assertion counter or challenge");
    }
    return { counter };
  }
}

function verifyCertificateChain(
  certificates: readonly X509Certificate[],
  root: X509Certificate,
): void {
  const now = Date.now();
  for (const certificate of [...certificates, root]) {
    const before = Date.parse(certificate.validFrom);
    const after = Date.parse(certificate.validTo);
    if (
      !Number.isFinite(before) ||
      !Number.isFinite(after) ||
      now < before ||
      now > after
    ) {
      throw new Error("App Attest certificate is outside its validity window");
    }
  }
  for (let index = 0; index < certificates.length - 1; index += 1) {
    const child = certificates[index] as X509Certificate;
    const issuer = certificates[index + 1] as X509Certificate;
    if (!child.checkIssued(issuer) || !child.verify(issuer.publicKey)) {
      throw new Error("invalid App Attest certificate chain");
    }
  }
  const last = certificates.at(-1) as X509Certificate;
  if (!last.checkIssued(root) || !last.verify(root.publicKey)) {
    throw new Error("App Attest chain is not rooted at the pinned Apple CA");
  }
}

function verifyAuthenticatorData(
  authData: Uint8Array,
  appId: string,
  credentialId: Uint8Array | undefined,
  requireAttestation: boolean,
): number {
  if (authData.byteLength < 37) {
    throw new Error("App Attest authenticator data is too short");
  }
  const rpId = createHash("sha256").update(appId).digest();
  if (!timingSafeEqual(Buffer.from(authData.subarray(0, 32)), rpId)) {
    throw new Error("App Attest application id does not match");
  }
  const counter = Buffer.from(authData).readUInt32BE(33);
  if (!requireAttestation) return counter;
  if (counter !== 0 || authData.byteLength < 87 || !credentialId) {
    throw new Error("invalid App Attest attestation counter");
  }
  const aaguid = Buffer.from(authData.subarray(37, 53));
  let end = aaguid.byteLength;
  while (end > 0 && aaguid[end - 1] === 0) end -= 1;
  if (aaguid.subarray(0, end).toString("ascii") !== "appattest") {
    throw new Error("development App Attest credentials are not accepted");
  }
  if (
    !timingSafeEqual(
      Buffer.from(authData.subarray(55, 87)),
      Buffer.from(credentialId),
    )
  ) {
    throw new Error("App Attest credential id does not match");
  }
  return counter;
}

function rawP256PublicKey(certificate: X509Certificate): Buffer {
  const jwk = certificate.publicKey.export({ format: "jwk" });
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("App Attest certificate does not use P-256");
  }
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  if (x.byteLength !== 32 || y.byteLength !== 32) {
    throw new Error("invalid App Attest P-256 public key");
  }
  return Buffer.concat([Buffer.from([4]), x, y]);
}

function publicKeyObject(raw: Uint8Array) {
  const bytes = Buffer.from(raw);
  if (bytes.byteLength !== 65 || bytes[0] !== 4) {
    throw new Error("invalid stored App Attest public key");
  }
  const jwk: JsonWebKey = {
    crv: "P-256",
    kty: "EC",
    x: bytes.subarray(1, 33).toString("base64url"),
    y: bytes.subarray(33).toString("base64url"),
  };
  return createPublicKey({ format: "jwk", key: jwk });
}

function credentialCertificateNonce(certificate: Uint8Array): Buffer {
  const extension = derFindExtension(certificate, CREDENTIAL_CERT_OID);
  const sequence = derUnwrap(extension, 0x30);
  const context = derUnwrap(sequence, 0xa1);
  const nonce = derUnwrap(context, 0x04);
  if (nonce.byteLength !== 32) {
    throw new Error("invalid App Attest credential certificate nonce");
  }
  return Buffer.from(nonce);
}

function derFindExtension(
  certificate: Uint8Array,
  oid: Uint8Array,
): Uint8Array {
  const cert = derUnwrap(certificate, 0x30);
  const tbs = derUnwrap(cert, 0x30);
  for (const field of derChildren(tbs)) {
    if (field.tag !== 0xa3) continue;
    const extensions = derUnwrap(field.value, 0x30);
    for (const extension of derChildren(extensions)) {
      if (extension.tag !== 0x30) continue;
      const parts = derChildren(extension.value);
      const oidPart = parts[0];
      if (
        oidPart?.tag === 0x06 &&
        Buffer.from(oidPart.value).equals(Buffer.from(oid))
      ) {
        const value = parts.find((part) => part.tag === 0x04);
        if (!value) break;
        return value.value;
      }
    }
  }
  throw new Error("App Attest credential certificate extension is missing");
}

function derUnwrap(value: Uint8Array, tag: number): Uint8Array {
  const children = derChildren(value, true);
  const item = children[0];
  if (!item || item.tag !== tag || item.end !== value.byteLength) {
    throw new Error("invalid DER structure");
  }
  return item.value;
}

function derChildren(
  value: Uint8Array,
  one = false,
): Array<{ tag: number; value: Uint8Array; end: number }> {
  const result: Array<{ tag: number; value: Uint8Array; end: number }> = [];
  let position = 0;
  while (position < value.byteLength) {
    const tag = value[position];
    const firstLength = value[position + 1];
    if (tag === undefined || firstLength === undefined) {
      throw new Error("truncated DER");
    }
    let length: number;
    let header = 2;
    if (firstLength < 0x80) {
      length = firstLength;
    } else {
      const count = firstLength & 0x7f;
      if (count < 1 || count > 4 || position + 2 + count > value.byteLength) {
        throw new Error("invalid DER length");
      }
      length = 0;
      for (let index = 0; index < count; index += 1) {
        length = length * 256 + (value[position + 2 + index] as number);
      }
      header += count;
    }
    const start = position + header;
    const end = start + length;
    if (end > value.byteLength) throw new Error("truncated DER value");
    result.push({ end, tag, value: value.subarray(start, end) });
    position = end;
    if (one) break;
  }
  return result;
}

function strictBase64(value: string, maximumBytes: number): Buffer {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error("invalid base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength < 1 ||
    decoded.byteLength > maximumBytes ||
    decoded.toString("base64") !== value
  ) {
    throw new Error("invalid base64 bounds or canonical form");
  }
  return decoded;
}

function cborRecord(value: Uint8Array): Record<string, unknown> {
  return asRecord(decode(value) as unknown);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid CBOR map");
  }
  if (value instanceof Map) {
    const entries = [...value.entries()];
    if (entries.some(([key]) => typeof key !== "string")) {
      throw new Error("invalid CBOR map key");
    }
    return Object.fromEntries(entries) as Record<string, unknown>;
  }
  return value as Record<string, unknown>;
}

function asBytes(value: unknown): Buffer {
  if (!(value instanceof Uint8Array)) throw new Error("expected CBOR bytes");
  return Buffer.from(value);
}

function asByteArray(value: unknown): Buffer[] {
  if (!Array.isArray(value)) throw new Error("expected CBOR byte array");
  return value.map(asBytes);
}
