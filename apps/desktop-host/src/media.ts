import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  validateFileContent,
  validateImageContent,
  validateVideoPrefixAndSize,
  type BlobDescriptor,
  type MediaConfig,
} from "@buzz/media";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";

import type { IdentityService } from "./identity.js";
import { readBoundedBytes } from "./native-utilities.js";
import {
  decodeAgentSnapshot,
  decodeTeamSnapshot,
  startsWithPng,
} from "./snapshots.js";

const MAX_DESKTOP_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const SAFE_MEDIA_PATH = /^\/media\/[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;

export type DesktopBlobDescriptor = BlobDescriptor & {
  readonly image?: string;
  readonly filename?: string;
};

type SnapshotKind = {
  readonly cap: number;
  readonly format: "buzz-agent-snapshot" | "buzz-team-snapshot";
  readonly png: boolean;
};

export class DesktopMediaService {
  #baseUrl: URL;
  readonly #identity: IdentityService;

  constructor(input: {
    readonly identity: IdentityService;
    readonly relayHttpUrl: string;
  }) {
    this.#identity = input.identity;
    this.#baseUrl = validatedRelayBase(input.relayHttpUrl);
  }

  setRelayHttpUrl(relayHttpUrl: string): void {
    this.#baseUrl = validatedRelayBase(relayHttpUrl);
  }

  async uploadMedia(
    args: Record<string, unknown>,
  ): Promise<DesktopBlobDescriptor> {
    const filePath = requireString(args.filePath, "filePath");
    const isTemp = requireBoolean(args.isTemp, "isTemp");
    return this.#uploadPath(filePath, true, isTemp);
  }

  async pickAndUploadMedia(): Promise<DesktopBlobDescriptor[]> {
    const paths = await pickFiles(false);
    const descriptors: DesktopBlobDescriptor[] = [];
    for (const selected of paths) {
      descriptors.push(await this.#uploadPath(selected, false, false));
    }
    return descriptors;
  }

  async pickAndUploadImage(): Promise<DesktopBlobDescriptor | null> {
    const [selected] = await pickFiles(true);
    if (!selected) return null;
    const descriptor = await this.#uploadPath(selected, false, false);
    if (!descriptor.type.startsWith("image/")) {
      throw new Error("Please choose an image file.");
    }
    return descriptor;
  }

  async uploadBytes(
    value: unknown,
    filenameValue?: unknown,
  ): Promise<DesktopBlobDescriptor> {
    const bytes = requireBytes(value, MAX_DESKTOP_UPLOAD_BYTES);
    const filename = optionalFilename(filenameValue);
    const prepared = await prepareUpload(bytes);
    const sha256 = createHash("sha256").update(prepared.bytes).digest("hex");
    const expirySeconds = prepared.mime === "video/mp4" ? 3_600 : 300;
    const event = this.#identity.sign({
      content: "Upload buzz-media",
      kind: 24_242,
      tags: [
        ["t", "upload"],
        ["x", sha256],
        ["expiration", String(Math.floor(Date.now() / 1_000) + expirySeconds)],
        ["server", serverAuthority(this.#baseUrl)],
      ],
    });
    const authorization = `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64url")}`;
    let response = await this.#sendUpload(
      new URL("/upload", this.#baseUrl),
      authorization,
      prepared,
      sha256,
    );
    if (response.status === 404 || response.status === 405) {
      response = await this.#sendUpload(
        new URL("/media/upload", this.#baseUrl),
        authorization,
        prepared,
        sha256,
      );
    }
    if (!response.ok) throw await mediaStatusError(response, "media upload");
    const descriptor = parseDescriptor(
      await readBoundedBytes(response, 64 * 1024, "upload response"),
    );
    return filename ? { ...descriptor, filename } : descriptor;
  }

  async fetchMedia(urlValue: unknown): Promise<Uint8Array> {
    const url = this.#mediaUrl(urlValue);
    const response = await fetch(url, {
      headers: { Authorization: this.#getAuthorization() },
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw await mediaStatusError(response, "media fetch");
    const bytes = await readBoundedBytes(
      response,
      MAX_DOWNLOAD_BYTES,
      "media file",
    );
    await validateDownloadedContent(bytes);
    return bytes;
  }

  async fetchSnapshot(args: Record<string, unknown>): Promise<Uint8Array> {
    const filename = sanitizeFilename(requireString(args.filename, "filename"));
    const kind = snapshotKind(filename);
    const expectedSha256 = requireString(
      args.expectedSha256,
      "expectedSha256",
    ).toLowerCase();
    if (!HEX_SHA256.test(expectedSha256)) {
      throw new Error(
        "expectedSha256 must be 64 lowercase hexadecimal characters",
      );
    }
    const expectedSize = requirePositiveInteger(
      args.expectedSize,
      "expectedSize",
    );
    if (expectedSize > kind.cap) {
      throw new Error(
        `declared snapshot size exceeds the ${kind.cap / (1024 * 1024)} MiB format limit`,
      );
    }
    const url = this.#mediaUrl(args.url);
    const response = await fetch(url, {
      headers: { Authorization: this.#getAuthorization() },
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw await mediaStatusError(response, "snapshot fetch");
    const bytes = await readBoundedBytes(response, kind.cap, "snapshot");
    if (bytes.byteLength !== expectedSize) {
      throw new Error(
        `snapshot size mismatch: received ${bytes.byteLength}, expected ${expectedSize}`,
      );
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== expectedSha256) {
      throw new Error("snapshot hash does not match the declared SHA-256");
    }
    const isPng = startsWithPng(bytes);
    if (isPng !== kind.png) {
      throw new Error(
        `snapshot bytes do not match the ${kind.png ? "PNG" : "JSON"} filename`,
      );
    }
    if (kind.format === "buzz-agent-snapshot") {
      await decodeAgentSnapshot(bytes);
    } else {
      await decodeTeamSnapshot(bytes);
    }
    return bytes;
  }

  async downloadFile(args: Record<string, unknown>): Promise<boolean> {
    const filename = sanitizeFilename(requireString(args.filename, "filename"));
    const bytes = await this.fetchMedia(args.url);
    return saveBytesWithDialog(filename, bytes);
  }

  async saveBytes(
    filenameValue: unknown,
    bytesValue: unknown,
  ): Promise<boolean> {
    const filename = sanitizeFilename(requireString(filenameValue, "filename"));
    const bytes = requireBytes(bytesValue, MAX_DOWNLOAD_BYTES);
    return saveBytesWithDialog(filename, bytes);
  }

  async downloadImage(args: Record<string, unknown>): Promise<boolean> {
    const url = this.#mediaUrl(args.url);
    const suggested = sanitizeFilename(
      decodeURIComponent(url.pathname.split("/").pop() ?? "image.png"),
    );
    const bytes = await this.fetchMedia(url.toString());
    try {
      await sharp(bytes, {
        failOn: "warning",
        limitInputPixels: 25_000_000,
      }).metadata();
    } catch {
      throw new Error("downloaded attachment is not a safe image");
    }
    return saveBytesWithDialog(suggested, bytes);
  }

  async copyText(args: Record<string, unknown>): Promise<void> {
    const text = requireString(args.text, "text");
    if (Buffer.byteLength(text, "utf8") > 10 * 1024 * 1024) {
      throw new Error("clipboard text exceeds 10 MiB");
    }
    const input = Buffer.from(text, "utf8");
    if (process.platform === "darwin") {
      await runNative("pbcopy", [], input);
      return;
    }
    if (process.platform === "win32") {
      await runNative(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$input | Set-Clipboard",
        ],
        input,
      );
      return;
    }
    try {
      await runNative("wl-copy", ["--type", "text/plain;charset=utf-8"], input);
    } catch {
      await runNative(
        "xclip",
        ["-selection", "clipboard", "-t", "text/plain;charset=utf-8", "-i"],
        input,
      );
    }
  }

  async copyImage(args: Record<string, unknown>): Promise<void> {
    const bytes = await this.fetchMedia(args.url);
    const png = await sharp(bytes, {
      failOn: "warning",
      limitInputPixels: 12_500_000,
      sequentialRead: true,
    })
      .rotate()
      .png({ compressionLevel: 9 })
      .toBuffer();
    if (png.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error("image is too large to copy to the clipboard");
    }
    if (process.platform === "linux") {
      try {
        await runNative("wl-copy", ["--type", "image/png"], png);
      } catch {
        await runNative(
          "xclip",
          ["-selection", "clipboard", "-t", "image/png", "-i"],
          png,
        );
      }
      return;
    }
    const temporary = await mkdtemp(path.join(os.tmpdir(), "buzz-clipboard-"));
    const imagePath = path.join(temporary, "image.png");
    try {
      await writeFile(imagePath, png, { flag: "wx", mode: 0o600 });
      if (process.platform === "darwin") {
        await runNative("osascript", [
          "-e",
          "on run argv",
          "-e",
          "set the clipboard to (read POSIX file (item 1 of argv) as «class PNGf»)",
          "-e",
          "end run",
          imagePath,
        ]);
      } else if (process.platform === "win32") {
        await runNative("powershell.exe", [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img=[System.Drawing.Image]::FromFile($args[0]); try {[System.Windows.Forms.Clipboard]::SetImage($img)} finally {$img.Dispose()}",
          imagePath,
        ]);
      } else {
        throw new Error("image clipboard is not supported on this platform");
      }
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  }

  async #uploadPath(
    filePath: string,
    requireTemporary: boolean,
    removeAfterRead: boolean,
  ): Promise<DesktopBlobDescriptor> {
    const handle = await open(filePath, "r");
    let resolved = await realpath(filePath);
    try {
      if (process.platform !== "win32") {
        try {
          resolved = await realpath(`/dev/fd/${handle.fd}`);
        } catch {
          // The opened handle remains authoritative even on platforms without
          // a resolvable /dev/fd entry.
        }
      }
      if (requireTemporary) {
        const temporaryRoot = await realpath(os.tmpdir());
        if (
          resolved !== temporaryRoot &&
          !resolved.startsWith(`${temporaryRoot}${path.sep}`)
        ) {
          throw new Error("upload source must be in the system temp directory");
        }
      }
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error("upload source must be a file");
      if (metadata.size <= 0 || metadata.size > MAX_DESKTOP_UPLOAD_BYTES) {
        throw new Error("upload exceeds the 100 MiB desktop limit");
      }
      const bytes = await handle.readFile();
      return await this.uploadBytes(bytes, path.basename(resolved));
    } finally {
      await handle.close();
      if (removeAfterRead) await rm(resolved, { force: true });
    }
  }

  #getAuthorization(): string {
    const event = this.#identity.sign({
      content: "Get buzz-media",
      kind: 24_242,
      tags: [
        ["t", "get"],
        ["expiration", String(Math.floor(Date.now() / 1_000) + 600)],
        ["server", serverAuthority(this.#baseUrl)],
      ],
    });
    return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64url")}`;
  }

  #mediaUrl(value: unknown): URL {
    const raw = requireString(value, "url");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("invalid media URL");
    }
    if (
      url.origin !== this.#baseUrl.origin ||
      url.username ||
      url.password ||
      url.hash ||
      !SAFE_MEDIA_PATH.test(url.pathname)
    ) {
      throw new Error("media URL must be a same-relay /media/ path");
    }
    return url;
  }

  #sendUpload(
    url: URL,
    authorization: string,
    prepared: { readonly bytes: Uint8Array; readonly mime: string },
    sha256: string,
  ): Promise<Response> {
    return fetch(url, {
      body: prepared.bytes,
      headers: {
        Authorization: authorization,
        "Content-Length": String(prepared.bytes.byteLength),
        "Content-Type": prepared.mime,
        "X-SHA-256": sha256,
      },
      method: "PUT",
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
  }
}

async function pickFiles(imagesOnly: boolean): Promise<string[]> {
  let result: NativeProcessResult;
  if (process.platform === "darwin") {
    const choose = imagesOnly
      ? 'set chosen to {choose file with prompt "Choose an image" of type {"public.image"}}'
      : 'set chosen to choose file with prompt "Choose attachments" with multiple selections allowed';
    result = await runNative(
      "osascript",
      [
        "-e",
        "on run",
        "-e",
        choose,
        "-e",
        "set paths to {}",
        "-e",
        "repeat with selectedFile in chosen",
        "-e",
        "set end of paths to POSIX path of selectedFile",
        "-e",
        "end repeat",
        "-e",
        "set AppleScript's text item delimiters to ASCII character 30",
        "-e",
        "return paths as text",
        "-e",
        "end run",
      ],
      undefined,
      true,
    );
  } else if (process.platform === "win32") {
    const filter = imagesOnly
      ? "Images|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.heic;*.heif;*.bmp"
      : "All Files|*.*";
    result = await runNative(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Multiselect=$${imagesOnly ? "false" : "true"}; $d.Filter=$args[0]; if($d.ShowDialog() -eq 'OK'){[Console]::Out.Write(($d.FileNames -join [char]30))}`,
        filter,
      ],
      undefined,
      true,
    );
  } else {
    result = await runNative(
      "zenity",
      [
        "--file-selection",
        ...(imagesOnly
          ? [
              "--file-filter=Images | *.png *.jpg *.jpeg *.gif *.webp *.heic *.heif *.bmp",
            ]
          : ["--multiple"]),
        "--separator=\u001e",
        "--title=Choose attachments",
      ],
      undefined,
      true,
    );
  }
  if (result.code !== 0) return [];
  const output = result.stdout.replace(/\r?\n$/, "");
  if (!output) return [];
  const paths = output.split("\u001e").filter(Boolean);
  if (paths.length > 100) throw new Error("at most 100 files may be selected");
  return paths;
}

async function saveBytesWithDialog(
  filename: string,
  bytes: Uint8Array,
): Promise<boolean> {
  const selected = await chooseSavePath(filename);
  if (!selected) return false;
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_TRUNC |
    (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(selected, flags, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return true;
}

async function chooseSavePath(filename: string): Promise<string | null> {
  let result: NativeProcessResult;
  if (process.platform === "darwin") {
    result = await runNative(
      "osascript",
      [
        "-e",
        "on run argv",
        "-e",
        'set chosen to choose file name with prompt "Save attachment" default name (item 1 of argv)',
        "-e",
        "return POSIX path of chosen",
        "-e",
        "end run",
        filename,
      ],
      undefined,
      true,
    );
  } else if (process.platform === "win32") {
    result = await runNative(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.SaveFileDialog; $d.FileName=$args[0]; $d.Filter='All Files|*.*'; if($d.ShowDialog() -eq 'OK'){[Console]::Out.Write($d.FileName)}",
        filename,
      ],
      undefined,
      true,
    );
  } else {
    result = await runNative(
      "zenity",
      [
        "--file-selection",
        "--save",
        "--confirm-overwrite",
        `--filename=${path.join(os.homedir(), "Downloads", filename)}`,
        "--title=Save attachment",
      ],
      undefined,
      true,
    );
  }
  if (result.code !== 0) return null;
  const selected = result.stdout.replace(/\r?\n$/, "");
  if (!selected || selected.includes("\0")) return null;
  return path.resolve(selected);
}

type NativeProcessResult = {
  readonly code: number;
  readonly stdout: string;
};

function runNative(
  executable: string,
  args: readonly string[],
  input?: Uint8Array,
  allowNonzero = false,
): Promise<NativeProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${executable} timed out`));
    }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= 1024 * 1024) stdout.push(chunk);
      else child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= 1024 * 1024) stderr.push(chunk);
      else child.kill("SIGKILL");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const status = code ?? 1;
      if (status !== 0 && !allowNonzero) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new Error(
            detail
              ? `${executable} failed: ${detail.slice(0, 1_000)}`
              : `${executable} failed (${status})`,
          ),
        );
        return;
      }
      resolve({
        code: status,
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function prepareUpload(
  input: Uint8Array,
): Promise<{ readonly bytes: Uint8Array; readonly mime: string }> {
  const detected = await fileTypeFromBuffer(input);
  if (detected?.mime === "video/mp4") {
    await validateVideoPrefixAndSize(
      input.subarray(0, Math.min(input.byteLength, 16_384)),
      input.byteLength,
      clientMediaConfig(),
    );
    return { bytes: input, mime: "video/mp4" };
  }
  if (detected?.mime.startsWith("image/")) {
    if (
      !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
        detected.mime,
      )
    ) {
      throw new Error(`unsupported image type: ${detected.mime}`);
    }
    let bytes = input;
    if (detected.mime !== "image/gif") {
      const image = sharp(input, {
        animated: false,
        failOn: "warning",
        limitInputPixels: 25_000_000,
        sequentialRead: true,
      }).rotate();
      bytes =
        detected.mime === "image/jpeg"
          ? await image.jpeg({ quality: 90 }).toBuffer()
          : detected.mime === "image/png"
            ? stripPngPhysicalDimensions(
                await image.png({ compressionLevel: 9 }).toBuffer(),
              )
            : await image.webp({ quality: 90 }).toBuffer();
    }
    await validateImageContent(bytes, clientMediaConfig());
    return { bytes, mime: detected.mime };
  }
  const validated = await validateFileContent(input, clientMediaConfig());
  return { bytes: input, mime: validated.mime };
}

/**
 * libvips writes a pHYs chunk even after Sharp has discarded input metadata.
 * The relay intentionally rejects pHYs because arbitrary density values are an
 * identity channel, so remove that complete chunk from the canonical upload.
 * CRCs belong to individual PNG chunks; removing one does not alter the rest.
 */
function stripPngPhysicalDimensions(input: Uint8Array): Buffer {
  const bytes = Buffer.from(input);
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (!bytes.subarray(0, signature.length).equals(signature)) {
    throw new Error("sanitized PNG has an invalid signature");
  }
  const chunks = [bytes.subarray(0, signature.length)];
  let offset = signature.length;
  let sawEnd = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error("sanitized PNG has a truncated chunk");
    }
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) {
      throw new Error("sanitized PNG has an invalid chunk length");
    }
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (kind !== "pHYs") chunks.push(bytes.subarray(offset, end));
    offset = end;
    if (kind === "IEND") {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd || offset !== bytes.length) {
    throw new Error("sanitized PNG is missing its canonical terminator");
  }
  return Buffer.concat(chunks);
}

