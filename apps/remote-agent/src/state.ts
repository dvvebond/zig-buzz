import {
  constants,
  chmod,
  mkdir,
  lstat,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";

import { z } from "zod";
import { remoteDeploymentConfigSchema } from "@buzz/remote-agent-protocol";

const STATE_AAD = Buffer.from("buzz-remote-agent-state-v1", "utf8");
const encryptedStateSchema = z
  .object({
    version: z.literal(1),
    iv: z.string().regex(/^[0-9a-f]{24}$/),
    ciphertext: z.string().min(1),
    authTag: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();

const deploymentStateSchema = z
  .object({
    id: z.uuid(),
    agentSecretKeyHex: z.string().regex(/^[0-9a-f]{64}$/),
    config: remoteDeploymentConfigSchema,
    status: z.enum(["stopped", "running", "failed", "revoked"]),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

const workerStateSchema = z
  .object({
    version: z.literal(1),
    workerSecretKeyHex: z.string().regex(/^[0-9a-f]{64}$/),
    ownerPubkey: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    enrollmentId: z.uuid().optional(),
    community: z.string().min(1).max(253).optional(),
    approved: z.boolean(),
    revoked: z.boolean().default(false),
    workerName: z.string().min(1).max(128),
    deployments: z.record(z.string(), deploymentStateSchema),
  })
  .strict();

export type DeploymentState = z.infer<typeof deploymentStateSchema>;
export type WorkerState = z.infer<typeof workerStateSchema>;

export class EncryptedStateStore {
  readonly #statePath: string;
  readonly #keyPath: string;

  public constructor(dataDirectory: string) {
    this.#statePath = join(dataDirectory, "state.enc.json");
    this.#keyPath = join(dataDirectory, "state.key");
  }

  public async loadOrCreate(input: {
    readonly workerName: string;
    readonly workerSecretKeyHex: string;
  }): Promise<WorkerState> {
    await mkdir(dirname(this.#statePath), { mode: 0o700, recursive: true });
    await chmod(dirname(this.#statePath), 0o700);
    const key = await this.#loadOrCreateKey();

    try {
      await assertPrivateFile(this.#statePath);
      const encoded = await readFile(this.#statePath, "utf8");
      return decryptState(encoded, key);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const state: WorkerState = {
        approved: false,
        deployments: {},
        revoked: false,
        version: 1,
        workerName: input.workerName,
        workerSecretKeyHex: input.workerSecretKeyHex,
      };
      await this.save(state);
      return state;
    }
  }

  public async save(state: WorkerState): Promise<void> {
    const parsed = workerStateSchema.parse(state);
    const key = await this.#loadOrCreateKey();
    const encoded = encryptState(parsed, key);
    const temporaryPath = `${this.#statePath}.${randomUUID()}.tmp`;
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(encoded, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.#statePath);
    await chmod(this.#statePath, 0o600);
  }

  async #loadOrCreateKey(): Promise<Buffer> {
    try {
      await assertPrivateFile(this.#keyPath);
      const key = await readFile(this.#keyPath);
      if (key.length !== 32)
        throw new Error("state key must be exactly 32 bytes");
      return key;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    const key = randomBytes(32);
    try {
      const handle = await open(
        this.#keyPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(key);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return key;
    } catch (error) {
      // A concurrent process may have created it. Read the winner, but never
      // overwrite a key because that would make existing state unrecoverable.
      if (!isAlreadyExists(error)) throw error;
      return this.#loadOrCreateKey();
    }
  }
}

function encryptState(state: WorkerState, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(STATE_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(state), "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    authTag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("hex"),
    version: 1,
  });
}

function decryptState(encoded: string, key: Buffer): WorkerState {
  const envelope = encryptedStateSchema.parse(JSON.parse(encoded) as unknown);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "hex"),
  );
  decipher.setAAD(STATE_AAD);
  decipher.setAuthTag(Buffer.from(envelope.authTag, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]);
  return workerStateSchema.parse(
    JSON.parse(plaintext.toString("utf8")) as unknown,
  );
}

async function assertPrivateFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${path} must be a regular file`);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`${path} permissions are too broad; expected mode 0600`);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

// Kept internal for tests that simulate an interrupted first write.
export async function removeStateFileForTest(path: string): Promise<void> {
  await unlink(path);
}
