#!/usr/bin/env node
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { DevMcpServer, tree } from "./index.js";

const personality = basename(process.argv[1] ?? "").replace(
  /\.(?:js|exe)$/i,
  "",
);
if (personality === "tree") {
  const args = process.argv.slice(2);
  const depthIndex = args.findIndex(
    (value) => value === "-d" || value === "--depth",
  );
  const depth = depthIndex >= 0 ? Number(args[depthIndex + 1]) : 50;
  const path =
    args.find(
      (value, index) => !value.startsWith("-") && index !== depthIndex + 1,
    ) ?? ".";
  process.stdout.write(
    await tree(path, Number.isInteger(depth) ? Math.min(depth, 50) : 50),
  );
} else {
  const server = new DevMcpServer();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: {
      jsonrpc: "2.0";
      id?: string | number;
      method: string;
      params?: unknown;
    };
    try {
      request = JSON.parse(line);
      const result = await server.handle(request);
      if (request.id !== undefined) {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
        );
      }
    } catch (error) {
      const id =
        typeof request! === "object" && request!.id !== undefined
          ? request!.id
          : null;
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code:
              error instanceof Error && "code" in error
                ? (error as Error & { code: number }).code
                : -32_600,
            message: error instanceof Error ? error.message : "invalid request",
          },
        })}\n`,
      );
    }
  }
}
