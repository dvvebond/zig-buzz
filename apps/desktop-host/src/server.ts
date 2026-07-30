import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";

import type { CommandRegistry } from "./commands.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_UPLOAD_BYTES = 100 * 1024 * 1024;
const STATIC_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; connect-src 'self' http: https: ws: wss:; font-src 'self' data:; frame-ancestors 'none'; img-src 'self' data: blob: http: https:; media-src 'self' data: blob: http: https:; object-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export type DesktopServer = {
  close(): Promise<void>;
  origin: string;
};

export async function startDesktopServer(input: {
  bootToken: string;
  commands: CommandRegistry;
  distDirectory: string;
  host?: string;
  port?: number;
}): Promise<DesktopServer> {
  const host = input.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("desktop host may only bind to a loopback address");
  }
  const distDirectory = path.resolve(input.distDirectory);
  const indexPath = path.join(distDirectory, "index.html");
  await access(indexPath);

  let origin = "";
  const server = createServer((request, response) => {
    void routeRequest({
      bootToken: input.bootToken,
      commands: input.commands,
      distDirectory,
      origin,
      request,
      response,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "internal error";
      sendJson(response, error instanceof HttpError ? error.status : 500, {
        error: message,
      });
    });
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("desktop host did not obtain a TCP address");
  }
  const urlHost =
    address.family === "IPv6" ? `[${address.address}]` : address.address;
  origin = `http://${urlHost}:${address.port}`;

  return {
    origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function routeRequest(input: {
  bootToken: string;
  commands: CommandRegistry;
  distDirectory: string;
  origin: string;
  request: IncomingMessage;
  response: ServerResponse;
}): Promise<void> {
  const { request, response } = input;
  const requestUrl = new URL(request.url ?? "/", input.origin);

  if (requestUrl.pathname === "/api/health" && request.method === "GET") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (requestUrl.pathname === "/api/bootstrap" && request.method === "GET") {
    authorize(input);
    sendJson(response, 200, {
      commands: input.commands.list(),
      protocol: "buzz.desktop.ipc.v1",
    });
    return;
  }

  if (requestUrl.pathname === "/api/invoke" && request.method === "POST") {
    authorize(input);
    const body = await readJsonBody(request);
    if (
      typeof body !== "object" ||
      body === null ||
      !("command" in body) ||
      typeof body.command !== "string" ||
      !/^[a-z][a-z0-9_]{0,127}$/.test(body.command) ||
      !("args" in body)
    ) {
      sendJson(response, 400, { error: "invalid invoke request" });
      return;
    }
    try {
      const result = await input.commands.invoke(body.command, body.args);
      sendJson(response, 200, { ok: true, result: result ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      sendJson(response, 400, { error: message, ok: false });
    }
    return;
  }

  if (
    requestUrl.pathname === "/api/binary/invoke" &&
    request.method === "POST"
  ) {
    authorize(input);
    const body = await readJsonBody(request);
    if (
      typeof body !== "object" ||
      body === null ||
      !("command" in body) ||
      (body.command !== "fetch_media_bytes" &&
        body.command !== "fetch_snapshot_bytes") ||
      !("args" in body)
    ) {
      sendJson(response, 400, { error: "invalid binary invoke request" });
      return;
    }
    try {
      const result = await input.commands.invoke(body.command, body.args);
      if (!(result instanceof Uint8Array)) {
        throw new Error("binary command did not return bytes");
      }
      sendBinary(response, result);
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "binary command failed",
        ok: false,
      });
    }
    return;
  }

  if (
    requestUrl.pathname === "/api/binary/upload" &&
    request.method === "POST"
  ) {
    authorize(input);
    if (
      request.headers["content-type"]?.toLowerCase() !==
      "application/octet-stream"
    ) {
      sendJson(response, 415, {
        error: "binary upload content-type must be application/octet-stream",
      });
      return;
    }
    try {
      const metadata = parseBinaryMetadata(
        request.headers["x-buzz-media-metadata"],
      );
      const data = await readBinaryBody(request);
      const result = await input.commands.invoke("upload_media_bytes", {
        data,
        ...metadata,
      });
      sendJson(response, 200, { ok: true, result });
    } catch (error) {
      sendJson(response, error instanceof HttpError ? error.status : 400, {
        error: error instanceof Error ? error.message : "binary upload failed",
        ok: false,
      });
    }
    return;
  }

  if (
    requestUrl.pathname === "/api/binary/snapshot" &&
    request.method === "POST"
  ) {
    authorize(input);
    if (
      request.headers["content-type"]?.toLowerCase() !==
      "application/octet-stream"
    ) {
      sendJson(response, 415, {
        error: "snapshot content-type must be application/octet-stream",
      });
      return;
    }
    try {
      const metadata = parseSnapshotMetadata(
        request.headers["x-buzz-snapshot-metadata"],
      );
      const fileBytes = await readBinaryBody(request);
      const args = metadata.command.startsWith("preview_")
        ? { fileBytes, fileName: metadata.fileName }
        : {
            input: {
              fileBytes,
              keepAllowlist: metadata.keepAllowlist,
            },
          };
      const result = await input.commands.invoke(metadata.command, args);
      sendJson(response, 200, { ok: true, result });
    } catch (error) {
      sendJson(response, error instanceof HttpError ? error.status : 400, {
        error:
          error instanceof Error ? error.message : "snapshot command failed",
        ok: false,
      });
    }
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "method not allowed" });
    return;
  }
  await serveStatic(
    input.distDirectory,
    requestUrl.pathname,
    request,
    response,
  );
}

