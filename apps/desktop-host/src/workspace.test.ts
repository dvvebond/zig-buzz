import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { generateSecretKey, nip19 } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IdentityService } from "./identity.js";
import {
  normalizeWorkspaceRelayUrl,
  relayHttpUrlFromWs,
  WorkspaceService,
} from "./workspace.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((operation) => operation()));
});

describe("WorkspaceService", () => {
  it("switches every relay-scoped service through one validated apply", async () => {
    const dataDirectory = await temporaryDirectory("buzz-workspace-data-");
    const reposDirectory = await temporaryDirectory("buzz-workspace-repos-");
    const identity = IdentityService.create(undefined, async () => undefined);
    const setRelayUrl = vi.fn();
    const setRelayScope = vi.fn();
    const setRelayHttpUrl = vi.fn();
    const setBaseUrl = vi.fn();
    const setWorkspaceRelayUrl = vi.fn(async () => undefined);
    const rebindOwnerAuthorization = vi.fn(async () => undefined);
    const workspace = new WorkspaceService({
      archive: { setRelayUrl },
      channels: { setRelayScope },
      dataDirectory,
      defaultRelayHttpUrl: "http://127.0.0.1:3000",
      defaultRelayUrl: "ws://127.0.0.1:3000",
      identity,
      managedAgents: {
        rebindOwnerAuthorization,
        setWorkspaceRelayUrl,
      },
      media: { setRelayHttpUrl },
      relay: { setBaseUrl },
    });

    await workspace.apply({
      agentManagedProfiles: true,
      relayUrl: "wss://relay.example/community",
      reposDir: reposDirectory,
      token: "not-persisted",
    });

    expect(workspace.relayUrl()).toBe("wss://relay.example/");
    expect(workspace.relayHttpUrl()).toBe("https://relay.example/");
    expect(setBaseUrl).toHaveBeenCalledWith("https://relay.example/");
    expect(setRelayUrl).toHaveBeenCalledWith("wss://relay.example/");
    expect(setRelayScope).toHaveBeenCalledWith("https://relay.example/");
    expect(setRelayHttpUrl).toHaveBeenCalledWith("https://relay.example/");
    expect(setWorkspaceRelayUrl).toHaveBeenCalledWith(
      "wss://relay.example/",
      false,
    );
    expect(rebindOwnerAuthorization).not.toHaveBeenCalled();
    expect(identity.setting("workspace.repos_dir", null)).toBe(
      await realpath(reposDirectory),
    );
    expect(identity.setting("agents.managed_profiles", false)).toBe(true);
  });

  it("rebinds agent authorization and forces runtime restart after an identity change", async () => {
    const dataDirectory = await temporaryDirectory("buzz-workspace-identity-");
    const identity = IdentityService.create(undefined, async () => undefined);
    const previousOwner = identity.info().pubkey;
    const setWorkspaceRelayUrl = vi.fn(async () => undefined);
    const rebindOwnerAuthorization = vi.fn(async () => undefined);
    const noOp = vi.fn();
    const workspace = new WorkspaceService({
      archive: { setRelayUrl: noOp },
      channels: { setRelayScope: noOp },
      dataDirectory,
      defaultRelayHttpUrl: "http://127.0.0.1:3000",
      defaultRelayUrl: "ws://127.0.0.1:3000",
      identity,
      managedAgents: {
        rebindOwnerAuthorization,
        setWorkspaceRelayUrl,
      },
      media: { setRelayHttpUrl: noOp },
      relay: { setBaseUrl: noOp },
    });

    await workspace.apply({
      nsec: nip19.nsecEncode(generateSecretKey()),
      relayUrl: "ws://127.0.0.1:3000",
    });

    expect(identity.info().pubkey).not.toBe(previousOwner);
    expect(rebindOwnerAuthorization).toHaveBeenCalledOnce();
    expect(setWorkspaceRelayUrl).toHaveBeenCalledWith(
      "ws://127.0.0.1:3000/",
      true,
    );
  });

  it("rejects plaintext remote relays and unsafe repository paths", async () => {
    expect(() => normalizeWorkspaceRelayUrl("ws://relay.example")).toThrow(
      /must use wss/,
    );
    expect(() =>
      normalizeWorkspaceRelayUrl("wss://user@relay.example"),
    ).toThrow(/credentials/);
    expect(relayHttpUrlFromWs("wss://relay.example")).toBe(
      "https://relay.example/",
    );

    const dataDirectory = await temporaryDirectory(
      "buzz-workspace-validation-",
    );
    const identity = IdentityService.create(undefined, async () => undefined);
    const noOp = vi.fn();
    const workspace = new WorkspaceService({
      archive: { setRelayUrl: noOp },
      channels: { setRelayScope: noOp },
      dataDirectory,
      defaultRelayHttpUrl: "http://127.0.0.1:3000",
      defaultRelayUrl: "ws://127.0.0.1:3000",
      identity,
      managedAgents: {
        rebindOwnerAuthorization: async () => undefined,
        setWorkspaceRelayUrl: async () => undefined,
      },
      media: { setRelayHttpUrl: noOp },
      relay: { setBaseUrl: noOp },
    });
    await expect(
      workspace.validateReposDirectory("relative/path"),
    ).rejects.toThrow(/absolute/);
    await expect(
      workspace.validateReposDirectory(path.dirname(dataDirectory)),
    ).rejects.toThrow(/ancestor/);
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  return directory;
}
