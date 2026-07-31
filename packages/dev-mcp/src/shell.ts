import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { object, optionalInteger, optionalString, string } from "./files.js";

const MAX_CAPTURE = 10 * 1024 * 1024;
const MAX_RETURN = 8 * 1024;

export async function shellTool(args: unknown): Promise<string> {
  const value = object(args);
  const command = string(value.command ?? value.cmd, "command");
  const timeoutMs = optionalInteger(value.timeout_ms, 120_000, 1, 600_000);
  const cwd = optionalString(value.workdir) ?? process.cwd();
  const shell =
    process.env.BUZZ_SHELL ??
    (process.platform === "win32" ? "powershell.exe" : "bash");
  const shellArgs =
    process.platform === "win32" && /powershell/i.test(shell)
      ? ["-NoProfile", "-NonInteractive", "-Command", command]
      : ["-lc", command];
  const child = spawn(shell, shellArgs, {
    cwd,
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  const capture = (chunk: Buffer): void => {
    if (bytes >= MAX_CAPTURE) return;
    const accepted = chunk.subarray(0, MAX_CAPTURE - bytes);
    chunks.push(accepted);
    bytes += accepted.byteLength;
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    } else child.kill("SIGKILL");
  }, timeoutMs);
  const result = await new Promise<{
    code: number | null;
    signal: string | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  const output = Buffer.concat(chunks).toString("utf8");
  const artifactDir = join(cwd, ".buzz", "mcp-artifacts");
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  const artifact = join(
    artifactDir,
    `shell-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.log`,
  );
  await writeFile(artifact, output, { mode: 0o600 });
  const tail =
    Buffer.byteLength(output) > MAX_RETURN
      ? `[output tail; full capture: ${artifact}]\n${Buffer.from(output).subarray(-MAX_RETURN).toString("utf8")}`
      : output;
  return `${tail}${tail.endsWith("\n") || tail === "" ? "" : "\n"}[exit=${result.code ?? result.signal ?? "unknown"}${timedOut ? " timeout" : ""}; artifact=${artifact}]`;
}
