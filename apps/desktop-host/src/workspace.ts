import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { ArchiveService } from "./archive.js";
import type { ChannelService } from "./channels.js";
import type { IdentityService } from "./identity.js";
import type { ManagedAgentService } from "./managed-agents.js";
import type { DesktopMediaService } from "./media.js";
import type { NestService } from "./nest.js";
import type { RelayHttpClient } from "./relay-http.js";

export class WorkspaceService {
  readonly #archive: Pick<ArchiveService, "setRelayUrl">;
  readonly #channels: Pick<ChannelService, "setRelayScope">;
  readonly #dataDirectory: string;
  readonly #defaultRelayUrl: string;
  readonly #identity: IdentityService;
  readonly #managedAgents: Pick<
    ManagedAgentService,
    "rebindOwnerAuthorization" | "setWorkspaceRelayUrl"
  >;
  readonly #media: Pick<DesktopMediaService, "setRelayHttpUrl">;
  readonly #nest: Pick<NestService, "setReposDirectory"> | undefined;
  readonly #relay: Pick<RelayHttpClient, "setBaseUrl">;
  #relayHttpUrl: string;
  #relayUrl: string;

  constructor(input: {
    archive: Pick<ArchiveService, "setRelayUrl">;
    channels: Pick<ChannelService, "setRelayScope">;
    dataDirectory: string;
    defaultRelayHttpUrl: string;
    defaultRelayUrl: string;
    identity: IdentityService;
    managedAgents: Pick<
      ManagedAgentService,
      "rebindOwnerAuthorization" | "setWorkspaceRelayUrl"
    >;
    media: Pick<DesktopMediaService, "setRelayHttpUrl">;
    nest?: Pick<NestService, "setReposDirectory">;
    relay: Pick<RelayHttpClient, "setBaseUrl">;
  }) {
    this.#archive = input.archive;
    this.#channels = input.channels;
    this.#dataDirectory = path.resolve(input.dataDirectory);
    this.#defaultRelayUrl = normalizeWorkspaceRelayUrl(input.defaultRelayUrl);
    this.#relayUrl = this.#defaultRelayUrl;
    this.#relayHttpUrl = normalizeRelayHttpUrl(input.defaultRelayHttpUrl);
    this.#identity = input.identity;
    this.#managedAgents = input.managedAgents;
    this.#media = input.media;
    this.#nest = input.nest;
    this.#relay = input.relay;
  }

  defaultRelayUrl(): string {
    return this.#defaultRelayUrl;
  }

  relayUrl(): string {
    return this.#relayUrl;
  }

  relayHttpUrl(): string {
    return this.#relayHttpUrl;
  }

  async apply(args: Record<string, unknown>): Promise<void> {
    const relayUrl = normalizeWorkspaceRelayUrl(args.relayUrl);
    const relayHttpUrl = relayHttpUrlFromWs(relayUrl);
    const nsec =
      typeof args.nsec === "string" && args.nsec.trim()
        ? args.nsec.trim()
        : undefined;
    const previousOwner = this.#identity.info().pubkey;
    let reposDirectory: string | null = null;
    let reposDirectoryError: string | null = null;
    if (typeof args.reposDir === "string" && args.reposDir.trim()) {
      try {
        reposDirectory = await validateReposDirectory(
          args.reposDir,
          this.#dataDirectory,
        );
      } catch (error) {
        reposDirectoryError = safeError(error);
      }
    } else if (
      args.reposDir !== undefined &&
      args.reposDir !== null &&
      typeof args.reposDir !== "string"
    ) {
      reposDirectoryError = "reposDir must be a string";
    }
    try {
      await this.#nest?.setReposDirectory(reposDirectory);
    } catch (error) {
      reposDirectory = null;
      reposDirectoryError = safeError(error);
    }
    if (
      args.agentManagedProfiles !== undefined &&
      typeof args.agentManagedProfiles !== "boolean"
    ) {
      throw new Error("agentManagedProfiles must be a boolean");
    }

    if (nsec) await this.#identity.import(nsec);
    const ownerChanged = previousOwner !== this.#identity.info().pubkey;
    if (ownerChanged) await this.#managedAgents.rebindOwnerAuthorization();

    await this.#identity.setSetting("workspace.relay_url", relayUrl);
    await this.#identity.setSetting("workspace.repos_dir", reposDirectory);
    await this.#identity.setSetting(
      "workspace.repos_dir_error",
      reposDirectoryError,
    );
    await this.#identity.setSetting(
      "agents.managed_profiles",
      args.agentManagedProfiles === true,
    );

    this.#relay.setBaseUrl(relayHttpUrl);
    this.#archive.setRelayUrl(relayUrl);
    this.#channels.setRelayScope(relayHttpUrl);
    this.#media.setRelayHttpUrl(relayHttpUrl);
    this.#relayUrl = relayUrl;
    this.#relayHttpUrl = relayHttpUrl;
    await this.#managedAgents.setWorkspaceRelayUrl(relayUrl, ownerChanged);
  }

  async setAgentManagedProfiles(value: unknown): Promise<void> {
    if (typeof value !== "boolean") {
      throw new Error("enabled must be a boolean");
    }
    await this.#identity.setSetting("agents.managed_profiles", value);
  }

  async validateReposDirectory(value: unknown): Promise<void> {
    if (value === undefined || value === null || value === "") return;
    if (typeof value !== "string") throw new Error("dir must be a string");
    await validateReposDirectory(value, this.#dataDirectory);
  }
}

export function normalizeWorkspaceRelayUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new Error("relayUrl must be a string no longer than 2048 characters");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("relayUrl is invalid");
  }
  const loopback = isLoopback(url.hostname);
  if (
    (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "remote relay URLs must use wss and may not contain credentials, query, or fragment",
    );
  }
  url.pathname = "/";
  return url.toString();
}

export function relayHttpUrlFromWs(relayUrl: string): string {
  const url = new URL(normalizeWorkspaceRelayUrl(relayUrl));
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.toString();
}

async function validateReposDirectory(
  value: string,
  dataDirectory: string,
): Promise<string> {
  const raw = value.trim();
  if (!raw || raw.startsWith("~") || !path.isAbsolute(raw)) {
    throw new Error("repository directory must be an existing absolute path");
  }
  const resolved = await realpath(raw).catch(() => {
    throw new Error("repository directory does not exist or is not accessible");
  });
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) {
    throw new Error("repository directory must be a directory");
  }
  const appData = await realpath(dataDirectory).catch(() =>
    path.resolve(dataDirectory),
  );
  if (appData === resolved || appData.startsWith(`${resolved}${path.sep}`)) {
    throw new Error(
      "repository directory cannot be the app data directory or its ancestor",
    );
  }
  return resolved;
}

function normalizeRelayHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("relay HTTP URL is invalid");
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopback(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("remote relay HTTP URLs must use HTTPS");
  }
  url.pathname = "/";
  return url.toString();
}

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "repository directory is invalid";
}
