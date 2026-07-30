#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { writeSync } from "node:fs";
import {
  normalizePublicKey,
  parseSecretKey,
  signPayload,
  verifyArmored,
  type OwnerAttestation,
} from "./index.js";

const parsed = parseArgs(process.argv.slice(2));
const payload = await readStdinBounded(100 * 1024 * 1024);
if (parsed.mode === "sign") {
  try {
    const secretKey = await loadKey();
    const ownerAttestation = loadAuthTag();
    const result = signPayload({
      payload,
      secretKey,
      keyId: parsed.keyId,
      ...(ownerAttestation ? { ownerAttestation } : {}),
    });
    process.stdout.write(result.armored);
    status(parsed.statusFd, "BEGIN_SIGNING");
    status(
      parsed.statusFd,
      `SIG_CREATED D 8 1 00 ${result.envelope.t} ${result.envelope.pk}`,
    );
  } catch (error) {
    process.stderr.write(`error: ${message(error)}\n`);
    process.exitCode = 1;
  }
} else {
  try {
    const metadata = await stat(parsed.signatureFile);
    if (!metadata.isFile() || metadata.size > 8 * 1024) {
      throw new Error("signature file is not a bounded regular file");
    }
    const signatureFile = await open(parsed.signatureFile, "r");
    const armored = await signatureFile.readFile("utf8");
    await signatureFile.close();
    const result = verifyArmored(armored, payload);
    const { envelope } = result;
    status(parsed.statusFd, "NEWSIG", true);
    status(parsed.statusFd, `GOODSIG ${envelope.pk} ${envelope.pk}`, true);
    status(
      parsed.statusFd,
      `VALIDSIG ${envelope.pk} ${utcDate(envelope.t)} ${envelope.t} 0 - - - - - ${envelope.pk}`,
      true,
    );
    status(
      parsed.statusFd,
      `${trusted(envelope.pk) ? "TRUST_FULLY" : "TRUST_UNDEFINED"} 0 shell`,
      true,
    );
    status(parsed.statusFd, "NOTATION_NAME nostr-trust-model", true);
    status(parsed.statusFd, "NOTATION_DATA advisory-config-match-only", true);
    status(parsed.statusFd, "NOTATION_NAME nostr-oa-status", true);
    status(
      parsed.statusFd,
      `NOTATION_DATA ${result.ownerAttestationStatus}`,
      true,
    );
    if (envelope.oa) {
      status(parsed.statusFd, "NOTATION_NAME nostr-oa-owner", true);
      status(parsed.statusFd, `NOTATION_DATA ${envelope.oa[0]}`, true);
    }
  } catch (error) {
    status(parsed.statusFd, "ERRSIG 0000000000000000 0 0 00 0 9");
    process.stderr.write(`error: ${message(error)}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(
  args: readonly string[],
):
  | { mode: "sign"; keyId: string; statusFd?: number }
  | { mode: "verify"; signatureFile: string; statusFd?: number } {
  let statusFd: number | undefined;
  let keyId: string | undefined;
  let signatureFile: string | undefined;
  let stdinMarker = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? "";
    if (value.startsWith("--status-fd=")) {
      statusFd = parseFd(value.slice("--status-fd=".length));
    } else if (value === "--status-fd") {
      statusFd = parseFd(args[++index]);
    } else if (value === "-bsau") {
      if (signatureFile || keyId) throw new Error("conflicting signing modes");
      keyId = required(args[++index], "-bsau");
    } else if (value === "--verify") {
      if (signatureFile || keyId) throw new Error("conflicting signing modes");
      signatureFile = required(args[++index], "--verify");
    } else if (value === "-") stdinMarker = true;
  }
  if (signatureFile) {
    if (!stdinMarker) throw new Error("--verify requires trailing -");
    return {
      mode: "verify",
      signatureFile,
      ...(statusFd === undefined ? {} : { statusFd }),
    };
  }
  if (!keyId) throw new Error("must specify -bsau or --verify");
  return {
    mode: "sign",
    keyId,
    ...(statusFd === undefined ? {} : { statusFd }),
  };
}

async function loadKey(): Promise<Uint8Array> {
  for (const name of ["NOSTR_PRIVATE_KEY", "BUZZ_PRIVATE_KEY"] as const) {
    const value = process.env[name];
    delete process.env[name];
    if (value?.trim()) {
      if (Buffer.byteLength(value) > 128) throw new Error(`${name} too large`);
      return parseSecretKey(value);
    }
  }
  const path = gitConfig("nostr.keyfile");
  if (!path) throw new Error("no signing key configured");
  const link = await lstat(path);
  if (link.isSymbolicLink())
    throw new Error("keyfile symlinks are not allowed");
  if (!link.isFile() || link.size > 1_024) throw new Error("invalid keyfile");
  if (process.platform !== "win32" && (link.mode & 0o177) !== 0) {
    throw new Error("keyfile permissions must be 0600 or 0400");
  }
  const handle = await open(
    path,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  const raw = await handle.readFile("utf8");
  await handle.close();
  return parseSecretKey(raw);
}

function loadAuthTag(): OwnerAttestation | undefined {
  const raw = process.env.BUZZ_AUTH_TAG || gitConfig("nostr.authtag");
  if (!raw) return undefined;
  if (Buffer.byteLength(raw) > 1_024) throw new Error("auth tag too large");
  const value: unknown = JSON.parse(raw);
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value[0] !== "auth" ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error("invalid BUZZ_AUTH_TAG");
  }
  return [value[1], value[2], value[3]] as OwnerAttestation;
}

async function readStdinBounded(limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limit) throw new Error("payload exceeds 100 MB limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function gitConfig(key: string): string | undefined {
  try {
    const env = { ...process.env };
    delete env.NOSTR_PRIVATE_KEY;
    delete env.BUZZ_PRIVATE_KEY;
    const output = execFileSync("git", ["config", "--get", key], {
      encoding: "utf8",
      env,
      timeout: 2_000,
      maxBuffer: 8_192,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function trusted(pubkey: string): boolean {
  const configured = gitConfig("user.signingkey");
  return configured ? normalizePublicKey(configured) === pubkey : false;
}

function status(fd: number | undefined, line: string, critical = false): void {
  const target = fd ?? 2;
  try {
    writeSync(target, `[GNUPG:] ${line}\n`);
  } catch (error) {
    if (critical) throw error;
  }
}

function parseFd(value: string | undefined): number {
  const fd = Number(value);
  if (!Number.isSafeInteger(fd) || fd < 1) throw new Error("invalid status fd");
  return fd;
}

function required(value: string | undefined, option: string): string {
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function utcDate(timestamp: number): string {
  return new Date(timestamp * 1_000).toISOString().slice(0, 10);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
