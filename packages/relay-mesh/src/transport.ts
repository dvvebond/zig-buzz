import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import {
  createServer as createHttpsServer,
  type ServerOptions as HttpsServerOptions,
} from "node:https";
import { isIP } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  handshakeAcceptedPreimage,
  handshakeAuthPreimage,
  handshakeChallengePreimage,
  readyPreimage,
  verifyRuntimeSignature,
  type RuntimeIdentity,
} from "./identity.js";
import { MeshMembership } from "./membership.js";
import {
  MAX_DATAGRAM_PAYLOAD,
  MESH_PROTOCOL,
  MeshProtocolError,
  WIRE_VERSION,
  decodeFrame,
  encodeFrame,
  type FencedHeader,
  type GoodbyeReason,
  type MeshStatus,
  type Profile,
  type ReadyRecord,
  type RuntimeId,
  type WireFrame,
} from "./model.js";
import type { ReadyRegistry } from "./registry.js";

const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const CLOSE_PROTOCOL = 4_402;
const CLOSE_AUTH = 4_403;
const MAX_BACKPRESSURE = 256 * 1024;

export interface MeshInboundHandler {
  validateFence(
    fenced: FencedHeader,
    from: RuntimeId,
  ): Promise<boolean> | boolean;
  onDatagram?(
    from: RuntimeId,
    datagram: {
      readonly fenced: FencedHeader;
      readonly seq: bigint;
      readonly payload: Uint8Array;
    },
  ): Promise<void> | void;
  onSessionStream?(
    from: RuntimeId,
    stream: MeshSessionStream,
  ): Promise<void> | void;
}

export interface MeshNodeOptions {
  readonly identity: RuntimeIdentity;
  readonly readyRecord: ReadyRecord;
  readonly expectedRelayPubkey: RuntimeId;
  readonly registry: ReadyRegistry;
  readonly handler: MeshInboundHandler;
  readonly host?: string;
  readonly port?: number;
  readonly publicHost?: string;
  readonly tls?: HttpsServerOptions;
  readonly allowInsecureLoopback?: boolean;
  readonly registryRefreshMs?: number;
}

interface AuthenticatedPeer {
  readonly runtimeId: RuntimeId;
  readonly socket: WebSocket;
  readonly streams: Map<string, MeshSessionStream>;
  processing: Promise<void>;
}

export class MeshSessionStream implements AsyncIterable<Uint8Array> {
  readonly #queue: Uint8Array[] = [];
  readonly #waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  #ended = false;

  public constructor(
    public readonly id: string,
    public readonly peerRuntimeId: RuntimeId,
    public readonly fenced: FencedHeader,
    public readonly profile: Exclude<Profile, "realtime_media">,
    readonly sendFrame: (frame: WireFrame) => void,
    readonly onFinish: () => void,
  ) {}

  public send(payload: Uint8Array): void {
    if (this.#ended) throw new MeshProtocolError("stream_closed");
    if (payload.byteLength > 12 * 1024 * 1024) {
      throw new MeshProtocolError("frame_too_large");
    }
    this.sendFrame({
      v: WIRE_VERSION,
      type: "stream_data",
      streamId: this.id,
      fenced: this.fenced,
      payload: Buffer.from(payload).toString("base64url"),
    });
  }

  public close(reason: GoodbyeReason = "session_ended"): void {
    if (this.#ended) return;
    this.sendFrame({
      v: WIRE_VERSION,
      type: "stream_close",
      streamId: this.id,
      fenced: this.fenced,
      reason,
    });
    this.finish();
  }

  public push(payload: Uint8Array): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: payload });
    else this.#queue.push(payload);
  }

  public finish(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.onFinish();
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        const value = this.#queue.shift();
        if (value) return { done: false, value };
        if (this.#ended) return { done: true, value: undefined };
        return await new Promise<IteratorResult<Uint8Array>>((resolve) =>
          this.#waiters.push(resolve),
        );
      },
      return: async () => {
        this.finish();
        return { done: true, value: undefined };
      },
    };
  }
}

