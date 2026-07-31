#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CommandRegistry } from "./commands.js";
import { readRememberedPort, rememberPort } from "./server-port.js";
import { AgentModelService } from "./agent-models.js";
import { ArchiveService } from "./archive.js";
import { BuilderlabService } from "./builderlab.js";
import { ChannelService } from "./channels.js";
import { DesktopEventBus } from "./event-bus.js";
import { EntityReconcileService } from "./entity-reconcile.js";
import { HuddleService } from "./huddle.js";
import { IdentityService } from "./identity.js";
import { IdentityArchiveService } from "./identity-archive.js";
import { LocalEntityService } from "./local-entities.js";
import { ManagedAgentService } from "./managed-agents.js";
import { ManagedAgentMessageService } from "./managed-agent-messages.js";
import { DesktopMediaService } from "./media.js";
import { AgentMemoryService } from "./memory.js";
import { MeshComputeService } from "./mesh-compute.js";
import { NestService } from "./nest.js";
import { fetchRelaySelf } from "./native-utilities.js";
import { PairingService } from "./pairing.js";
import { ProfileService } from "./profile.js";
import { ProjectGitService } from "./project-git.js";
import { RelayHttpClient } from "./relay-http.js";
import { RuntimeCatalogService } from "./runtime-catalog.js";
import { DesktopResetService, runPendingReset } from "./reset.js";
import { SecureStore } from "./secure-store.js";
import { startDesktopServer } from "./server.js";
import { SocialService } from "./social.js";
import { SnapshotService } from "./snapshot-service.js";
import { WorkspaceService } from "./workspace.js";
import { WorkflowService } from "./workflows.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(moduleDirectory, "../../..");
const dataDirectory =
  process.env.BUZZ_DESKTOP_DATA_DIR?.trim() ||
  path.join(defaultDataRoot(), "Buzz TypeScript");
const distDirectory =
  process.env.BUZZ_DESKTOP_DIST?.trim() ||
  path.join(workspaceRoot, "desktop", "dist");
const explicitPort = Number(process.env.BUZZ_DESKTOP_PORT?.trim() ?? "");
const configuredPort =
  Number.isInteger(explicitPort) &&
  explicitPort >= 1_024 &&
  explicitPort <= 65_535
    ? explicitPort
    : await readRememberedPort(dataDirectory);
const relayUrl = process.env.BUZZ_RELAY_URL?.trim() || "ws://127.0.0.1:3000";
const relayHttpUrl =
  process.env.BUZZ_RELAY_HTTP_URL?.trim() || relayUrl.replace(/^ws/, "http");
const nestDirectory =
  process.env.BUZZ_NEST_DIR?.trim() || path.join(os.homedir(), ".buzz");

