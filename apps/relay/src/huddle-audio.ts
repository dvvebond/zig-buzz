import { randomBytes } from "node:crypto";

import {
  KIND_AUTH,
  unixNow,
  verifyNostrEvent,
  type NostrEvent,
} from "@buzz/core";
import { TokenBucketRateLimiter } from "@buzz/auth";
import type { RelayAccessPolicy } from "@buzz/db";
import {
  MAX_DATAGRAM_PAYLOAD,
  fencedHeader,
  type FencedHeader,
  type MeshNode,
  type MeshSessionStream,
  type SessionDirectory,
  type RuntimeId,
  type SessionLease,
} from "@buzz/relay-mesh";
import { WebSocket, type RawData } from "ws";

import { verifyOwnerAttestation } from "./nip98.js";
import {
  type HuddleMeshConsumer,
  type RelayMeshDispatcher,
} from "./mesh-dispatcher.js";
import type { HuddleLifecycle } from "./huddle-lifecycle.js";

const AUTH_TIMEOUT_MS = 5_000;
const CONTROL_BYTES = 64 * 1024;
const MAX_AUDIO_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_PEERS = 255;
const MAX_ROOMS = 10_000;
const REGISTER_TIMEOUT_MS = 5_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LocalPeer = {
  readonly index: number;
  readonly kind: "local";
  readonly ownerPubkey: string | undefined;
  readonly pubkey: string;
  readonly socket: WebSocket;
};

type RemotePeer = {
  readonly index: number;
  readonly kind: "remote";
  readonly pubkey: string;
  readonly runtimeId: RuntimeId;
  readonly stream: MeshSessionStream;
  sequence: bigint;
};

type Peer = LocalPeer | RemotePeer;

type Room = {
  ended: boolean;
  readonly parentChannelId: string;
  readonly peers: Map<number, Peer>;
  readonly protocolVersion: 1 | 2;
};

type AuthMessage = {
  event: NostrEvent;
  parentChannelId: string;
  protocolVersion: 1 | 2;
};

type OwnerLease = {
  lease: SessionLease;
  renewing: boolean;
  timer: NodeJS.Timeout;
};

type RemoteIngress = {
  readonly channelId: string;
  readonly fenced: FencedHeader;
  readonly index: number;
  readonly ownerRuntimeId: RuntimeId;
  readonly pubkey: string;
  readonly socket: WebSocket;
  readonly stream: MeshSessionStream;
  sequence: bigint;
};

/** Mesh dependencies shared by one tenant's dynamically created relay. */
export type HuddleAudioMeshOptions = {
  readonly communityId: string;
  readonly directory: SessionDirectory;
  readonly dispatcher: RelayMeshDispatcher;
  readonly node: MeshNode;
};

/**
 * Authenticated Opus relay. Without mesh it fans out in process. With mesh,
 * Redis selects one owner pod and every ingress registers a globally indexed
 * peer through one reliable control stream plus lossy media datagrams.
 */