async function validateDownloadedContent(bytes: Uint8Array): Promise<void> {
  const detected = await fileTypeFromBuffer(bytes);
  if (detected?.mime.startsWith("image/")) {
    await validateImageContent(bytes, clientMediaConfig());
    return;
  }
  if (detected?.mime === "video/mp4") {
    await validateVideoPrefixAndSize(
      bytes.subarray(0, Math.min(bytes.byteLength, 16_384)),
      bytes.byteLength,
      clientMediaConfig(),
    );
    return;
  }
  await validateFileContent(bytes, clientMediaConfig());
}

function clientMediaConfig(): MediaConfig {
  return {
    maxFileBytes: MAX_DESKTOP_UPLOAD_BYTES,
    maxGifBytes: 10 * 1024 * 1024,
    maxImageBytes: 50 * 1024 * 1024,
    maxVideoBytes: MAX_DESKTOP_UPLOAD_BYTES,
    publicBaseUrl: "https://relay.invalid/media",
    uploadRecordsEnabled: false,
  };
}

function validatedRelayBase(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid relay HTTP URL");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("relay media URL must use HTTPS (HTTP only for loopback)");
  }
  return url;
}

function serverAuthority(url: URL): string {
  const defaultPort =
    (url.protocol === "https:" && (url.port === "" || url.port === "443")) ||
    (url.protocol === "http:" && (url.port === "" || url.port === "80"));
  return `${url.hostname}${defaultPort ? "" : `:${url.port}`}`;
}