function authorize(input: {
  bootToken: string;
  origin: string;
  request: IncomingMessage;
}): void {
  const suppliedToken = input.request.headers["x-buzz-desktop-token"];
  if (suppliedToken !== input.bootToken) {
    throw new HttpError(401, "invalid desktop session");
  }
  const origin = input.request.headers.origin;
  if (origin !== input.origin) {
    throw new HttpError(403, "cross-origin desktop IPC is forbidden");
  }
  const fetchSite = input.request.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin") {
    throw new HttpError(403, "cross-site desktop IPC is forbidden");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "content-type must be application/json");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      request.destroy();
      throw new HttpError(413, "request exceeds the 2 MiB limit");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
}

async function readBinaryBody(request: IncomingMessage): Promise<Uint8Array> {
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const value = Number(Array.isArray(declared) ? declared[0] : declared);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new HttpError(400, "binary upload has an invalid content length");
    }
    if (value > MAX_BINARY_UPLOAD_BYTES) {
      throw new HttpError(413, "binary upload exceeds the 100 MiB limit");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_BINARY_UPLOAD_BYTES) {
      request.destroy();
      throw new HttpError(413, "binary upload exceeds the 100 MiB limit");
    }
    chunks.push(bytes);
  }
  if (total === 0) throw new HttpError(400, "binary upload is empty");
  return Buffer.concat(chunks, total);
}

function parseBinaryMetadata(value: string | string[] | undefined): {
  readonly filename?: string;
  readonly progressId?: string;
} {
  if (value === undefined) return {};
  if (Array.isArray(value) || value.length === 0 || value.length > 2_048) {
    throw new HttpError(400, "invalid binary upload metadata");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid binary upload metadata");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid binary upload metadata");
  }
  const item = parsed as Record<string, unknown>;
  const keys = Object.keys(item);
  if (keys.some((key) => key !== "filename" && key !== "progressId")) {
    throw new HttpError(400, "invalid binary upload metadata");
  }
  const result: { filename?: string; progressId?: string } = {};
  if (item.filename !== undefined) {
    if (typeof item.filename !== "string" || item.filename.length > 512) {
      throw new HttpError(400, "invalid binary upload filename");
    }
    result.filename = item.filename;
  }
  if (item.progressId !== undefined) {
    if (
      typeof item.progressId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(item.progressId)
    ) {
      throw new HttpError(400, "invalid binary upload progress id");
    }
    result.progressId = item.progressId;
  }
  return result;
}

