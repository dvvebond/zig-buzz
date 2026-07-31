import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { DesktopEventBus } from "./event-bus.js";

const GITHUB_API =
  "https://api.github.com/repos/Mesh-LLM/mesh-llm/releases/latest";
const MAX_RELEASE_JSON_BYTES = 2 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 4 * 1024;
const MAX_ARCHIVE_BYTES = 1_500 * 1024 * 1024;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);

type ReleaseAsset = {
  browser_download_url: string;
  name: string;
};

type Release = {
  assets: ReleaseAsset[];
  tag_name: string;
};

export class MeshRuntimeInstaller {
  readonly #dataDirectory: string;
  readonly #events: DesktopEventBus;
  readonly #fetch: typeof fetch;
  readonly #overridePath: string | undefined;
  #installing: Promise<string> | null = null;

  constructor(input: {
    dataDirectory: string;
    events: DesktopEventBus;
    fetch?: typeof fetch;
    binaryPath?: string;
  }) {
    this.#dataDirectory = path.resolve(input.dataDirectory);
    this.#events = input.events;
    this.#fetch = input.fetch ?? fetch;
    this.#overridePath = input.binaryPath;
  }

  async find(): Promise<string | null> {
    const candidates = [
      this.#overridePath,
      process.env.BUZZ_MESH_LLM_BIN,
      ...pathCandidates("mesh-llm"),
      path.join(os.homedir(), ".local", "bin", executableName()),
    ].filter((entry): entry is string => Boolean(entry));
    const managedRoot = path.join(this.#dataDirectory, "runtimes", "mesh-llm");
    try {
      const versions = (await readdir(managedRoot, { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isDirectory() && /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(entry.name),
        )
        .map((entry) => entry.name)
        .sort(compareVersions)
        .reverse();
      candidates.push(
        ...versions.map((version) =>
          path.join(managedRoot, version, executableName()),
        ),
      );
    } catch {
      // Managed runtime has not been installed yet.
    }
    for (const candidate of candidates) {
      const safe = await validateExecutable(candidate).catch(() => null);
      if (safe) return safe;
    }
    return null;
  }

  async ensure(): Promise<string> {
    const existing = await this.find();
    if (existing) return existing;
    if (!this.#installing) {
      this.#installing = this.#install().finally(() => {
        this.#installing = null;
      });
    }
    return this.#installing;
  }

  async #install(): Promise<string> {
    this.#emitProgress({
      done: false,
      downloadedBytes: null,
      file: null,
      label: "Installing the shared-compute runtime",
      status: "preparing",
      totalBytes: null,
    });
    const release = await this.#release();
    const assetName = platformAssetName();
    const asset = release.assets.find((entry) => entry.name === assetName);
    const checksumAsset = release.assets.find(
      (entry) => entry.name === `${assetName}.sha256`,
    );
    if (!asset || !checksumAsset) {
      throw new Error(
        `Mesh-LLM ${release.tag_name} has no verified ${assetName} bundle`,
      );
    }
    const checksumText = await this.#fetchText(
      checksumAsset.browser_download_url,
      MAX_CHECKSUM_BYTES,
    );
    const expected = checksumText.trim().match(/^([0-9a-f]{64})(?:\s|$)/)?.[1];
    if (!expected) throw new Error("Mesh-LLM checksum asset is malformed");

    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "buzz-mesh-install-"),
    );
    try {
      const archive = path.join(temporary, assetName);
      await this.#download(asset.browser_download_url, archive, expected);
      const entries = await runBounded(
        "tar",
        ["-tf", archive],
        30_000,
        4 * 1024 * 1024,
      );
      validateArchiveEntries(entries.stdout);
      const extracted = path.join(temporary, "extracted");
      await mkdir(extracted, { recursive: true, mode: 0o700 });
      await runBounded(
        "tar",
        ["-xf", archive, "-C", extracted],
        120_000,
        512 * 1024,
      );
      const source = await findExtractedBinary(extracted);
      const targetDirectory = path.join(
        this.#dataDirectory,
        "runtimes",
        "mesh-llm",
        release.tag_name,
      );
      await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
      const target = path.join(targetDirectory, executableName());
      await copyFile(source, target);
      if (process.platform !== "win32") await chmod(target, 0o700);
      const validated = await validateExecutable(target);
      await runBounded(validated, ["--version"], 10_000, 64 * 1024);
      this.#emitProgress({
        done: true,
        downloadedBytes: null,
        file: assetName,
        label: `Installed Mesh-LLM ${release.tag_name}`,
        status: "done",
        totalBytes: null,
      });
      return validated;
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  }

  async #release(): Promise<Release> {
    const text = await this.#fetchText(GITHUB_API, MAX_RELEASE_JSON_BYTES, {
      Accept: "application/vnd.github+json",
      "User-Agent": "Buzz-TypeScript-Desktop",
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("GitHub returned malformed Mesh-LLM release metadata");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("tag_name" in parsed) ||
      typeof parsed.tag_name !== "string" ||
      !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(parsed.tag_name) ||
      !("assets" in parsed) ||
      !Array.isArray(parsed.assets) ||
      parsed.assets.length > 256
    ) {
      throw new Error("Mesh-LLM release metadata has an invalid shape");
    }
    const assets = parsed.assets.map((value) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("name" in value) ||
        typeof value.name !== "string" ||
        !("browser_download_url" in value) ||
        typeof value.browser_download_url !== "string"
      ) {
        throw new Error("Mesh-LLM release contains an invalid asset");
      }
      validateGitHubUrl(value.browser_download_url);
      return {
        browser_download_url: value.browser_download_url,
        name: value.name,
      };
    });
    return { assets, tag_name: parsed.tag_name };
  }

  async #fetchText(
    url: string,
    maximum: number,
    headers?: Record<string, string>,
  ): Promise<string> {
    validateGitHubUrl(url);
    const response = await this.#fetch(url, {
      ...(headers ? { headers } : {}),
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    validateFinalDownloadUrl(response.url);
    if (!response.ok) {
      throw new Error(`Mesh-LLM download failed (${response.status})`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximum) {
      throw new Error("Mesh-LLM metadata response is too large");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  async #download(
    url: string,
    target: string,
    expectedSha256: string,
  ): Promise<void> {
    validateGitHubUrl(url);
    const response = await this.#fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(30 * 60_000),
    });
    validateFinalDownloadUrl(response.url);
    if (!response.ok || !response.body) {
      throw new Error(`Mesh-LLM bundle download failed (${response.status})`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
      throw new Error("Mesh-LLM bundle exceeds the 1.5 GiB safety limit");
    }
    const file = await open(target, "wx", 0o600);
    const digest = createHash("sha256");
    const reader = response.body.getReader();
    let downloaded = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        downloaded += value.byteLength;
        if (downloaded > MAX_ARCHIVE_BYTES) {
          throw new Error("Mesh-LLM bundle exceeds the 1.5 GiB safety limit");
        }
        digest.update(value);
        await file.write(value);
        this.#emitProgress({
          done: false,
          downloadedBytes: downloaded,
          file: path.basename(target),
          label: "Downloading the shared-compute runtime",
          status: "downloading",
          totalBytes: Number.isFinite(declared) ? declared : null,
        });
      }
      await file.sync();
    } finally {
      await file.close();
    }
    if (digest.digest("hex") !== expectedSha256) {
      throw new Error("Mesh-LLM bundle checksum verification failed");
    }
  }

  #emitProgress(payload: Record<string, unknown>): void {
    this.#events.emit("mesh-download-progress", payload);
  }
}