async function mediaStatusError(
  response: Response,
  label: string,
): Promise<Error> {
  if (response.status >= 300 && response.status < 400) {
    return new Error(`${label} refused relay redirect (${response.status})`);
  }
  let detail = "";
  try {
    detail = new TextDecoder()
      .decode(
        await readBoundedBytes(
          response,
          MAX_ERROR_BYTES,
          `${label} error`,
          true,
        ),
      )
      .trim();
  } catch {
    // Status remains sufficient and avoids replacing it with a parsing error.
  }
  return new Error(
    detail && detail.length <= 1_000
      ? `${label} failed (${response.status}): ${detail}`
      : `${label} failed (${response.status})`,
  );
}

function parseDescriptor(bytes: Uint8Array): DesktopBlobDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("relay returned a malformed upload descriptor");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("relay returned a malformed upload descriptor");
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.url !== "string" ||
    typeof item.sha256 !== "string" ||
    !HEX_SHA256.test(item.sha256) ||
    !Number.isSafeInteger(item.size) ||
    (item.size as number) <= 0 ||
    typeof item.type !== "string" ||
    !Number.isSafeInteger(item.uploaded)
  ) {
    throw new Error("relay returned a malformed upload descriptor");
  }
  return value as DesktopBlobDescriptor;
}

