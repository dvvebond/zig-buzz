import {
  chmod,
  mkdtemp,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function readTextFile(
  path: string,
  workdir = process.cwd(),
): Promise<{ readonly path: string; readonly content: string }> {
  const target = resolvePath(path, workdir);
  const metadata = await stat(target);
  if (!metadata.isFile()) throw new Error(`not a regular file: ${target}`);
  if (metadata.size > MAX_FILE_BYTES) throw new Error("file too large");
  const content = await readFile(target, "utf8");
  if (Buffer.byteLength(content) > MAX_FILE_BYTES)
    throw new Error("file grew during read");
  return { path: target, content };
}

export async function readFileTool(args: unknown): Promise<string> {
  const value = object(args);
  const path = string(value.path, "path");
  const offset = optionalInteger(value.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = optionalInteger(value.limit, 2_000, 0, 10_000);
  const workdir = optionalString(value.workdir);
  const file = await readTextFile(path, workdir);
  const lines = file.content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return `${path} is empty (0 lines)`;
  const selected = lines.slice(offset, offset + limit);
  if (selected.length === 0) {
    return `${path} (no lines in range, file has ${lines.length} lines)`;
  }
  const start = offset + 1;
  const end = offset + selected.length;
  let output = `${path} (lines ${start}-${end} of ${lines.length})\n`;
  output += selected
    .map((line, index) => `${offset + index + 1}:${line}`)
    .join("\n");
  if (end < lines.length) {
    output += `\n[showing lines ${start}-${end} of ${lines.length}; use offset=${end} to continue]`;
  }
  return `${output}\n`;
}

export async function strReplaceTool(args: unknown): Promise<string> {
  const value = object(args);
  const path = string(value.path, "path");
  const oldString = string(value.old_str, "old_str");
  const newString = string(value.new_str, "new_str");
  const replaceAll = value.replace_all === true;
  if (!oldString) throw new Error("old_str must not be empty");
  if (
    Buffer.byteLength(oldString) > 1024 * 1024 ||
    Buffer.byteLength(newString) > 1024 * 1024
  ) {
    throw new Error("old_str/new_str exceeds 1 MiB");
  }
  const file = await readTextFile(path, optionalString(value.workdir));
  const occurrences = file.content.split(oldString).length - 1;
  if (occurrences === 0) throw new Error(`old_str not found in ${file.path}`);
  if (!replaceAll && occurrences > 1) {
    throw new Error("old_str matched multiple locations; provide more context");
  }
  const updated = replaceAll
    ? file.content.replaceAll(oldString, newString)
    : file.content.replace(oldString, newString);
  if (Buffer.byteLength(updated) > MAX_FILE_BYTES)
    throw new Error("result too large");
  const metadata = await stat(file.path);
  const scratch = await mkdtemp(join(dirname(file.path), ".buzz-edit-"));
  const temporary = join(scratch, basename(file.path));
  await writeFile(temporary, updated, { mode: metadata.mode });
  const handle = await open(temporary, "r");
  await handle.sync();
  await handle.close();
  await rename(temporary, file.path);
  await chmod(file.path, metadata.mode);
  const diff = compactDiff(file.path, file.content, updated);
  return `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${file.path}.\n\n${diff}`;
}

export function resolvePath(path: string, workdir = process.cwd()): string {
  if (!path || path.includes("\0")) throw new Error("invalid path");
  return resolve(isAbsolute(path) ? path : join(workdir, path));
}

function compactDiff(path: string, oldValue: string, newValue: string): string {
  const oldLines = oldValue.split("\n");
  const newLines = newValue.split("\n");
  let start = 0;
  while (oldLines[start] === newLines[start] && start < oldLines.length)
    start += 1;
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (
    oldEnd >= start &&
    newEnd >= start &&
    oldLines[oldEnd] === newLines[newEnd]
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const contextStart = Math.max(0, start - 3);
  const contextOldEnd = Math.min(oldLines.length - 1, oldEnd + 3);
  const contextNewEnd = Math.min(newLines.length - 1, newEnd + 3);
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${contextStart + 1},${contextOldEnd - contextStart + 1} +${contextStart + 1},${contextNewEnd - contextStart + 1} @@`,
    ...oldLines.slice(contextStart, start).map((line) => ` ${line}`),
    ...oldLines.slice(start, oldEnd + 1).map((line) => `-${line}`),
    ...newLines.slice(start, newEnd + 1).map((line) => `+${line}`),
    ...newLines.slice(newEnd + 1, contextNewEnd + 1).map((line) => ` ${line}`),
  ].join("\n");
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("arguments must be an object");
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

export function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("expected a string");
  return value;
}

export function optionalInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`expected integer ${minimum}..${maximum}`);
  }
  return value as number;
}
