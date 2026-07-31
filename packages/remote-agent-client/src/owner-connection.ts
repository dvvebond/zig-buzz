import {
  KIND_AUTH,
  KIND_REMOTE_AGENT_ACK,
  KIND_REMOTE_AGENT_ENROLLMENT,
  KIND_REMOTE_AGENT_STATUS,
  signNostrEvent,
  unixNow,
  verifyNostrEvent,
  type NostrEvent,
} from "@buzz/core";
import {
  createRemoteEnvelope,
  openRemoteEnvelope,
  ReplayGuard,
  validateRemoteRelayUrl,
  type AckPayload,
  type CommandPayload,
  type EnrollmentPayload,
  type StatusPayload,
} from "@buzz/remote-agent-protocol";
import { getPublicKey } from "nostr-tools/pure";

export type OwnerConnectionEvent =
  | {
      readonly type: "enrollment";
      readonly event: NostrEvent;
      readonly payload: EnrollmentPayload;
    }
  | {
      readonly type: "ack";
      readonly event: NostrEvent;
      readonly payload: AckPayload;
    }
  | {
      readonly type: "status";
      readonly event: NostrEvent;
      readonly payload: StatusPayload;
    }
  | { readonly type: "error"; readonly error: Error }
  | { readonly type: "connected" | "disconnected" };

