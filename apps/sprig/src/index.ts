import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const PERSONALITIES = {
  "buzz-acp": "packages/acp/dist/main.js",
  "buzz-agent": "packages/agent/dist/main.js",
  buzz: "packages/cli/dist/main.js",
  "buzz-dev-mcp": "packages/dev-mcp/dist/main.js",
  "git-credential-nostr": "packages/git-credential-nostr/dist/main.js",
  "git-sign-nostr": "packages/git-sign-nostr/dist/main.js",
} as const;

export function personalityTarget(name: string): string | undefined {
  const relative = PERSONALITIES[name as keyof typeof PERSONALITIES];
  if (!relative) return undefined;
  const target = resolve(workspace, relative);
  if (!existsSync(target)) {
    throw new Error(`Sprig personality '${name}' is not built: ${target}`);
  }
  return target;
}

export function usage(): string {
  return `Sprig — all-in-one Buzz TypeScript distribution

Invoke through a personality link:
  buzz-acp                ACP harness
  buzz-agent              ACP-compliant agent
  buzz-dev-mcp            Developer MCP server
  buzz                     Buzz CLI
  git-credential-nostr    Git NIP-98 credential helper
  git-sign-nostr          Git NIP-GS signer

Create links with:
  ln -s sprig buzz-acp
  ln -s sprig buzz-agent
  ln -s sprig buzz-dev-mcp
`;
}
