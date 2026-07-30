import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

export type RelayStaticOptions = {
  readonly admin?: {
    readonly host: string;
    readonly webDirectory: string;
  };
  readonly public?: {
    readonly serveGitWebGui: boolean;
    readonly webDirectory: string;
  };
};

/**
 * Narrow SPA/static fallback matching the Rust router.
 *
 * It serves only hashed assets and explicit application routes. Arbitrary
 * unknown relay/API paths never fall through to index.html.
 */
export class RelayStaticHttp {
  readonly #admin: RelayStaticOptions["admin"];
  readonly #public: RelayStaticOptions["public"];

  public constructor(options: RelayStaticOptions) {
    this.#admin = options.admin;
    this.#public = options.public;
  }

  public async handleAdmin(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (!this.#admin || request.headers.host !== this.#admin.host) return false;
    const pathname = requestPathname(request);
    if (!isReadMethod(request.method)) return false;
    if (pathname.startsWith("/assets/")) {
      await serveAsset(
        this.#admin.webDirectory,
        pathname,
        request.method === "HEAD",
        response,
      );
      return true;
    }
    if (pathname === "/" && !request.headers.accept?.includes("text/html")) {
      return false;
    }
    if (isAdminSpaPath(pathname)) {
      await serveIndex(
        this.#admin.webDirectory,
        request.method === "HEAD",
        response,
      );
      return true;
    }
    return false;
  }

  public async handlePublic(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    if (!this.#public || !isReadMethod(request.method)) return false;
    const pathname = requestPathname(request);
    if (pathname.startsWith("/assets/")) {
      await serveAsset(
        this.#public.webDirectory,
        pathname,
        request.method === "HEAD",
        response,
      );
      return true;
    }
    if (
      isInviteLandingPath(pathname) ||
      (this.#public.serveGitWebGui && isGitSpaPath(pathname))
    ) {
      await serveIndex(
        this.#public.webDirectory,
        request.method === "HEAD",
        response,
      );
      return true;
    }
    return false;
  }
}

function isAdminSpaPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/reports" ||
    pathname.startsWith("/reports/") ||
    pathname === "/feedback" ||
    pathname.startsWith("/feedback/")
  );
}

function isInviteLandingPath(pathname: string): boolean {
  const match = /^\/invite\/([^/]+)$/.exec(pathname);
  return match?.[1] !== undefined && match[1].length > 0;
}

function isGitSpaPath(pathname: string): boolean {
  return (
    pathname === "/" || pathname === "/repos" || pathname.startsWith("/repos/")
  );
}

function isReadMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD";
}

function requestPathname(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://relay.invalid").pathname;
  } catch {
    return "";
  }
}

async function serveIndex(
  directory: string,
  headOnly: boolean,
  response: ServerResponse,
): Promise<void> {
  try {
    const bytes = await readFile(resolve(directory, "index.html"));
    response.statusCode = 200;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'",
    );
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Content-Length", bytes.length);
    if (headOnly) response.end();
    else response.end(bytes);
  } catch {
    staticError(response, 500);
  }
}

async function serveAsset(
  directory: string,
  pathname: string,
  headOnly: boolean,
  response: ServerResponse,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    staticError(response, 404);
    return;
  }
  if (
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    decoded.split("/").includes("..")
  ) {
    staticError(response, 404);
    return;
  }
  const root = resolve(directory);
  const path = resolve(root, `.${decoded}`);
  if (!path.startsWith(`${root}${sep}`)) {
    staticError(response, 404);
    return;
  }
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size > 64 * 1024 * 1024) {
      staticError(response, 404);
      return;
    }
    const bytes = await readFile(path);
    response.statusCode = 200;
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    response.setHeader("Content-Length", bytes.length);
    response.setHeader("Content-Type", assetContentType(path));
    if (headOnly) response.end();
    else response.end(bytes);
  } catch {
    staticError(response, 404);
  }
}

function assetContentType(path: string): string {
  switch (extname(path).toLowerCase()) {
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
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function staticError(response: ServerResponse, status: number): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(status === 404 ? "not found" : "internal server error");
}