export type SocketLike = {
  readonly readyState: number;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export class RemoteAgentOwnerConnection {
  readonly #relayUrl: URL;
  readonly #ownerSecretKey: Uint8Array;
  readonly #ownerPubkey: string;
  readonly #socketFactory: (url: string) => SocketLike;
  readonly #listeners = new Set<(event: OwnerConnectionEvent) => void>();
  readonly #replay = new ReplayGuard();
  readonly #sessions = new Map<
    string,
    {
      readonly deploymentId: string;
      readonly sessionId: string;
      nextSequence: number;
    }
  >();
  readonly #pendingCommands = new Map<
    string,
    {
      readonly resolve: (payload: AckPayload) => void;
      readonly reject: (error: Error) => void;
      readonly timeout: ReturnType<typeof setTimeout>;
    }
  >();
  #socket: SocketLike | undefined;
  #authEventId: string | undefined;
  #authenticated = false;

  public constructor(input: {
    readonly relayUrl: string;
    readonly ownerSecretKey: Uint8Array;
    readonly allowInsecureLocalhost?: boolean;
    readonly socketFactory?: (url: string) => SocketLike;
  }) {
    this.#relayUrl = validateRemoteRelayUrl(
      input.relayUrl,
      input.allowInsecureLocalhost,
    );
    this.#ownerSecretKey = input.ownerSecretKey;
    this.#ownerPubkey = getPublicKey(input.ownerSecretKey);
    this.#socketFactory =
      input.socketFactory ??
      ((url) => new WebSocket(url) as unknown as SocketLike);
  }

  public on(listener: (event: OwnerConnectionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async connect(): Promise<void> {
    if (this.#socket) throw new Error("owner connection is already started");
    const socket = this.#socketFactory(this.#relayUrl.toString());
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      this.#handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      this.#authenticated = false;
      this.#authEventId = undefined;
      this.#socket = undefined;
      this.#sessions.clear();
      this.#rejectPendingCommands(
        new Error("relay disconnected before acknowledgement"),
      );
      this.#emit({ type: "disconnected" });
    });
    socket.addEventListener("error", () => {
      this.#emit({
        error: new Error("relay connection failed"),
        type: "error",
      });
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("relay connection timed out")),
        15_000,
      );
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("relay connection failed"));
      });
    });
  }

  public close(): void {
    this.#sessions.clear();
    this.#rejectPendingCommands(
      new Error("owner connection closed before acknowledgement"),
    );
    this.#socket?.close(1000, "owner shutdown");
  }

  #rejectPendingCommands(error: Error): void {
    for (const pending of this.#pendingCommands.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pendingCommands.clear();
  }

  public approveEnrollment(input: {
    readonly enrollment: EnrollmentPayload;
    readonly workerPubkey: string;
  }): string {
    this.#requireAuthenticated();
    const now = unixNow();
    const payload: AckPayload = {
      body: {
        commandMessageId: input.enrollment.messageId,
        outcome: "completed",
      },
      deploymentId: input.enrollment.deploymentId,
      expiresAt: now + 30,
      issuedAt: now,
      messageId: crypto.randomUUID(),
      sequence: 0,
      sessionId: input.enrollment.sessionId,
      type: "ack",
      version: 1,
    };
    const event = createRemoteEnvelope({
      payload,
      recipientPubkey: input.workerPubkey,
      senderSecretKey: this.#ownerSecretKey,
      workerPubkey: input.workerPubkey,
    });
    this.#send([
      "BRAP",
      "APPROVE",
      input.enrollment.deploymentId,
      input.workerPubkey,
      event,
    ]);
    return event.id;
  }

  public sendCommand(input: {
    readonly deploymentId: string;
    readonly workerPubkey: string;
    readonly body: CommandPayload["body"];
  }): string {
    return this.#sendCommand(input, crypto.randomUUID());
  }

  public sendCommandAndWait(
    input: {
      readonly deploymentId: string;
      readonly workerPubkey: string;
      readonly body: CommandPayload["body"];
    },
    timeoutMilliseconds = 60_000,
  ): Promise<AckPayload> {
    if (
      !Number.isSafeInteger(timeoutMilliseconds) ||
      timeoutMilliseconds < 1_000 ||
      timeoutMilliseconds > 10 * 60_000
    ) {
      throw new RangeError("command timeout must be between 1 and 600 seconds");
    }
    const messageId = crypto.randomUUID();
    return new Promise<AckPayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingCommands.delete(messageId);
        reject(new Error("remote worker acknowledgement timed out"));
      }, timeoutMilliseconds);
      this.#pendingCommands.set(messageId, { reject, resolve, timeout });
      try {
        this.#sendCommand(input, messageId);
      } catch (error) {
        clearTimeout(timeout);
        this.#pendingCommands.delete(messageId);
        reject(error instanceof Error ? error : new Error("command failed"));
      }
    });
  }

  #sendCommand(
    input: {
      readonly deploymentId: string;
      readonly workerPubkey: string;
      readonly body: CommandPayload["body"];
    },
    messageId: string,
  ): string {
    this.#requireAuthenticated();
    const now = unixNow();
    const session = this.#requireSession(input.workerPubkey);
    if (session.deploymentId !== input.deploymentId) {
      throw new Error(
        "remote deployment does not match the active worker session",
      );
    }
    const payload: CommandPayload = {
      body: input.body,
      deploymentId: input.deploymentId,
      expiresAt: now + 30,
      issuedAt: now,
      messageId,
      sequence: this.#nextCommandSequence(input.workerPubkey),
      sessionId: session.sessionId,
      type: "command",
      version: 1,
    };
    const event = createRemoteEnvelope({
      payload,
      recipientPubkey: input.workerPubkey,
      senderSecretKey: this.#ownerSecretKey,
      workerPubkey: input.workerPubkey,
    });
    this.#send(
      input.body.action === "revoke"
        ? ["BRAP", "REVOKE", input.workerPubkey, event]
        : ["EVENT", event],
    );
    return messageId;
  }

  #handleMessage(raw: unknown): void {
    let message: unknown;
    try {
      const encoded =
        typeof raw === "string"
          ? raw
          : raw instanceof ArrayBuffer
            ? new TextDecoder().decode(raw)
            : String(raw);
      if (new TextEncoder().encode(encoded).length > 256 * 1024) return;
      message = JSON.parse(encoded) as unknown;
    } catch {
      return;
    }
    if (!Array.isArray(message)) return;
    if (message[0] === "AUTH" && typeof message[1] === "string") {
      const event = signNostrEvent(
        {
          content: "",
          created_at: unixNow(),
          kind: KIND_AUTH,
          tags: [
            ["relay", this.#relayUrl.toString()],
            ["challenge", message[1]],
          ],
        },
        this.#ownerSecretKey,
      );
      this.#authEventId = event.id;
      this.#send(["AUTH", event]);
      return;
    }
    if (
      message[0] === "OK" &&
      message[1] === this.#authEventId &&
      message[2] === true
    ) {
      this.#authenticated = true;
      this.#send([
        "REQ",
        "brap-owner",
        {
          "#p": [this.#ownerPubkey],
          kinds: [
            KIND_REMOTE_AGENT_ENROLLMENT,
            KIND_REMOTE_AGENT_STATUS,
            KIND_REMOTE_AGENT_ACK,
          ],
        },
      ]);
      this.#emit({ type: "connected" });
      return;
    }
    if (message[0] === "EVENT" && message[2]) {
      this.#handleEvent(message[2]);
    }
  }

  #handleEvent(value: unknown): void {
    try {
      if (!verifyNostrEvent(value)) throw new Error("invalid remote event");
      const workerPubkey = singleTag(value, "worker");
      const payload = openRemoteEnvelope({
        event: value,
        expectedSenderPubkey: workerPubkey,
        expectedWorkerPubkey: workerPubkey,
        recipientPubkey: this.#ownerPubkey,
        recipientSecretKey: this.#ownerSecretKey,
        replayGuard: this.#replay,
      });
      if (payload.type === "enrollment") {
        if (
          payload.body.ownerPubkey !== this.#ownerPubkey ||
          payload.body.workerPubkey !== workerPubkey
        ) {
          throw new Error("enrollment binding does not match");
        }
        this.#emit({ event: value, payload, type: "enrollment" });
      } else if (payload.type === "status") {
        if (
          payload.body.state === "hello" &&
          payload.body.challenge &&
          payload.body.capabilities
        ) {
          this.#acceptHello(workerPubkey, payload);
        }
        this.#emit({ event: value, payload, type: "status" });
      } else if (payload.type === "ack") {
        const pending = this.#pendingCommands.get(
          payload.body.commandMessageId,
        );
        if (pending) {
          clearTimeout(pending.timeout);
          this.#pendingCommands.delete(payload.body.commandMessageId);
          if (payload.body.outcome === "rejected") {
            pending.reject(
              new Error(
                payload.body.message ??
                  payload.body.code ??
                  "remote command was rejected",
              ),
            );
          } else if (payload.body.outcome === "completed") {
            pending.resolve(payload);
          }
        }
        this.#emit({ event: value, payload, type: payload.type });
      }
    } catch (error) {
      this.#emit({
        error:
          error instanceof Error ? error : new Error("invalid remote event"),
        type: "error",
      });
    }
  }

  #acceptHello(workerPubkey: string, status: StatusPayload): void {
    const challenge = status.body.challenge;
    if (!challenge) throw new Error("remote hello challenge is missing");
    this.#sessions.set(workerPubkey, {
      deploymentId: status.deploymentId,
      nextSequence: 1,
      sessionId: status.sessionId,
    });
    const now = unixNow();
    const payload: AckPayload = {
      body: {
        challenge,
        commandMessageId: status.messageId,
        outcome: "completed",
      },
      deploymentId: status.deploymentId,
      expiresAt: now + 30,
      issuedAt: now,
      messageId: crypto.randomUUID(),
      sequence: 0,
      sessionId: status.sessionId,
      type: "ack",
      version: 1,
    };
    this.#send([
      "EVENT",
      createRemoteEnvelope({
        payload,
        recipientPubkey: workerPubkey,
        senderSecretKey: this.#ownerSecretKey,
        workerPubkey,
      }),
    ]);
  }

  #requireSession(workerPubkey: string): {
    readonly deploymentId: string;
    readonly sessionId: string;
    nextSequence: number;
  } {
    const session = this.#sessions.get(workerPubkey);
    if (!session) {
      throw new Error(
        "remote worker has not completed its secure session hello",
      );
    }
    return session;
  }

  #nextCommandSequence(workerPubkey: string): number {
    const session = this.#requireSession(workerPubkey);
    const sequence = session.nextSequence;
    session.nextSequence += 1;
    return sequence;
  }

  #requireAuthenticated(): void {
    if (!this.#authenticated) {
      throw new Error("owner connection is not authenticated");
    }
  }

  #send(message: unknown[]): void {
    if (this.#socket?.readyState !== 1) {
      throw new Error("relay connection is not open");
    }
    this.#socket.send(JSON.stringify(message));
  }

  #emit(event: OwnerConnectionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

function singleTag(event: NostrEvent, name: string): string {
  const values = event.tags.filter((tag) => tag[0] === name);
  if (values.length !== 1 || values[0]?.length !== 2 || !values[0][1]) {
    throw new Error(`remote event has invalid ${name} binding`);
  }
  return values[0][1];
}
