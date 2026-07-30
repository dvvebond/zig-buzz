import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FILE_VERSION = 1;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const AAD = Buffer.from("buzz.desktop.state.v1", "utf8");

export type DesktopState = {
  identitySecretHex: string;
  settings: Record<string, unknown>;
};

type Envelope = {
  ciphertext: string;
  nonce: string;
  tag: string;
  v: number;
};

export class SecureStore {
  readonly #directory: string;
  readonly #keyPath: string;
  readonly #statePath: string;
  #key: Buffer | undefined;
  #queue: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.#directory = path.resolve(directory);
    this.#keyPath = path.join(this.#directory, "master.key");
    this.#statePath = path.join(this.#directory, "state.enc.json");
  }

  async load(): Promise<DesktopState | undefined> {
    const key = await this.#loadOrCreateKey();
    let raw: Buffer;
    try {
      raw = await readFile(this.#statePath);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    if (raw.byteLength > MAX_STATE_BYTES) {
      throw new Error("encrypted desktop state exceeds the 8 MiB limit");
    }

    const envelope = parseEnvelope(raw);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.nonce, "base64"),
    );
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    if (plaintext.byteLength > MAX_STATE_BYTES) {
      throw new Error("decrypted desktop state exceeds the 8 MiB limit");
    }

    const value: unknown = JSON.parse(plaintext.toString("utf8"));
    if (!isDesktopState(value)) {
      throw new Error("desktop state has an invalid shape");
    }
    return value;
  }

  async save(state: DesktopState): Promise<void> {
    const operation = this.#queue.then(async () => {
      const key = await this.#loadOrCreateKey();
      const plaintext = Buffer.from(JSON.stringify(state), "utf8");
      if (plaintext.byteLength > MAX_STATE_BYTES) {
        throw new Error("desktop state exceeds the 8 MiB limit");
      }
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      const envelope: Envelope = {
        ciphertext: ciphertext.toString("base64"),
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        v: FILE_VERSION,
      };
      const temporaryPath = `${this.#statePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(envelope)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, this.#statePath);
      await chmod(this.#statePath, 0o600);
    });
    this.#queue = operation.catch(() => undefined);
    await operation;
  }

  close(): void {
    this.#key?.fill(0);
    this.#key = undefined;
  }

  async #loadOrCreateKey(): Promise<Buffer> {
    if (this.#key) return this.#key;
    await mkdir(this.#directory, { mode: 0o700, recursive: true });
    await chmod(this.#directory, 0o700);

    let key: Buffer;
    try {
      key = await readFile(this.#keyPath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const generated = randomBytes(KEY_BYTES);
      try {
        const handle = await open(this.#keyPath, "wx", 0o600);
        try {
          await handle.writeFile(generated);
          await handle.sync();
        } finally {
          await handle.close();
        }
        key = generated;
      } catch (createError) {
        if (!isAlreadyExists(createError)) throw createError;
        key = await readFile(this.#keyPath);
      }
    }
    if (key.byteLength !== KEY_BYTES) {
      throw new Error("desktop master key must contain exactly 32 bytes");
    }
    const metadata = await stat(this.#keyPath);
    if ((metadata.mode & 0o077) !== 0) {
      await chmod(this.#keyPath, 0o600);
    }
    this.#key = key;
    return key;
  }
}

function parseEnvelope(raw: Buffer): Envelope {
  const value: unknown = JSON.parse(raw.toString("utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("v" in value) ||
    value.v !== FILE_VERSION ||
    !("nonce" in value) ||
    typeof value.nonce !== "string" ||
    Buffer.from(value.nonce, "base64").byteLength !== NONCE_BYTES ||
    !("tag" in value) ||
    typeof value.tag !== "string" ||
    Buffer.from(value.tag, "base64").byteLength !== TAG_BYTES ||
    !("ciphertext" in value) ||
    typeof value.ciphertext !== "string"
  ) {
    throw new Error("encrypted desktop state has an invalid envelope");
  }
  return value as Envelope;
}

function isDesktopState(value: unknown): value is DesktopState {
  return (
    typeof value === "object" &&
    value !== null &&
    "identitySecretHex" in value &&
    typeof value.identitySecretHex === "string" &&
    /^[0-9a-f]{64}$/.test(value.identitySecretHex) &&
    "settings" in value &&
    typeof value.settings === "object" &&
    value.settings !== null &&
    !Array.isArray(value.settings)
  );
}

function isNotFound(error: unknown): boolean {
  return isErrorCode(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return isErrorCode(error, "EEXIST");
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