export class MeshNode {
  readonly #options: MeshNodeOptions;
  readonly #membership: MeshMembership;
  readonly #peers = new Map<RuntimeId, AuthenticatedPeer>();
  readonly #wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024 * 1024,
    perMessageDeflate: false,
    clientTracking: false,
  });
  #server: HttpServer | undefined;
  #timer: NodeJS.Timeout | undefined;
  #started = false;
  #advertisedRecord: ReadyRecord;

  public constructor(options: MeshNodeOptions) {
    if (options.readyRecord.runtimeId !== options.identity.runtimeId) {
      throw new Error("ready record does not belong to runtime identity");
    }
    this.#options = options;
    this.#advertisedRecord = structuredClone(options.readyRecord);
    this.#membership = new MeshMembership(
      options.identity,
      options.expectedRelayPubkey,
      options.readyRecord,
    );
  }

  public get runtimeId(): RuntimeId {
    return this.#options.identity.runtimeId;
  }

  public get status(): MeshStatus {
    return this.#membership.status();
  }

  public async start(): Promise<URL> {
    if (this.#started) throw new Error("mesh node already started");
    this.#started = true;
    const host = this.#options.host ?? "127.0.0.1";
    this.#server = this.#options.tls
      ? createHttpsServer(this.#options.tls)
      : createHttpServer();
    this.#server.on("upgrade", (request, socket, head) => {
      let url: URL;
      try {
        url = new URL(request.url ?? "", "http://mesh.invalid");
      } catch {
        socket.destroy();
        return;
      }
      if (
        url.pathname !== "/_mesh/ws" ||
        url.search !== "" ||
        request.headers["sec-websocket-protocol"] !== MESH_PROTOCOL
      ) {
        socket.destroy();
        return;
      }
      this.#wss.handleUpgrade(request, socket, head, (ws) => {
        this.#wss.emit("connection", ws, request);
      });
    });
    this.#wss.on("connection", (socket) => {
      void this.#accept(socket);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.#options.port ?? 0, host, () => resolve());
    });
    const address = this.#server.address();
    if (!address || typeof address === "string")
      throw new Error("mesh bind failed");
    const scheme = this.#options.tls ? "wss" : "ws";
    const publicHost = this.#options.publicHost ?? host;
    const endpoint = new URL(
      `${scheme}://${formatHost(publicHost)}:${address.port}/_mesh/ws`,
    );
    validateMeshEndpoint(
      endpoint,
      this.#options.allowInsecureLoopback ?? false,
    );
    const unsignedRecord = {
      ...this.#advertisedRecord,
      endpointUrls: [endpoint.toString()],
    };
    const { readyRuntimeSig: _oldReadySignature, ...unsigned } = unsignedRecord;
    this.#advertisedRecord = {
      ...unsigned,
      readyRuntimeSig: this.#options.identity.sign(readyPreimage(unsigned)),
    };
    this.#membership.replaceLocalReady(this.#advertisedRecord);
    await this.#heartbeat();
    const interval = this.#options.registryRefreshMs ?? 15_000;
    this.#timer = setInterval(() => void this.#heartbeat(), interval);
    this.#timer.unref();
    return endpoint;
  }

  public async close(): Promise<void> {
    if (!this.#started) return;
    this.#membership.updateLocal({ draining: true });
    if (this.#timer) clearInterval(this.#timer);
    for (const peer of this.#peers.values()) {
      peer.socket.close(1_001, "draining");
      for (const stream of peer.streams.values()) stream.finish();
    }
    this.#peers.clear();
    await this.#options.registry.clear(this.runtimeId);
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
    this.#wss.close();
    this.#started = false;
  }

  public async reconcile(): Promise<void> {
    const records = await this.#options.registry.list(
      this.#options.expectedRelayPubkey,
    );
    this.#membership.applyReady(records);
    await Promise.all(
      records
        .filter(
          (record) =>
            record.runtimeId > this.runtimeId &&
            !this.#peers.has(record.runtimeId),
        )
        .map((record) =>
          this.#dialRecord(record).catch((error: unknown) => {
            const transportReason =
              error instanceof Error
                ? error.message.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 80)
                : "transport";
            this.#membership.increment(
              `connect_error_${error instanceof MeshProtocolError ? error.code : transportReason}`,
            );
          }),
        ),
    );
  }

  public openSessionStream(
    to: RuntimeId,
    fenced: FencedHeader,
    profile: Exclude<Profile, "realtime_media">,
  ): MeshSessionStream {
    const peer = this.#requirePeer(to);
    const id = randomUUID();
    const stream = new MeshSessionStream(
      id,
      to,
      fenced,
      profile,
      (frame) => send(peer.socket, frame),
      () => peer.streams.delete(id),
    );
    peer.streams.set(id, stream);
    send(peer.socket, {
      v: WIRE_VERSION,
      type: "stream_open",
      streamId: id,
      fenced,
      profile,
    });
    this.#membership.increment("streams_opened");
    return stream;
  }

  public sendDatagram(
    to: RuntimeId,
    datagram: {
      readonly fenced: FencedHeader;
      readonly seq: bigint;
      readonly payload: Uint8Array;
    },
  ): boolean {
    if (datagram.payload.byteLength > MAX_DATAGRAM_PAYLOAD) {
      throw new MeshProtocolError("datagram_too_large");
    }
    const peer = this.#requirePeer(to);
    if (peer.socket.bufferedAmount > MAX_BACKPRESSURE) {
      this.#membership.increment("datagrams_dropped_backpressure");
      return false;
    }
    send(peer.socket, {
      v: WIRE_VERSION,
      type: "datagram",
      fenced: datagram.fenced,
      seq: String(datagram.seq),
      payload: Buffer.from(datagram.payload).toString("base64url"),
    });
    this.#membership.increment("datagrams_sent");
    return true;
  }

  async #heartbeat(): Promise<void> {
    const interval = this.#options.registryRefreshMs ?? 15_000;
    await this.#options.registry.publish(
      this.#advertisedRecord,
      Math.max(1, Math.ceil((interval * 3) / 1_000)),
    );
    this.#membership.updateLocal({});
    await this.reconcile();
    for (const peer of this.#peers.values()) {
      send(peer.socket, {
        v: WIRE_VERSION,
        type: "gossip_digest",
        entries: this.#membership.digest(),
      });
    }
  }

  async #accept(socket: WebSocket): Promise<void> {
    const nonce = randomBytes(32).toString("base64url");
    const timestamp = Date.now();
    send(socket, {
      v: WIRE_VERSION,
      type: "challenge",
      runtimeId: this.runtimeId,
      nonce,
      timestamp,
      signature: this.#options.identity.sign(
        handshakeChallengePreimage({
          runtimeId: this.runtimeId,
          nonce,
          timestamp,
        }),
      ),
    });
    try {
      const frame = await firstFrame(socket);
      if (
        frame.type !== "authenticate" ||
        frame.challengeNonce !== nonce ||
        frame.runtimeId >= this.runtimeId ||
        !fresh(frame.timestamp)
      ) {
        throw new MeshProtocolError("authentication_failed");
      }
      await this.#refreshMembership();
      if (!this.#membership.hasPeer(frame.runtimeId)) {
        throw new MeshProtocolError("unknown_runtime");
      }
      const auth = handshakeAuthPreimage({
        clientRuntimeId: frame.runtimeId,
        serverRuntimeId: this.runtimeId,
        clientNonce: frame.nonce,
        serverNonce: nonce,
        timestamp: frame.timestamp,
      });
      if (!verifyRuntimeSignature(frame.runtimeId, auth, frame.signature)) {
        throw new MeshProtocolError("authentication_failed");
      }
      send(socket, {
        v: WIRE_VERSION,
        type: "accepted",
        signature: this.#options.identity.sign(
          handshakeAcceptedPreimage({
            clientRuntimeId: frame.runtimeId,
            serverRuntimeId: this.runtimeId,
            clientNonce: frame.nonce,
            serverNonce: nonce,
          }),
        ),
      });
      this.#installPeer(frame.runtimeId, socket);
    } catch {
      socket.close(CLOSE_AUTH, "authentication failed");
    }
  }

  async #dialRecord(record: ReadyRecord): Promise<void> {
    if (record.runtimeId <= this.runtimeId) return;
    const endpoint = record.endpointUrls[0];
    if (!endpoint) return;
    const url = new URL(endpoint);
    validateMeshEndpoint(url, this.#options.allowInsecureLoopback ?? false);
    const socket = new WebSocket(url, MESH_PROTOCOL, {
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      followRedirects: false,
      maxPayload: 16 * 1024 * 1024,
      perMessageDeflate: false,
    });
    const challengePromise = firstFrame(socket);
    await opened(socket);
    const challenge = await challengePromise;
    if (
      challenge.type !== "challenge" ||
      challenge.runtimeId !== record.runtimeId ||
      !fresh(challenge.timestamp) ||
      !verifyRuntimeSignature(
        challenge.runtimeId,
        handshakeChallengePreimage(challenge),
        challenge.signature,
      )
    ) {
      socket.close(CLOSE_AUTH, "authentication failed");
      throw new MeshProtocolError("authentication_failed");
    }
    const nonce = randomBytes(32).toString("base64url");
    const timestamp = Date.now();
    const acceptedPromise = firstFrame(socket);
    send(socket, {
      v: WIRE_VERSION,
      type: "authenticate",
      runtimeId: this.runtimeId,
      nonce,
      challengeNonce: challenge.nonce,
      timestamp,
      signature: this.#options.identity.sign(
        handshakeAuthPreimage({
          clientRuntimeId: this.runtimeId,
          serverRuntimeId: challenge.runtimeId,
          clientNonce: nonce,
          serverNonce: challenge.nonce,
          timestamp,
        }),
      ),
    });
    const accepted = await acceptedPromise;
    if (
      accepted.type !== "accepted" ||
      !verifyRuntimeSignature(
        record.runtimeId,
        handshakeAcceptedPreimage({
          clientRuntimeId: this.runtimeId,
          serverRuntimeId: record.runtimeId,
          clientNonce: nonce,
          serverNonce: challenge.nonce,
        }),
        accepted.signature,
      )
    ) {
      socket.close(CLOSE_AUTH, "authentication failed");
      throw new MeshProtocolError("authentication_failed");
    }
    this.#installPeer(record.runtimeId, socket);
  }

  #installPeer(runtimeId: RuntimeId, socket: WebSocket): void {
    const prior = this.#peers.get(runtimeId);
    if (prior) {
      prior.socket.close(1_000, "superseded");
      for (const stream of prior.streams.values()) stream.finish();
    }
    const peer: AuthenticatedPeer = {
      runtimeId,
      socket,
      streams: new Map(),
      processing: Promise.resolve(),
    };
    this.#peers.set(runtimeId, peer);
    this.#membership.markConnected(runtimeId, true);
    socket.on("message", (raw, binary) => {
      if (binary) {
        socket.close(CLOSE_PROTOCOL, "text frames required");
        return;
      }
      peer.processing = peer.processing
        .then(() => this.#handleFrame(peer, raw))
        .catch(() => socket.close(CLOSE_PROTOCOL, "protocol violation"));
    });
    socket.once("close", () => {
      if (this.#peers.get(runtimeId)?.socket === socket) {
        this.#peers.delete(runtimeId);
        this.#membership.markConnected(runtimeId, false);
      }
      for (const stream of peer.streams.values()) stream.finish();
    });
    send(socket, {
      v: WIRE_VERSION,
      type: "gossip_digest",
      entries: this.#membership.digest(),
    });
  }

  async #handleFrame(peer: AuthenticatedPeer, raw: RawData): Promise<void> {
    const frame = decodeFrame(raw);
    switch (frame.type) {
      case "gossip_digest":
        send(peer.socket, {
          v: WIRE_VERSION,
          type: "gossip_delta",
          records: this.#membership.deltaFor(frame.entries),
        });
        return;
      case "gossip_delta":
        for (const record of frame.records)
          this.#membership.applyGossip(record);
        return;
      case "stream_open": {
        if (
          !(await this.#options.handler.validateFence(
            frame.fenced,
            peer.runtimeId,
          ))
        ) {
          this.#membership.increment("fence_rejections");
          return;
        }
        const stream = new MeshSessionStream(
          frame.streamId,
          peer.runtimeId,
          frame.fenced,
          frame.profile,
          (outbound) => send(peer.socket, outbound),
          () => peer.streams.delete(frame.streamId),
        );
        peer.streams.set(frame.streamId, stream);
        this.#membership.increment("streams_received");
        void Promise.resolve(
          this.#options.handler.onSessionStream?.(peer.runtimeId, stream),
        ).catch(() => stream.close());
        return;
      }
      case "stream_data": {
        const stream = peer.streams.get(frame.streamId);
        if (!stream || !sameFence(stream.fenced, frame.fenced)) {
          throw new MeshProtocolError("unknown_stream");
        }
        if (
          !(await this.#options.handler.validateFence(
            frame.fenced,
            peer.runtimeId,
          ))
        ) {
          this.#membership.increment("fence_rejections");
          stream.close("stale_generation");
          return;
        }
        stream.push(decodePayload(frame.payload, 12 * 1024 * 1024));
        return;
      }
      case "stream_close": {
        const stream = peer.streams.get(frame.streamId);
        if (!stream || !sameFence(stream.fenced, frame.fenced)) {
          throw new MeshProtocolError("unknown_stream");
        }
        stream.finish();
        return;
      }
      case "datagram":
        if (
          !(await this.#options.handler.validateFence(
            frame.fenced,
            peer.runtimeId,
          ))
        ) {
          this.#membership.increment("fence_rejections");
          return;
        }
        await this.#options.handler.onDatagram?.(peer.runtimeId, {
          fenced: frame.fenced,
          seq: BigInt(frame.seq),
          payload: decodePayload(frame.payload, MAX_DATAGRAM_PAYLOAD),
        });
        this.#membership.increment("datagrams_received");
        return;
      default:
        throw new MeshProtocolError("unexpected_handshake_frame");
    }
  }

  async #refreshMembership(): Promise<void> {
    this.#membership.applyReady(
      await this.#options.registry.list(this.#options.expectedRelayPubkey),
    );
  }

  #requirePeer(runtimeId: RuntimeId): AuthenticatedPeer {
    const peer = this.#peers.get(runtimeId);
    if (!peer || peer.socket.readyState !== WebSocket.OPEN) {
      throw new MeshProtocolError("peer_not_connected");
    }
    return peer;
  }
}