function parseSnapshotMetadata(value: string | string[] | undefined): {
  readonly command:
    | "preview_agent_snapshot_import"
    | "confirm_agent_snapshot_import"
    | "preview_team_snapshot_import"
    | "confirm_team_snapshot_import";
  readonly fileName: string;
  readonly keepAllowlist: boolean;
} {
  const parsed = decodeMetadataHeader(value, "snapshot metadata");
  const allowed = new Set([
    "preview_agent_snapshot_import",
    "confirm_agent_snapshot_import",
    "preview_team_snapshot_import",
    "confirm_team_snapshot_import",
  ]);
  if (typeof parsed.command !== "string" || !allowed.has(parsed.command)) {
    throw new HttpError(400, "invalid snapshot command");
  }
  const preview = parsed.command.startsWith("preview_");
  const allowedKeys = preview
    ? new Set(["command", "fileName"])
    : new Set(["command", "keepAllowlist"]);
  if (Object.keys(parsed).some((key) => !allowedKeys.has(key))) {
    throw new HttpError(400, "snapshot metadata contains unknown fields");
  }
  if (
    (preview &&
      (typeof parsed.fileName !== "string" ||
        parsed.fileName.length === 0 ||
        parsed.fileName.length > 512)) ||
    (!preview && parsed.fileName !== undefined)
  ) {
    throw new HttpError(400, "invalid snapshot filename");
  }
  if (
    (preview && parsed.keepAllowlist !== undefined) ||
    (!preview && typeof parsed.keepAllowlist !== "boolean")
  ) {
    throw new HttpError(400, "invalid snapshot confirmation");
  }
  return {
    command: parsed.command as
      | "preview_agent_snapshot_import"
      | "confirm_agent_snapshot_import"
      | "preview_team_snapshot_import"
      | "confirm_team_snapshot_import",
    fileName: preview ? (parsed.fileName as string) : "",
    keepAllowlist: preview ? false : (parsed.keepAllowlist as boolean),
  };
}

function decodeMetadataHeader(
  value: string | string[] | undefined,
  label: string,
): Record<string, unknown> {
  if (
    value === undefined ||
    Array.isArray(value) ||
    value.length === 0 ||
    value.length > 4_096
  ) {
    throw new HttpError(400, `invalid ${label}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(400, `invalid ${label}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, `invalid ${label}`);
  }
  return parsed as Record<string, unknown>;
}

async function serveStatic(
  distDirectory: string,
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: "invalid path encoding" });
    return;
  }
  if (decoded.includes("\0")) {
    sendJson(response, 400, { error: "invalid path" });
    return;
  }
  const relative = decoded.replace(/^\/+/, "");
  let filePath = path.resolve(distDirectory, relative);
  if (
    filePath !== distDirectory &&
    !filePath.startsWith(`${distDirectory}${path.sep}`)
  ) {
    sendJson(response, 403, { error: "path escapes desktop bundle" });
    return;
  }

  let metadata;
  try {
    metadata = await stat(filePath);
  } catch {
    filePath = path.join(distDirectory, "index.html");
    metadata = await stat(filePath);
  }
  if (metadata.isDirectory()) {
    filePath = path.join(filePath, "index.html");
    metadata = await stat(filePath);
  }
  if (!metadata.isFile()) {
    sendJson(response, 404, { error: "not found" });
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentType = mimeType(extension);
  response.writeHead(200, {
    ...STATIC_HEADERS,
    "Cache-Control":
      path.basename(filePath) === "index.html"
        ? "no-store"
        : "public, max-age=31536000, immutable",
    "Content-Length": metadata.size,
    "Content-Type": contentType,
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  if (response.headersSent) return;
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, {
    ...STATIC_HEADERS,
    "Cache-Control": "no-store",
    "Content-Length": body.byteLength,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(body);
}

function sendBinary(response: ServerResponse, value: Uint8Array): void {
  if (response.headersSent) return;
  response.writeHead(200, {
    ...STATIC_HEADERS,
    "Cache-Control": "no-store",
    "Content-Disposition": "attachment",
    "Content-Length": value.byteLength,
    "Content-Type": "application/octet-stream",
  });
  response.end(value);
}

function mimeType(extension: string): string {
  switch (extension) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".wasm":
      return "application/wasm";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