function snapshotKind(filename: string): SnapshotKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".agent.json")) {
    return { cap: 5 * 1024 * 1024, format: "buzz-agent-snapshot", png: false };
  }
  if (lower.endsWith(".agent.png")) {
    return { cap: 10 * 1024 * 1024, format: "buzz-agent-snapshot", png: true };
  }
  if (lower.endsWith(".team.json")) {
    return { cap: 25 * 1024 * 1024, format: "buzz-team-snapshot", png: false };
  }
  if (lower.endsWith(".team.png")) {
    return { cap: 50 * 1024 * 1024, format: "buzz-team-snapshot", png: true };
  }
  throw new Error(
    "snapshot filename must end in .agent.json, .agent.png, .team.json, or .team.png",
  );
}

function requireBytes(value: unknown, limit: number): Uint8Array {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (
    Array.isArray(value) &&
    value.length <= limit &&
    value.every(
      (item) =>
        Number.isInteger(item) &&
        (item as number) >= 0 &&
        (item as number) <= 255,
    )
  ) {
    bytes = Uint8Array.from(value as number[]);
  } else {
    throw new Error("data must be a byte array");
  }
  if (bytes.byteLength === 0) throw new Error("empty upload");
  if (bytes.byteLength > limit) {
    throw new Error("upload exceeds the 100 MiB desktop limit");
  }
  return bytes;
}

function optionalFilename(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return sanitizeFilename(requireString(value, "filename"));
}

export function sanitizeFilename(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f/\\:]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200);
  return cleaned || "attachment.bin";
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value as number;
}
