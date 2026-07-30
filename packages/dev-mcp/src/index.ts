import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { readFileTool, strReplaceTool } from "./files.js";
import { viewImageTool } from "./image.js";
import { shellTool } from "./shell.js";
import { TodoState } from "./todo.js";

type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id?: string | number;
  readonly method: string;
  readonly params?: unknown;
};

const tools = [
  tool(
    "shell",
    "Run a bounded ephemeral shell command.",
    {
      command: { type: "string" },
      timeout_ms: { type: "integer" },
      workdir: { type: "string" },
    },
    ["command"],
  ),
  tool(
    "read_file",
    "Read a UTF-8 file with numbered lines.",
    {
      path: { type: "string" },
      offset: { type: "integer" },
      limit: { type: "integer" },
      workdir: { type: "string" },
    },
    ["path"],
  ),
  tool(
    "view_image",
    "Load and bound a local, HTTP, or data-URL image.",
    {
      source: { type: "string" },
      max_dim: { type: "integer" },
      workdir: { type: "string" },
    },
    ["source"],
  ),
  tool(
    "str_replace",
    "Atomically replace an exact string and return a diff.",
    {
      path: { type: "string" },
      old_str: { type: "string" },
      new_str: { type: "string" },
      replace_all: { type: "boolean" },
      workdir: { type: "string" },
    },
    ["path", "old_str", "new_str"],
  ),
  tool("todo", "Read or replace the in-memory task list.", {
    todos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" }, done: { type: "boolean" } },
        required: ["text"],
      },
    },
  }),
  tool("_Stop", "Return an objection while todo items remain open.", {}),
  tool("_PostCompact", "Return todo state after compaction.", {}),
];

export class DevMcpServer {
  readonly #todo = new TodoState();

  public async handle(request: JsonRpcRequest): Promise<unknown> {
    if (request.method === "initialize") {
      return {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "buzz-dev-mcp", version: "0.1.0" },
        instructions:
          "Use read_file and str_replace for files, rg for search, and bounded shell calls for commands.",
      };
    }
    if (request.method === "notifications/initialized") return undefined;
    if (request.method === "ping") return {};
    if (request.method === "tools/list") return { tools };
    if (request.method !== "tools/call")
      throw rpcError(-32601, "method not found");
    const params = request.params as {
      readonly name?: string;
      readonly arguments?: unknown;
    };
    try {
      if (params.name === "view_image") {
        return { content: [await viewImageTool(params.arguments)] };
      }
      const text =
        params.name === "shell"
          ? await shellTool(params.arguments)
          : params.name === "read_file"
            ? await readFileTool(params.arguments)
            : params.name === "str_replace"
              ? await strReplaceTool(params.arguments)
              : params.name === "todo"
                ? this.#todo.handle(params.arguments ?? {})
                : params.name === "_Stop"
                  ? this.#todo.stop()
                  : params.name === "_PostCompact"
                    ? this.#todo.postCompact()
                    : undefined;
      if (text === undefined) throw new Error("unknown tool");
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
}

export async function tree(root = ".", maxDepth = 50): Promise<string> {
  const lines: string[] = [];
  async function walk(path: string, depth: number): Promise<number> {
    if (depth > maxDepth) return 0;
    const entries = (await readdir(path, { withFileTypes: true }))
      .filter((entry) => ![".git", "node_modules", "dist"].includes(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    let total = 0;
    for (const entry of entries) {
      if (lines.length >= 2_000) break;
      const target = join(path, entry.name);
      if (entry.isDirectory()) {
        const index = lines.length;
        lines.push(`${"  ".repeat(depth)}${entry.name}/`);
        const count = await walk(target, depth + 1);
        lines[index] += `  [${count}]`;
        total += count;
      } else if (entry.isFile()) {
        const metadata = await stat(target);
        let count = 0;
        if (metadata.size <= 10 * 1024 * 1024) {
          const bytes = await readFile(target);
          count =
            bytes.byteLength === 0
              ? 0
              : bytes.filter((byte) => byte === 10).length +
                (bytes.at(-1) === 10 ? 0 : 1);
        }
        total += count;
        lines.push(`${"  ".repeat(depth)}${entry.name}  [${count}]`);
      }
    }
    return total;
  }
  const total = await walk(root, 0);
  return `${basename(root)}/  [${total}]\n${lines.join("\n")}${lines.length >= 2_000 ? "\n[truncated]" : ""}\n`;
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
  };
}

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}