await runPendingReset(dataDirectory);
const nest = await NestService.create(nestDirectory);
await nest.ensure();
const reset = new DesktopResetService(dataDirectory);
const store = new SecureStore(dataDirectory);
const events = new DesktopEventBus();
const identity = IdentityService.create(await store.load(), (state) =>
  store.save(state),
);
const builderlab = new BuilderlabService({
  identity,
  openExternal: openBrowser,
});
const localEntities = new LocalEntityService(identity);
const runtimeCatalog = new RuntimeCatalogService(identity);
const managedAgents = new ManagedAgentService({
  dataDirectory,
  defaultRelayUrl: relayUrl,
  identity,
  localEntities,
  nest,
  runtimeCatalog,
});
await nest.regenerate(managedAgents.list(), relayUrl);
const entityReconcile = new EntityReconcileService({
  events,
  identity,
  localEntities,
  managedAgents,
});
const relay = new RelayHttpClient({
  baseUrl: relayHttpUrl,
  sign: (input) => identity.sign(input),
});
const archive = await ArchiveService.create({
  dataDirectory,
  identity,
  relay,
  relayUrl,
});
const media = new DesktopMediaService({ identity, relayHttpUrl });
const memory = new AgentMemoryService({ identity, managedAgents, relay });
const snapshots = new SnapshotService({
  localEntities,
  managedAgents,
  media,
  memory,
});
const profiles = new ProfileService(identity, relay);
const channels = new ChannelService({
  identity,
  profiles,
  relay,
  relayScope: relayHttpUrl,
});
const social = new SocialService(identity, relay);
const workflows = new WorkflowService(identity, relay);
const workspace = new WorkspaceService({
  archive,
  channels,
  dataDirectory,
  defaultRelayHttpUrl: relayHttpUrl,
  defaultRelayUrl: relayUrl,
  identity,
  managedAgents,
  media,
  nest,
  relay,
});
const identityArchive = new IdentityArchiveService({
  identity,
  relay,
  relaySelf: () => fetchRelaySelf(workspace.relayHttpUrl()),
});
const projectGit = new ProjectGitService({
  identity,
  managedAgents,
  relay,
  workspace,
});
const pairing = new PairingService({
  events,
  identity,
  workspace,
});
const huddle = new HuddleService({
  channels,
  events,
  identity,
  relay,
  workspace,
});
const meshCompute = new MeshComputeService({
  dataDirectory,
  events,
  identity,
  workspace,
  ...(process.env.BUZZ_MESH_LLM_BINARY?.trim()
    ? { binaryPath: process.env.BUZZ_MESH_LLM_BINARY.trim() }
    : {}),
});
const agentModels = new AgentModelService({
  localEntities,
  managedAgents,
  mesh: meshCompute,
  runtimeCatalog,
});
const managedAgentMessages = new ManagedAgentMessageService(
  managedAgents,
  relay,
);
const commands = new CommandRegistry({
  agentModels,
  archive,
  builderlab,
  channels,
  events,
  huddle,
  entityReconcile,
  identity,
  identityArchive,
  localEntities,
  managedAgents,
  managedAgentMessages,
  media,
  memory,
  meshCompute,
  pairing,
  profiles,
  projectGit,
  reset,
  runtimeCatalog,
  social,
  snapshots,
  workspace,
  workflows,
});
const configuredBootToken = process.env.BUZZ_DESKTOP_BOOT_TOKEN?.trim();
if (
  configuredBootToken !== undefined &&
  !/^[A-Za-z0-9_-]{43,128}$/.test(configuredBootToken)
) {
  throw new Error(
    "BUZZ_DESKTOP_BOOT_TOKEN must contain 43 to 128 base64url characters",
  );
}
const bootToken = configuredBootToken ?? randomBytes(32).toString("base64url");
const server = await startDesktopServer({
  bootToken,
  commands,
  distDirectory,
  // Prefer the port used last time so the browser origin — and with it the UI's
  // per-origin state — survives a restart. BUZZ_DESKTOP_PORT overrides it.
  ...(configuredPort !== undefined ? { port: configuredPort } : {}),
});
await rememberPort(
  dataDirectory,
  new URL(server.origin).port ? Number(new URL(server.origin).port) : 0,
);
const launchUrl = `${server.origin}/#buzz-token=${encodeURIComponent(bootToken)}`;
reset.setRestartHandler(async () => {
  await close();
  await runPendingReset(dataDirectory);
  restartProcess();
  process.exit(0);
});

console.log(`Buzz TypeScript desktop host listening on ${server.origin}`);
void managedAgents.startOnLaunch();
void meshCompute.restore().catch((error: unknown) => {
  console.error(
    `Unable to restore compute sharing: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
});
if (process.env.BUZZ_DESKTOP_NO_OPEN !== "1") openBrowser(launchUrl);

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await builderlab.shutdown();
  await pairing.shutdown();
  await managedAgents.shutdown();
  await meshCompute.shutdown();
  archive.close();
  store.close();
  await server.close();
}
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

function defaultDataRoot(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  if (process.platform === "win32") {
    return (
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    );
  }
  return (
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  );
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? { executable: "open", args: [url] }
      : process.platform === "win32"
        ? { executable: "cmd.exe", args: ["/d", "/s", "/c", "start", "", url] }
        : { executable: "xdg-open", args: [url] };
  const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function restartProcess(): void {
  const environment = { ...process.env };
  delete environment.BUZZ_DESKTOP_BOOT_TOKEN;
  const child = spawn(
    process.execPath,
    [...process.execArgv, ...process.argv.slice(1)],
    {
      cwd: process.cwd(),
      detached: true,
      env: environment,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
}