function platformAssetName(): string {
  const architecture =
    process.arch === "arm64"
      ? "aarch64"
      : process.arch === "x64"
        ? "x86_64"
        : null;
  if (!architecture) {
    throw new Error(`Mesh-LLM does not publish binaries for ${process.arch}`);
  }
  if (process.platform === "darwin") {
    return `mesh-llm-${architecture}-apple-darwin.tar.gz`;
  }
  if (process.platform === "linux") {
    return `mesh-llm-${architecture}-unknown-linux-gnu.tar.gz`;
  }
  if (process.platform === "win32" && architecture === "x86_64") {
    return "mesh-llm-x86_64-pc-windows-msvc.zip";
  }
  throw new Error(`Mesh-LLM does not publish binaries for ${process.platform}`);
}

function executableName(): string {
  return process.platform === "win32" ? "mesh-llm.exe" : "mesh-llm";
}

function pathCandidates(name: string): string[] {
  const pathValue = process.env.PATH ?? "";
  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) =>
      path.join(directory, process.platform === "win32" ? `${name}.exe` : name),
    );
}

async function validateExecutable(candidate: string): Promise<string> {
  const resolved = await realpath(path.resolve(candidate));
  const details = await stat(resolved);
  if (!details.isFile()) throw new Error("mesh runtime is not a regular file");
  if (process.platform !== "win32") {
    if ((details.mode & 0o111) === 0) {
      throw new Error("mesh runtime is not executable");
    }
    if ((details.mode & 0o002) !== 0) {
      throw new Error("mesh runtime must not be world-writable");
    }
  }
  return resolved;
}

async function findExtractedBinary(root: string): Promise<string> {
  const pending = [{ depth: 0, directory: root }];
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const entry of await readdir(current.directory, {
      withFileTypes: true,
    })) {
      const candidate = path.join(current.directory, entry.name);
      const details = await lstat(candidate);
      if (details.isSymbolicLink()) continue;
      if (details.isFile() && entry.name === executableName()) return candidate;
      if (details.isDirectory() && current.depth < 5) {
        pending.push({ depth: current.depth + 1, directory: candidate });
      }
    }
  }
  throw new Error("Mesh-LLM bundle does not contain the expected executable");
}

function validateArchiveEntries(output: string): void {
  const entries = output.split(/\r?\n/).filter(Boolean);
  if (entries.length < 1 || entries.length > 20_000) {
    throw new Error("Mesh-LLM archive has an invalid file count");
  }
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split("/").includes("..") ||
      normalized.includes("\0")
    ) {
      throw new Error("Mesh-LLM archive contains an unsafe path");
    }
  }
}

function validateGitHubUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !["api.github.com", "github.com"].includes(url.hostname)
  ) {
    throw new Error("Mesh-LLM release URL is not an approved GitHub URL");
  }
}

function validateFinalDownloadUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)
  ) {
    throw new Error("Mesh-LLM download redirected to an unapproved host");
  }
}

async function runBounded(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  maximumBytes: number,
): Promise<{ stderr: string; stdout: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    const append = (current: Buffer, chunk: Buffer): Buffer => {
      const next = Buffer.concat([current, chunk]);
      if (next.byteLength > maximumBytes) {
        child.kill("SIGKILL");
        reject(new Error("mesh command output exceeded its safety limit"));
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("mesh command timed out"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `mesh command failed (${code ?? "signal"}): ${stderr.toString("utf8").slice(-2_000)}`,
          ),
        );
      } else {
        resolve({
          stderr: stderr.toString("utf8"),
          stdout: stdout.toString("utf8"),
        });
      }
    });
  });
}

function compareVersions(left: string, right: string): number {
  const l = left.slice(1).split(".").map(Number);
  const r = right.slice(1).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (l[index] ?? 0) - (r[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
