import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFileSizeCheck } from "../../scripts/check-file-sizes-core.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const MAX_LINES = 1000;
const rules = [
  "src/app",
  "src/features",
  "src/shared/api",
  "src/shared/context",
  "src/shared/lib",
  "src/shared/ui",
].map((root) => ({
  extensions: new Set([".ts", ".tsx"]),
  maxLines: MAX_LINES,
  root,
}));
rules.push({
  extensions: new Set([".css"]),
  maxLines: MAX_LINES,
  root: "src/shared/styles",
});

// Existing large UI modules are ratcheted at their current limits. New files
// must remain under the default, and these entries should shrink when split.
const overrides = new Map([
  ["src/shared/ui/VideoPlayer.tsx", 2214],
  ["src/shared/ui/markdown.tsx", 2152],
  ["src/shared/api/tauri.ts", 1307],
  ["src/features/agents/ui/AgentInstanceEditDialog.tsx", 1201],
  ["src/features/agents/ui/agentSessionTranscript.ts", 1202],
  ["src/shared/api/relayClientSession.ts", 1096],
  ["src/shared/api/types.ts", 1058],
  ["src/features/agents/ui/AgentDefinitionDialog.tsx", 1035],
  ["src/features/messages/ui/MessageComposer.tsx", 1114],
  ["src/features/agents/ui/AgentCreationPreview.tsx", 1026],
  ["src/features/channels/useUnreadChannels.ts", 1022],
  ["src/shared/ui/sidebar.tsx", 1042],
]);

await runFileSizeCheck({
  projectRoot,
  rules,
  overrides,
  label: "Desktop",
  scriptPath: "desktop/scripts/check-file-sizes.mjs",
});
