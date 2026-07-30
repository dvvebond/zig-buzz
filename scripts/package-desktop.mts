#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const parsed = parseArgs({
  options: {
    archive: { type: "boolean", default: false },
    out: { type: "string" },
    platform: {
      type: "string",
      default: `${process.platform}-${process.arch}`,
    },
  },
  strict: true,
});
const platform = safeSegment(parsed.values.platform);
const outputRoot = path.resolve(
  repositoryRoot,
  parsed.values.out ?? `dist/buzz-desktop-${platform}`,
);
assertSafeOutput(outputRoot);

await rm(outputRoot, { force: true, recursive: true });
await mkdir(path.join(outputRoot, "bin"), { recursive: true });

await run("pnpm", ["-C", "desktop", "build"]);
await run("pnpm", ["--filter", "@buzz/sprig", "build"]);
await run("pnpm", ["--filter", "@buzz/remote-agent", "build"]);
try {
  await run("pnpm", [
    "--config.allow-unused-patches=true",
    "--filter",
    "@buzz/desktop-host",
    "deploy",
    "--legacy",
    "--prod",
    path.join(outputRoot, "host"),
  ]);
  await run("pnpm", [
    "--config.allow-unused-patches=true",
    "--filter",
    "@buzz/sprig",
    "deploy",
    "--legacy",
    "--prod",
    path.join(outputRoot, "tools"),
  ]);
  await run("pnpm", [
    "--config.allow-unused-patches=true",
    "--filter",
    "@buzz/remote-agent",
    "deploy",
    "--legacy",
    "--prod",
    path.join(outputRoot, "remote-agent"),
  ]);
} finally {
  // pnpm's v11 legacy deploy marks the shared workspace modules state as
  // production-only. Restore the already-cached development graph even when a
  // deploy fails, otherwise the next workspace command silently prunes CI
  // tooling such as TypeScript, Vitest, and Biome.
  await run("pnpm", [
    "install",
    "--frozen-lockfile",
    "--offline",
    "--prod=false",
  ]);
}

await cp(
  path.join(repositoryRoot, "desktop", "dist"),
  path.join(outputRoot, "ui"),
  {
    recursive: true,
  },
);
await copyFile(
  path.join(repositoryRoot, "LICENSE"),
  path.join(outputRoot, "LICENSE"),
);

const unixLauncher = `#!/usr/bin/env sh
set -eu
BUZZ_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
export BUZZ_DESKTOP_DIST="$BUZZ_ROOT/ui"
export PATH="$BUZZ_ROOT/tools/node_modules/.bin:$BUZZ_ROOT/tools:$PATH"
exec node "$BUZZ_ROOT/host/dist/main.js" "$@"
`;
const workerLauncher = `#!/usr/bin/env sh
set -eu
BUZZ_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec node "$BUZZ_ROOT/remote-agent/dist/main.js" "$@"
`;
const windowsLauncher = `@echo off\r
set "BUZZ_ROOT=%~dp0.."\r
set "BUZZ_DESKTOP_DIST=%BUZZ_ROOT%\\ui"\r
set "PATH=%BUZZ_ROOT%\\tools\\node_modules\\.bin;%BUZZ_ROOT%\\tools;%PATH%"\r
node "%BUZZ_ROOT%\\host\\dist\\main.js" %*\r
`;
const windowsWorkerLauncher = `@echo off\r
set "BUZZ_ROOT=%~dp0.."\r
node "%BUZZ_ROOT%\\remote-agent\\dist\\main.js" %*\r
`;
const desktopLauncher = path.join(outputRoot, "bin", "buzz-desktop");
const remoteLauncher = path.join(outputRoot, "bin", "buzz-remote-agent");
await writeFile(desktopLauncher, unixLauncher, { mode: 0o755 });
await writeFile(remoteLauncher, workerLauncher, { mode: 0o755 });
await writeFile(
  path.join(outputRoot, "bin", "buzz-desktop.cmd"),
  windowsLauncher,
);
await writeFile(
  path.join(outputRoot, "bin", "buzz-remote-agent.cmd"),
  windowsWorkerLauncher,
);
await chmod(desktopLauncher, 0o755);
await chmod(remoteLauncher, 0o755);

const packageMetadata = JSON.parse(
  await readFile(path.join(repositoryRoot, "desktop", "package.json"), "utf8"),
) as { readonly version?: unknown };
const version =
  typeof packageMetadata.version === "string"
    ? packageMetadata.version
    : "0.0.0";
await writeFile(
  path.join(outputRoot, "PACKAGE.json"),
  `${JSON.stringify(
    {
      format: "buzz-typescript-desktop",
      node: ">=22",
      platform,
      version,
    },
    null,
    2,
  )}\n`,
);

const checksums = await checksumTree(outputRoot);
await writeFile(
  path.join(outputRoot, "SHA256SUMS"),
  checksums.map(({ digest, relative }) => `${digest}  ${relative}`).join("\n") +
    "\n",
);

if (parsed.values.archive) {
  const archivePath = `${outputRoot}.tar.gz`;
  await rm(archivePath, { force: true });
  await run("tar", [
    "-C",
    path.dirname(outputRoot),
    "-czf",
    archivePath,
    path.basename(outputRoot),
  ]);
  process.stdout.write(`${archivePath}\n`);
} else {
  process.stdout.write(`${outputRoot}\n`);
}

function assertSafeOutput(output: string): void {
  const allowedRoot = path.join(repositoryRoot, "dist");
  const relative = path.relative(allowedRoot, output);
  if (
    output === repositoryRoot ||
    output === homedir() ||
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`output must be a child of ${allowedRoot}`);
  }
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(value)) {
    throw new Error(
      "platform must contain only letters, digits, dot, dash, or underscore",
    );
  }
  return value;
}

async function checksumTree(
  root: string,
): Promise<Array<{ readonly digest: string; readonly relative: string }>> {
  const files: string[] = [];
  await walk(root, files);
  const output: Array<{ digest: string; relative: string }> = [];
  for (const file of files.sort()) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (relative === "SHA256SUMS") continue;
    const digest = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    output.push({ digest, relative });
  }
  return output;
}

async function walk(directory: string, files: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute, files);
    else if (entry.isFile() || entry.isSymbolicLink()) {
      const details = await stat(absolute);
      if (details.isFile()) files.push(absolute);
    }
  }
}

/**
 * Resolve how to invoke a tool without a shell, so no argument ever passes
 * through shell quoting.
 *
 * On Windows `pnpm` is a `.cmd` shim, which `spawn` cannot execute directly.
 * When this script is itself run by pnpm, `npm_execpath` points at pnpm's own
 * JavaScript entry, which the current Node can execute on every platform; that
 * is preferred because it also guarantees the same pnpm version. Otherwise fall
 * back to naming the platform's shim.
 */
function resolveInvocation(
  command: string,
  args: readonly string[],
): { command: string; args: readonly string[] } {
  if (command !== "pnpm") return { args, command };
  const execPath = process.env.npm_execpath;
  if (execPath && /\.[cm]?js$/i.test(execPath)) {
    return { args: [execPath, ...args], command: process.execPath };
  }
  return {
    args,
    command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  };
}

async function run(command: string, args: readonly string[]): Promise<void> {
  const invocation = resolveInvocation(command, args);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: repositoryRoot,
      env: { ...process.env, CI: "true" },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} terminated by ${signal}`));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with status ${code ?? "unknown"}`));
      }
    });
  });
}
