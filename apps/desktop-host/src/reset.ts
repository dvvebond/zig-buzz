import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const RESET_SUFFIX = ".reset-pending";
const TRASH_SUFFIX = ".reset-trash";

export class DesktopResetService {
  readonly #dataDirectory: string;
  #pending = false;
  #restart: (() => Promise<void>) | undefined;

  constructor(dataDirectory: string) {
    this.#dataDirectory = path.resolve(dataDirectory);
  }

  setRestartHandler(handler: () => Promise<void>): void {
    if (this.#restart) throw new Error("desktop reset handler is already set");
    this.#restart = handler;
  }

  async request(): Promise<void> {
    if (this.#pending) throw new Error("desktop reset is already pending");
    if (!this.#restart) throw new Error("desktop reset is not ready");
    await writeResetSentinel(this.#dataDirectory);
    this.#pending = true;
    const restart = this.#restart;
    const timer = setTimeout(() => {
      void restart().catch((error: unknown) => {
        process.stderr.write(
          `Buzz reset failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
        );
        process.exitCode = 1;
      });
    }, 150);
    timer.unref();
  }
}

/**
 * Complete a pending reset before any identity, archive, or agent state opens.
 * The sentinel remains until every deletion succeeds, so an interrupted wipe
 * is retried on the next launch.
 */
export async function runPendingReset(dataDirectory: string): Promise<boolean> {
  const unresolvedTarget = path.resolve(dataDirectory);
  const sentinel = resetSentinelPath(unresolvedTarget);
  if (!(await exists(sentinel))) return false;
  const target = await validateResetTarget(unresolvedTarget);
  const trash = `${target}${TRASH_SUFFIX}`;

  await rm(trash, { force: true, recursive: true });
  if (await exists(target)) {
    await rejectSymlink(target);
    await rename(target, trash);
  }
  await rm(trash, { force: true, recursive: true });
  await rm(sentinel, { force: true });
  return true;
}

export async function writeResetSentinel(
  dataDirectory: string,
): Promise<string> {
  const target = await validateResetTarget(dataDirectory);
  if (await exists(target)) await rejectSymlink(target);
  const sentinel = resetSentinelPath(target);
  await mkdir(path.dirname(sentinel), { mode: 0o700, recursive: true });
  let handle;
  try {
    handle = await open(sentinel, "wx", 0o600);
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
    return sentinel;
  }
  try {
    await handle.writeFile(
      JSON.stringify({
        createdAt: new Date().toISOString(),
        nonce: randomBytes(16).toString("base64url"),
        version: 1,
      }),
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  return sentinel;
}

export async function validateResetTarget(
  dataDirectory: string,
): Promise<string> {
  if (typeof dataDirectory !== "string" || !dataDirectory.trim()) {
    throw new Error("desktop data directory is missing");
  }
  const target = path.resolve(dataDirectory);
  const root = path.parse(target).root;
  const home = path.resolve(os.homedir());
  const basename = path.basename(target).toLowerCase();
  const components = target.slice(root.length).split(path.sep).filter(Boolean);
  if (
    target === root ||
    target === home ||
    components.length < 2 ||
    !basename.includes("buzz")
  ) {
    throw new Error(
      "refusing to reset an unsafe data directory; the final directory name must contain “buzz”",
    );
  }
  return target;
}

function resetSentinelPath(target: string): string {
  return path.join(
    path.dirname(target),
    `.${path.basename(target)}${RESET_SUFFIX}`,
  );
}

async function rejectSymlink(target: string): Promise<void> {
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink()) {
    throw new Error("refusing to reset a symlinked desktop data directory");
  }
  if (!metadata.isDirectory()) {
    throw new Error("desktop data path is not a directory");
  }
}

async function exists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
