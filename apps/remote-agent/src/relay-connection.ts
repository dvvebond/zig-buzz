import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";

import {
  KIND_AUTH,
  KIND_REMOTE_AGENT_ACK,
  KIND_REMOTE_AGENT_COMMAND,
  KIND_REMOTE_AGENT_STATUS,
  signNostrEvent,
  unixNow,
  type NostrEvent,
} from "@buzz/core";
import {
  createRemoteEnvelope,
  openRemoteEnvelope,
  parseEnrollmentToken,
  ReplayGuard,
  type AckPayload,
  type EnrollmentPayload,
  type RemoteCapability,
  type RemotePayload,
  type StatusPayload,
} from "@buzz/remote-agent-protocol";
import { getPublicKey } from "nostr-tools/pure";
import WebSocket from "ws";

export type RelayConnectionOptions = {
  readonly relayUrl: URL;
  readonly workerName: string;
  readonly workerVersion: string;
  readonly workerSecretKey: Uint8Array;
  readonly ownerPubkey: string;
  readonly community: string;
  readonly enrollmentId: string;
  readonly enrollmentToken?: string;
  readonly approved: boolean;
  readonly capabilities: readonly RemoteCapability[];
};

export class RelayConnection extends EventEmitter<{
  approved: [];
  ready: [];
  command: [payload: RemotePayload];
  error: [error: Error];
}> {
  readonly #options: RelayConnectionOptions;
  readonly #workerPubkey: string;
  readonly #replay = new ReplayGuard();
  readonly #outboundSequences = new Map<string, number>();
  #socket: WebSocket | undefined;
  #authenticated = false;
  #approved = false;
  #stopping = false;
  #attempt = 0;
  #authEventId: string | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #authTimeout: NodeJS.Timeout | undefined;
  #helloTimeout: NodeJS.Timeout | undefined;
  #runAbort: AbortController | undefined;
  #running = false;
  #lastPongAt = 0;
  #pendingHello:
    | { readonly challenge: string; readonly sessionId: string }
    | undefined;
  #activeSessionId: string | undefined;
  #enrollmentMessageId: string | undefined;

  public constructor(options: RelayConnectionOptions) {
    super();
    this.#options = options;
    this.#workerPubkey = getPublicKey(options.workerSecretKey);
    this.#approved = options.approved;
  }

  public workerPubkey(): string {
    return this.#workerPubkey;
  }

  public async run(): Promise<void> {
    if (this.#running) throw new Error("relay connection is already running");
    this.#running = true;
    this.#stopping = false;
    this.#runAbort = new AbortController();
    try {
      while (!this.#stopping) {
        try {
          await this.#connectOnce();
          this.#attempt = 0;
        } catch (error) {
          if (!this.#stopping) {
            this.#reportError(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        } finally {
          this.#clearSocket();
        }
        if (this.#stopping) break;
        const delay = backoffWithJitter(this.#attempt++);
        await abortableDelay(delay, this.#runAbort.signal);
      }
    } finally {
      this.#runAbort = undefined;
      this.#running = false;
    }
  }

  public stop(): void {
    this.#stopping = true;
    this.#runAbort?.abort();
    this.#socket?.close(1000, "worker shutdown");
    this.#clearSocket();
  }

  public sendAck(input: {
    readonly command: RemotePayload;
    readonly outcome: "accepted" | "completed" | "rejected";
    readonly code?: string;
    readonly message?: string;
    readonly agentPubkey?: string;
  }): void {
    const sessionId = input.command.sessionId;
    const now = unixNow();
    const payload: AckPayload = {
      body: {
        commandMessageId: input.command.messageId,
        code: input.code,
        message: input.message,
        agentPubkey: input.agentPubkey,
        outcome: input.outcome,
      },
      deploymentId: input.command.deploymentId,
      expiresAt: now + 30,
      issuedAt: now,
      messageId: randomUUID(),
      sequence: this.#nextOutboundSequence(sessionId),
      sessionId,
      type: "ack",
      version: 1,
    };
    this.#sendEvent(
      createRemoteEnvelope({
        payload,
        recipientPubkey: this.#options.ownerPubkey,
        senderSecretKey: this.#options.workerSecretKey,
        workerPubkey: this.#workerPubkey,
      }),
    );
  }

  async #connectOnce(): Promise<void> {
    const socket = new WebSocket(this.#options.relayUrl, {
      followRedirects: false,
      handshakeTimeout: 15_000,
      maxPayload: 256 * 1024,
      perMessageDeflate: false,
    });
    this.#socket = socket;
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });
    socket.on("message", (data, isBinary) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      if (isBinary || bytes.length > 256 * 1024) {
        socket.close(1009, "unsupported payload");
        return;
      }
      try {
        this.#handleWireMessage(bytes.toString("utf8"));
      } catch (error) {
        this.#reportError(
          error instanceof Error
            ? error
            : new Error("invalid relay worker message"),
        );
        socket.close(1008, "worker protocol failure");
      }
    });
    socket.on("pong", () => {
      this.#lastPongAt = Date.now();
    });
    socket.on("error", (error) => this.#reportError(error));
    await once(socket, "open");
    this.#lastPongAt = Date.now();
    this.#authTimeout = setTimeout(() => {
      if (!this.#authenticated) socket.close(1008, "authentication timed out");
    }, 15_000);
    this.#authTimeout.unref();
    this.#heartbeat = setInterval(() => {
      if (Date.now() - this.#lastPongAt > 60_000) {
        socket.terminate();
        return;
      }
      socket.ping();
    }, 20_000);
    this.#heartbeat.unref();
    await closed;
  }

  #handleWireMessage(encoded: string): void {
    let message: unknown;
    try {
      message = JSON.parse(encoded) as unknown;
    } catch {
      return;
    }
    if (!Array.isArray(message) || typeof message[0] !== "string") return;
    switch (message[0]) {
      case "AUTH":
        if (typeof message[1] === "string") this.#authenticate(message[1]);
        break;
      case "OK":
        if (
          message[1] === this.#authEventId &&
          message[2] === true &&
          !this.#authenticated
        ) {
          this.#authenticated = true;
          if (this.#authTimeout) clearTimeout(this.#authTimeout);
          this.#authTimeout = undefined;
          this.#afterAuthentication();
        } else if (message[1] === this.#authEventId && message[2] === false) {
          this.#socket?.close(1008, "relay authentication rejected");
        }
        break;
      case "EVENT":
        if (message[2]) this.#handleEvent(message[2]);
        break;
      case "BRAP":
        if (message[1] === "APPROVED") {
          this.#markApproved();
        }
        break;
      case "NOTICE":
        this.#reportError(new Error("relay rejected a worker request"));
        if (!this.#approved || !this.#activeSessionId) {
          this.#socket?.close(1008, "worker request rejected");
        }
        break;
    }
  }

  #authenticate(challenge: string): void {
    if (
      Buffer.byteLength(challenge, "utf8") < 16 ||
      Buffer.byteLength(challenge, "utf8") > 512
    ) {
      this.#socket?.close(1008, "invalid auth challenge");
      return;
    }
    const event = signNostrEvent(
      {
        content: "",
        created_at: unixNow(),
        kind: KIND_AUTH,
        tags: [
          ["relay", this.#options.relayUrl.toString()],
          ["challenge", challenge],
        ],
      },
      this.#options.workerSecretKey,
    );
    this.#authEventId = event.id;
    this.#send(["AUTH", event]);
  }

  #afterAuthentication(): void {
    if (this.#approved) {
      this.#subscribe();
      return;
    }
    if (this.#options.enrollmentToken) {
      this.#subscribePendingApproval();
      this.#sendEnrollment(this.#options.enrollmentToken);
      return;
    }
    throw new Error("worker approval is required before subscribing");
  }

  #sendEnrollment(token: string): void {
    const parsedToken = parseEnrollmentToken(token);
    if (parsedToken.ownerPubkey !== this.#options.ownerPubkey) {
      throw new Error("enrollment token is bound to a different owner");
    }
    const now = unixNow();
    const sessionId = randomBytes(16).toString("hex");
    const payload: EnrollmentPayload = {
      body: {
        capabilities: [...this.#options.capabilities],
        challenge: randomBytes(32).toString("hex"),
        community: this.#options.community,
        enrollmentId: parsedToken.id,
        ownerPubkey: this.#options.ownerPubkey,
        workerName: this.#options.workerName,
        workerPubkey: this.#workerPubkey,
        workerVersion: this.#options.workerVersion,
      },
      deploymentId: parsedToken.id,
      expiresAt: now + 30,
      issuedAt: now,
      messageId: randomUUID(),
      sequence: 0,
      sessionId,
      type: "enrollment",
      version: 1,
    };
    const event = createRemoteEnvelope({
      payload,
      recipientPubkey: this.#options.ownerPubkey,
      senderSecretKey: this.#options.workerSecretKey,
      workerPubkey: this.#workerPubkey,
    });
    this.#enrollmentMessageId = payload.messageId;
    this.#send(["BRAP", "ENROLL", token, event]);
  }

  #subscribePendingApproval(): void {
    this.#send([
      "REQ",
      "brap-enrollment-approval",
      {
        "#p": [this.#workerPubkey],
        kinds: [KIND_REMOTE_AGENT_ACK],
      },
    ]);
  }

  #subscribe(): void {
    this.#send([
      "REQ",
      "brap-commands",
      {
        "#p": [this.#workerPubkey],
        kinds: [KIND_REMOTE_AGENT_COMMAND, KIND_REMOTE_AGENT_ACK],
      },
    ]);
    this.#sendHello();
  }

  #handleEvent(value: unknown): void {
    try {
      const payload = openRemoteEnvelope({
        event: value,
        expectedSenderPubkey: this.#options.ownerPubkey,
        expectedWorkerPubkey: this.#workerPubkey,
        recipientPubkey: this.#workerPubkey,
        recipientSecretKey: this.#options.workerSecretKey,
        replayGuard: this.#replay,
      });
      if (!this.#approved) {
        if (
          payload.type === "ack" &&
          payload.deploymentId === this.#options.enrollmentId &&
          payload.body.commandMessageId === this.#enrollmentMessageId &&
          payload.body.outcome === "completed"
        ) {
          this.#markApproved();
        }
        return;
      }
      if (payload.type === "ack") {
        if (
          this.#pendingHello &&
          payload.sessionId === this.#pendingHello.sessionId &&
          payload.sequence === 0 &&
          payload.body.challenge === this.#pendingHello.challenge &&
          payload.body.outcome === "completed"
        ) {
          this.#activeSessionId = payload.sessionId;
          this.#pendingHello = undefined;
          if (this.#helloTimeout) clearTimeout(this.#helloTimeout);
          this.#helloTimeout = undefined;
          this.emit("ready");
        }
        return;
      }
      if (
        payload.type === "command" &&
        payload.sessionId === this.#activeSessionId
      ) {
        this.emit("command", payload);
      }
    } catch (error) {
      this.#reportError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  #markApproved(): void {
    if (this.#approved) return;
    this.#approved = true;
    this.#send(["CLOSE", "brap-enrollment-approval"]);
    this.#subscribe();
    this.emit("approved");
  }

  #sendHello(): void {
    const now = unixNow();
    const sessionId = randomBytes(16).toString("hex");
    const challenge = randomBytes(32).toString("hex");
    const payload: StatusPayload = {
      body: {
        capabilities: [...this.#options.capabilities],
        challenge,
        state: "hello",
        workerVersion: this.#options.workerVersion,
      },
      deploymentId: this.#options.enrollmentId,
      expiresAt: now + 30,
      issuedAt: now,
      messageId: randomUUID(),
      sequence: 0,
      sessionId,
      type: "status",
      version: 1,
    };
    this.#pendingHello = { challenge, sessionId };
    this.#activeSessionId = undefined;
    this.#outboundSequences.set(sessionId, 1);
    const event = createRemoteEnvelope({
      payload,
      recipientPubkey: this.#options.ownerPubkey,
      senderSecretKey: this.#options.workerSecretKey,
      workerPubkey: this.#workerPubkey,
    });
    if (event.kind !== KIND_REMOTE_AGENT_STATUS) {
      throw new Error("remote hello event kind mismatch");
    }
    this.#sendEvent(event);
    if (this.#helloTimeout) clearTimeout(this.#helloTimeout);
    this.#helloTimeout = setTimeout(() => {
      if (this.#pendingHello?.sessionId === sessionId) {
        this.#socket?.close(1008, "secure-session handshake timed out");
      }
    }, 30_000);
    this.#helloTimeout.unref();
  }

  #sendEvent(event: NostrEvent): void {
    this.#send(["EVENT", event]);
  }

  #send(message: unknown[]): void {
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      throw new Error("relay connection is not open");
    }
    this.#socket.send(JSON.stringify(message));
  }

  #nextOutboundSequence(sessionId: string): number {
    const sequence = this.#outboundSequences.get(sessionId) ?? 0;
    this.#outboundSequences.set(sessionId, sequence + 1);
    return sequence;
  }

  #clearSocket(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#authTimeout) clearTimeout(this.#authTimeout);
    if (this.#helloTimeout) clearTimeout(this.#helloTimeout);
    this.#heartbeat = undefined;
    this.#authTimeout = undefined;
    this.#helloTimeout = undefined;
    this.#socket = undefined;
    this.#authenticated = false;
    this.#authEventId = undefined;
    this.#pendingHello = undefined;
    this.#activeSessionId = undefined;
    this.#enrollmentMessageId = undefined;
  }

  #reportError(error: Error): void {
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }
}

function backoffWithJitter(attempt: number): number {
  const ceiling = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    timeout.unref();
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