export function validateMeshEndpoint(
  url: URL,
  allowInsecureLoopback: boolean,
): void {
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/_mesh/ws"
  ) {
    throw new Error("mesh endpoint must be an origin plus /_mesh/ws");
  }
  const loopback = isLoopbackHost(url.hostname);
  if (
    url.protocol !== "wss:" &&
    !(url.protocol === "ws:" && loopback && allowInsecureLoopback)
  ) {
    throw new Error("mesh endpoint must use wss (ws is loopback-test-only)");
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) === 4) {
    const first = Number(host.split(".")[0]);
    return first === 127;
  }
  return false;
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function fresh(timestamp: number): boolean {
  return Math.abs(Date.now() - timestamp) <= MAX_CLOCK_SKEW_MS;
}

function send(socket: WebSocket, frame: WireFrame): void {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new MeshProtocolError("peer_not_connected");
  }
  socket.send(encodeFrame(frame));
}

function firstFrame(socket: WebSocket): Promise<WireFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new MeshProtocolError("handshake_timeout"));
    }, HANDSHAKE_TIMEOUT_MS);
    const message = (raw: RawData, binary: boolean): void => {
      cleanup();
      if (binary) reject(new MeshProtocolError("text_frames_required"));
      else {
        try {
          resolve(decodeFrame(raw));
        } catch (error) {
          reject(error);
        }
      }
    };
    const closed = (): void => {
      cleanup();
      reject(new MeshProtocolError("connection_closed"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("message", message);
      socket.off("close", closed);
      socket.off("error", closed);
    };
    socket.once("message", message);
    socket.once("close", closed);
    socket.once("error", closed);
  });
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new MeshProtocolError("connect_timeout")),
      HANDSHAKE_TIMEOUT_MS,
    );
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function decodePayload(value: string, max: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value))
    throw new MeshProtocolError("invalid_payload");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value || bytes.byteLength > max) {
    throw new MeshProtocolError("invalid_payload");
  }
  return bytes;
}

function sameFence(a: FencedHeader, b: FencedHeader): boolean {
  return (
    a.communityId === b.communityId &&
    a.sessionId === b.sessionId &&
    a.generation === b.generation &&
    a.ownerRuntimeId === b.ownerRuntimeId
  );
}