export class HuddleAudioRooms implements HuddleMeshConsumer {
  readonly #accessPolicy: RelayAccessPolicy;
  readonly #community: string;
  readonly #publicUrl: URL;
  readonly #rooms = new Map<string, Room>();
  readonly #frameRate = new TokenBucketRateLimiter({
    capacity: 200,
    refillPerSecond: 100,
    maximumKeys: 100_000,
  });
  readonly #mesh: HuddleAudioMeshOptions | undefined;
  readonly #lifecycle: HuddleLifecycle | undefined;
  readonly #ownerLeases = new Map<string, OwnerLease>();
  readonly #remoteIngress = new Map<string, RemoteIngress>();
  readonly #remoteByPubkey = new Map<string, RemoteIngress>();
  readonly #unregisterMesh: (() => void) | undefined;
  #connections = 0;
  #closed = false;

  public constructor(input: {
    accessPolicy: RelayAccessPolicy;
    community: string;
    lifecycle?: HuddleLifecycle;
    publicUrl: URL;
    mesh?: HuddleAudioMeshOptions;
  }) {
    this.#accessPolicy = input.accessPolicy;
    this.#community = input.community;
    this.#lifecycle = input.lifecycle;
    this.#publicUrl = input.publicUrl;
    this.#mesh = input.mesh;
    if (input.mesh) {
      if (!UUID.test(input.mesh.communityId)) {
        throw new Error("huddle mesh requires a UUID community");
      }
      this.#unregisterMesh = input.mesh.dispatcher.registerHuddle(
        input.mesh.communityId,
        this,
      );
    }
  }

  /** Begin NIP-42 authentication for one huddle audio WebSocket. */
  public accept(socket: WebSocket, channelIdValue: string): void {
    if (
      this.#closed ||
      this.#connections >= MAX_ROOMS * 2 ||
      !UUID.test(channelIdValue)
    ) {
      socket.close(1013, "huddle audio unavailable");
      return;
    }
    this.#connections += 1;
    const channelId = channelIdValue.toLowerCase();
    let counted = true;
    const decrement = () => {
      if (!counted) return;
      counted = false;
      this.#connections -= 1;
    };
    socket.once("close", decrement);
    socket.once("error", decrement);
    void this.#authenticate(socket, channelId);
  }

  /** Close local clients, remote registrations, and owned fenced leases. */
  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unregisterMesh?.();
    for (const ingress of this.#remoteIngress.values()) {
      ingress.socket.close(1001, "relay shutdown");
      ingress.stream.close("draining");
    }
    this.#remoteIngress.clear();
    this.#remoteByPubkey.clear();
    for (const room of this.#rooms.values()) {
      for (const peer of room.peers.values()) this.closePeer(peer, "draining");
    }
    this.#rooms.clear();
    for (const owned of this.#ownerLeases.values()) {
      clearInterval(owned.timer);
      void this.#mesh?.directory.release(owned.lease);
    }
    this.#ownerLeases.clear();
  }

  /** Number of owner-authoritative rooms currently hosted on this pod. */
  public get roomCount(): number {
    return this.#rooms.size;
  }

  /** Route one already-fenced realtime media datagram. */
  public onDatagram(
    from: RuntimeId,
    datagram: {
      readonly fenced: FencedHeader;
      readonly seq: bigint;
      readonly payload: Uint8Array;
    },
  ): void {
    if (!this.#mesh || datagram.payload.byteLength < 2) return;
    const channelId = datagram.fenced.sessionId.toLowerCase();
    const payload = Buffer.from(datagram.payload);
    if (datagram.fenced.ownerRuntimeId === this.#mesh.node.runtimeId) {
      const authorIndex = payload[0];
      if (authorIndex === undefined) return;
      const room = this.#rooms.get(channelId);
      const author = room?.peers.get(authorIndex);
      if (!room || author?.kind !== "remote" || author.runtimeId !== from) {
        return;
      }
      const frame = payload.subarray(1);
      if (!validAudioFrame(frame, room.protocolVersion)) return;
      this.broadcastFrame(room, authorIndex, frame);
      return;
    }
    if (from !== datagram.fenced.ownerRuntimeId) return;
    const targetIndex = payload[0];
    if (targetIndex === undefined) return;
    const ingress = this.#remoteIngress.get(
      remoteIndexKey(channelId, targetIndex),
    );
    if (
      !ingress ||
      ingress.ownerRuntimeId !== from ||
      ingress.fenced.generation !== datagram.fenced.generation ||
      ingress.socket.readyState !== WebSocket.OPEN ||
      ingress.socket.bufferedAmount > MAX_BUFFERED_BYTES
    ) {
      return;
    }
    ingress.socket.send(payload.subarray(1), { binary: true });
  }

  /** Accept one fenced remote-peer registration on the owner pod. */
  public async onSessionStream(
    from: RuntimeId,
    stream: MeshSessionStream,
  ): Promise<void> {
    if (
      !this.#mesh ||
      stream.profile !== "huddle_control" ||
      stream.fenced.ownerRuntimeId !== this.#mesh.node.runtimeId
    ) {
      stream.close("session_ended");
      return;
    }
    const iterator = stream[Symbol.asyncIterator]();
    let registered:
      | {
          readonly channelId: string;
          readonly index: number;
          readonly room: Room;
        }
      | undefined;
    try {
      const first = await nextWithTimeout(iterator, REGISTER_TIMEOUT_MS);
      const message = parseControl(first);
      if (
        message.type !== "register" ||
        typeof message.pubkey !== "string" ||
        !/^[0-9a-f]{64}$/.test(message.pubkey) ||
        typeof message.parentChannelId !== "string" ||
        !UUID.test(message.parentChannelId) ||
        (message.protocolVersion !== 1 && message.protocolVersion !== 2)
      ) {
        throw new Error("invalid remote huddle registration");
      }
      const channelId = stream.fenced.sessionId.toLowerCase();
      let parentChannelId = message.parentChannelId.toLowerCase();
      try {
        parentChannelId =
          (
            await this.#lifecycle?.authorizeJoin({
              channelId,
              parentChannelId,
              pubkey: message.pubkey,
            })
          )?.parentChannelId ?? parentChannelId;
      } catch {
        stream.send(
          encodeControl({
            reason: "identity is not authorized for this huddle",
            type: "rejected",
          }),
        );
        stream.close("session_ended");
        return;
      }
      const existingRoom = this.#rooms.get(channelId);
      if (
        existingRoom &&
        existingRoom.protocolVersion !== message.protocolVersion
      ) {
        stream.send(
          encodeControl({
            code: "upgrade_required",
            protocolVersion: existingRoom.protocolVersion,
            reason: `huddle uses audio protocol v${existingRoom.protocolVersion}`,
            type: "rejected",
          }),
        );
        stream.close("session_ended");
        return;
      }
      if (existingRoom && existingRoom.parentChannelId !== parentChannelId) {
        stream.send(
          encodeControl({
            reason: "huddle parent channel does not match",
            type: "rejected",
          }),
        );
        stream.close("session_ended");
        return;
      }
      const room = this.getOrCreateRoom(
        channelId,
        parentChannelId,
        message.protocolVersion,
      );
      this.removeDuplicatePubkey(channelId, room, message.pubkey);
      if (room.peers.size >= MAX_PEERS) {
        stream.send(
          encodeControl({ reason: "huddle is full", type: "rejected" }),
        );
        stream.close("session_ended");
        return;
      }
      const index = firstFreeIndex(room);
      const peer: RemotePeer = {
        index,
        kind: "remote",
        pubkey: message.pubkey,
        runtimeId: from,
        sequence: 0n,
        stream,
      };
      room.peers.set(index, peer);
      void this.#lifecycle
        ?.participantJoined({
          channelId,
          parentChannelId: room.parentChannelId,
          pubkey: peer.pubkey,
        })
        .catch(() => undefined);
      registered = { channelId, index, room };
      stream.send(
        encodeControl({
          peerIndex: index,
          peers: [...room.peers.values()].map(publicPeer),
          type: "registered",
        }),
      );
      this.broadcastControl(room, index, {
        peer_index: index,
        pubkey: peer.pubkey,
        type: "joined",
      });
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const control = parseControl(next.value);
        if (control.type === "unregister" && control.peerIndex === index) {
          break;
        }
        throw new Error("unexpected huddle control message");
      }
    } catch {
      stream.close("session_ended");
    } finally {
      if (registered) {
        this.removeOwnerPeer(registered.channelId, registered.index, stream);
      }
    }
  }

  async #authenticate(socket: WebSocket, channelId: string): Promise<void> {
    const challenge = randomBytes(32).toString("hex");
    socket.send(JSON.stringify({ challenge, type: "challenge" }));
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) socket.close(1008, "audio authentication timeout");
    }, AUTH_TIMEOUT_MS);
    try {
      const auth = await firstAuthMessage(socket, challenge, this.#publicUrl);
      settled = true;
      clearTimeout(timer);
      const ownerPubkey = verifyOwnerAttestation(auth.event);
      if (
        auth.event.tags.some((tag) => tag[0] === "auth") &&
        ownerPubkey === undefined
      ) {
        throw new Error("audio owner credential is invalid");
      }
      if (
        !(await this.#accessPolicy.canConnect(
          this.#community,
          auth.event.pubkey,
          ownerPubkey,
        ))
      ) {
        throw new Error("identity is not admitted to this community");
      }
      const resolvedParent =
        (
          await this.#lifecycle?.authorizeJoin({
            channelId,
            parentChannelId: auth.parentChannelId,
            pubkey: auth.event.pubkey,
          })
        )?.parentChannelId ?? auth.parentChannelId;
      if (
        !(await this.#accessPolicy.canRead(
          this.#community,
          auth.event.pubkey,
          channelProbe(channelId, auth.event.pubkey),
          ownerPubkey,
        ))
      ) {
        throw new Error("identity is not a huddle member");
      }
      await this.#join(
        socket,
        channelId,
        { ...auth, parentChannelId: resolvedParent },
        ownerPubkey,
      );
    } catch {
      settled = true;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            message: "not authorized for this huddle",
            type: "error",
          }),
        );
        socket.close(1008, "audio authorization failed");
      }
    }
  }

  async #join(
    socket: WebSocket,
    channelId: string,
    auth: AuthMessage,
    ownerPubkey: string | undefined,
  ): Promise<void> {
    if (!this.#mesh) {
      this.joinOwnerLocal(socket, channelId, auth, ownerPubkey);
      return;
    }
    const outcome = await this.#mesh.directory.acquire(
      this.#mesh.communityId,
      channelId,
      this.#mesh.node.runtimeId,
      "huddle_control",
    );
    if (outcome.lease.profile !== "huddle_control") {
      throw new Error("huddle lease has the wrong profile");
    }
    if (outcome.lease.ownerRuntimeId === this.#mesh.node.runtimeId) {
      this.attachOwnerLease(channelId, outcome.lease);
      this.joinOwnerLocal(socket, channelId, auth, ownerPubkey);
      return;
    }
    await this.joinRemote(socket, channelId, auth, outcome.lease);
  }

  private joinOwnerLocal(
    socket: WebSocket,
    channelId: string,
    auth: AuthMessage,
    ownerPubkey: string | undefined,
  ): void {
    const existingRoom = this.#rooms.get(channelId);
    if (existingRoom && existingRoom.protocolVersion !== auth.protocolVersion) {
      socket.send(
        JSON.stringify({
          code: "upgrade_required",
          message: `huddle uses audio protocol v${existingRoom.protocolVersion}`,
          protocol_version: existingRoom.protocolVersion,
          type: "error",
        }),
      );
      socket.close(1008, "audio protocol mismatch");
      return;
    }
    if (existingRoom && existingRoom.parentChannelId !== auth.parentChannelId) {
      socket.send(
        JSON.stringify({
          message: "huddle parent channel does not match",
          type: "error",
        }),
      );
      socket.close(1008, "huddle parent mismatch");
      return;
    }
    const room = this.getOrCreateRoom(
      channelId,
      auth.parentChannelId,
      auth.protocolVersion,
    );
    this.removeDuplicatePubkey(channelId, room, auth.event.pubkey);
    if (room.peers.size >= MAX_PEERS) {
      socket.send(JSON.stringify({ message: "huddle is full", type: "error" }));
      socket.close(1013, "huddle is full");
      return;
    }
    const index = firstFreeIndex(room);
    const peer: LocalPeer = {
      index,
      kind: "local",
      ownerPubkey,
      pubkey: auth.event.pubkey,
      socket,
    };
    room.peers.set(index, peer);
    void this.#lifecycle
      ?.participantJoined({
        channelId,
        parentChannelId: room.parentChannelId,
        pubkey: peer.pubkey,
      })
      .catch(() => undefined);
    socket.send(
      JSON.stringify({
        peer_index: index,
        peers: [...room.peers.values()].map(publicPeer),
        pubkey: peer.pubkey,
        type: "joined",
      }),
    );
    this.broadcastControl(room, index, {
      peer_index: index,
      pubkey: peer.pubkey,
      type: "joined",
    });
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      this.removeOwnerPeer(channelId, index, socket);
    };
    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        const bytes = toBuffer(data);
        if (bytes.byteLength > CONTROL_BYTES) {
          socket.close(1009, "control frame too large");
          return;
        }
        socket.close(1008, "unexpected audio control message");
        return;
      }
      const frame = toBuffer(data);
      if (
        !validAudioFrame(frame, room.protocolVersion) ||
        !this.#frameRate.consume(`${channelId}:${peer.pubkey}`, 1)
      ) {
        return;
      }
      this.broadcastFrame(room, index, frame);
    });
    socket.once("close", remove);
    socket.once("error", remove);
  }

  private async joinRemote(
    socket: WebSocket,
    channelId: string,
    auth: AuthMessage,
    lease: SessionLease,
  ): Promise<void> {
    if (!this.#mesh) throw new Error("mesh is unavailable");
    await this.#mesh.node.reconcile();
    const fenced = fencedHeader(lease);
    const stream = this.#mesh.node.openSessionStream(
      lease.ownerRuntimeId,
      fenced,
      "huddle_control",
    );
    const iterator = stream[Symbol.asyncIterator]();
    stream.send(
      encodeControl({
        parentChannelId: auth.parentChannelId,
        protocolVersion: auth.protocolVersion,
        pubkey: auth.event.pubkey,
        type: "register",
      }),
    );
    const first = parseControl(
      await nextWithTimeout(iterator, REGISTER_TIMEOUT_MS),
    );
    if (first.type === "rejected") {
      stream.close("session_ended");
      if (
        first.code === "upgrade_required" &&
        (first.protocolVersion === 1 || first.protocolVersion === 2)
      ) {
        socket.send(
          JSON.stringify({
            code: "upgrade_required",
            message:
              typeof first.reason === "string"
                ? first.reason
                : `huddle uses audio protocol v${first.protocolVersion}`,
            protocol_version: first.protocolVersion,
            type: "error",
          }),
        );
        socket.close(1008, "audio protocol mismatch");
        return;
      }
      throw new Error(
        typeof first.reason === "string"
          ? first.reason
          : "huddle owner rejected registration",
      );
    }
    if (
      first.type !== "registered" ||
      !Number.isInteger(first.peerIndex) ||
      (first.peerIndex as number) < 0 ||
      (first.peerIndex as number) >= MAX_PEERS ||
      !Array.isArray(first.peers)
    ) {
      stream.close("session_ended");
      throw new Error("huddle owner rejected registration");
    }
    const index = first.peerIndex as number;
    const ingress: RemoteIngress = {
      channelId,
      fenced,
      index,
      ownerRuntimeId: lease.ownerRuntimeId,
      pubkey: auth.event.pubkey,
      sequence: 0n,
      socket,
      stream,
    };
    const duplicate = this.#remoteByPubkey.get(
      remotePubkeyKey(channelId, ingress.pubkey),
    );
    duplicate?.socket.close(1000, "replaced by a newer audio connection");
    this.#remoteIngress.set(remoteIndexKey(channelId, index), ingress);
    this.#remoteByPubkey.set(
      remotePubkeyKey(channelId, ingress.pubkey),
      ingress,
    );
    socket.send(
      JSON.stringify({
        peer_index: index,
        peers: first.peers,
        pubkey: ingress.pubkey,
        type: "joined",
      }),
    );
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      this.removeRemoteIngress(ingress);
    };
    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        socket.close(1008, "unexpected audio control message");
        return;
      }
      const frame = toBuffer(data);
      if (
        !validAudioFrame(frame, auth.protocolVersion) ||
        frame.byteLength + 1 > MAX_DATAGRAM_PAYLOAD ||
        !this.#frameRate.consume(`${channelId}:${ingress.pubkey}`, 1)
      ) {
        return;
      }
      const payload = Buffer.allocUnsafe(frame.byteLength + 1);
      payload[0] = ingress.index;
      frame.copy(payload, 1);
      try {
        this.#mesh?.node.sendDatagram(ingress.ownerRuntimeId, {
          fenced: ingress.fenced,
          payload,
          seq: ingress.sequence,
        });
        ingress.sequence += 1n;
      } catch {
        // Lossy media drops while the control stream decides reconnection.
      }
    });
    socket.once("close", remove);
    socket.once("error", remove);
    void this.readRemoteOwnerControl(iterator, ingress).finally(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close(1012, "huddle owner changed; reconnect");
      }
      remove();
    });
  }

  private async readRemoteOwnerControl(
    iterator: AsyncIterator<Uint8Array>,
    ingress: RemoteIngress,
  ): Promise<void> {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      const control = parseControl(next.value);
      if (
        control.type === "control" &&
        typeof control.value === "object" &&
        control.value !== null &&
        !Array.isArray(control.value)
      ) {
        if (ingress.socket.readyState === WebSocket.OPEN) {
          ingress.socket.send(JSON.stringify(control.value));
        }
      } else if (control.type === "close") {
        return;
      } else {
        throw new Error("invalid owner huddle control");
      }
    }
  }

  private getOrCreateRoom(
    channelId: string,
    parentChannelId: string,
    protocolVersion: 1 | 2,
  ): Room {
    let room = this.#rooms.get(channelId);
    if (!room) {
      if (this.#rooms.size >= MAX_ROOMS) {
        throw new Error("huddle room capacity reached");
      }
      room = {
        ended: false,
        parentChannelId,
        peers: new Map(),
        protocolVersion,
      };
      this.#rooms.set(channelId, room);
    }
    if (room.ended) throw new Error("huddle has ended");
    if (room.parentChannelId !== parentChannelId) {
      throw new Error("huddle parent channel does not match");
    }
    if (room.protocolVersion !== protocolVersion) {
      throw new Error(`huddle uses audio protocol v${room.protocolVersion}`);
    }
    return room;
  }

  private removeDuplicatePubkey(
    channelId: string,
    room: Room,
    pubkey: string,
  ): void {
    for (const peer of room.peers.values()) {
      if (peer.pubkey !== pubkey) continue;
      this.closePeer(peer, "session_ended");
      this.removeOwnerPeer(
        channelId,
        peer.index,
        peer.kind === "local" ? peer.socket : peer.stream,
        false,
      );
    }
  }

  private removeOwnerPeer(
    channelId: string,
    index: number,
    identity: WebSocket | MeshSessionStream,
    autoEnd = true,
  ): void {
    const room = this.#rooms.get(channelId);
    const peer = room?.peers.get(index);
    if (
      !room ||
      !peer ||
      (peer.kind === "local"
        ? peer.socket !== identity
        : peer.stream !== identity)
    ) {
      return;
    }
    room.peers.delete(index);
    this.broadcastControl(room, index, {
      peer_index: index,
      pubkey: peer.pubkey,
      type: "left",
    });
    const roomEmpty = room.peers.size === 0 && autoEnd;
    if (!roomEmpty) {
      void this.#lifecycle
        ?.participantLeft({
          channelId,
          parentChannelId: room.parentChannelId,
          pubkey: peer.pubkey,
          roomEmpty: false,
        })
        .catch(() => undefined);
      return;
    }
    if (!this.#lifecycle) {
      this.#rooms.delete(channelId);
      this.releaseOwnerLease(channelId);
      return;
    }
    room.ended = true;
    void this.#lifecycle
      .participantLeft({
        channelId,
        parentChannelId: room.parentChannelId,
        pubkey: peer.pubkey,
        roomEmpty: true,
      })
      .then(() => {
        if (
          this.#rooms.get(channelId) === room &&
          room.peers.size === 0 &&
          room.ended
        ) {
          this.#rooms.delete(channelId);
          this.releaseOwnerLease(channelId);
        }
      })
      .catch(() => {
        if (this.#rooms.get(channelId) === room) room.ended = false;
      });
  }

  private removeRemoteIngress(ingress: RemoteIngress): void {
    if (
      this.#remoteIngress.get(
        remoteIndexKey(ingress.channelId, ingress.index),
      ) !== ingress
    ) {
      return;
    }
    this.#remoteIngress.delete(
      remoteIndexKey(ingress.channelId, ingress.index),
    );
    if (
      this.#remoteByPubkey.get(
        remotePubkeyKey(ingress.channelId, ingress.pubkey),
      ) === ingress
    ) {
      this.#remoteByPubkey.delete(
        remotePubkeyKey(ingress.channelId, ingress.pubkey),
      );
    }
    try {
      ingress.stream.send(
        encodeControl({ peerIndex: ingress.index, type: "unregister" }),
      );
    } catch {
      // The owner may already have closed a stale-generation stream.
    }
    ingress.stream.close("session_ended");
  }

  private broadcastFrame(room: Room, authorIndex: number, frame: Buffer): void {
    const outgoing = Buffer.allocUnsafe(frame.byteLength + 1);
    outgoing[0] = authorIndex;
    frame.copy(outgoing, 1);
    for (const target of room.peers.values()) {
      if (target.index === authorIndex) continue;
      if (target.kind === "local") {
        if (
          target.socket.readyState === WebSocket.OPEN &&
          target.socket.bufferedAmount <= MAX_BUFFERED_BYTES
        ) {
          target.socket.send(outgoing, { binary: true });
        }
        continue;
      }
      if (!this.#mesh || outgoing.byteLength + 1 > MAX_DATAGRAM_PAYLOAD) {
        continue;
      }
      const payload = Buffer.allocUnsafe(outgoing.byteLength + 1);
      payload[0] = target.index;
      outgoing.copy(payload, 1);
      try {
        this.#mesh.node.sendDatagram(target.runtimeId, {
          fenced: target.stream.fenced,
          payload,
          seq: target.sequence,
        });
        target.sequence += 1n;
      } catch {
        // Realtime media is intentionally lossy under peer backpressure.
      }
    }
  }

  private broadcastControl(
    room: Room,
    excludedIndex: number,
    value: Record<string, unknown>,
  ): void {
    for (const target of room.peers.values()) {
      if (target.index === excludedIndex) continue;
      if (target.kind === "local") {
        if (target.socket.readyState === WebSocket.OPEN) {
          target.socket.send(JSON.stringify(value));
        }
      } else {
        try {
          target.stream.send(encodeControl({ type: "control", value }));
        } catch {
          // Control stream teardown will remove the remote peer.
        }
      }
    }
  }

  private attachOwnerLease(channelId: string, lease: SessionLease): void {
    const existing = this.#ownerLeases.get(channelId);
    if (
      existing?.lease.generation === lease.generation &&
      existing.lease.ownerRuntimeId === lease.ownerRuntimeId
    ) {
      return;
    }
    if (existing) clearInterval(existing.timer);
    const owned: OwnerLease = {
      lease,
      renewing: false,
      timer: setInterval(
        () => {
          void this.renewOwnerLease(channelId, owned);
        },
        Math.max(
          250,
          Math.floor((this.#mesh?.directory.leaseTtlMs ?? 30_000) / 3),
        ),
      ),
    };
    owned.timer.unref();
    this.#ownerLeases.set(channelId, owned);
  }

  private async renewOwnerLease(
    channelId: string,
    owned: OwnerLease,
  ): Promise<void> {
    if (
      owned.renewing ||
      this.#ownerLeases.get(channelId) !== owned ||
      !this.#mesh
    ) {
      return;
    }
    owned.renewing = true;
    try {
      const renewed = await this.#mesh.directory.renew(owned.lease);
      if (renewed.status !== "renewed") {
        this.ownerLeaseLost(channelId, owned);
      } else {
        owned.lease = renewed.lease;
      }
    } catch {
      this.ownerLeaseLost(channelId, owned);
    } finally {
      owned.renewing = false;
    }
  }

  private ownerLeaseLost(channelId: string, owned: OwnerLease): void {
    if (this.#ownerLeases.get(channelId) !== owned) return;
    clearInterval(owned.timer);
    this.#ownerLeases.delete(channelId);
    const room = this.#rooms.get(channelId);
    if (!room) return;
    for (const peer of room.peers.values()) {
      this.closePeer(peer, "stale_generation");
    }
    this.#rooms.delete(channelId);
  }

  private releaseOwnerLease(channelId: string): void {
    const owned = this.#ownerLeases.get(channelId);
    if (!owned) return;
    clearInterval(owned.timer);
    this.#ownerLeases.delete(channelId);
    void this.#mesh?.directory.release(owned.lease);
  }

  private closePeer(
    peer: Peer,
    reason: "draining" | "session_ended" | "stale_generation",
  ): void {
    if (peer.kind === "local") {
      peer.socket.close(
        reason === "session_ended" ? 1000 : 1012,
        reason.replaceAll("_", " "),
      );
      return;
    }
    try {
      peer.stream.send(encodeControl({ reason, type: "close" }));
    } catch {
      // Stream may already be closed.
    }
    peer.stream.close(reason);
  }
}

async function firstAuthMessage(
  socket: WebSocket,
  challenge: string,
  publicUrl: URL,
): Promise<AuthMessage> {
  return await new Promise<AuthMessage>((resolve, reject) => {
    const onClose = () =>
      reject(new Error("audio socket closed before authentication"));
    const onError = () =>
      reject(new Error("audio socket failed before authentication"));
    const onMessage = (data: RawData, isBinary: boolean) => {
      const bytes = toBuffer(data);
      if (isBinary || bytes.byteLength > CONTROL_BYTES) {
        finish(new Error("audio authentication frame is invalid"));
        return;
      }
      try {
        finish(
          undefined,
          parseAuth(bytes.toString("utf8"), challenge, publicUrl),
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error("invalid auth"));
      }
    };
    const finish = (error?: Error, value?: AuthMessage) => {
      socket.off("close", onClose);
      socket.off("error", onError);
      socket.off("message", onMessage);
      if (error) reject(error);
      else resolve(value as AuthMessage);
    };
    socket.once("close", onClose);
    socket.once("error", onError);
    socket.once("message", onMessage);
  });
}

function parseAuth(
  encoded: string,
  challenge: string,
  publicUrl: URL,
): AuthMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("audio authentication is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("audio authentication has an invalid shape");
  }
  const input = parsed as Record<string, unknown>;
  if (
    input.type !== "auth" ||
    (input.protocol_version !== 1 && input.protocol_version !== 2) ||
    typeof input.parent_channel_id !== "string" ||
    !UUID.test(input.parent_channel_id) ||
    !verifyNostrEvent(input.event) ||
    input.event.kind !== KIND_AUTH
  ) {
    throw new Error("audio authentication is invalid");
  }
  if (
    input.event.created_at < unixNow() - 600 ||
    input.event.created_at > unixNow() + 600 ||
    singleTag(input.event, "challenge") !== challenge ||
    normalizeRelayUrl(singleTag(input.event, "relay")) !==
      normalizeRelayUrl(publicUrl.toString())
  ) {
    throw new Error("audio authentication binding is invalid");
  }
  return {
    event: input.event,
    parentChannelId: input.parent_channel_id.toLowerCase(),
    protocolVersion: input.protocol_version,
  };
}

function validAudioFrame(frame: Buffer, version: 1 | 2): boolean {
  if (frame.byteLength < 1 || frame.byteLength > MAX_AUDIO_BYTES) return false;
  if (version === 1) return true;
  if (frame.byteLength <= 8) return false;
  const level = frame.readInt8(6);
  void (level >= -127 && level <= 0 ? level : -127);
  return true;
}

function firstFreeIndex(room: Room): number {
  for (let index = 0; index < MAX_PEERS; index += 1) {
    if (!room.peers.has(index)) return index;
  }
  throw new Error("huddle is full");
}

function publicPeer(peer: Peer): { peer_index: number; pubkey: string } {
  return { peer_index: peer.index, pubkey: peer.pubkey };
}

function channelProbe(channelId: string, pubkey: string): NostrEvent {
  return {
    content: "",
    created_at: unixNow(),
    id: "0".repeat(64),
    kind: 9,
    pubkey,
    sig: "0".repeat(128),
    tags: [["h", channelId]],
  };
}

function singleTag(event: NostrEvent, name: string): string {
  const values = event.tags.filter(
    (tag) => tag[0] === name && tag.length === 2,
  );
  if (values.length !== 1 || !values[0]?.[1]) {
    throw new Error(`audio auth has invalid ${name} tag`);
  }
  return values[0][1];
}

function normalizeRelayUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function toBuffer(value: RawData): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.concat(value);
  return Buffer.from(value);
}

function encodeControl(value: Record<string, unknown>): Buffer {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.byteLength > CONTROL_BYTES) {
    throw new Error("huddle control message is too large");
  }
  return bytes;
}

function parseControl(value: Uint8Array): Record<string, unknown> {
  if (value.byteLength < 2 || value.byteLength > CONTROL_BYTES) {
    throw new Error("invalid huddle control message");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value).toString("utf8")) as unknown;
  } catch {
    throw new Error("invalid huddle control JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid huddle control shape");
  }
  return parsed as Record<string, unknown>;
}

async function nextWithTimeout(
  iterator: AsyncIterator<Uint8Array>,
  timeoutMs: number,
): Promise<Uint8Array> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("huddle control timed out")),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
    if (result.done) throw new Error("huddle control stream closed");
    return result.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function remoteIndexKey(channelId: string, index: number): string {
  return `${channelId}:${index}`;
}

function remotePubkeyKey(channelId: string, pubkey: string): string {
  return `${channelId}:${pubkey}`;
}
