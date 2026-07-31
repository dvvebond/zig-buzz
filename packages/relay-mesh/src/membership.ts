import {
  signGossipRecord,
  verifyGossipRecord,
  type RuntimeIdentity,
} from "./identity.js";
import type {
  GossipRecord,
  MeshPeerInfo,
  MeshStatus,
  ReadyRecord,
  RuntimeId,
} from "./model.js";

interface PeerState {
  record: GossipRecord;
  connected: boolean;
}

export class MeshMembership {
  readonly #identity: RuntimeIdentity;
  readonly #relayPubkey: RuntimeId;
  readonly #peers = new Map<RuntimeId, PeerState>();
  readonly #counters = new Map<string, number>();
  #local: GossipRecord;

  public constructor(
    identity: RuntimeIdentity,
    relayPubkey: RuntimeId,
    ready: ReadyRecord,
  ) {
    this.#identity = identity;
    this.#relayPubkey = relayPubkey;
    this.#local = signGossipRecord(identity, {
      ...ready,
      load: 0,
      draining: false,
      version: "1",
      heartbeatMillis: String(Date.now()),
    });
  }

  public get localRuntimeId(): RuntimeId {
    return this.#identity.runtimeId;
  }

  public get localRecord(): GossipRecord {
    return structuredClone(this.#local);
  }

  public hasPeer(runtimeId: RuntimeId): boolean {
    return this.#peers.has(runtimeId);
  }

  public applyReady(records: readonly ReadyRecord[]): void {
    for (const ready of records) {
      if (ready.runtimeId === this.localRuntimeId) continue;
      const existing = this.#peers.get(ready.runtimeId);
      if (!existing) {
        this.#peers.set(ready.runtimeId, {
          connected: false,
          record: signlessSeed(ready),
        });
      }
    }
  }

  /** Replace this runtime's advertised endpoint while retaining dynamic state. */
  public replaceLocalReady(ready: ReadyRecord): void {
    if (ready.runtimeId !== this.localRuntimeId) {
      throw new Error("cannot replace local record with a foreign runtime");
    }
    this.#local = signGossipRecord(this.#identity, {
      ...ready,
      load: this.#local.load,
      draining: this.#local.draining,
      version: String(BigInt(this.#local.version) + 1n),
      heartbeatMillis: String(Date.now()),
    });
  }

  public applyGossip(record: GossipRecord): boolean {
    if (
      record.runtimeId === this.localRuntimeId ||
      !verifyGossipRecord(record, this.#relayPubkey)
    ) {
      this.increment("invalid_gossip_rejections");
      return false;
    }
    const existing = this.#peers.get(record.runtimeId);
    if (existing && BigInt(record.version) <= BigInt(existing.record.version)) {
      return false;
    }
    this.#peers.set(record.runtimeId, {
      connected: existing?.connected ?? false,
      record: structuredClone(record),
    });
    return true;
  }

  public markConnected(runtimeId: RuntimeId, connected: boolean): void {
    const peer = this.#peers.get(runtimeId);
    if (peer) peer.connected = connected;
  }

  public updateLocal(update: {
    load?: number;
    draining?: boolean;
  }): GossipRecord {
    const { runtimeSig: _runtimeSig, ...base } = this.#local;
    this.#local = signGossipRecord(this.#identity, {
      ...base,
      ...(update.load === undefined ? {} : { load: update.load }),
      ...(update.draining === undefined ? {} : { draining: update.draining }),
      version: String(BigInt(base.version) + 1n),
      heartbeatMillis: String(Date.now()),
    });
    return this.localRecord;
  }

  public records(): GossipRecord[] {
    return [
      this.localRecord,
      ...[...this.#peers.values()].map((p) => structuredClone(p.record)),
    ];
  }

  public digest(): { runtimeId: RuntimeId; version: string }[] {
    return this.records()
      .map(({ runtimeId, version }) => ({ runtimeId, version }))
      .sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
  }

  public deltaFor(
    digest: readonly { runtimeId: RuntimeId; version: string }[],
  ): GossipRecord[] {
    const versions = new Map(
      digest.map((entry) => [entry.runtimeId, BigInt(entry.version)]),
    );
    return this.records()
      .filter(
        (record) =>
          (versions.get(record.runtimeId) ?? -1n) < BigInt(record.version),
      )
      .sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
  }

  public increment(name: string): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + 1);
  }

  public status(): MeshStatus {
    const peers: MeshPeerInfo[] = [...this.#peers.values()]
      .map(({ record, connected }) => ({
        runtimeId: record.runtimeId,
        draining: record.draining,
        load: record.load,
        connected,
        lastHeartbeatMillis: Number(record.heartbeatMillis),
      }))
      .sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
    return {
      enabled: true,
      localRuntimeId: this.localRuntimeId,
      draining: this.#local.draining,
      peerCount: peers.length,
      peers,
      counters: Object.fromEntries(this.#counters),
    };
  }
}

function signlessSeed(ready: ReadyRecord): GossipRecord {
  return {
    ...ready,
    load: 0,
    draining: false,
    version: "0",
    heartbeatMillis: String(Date.now()),
    runtimeSig: "A".repeat(86),
  };
}
