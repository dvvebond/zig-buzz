import { validateEventShape, type NostrEvent } from "@buzz/core";
import WebSocket, { type RawData } from "ws";

const HEX_32 = /^[0-9a-f]{64}$/;

export class PairingRelayClient {
  readonly #url: string;
  readonly #recipient: string;
  readonly #queue: NostrEvent[] = [];
  readonly #acknowledgements = new Map<
    string,
    {
      readonly resolve: (value: void) => void;
      readonly reject: (reason: Error) => void;
      readonly timer: NodeJS.Timeout;
    }
  >();
  #socket: WebSocket | undefined;
  #eventWaiter:
    | {
        readonly resolve: (event: NostrEvent) => void;
        readonly reject: (reason: Error) => void;
        readonly timer: NodeJS.Timeout;
      }
    | undefined;
  #closedError: Error | undefined;

  public constructor(url: string, recipient: string) {
    const parsed = new URL(url);
    if (
      !["ws:", "wss:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      !HEX_32.test(recipient)
    ) {
      throw new Error("invalid pairing relay connection");
    }
    if (parsed.protocol === "ws:" && !isLoopback(parsed.hostname)) {
      throw new Error("unencrypted pairing relay is allowed only on loopback");
    }
    this.#url = url;
    this.#recipient = recipient;
  }

  public async connect(timeoutMilliseconds = 10_000): Promise<void> {
    if (this.#socket) throw new Error("pairing relay client already connected");
    const socket = new WebSocket(this.#url, {
      handshakeTimeout: timeoutMilliseconds,
      maxPayload: 4_096,
      perMessageDeflate: false,
    });
    this.#socket = socket;
    socket.on("message", (data, binary) => {
      if (binary) {
        this.#fail(new Error("pairing relay sent a binary frame"));
        socket.close(1003);
        return;
      }
      this.#message(data);
    });
    socket.once("close", () => {
      this.#fail(new Error("pairing relay connection closed"));
    });
    socket.once("error", (error) => {
      this.#fail(error);
    });
    await waitForOpen(socket, timeoutMilliseconds);
    const eose = this.#waitForControl("EOSE", timeoutMilliseconds);
    socket.send(
      JSON.stringify([
        "REQ",
        "pair",
        { "#p": [this.#recipient], kinds: [24_134] },
      ]),
    );
    await eose;
  }

  public async publish(
    event: NostrEvent,
    timeoutMilliseconds = 10_000,
  ): Promise<void> {
    const socket = this.#requiredSocket();
    if (this.#acknowledgements.has(event.id)) {
      throw new Error("event publication is already pending");
    }
    const acknowledgement = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#acknowledgements.delete(event.id);
        reject(new Error("pairing relay acknowledgement timed out"));
      }, timeoutMilliseconds);
      timer.unref();
      this.#acknowledgements.set(event.id, { reject, resolve, timer });
    });
    socket.send(JSON.stringify(["EVENT", event]));
    await acknowledgement;
  }

  public async nextEvent(timeoutMilliseconds: number): Promise<NostrEvent> {
    if (this.#closedError) throw this.#closedError;
    const queued = this.#queue.shift();
    if (queued) return queued;
    if (this.#eventWaiter) {
      throw new Error("only one pairing event consumer is supported");
    }
    return new Promise<NostrEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#eventWaiter = undefined;
        reject(new Error("timeout waiting for pairing peer"));
      }, timeoutMilliseconds);
      timer.unref();
      this.#eventWaiter = { reject, resolve, timer };
    });
  }

  public close(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(["CLOSE", "pair"]));
      socket.close(1000);
    } else {
      socket?.terminate();
    }
    this.#fail(new Error("pairing relay client closed"));
  }

  #message(data: RawData): void {
    let value: unknown;
    try {
      value = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!Array.isArray(value) || typeof value[0] !== "string") return;
    if (
      value[0] === "EVENT" &&
      value[1] === "pair" &&
      validateEventShape(value[2])
    ) {
      if (this.#eventWaiter) {
        const waiter = this.#eventWaiter;
        this.#eventWaiter = undefined;
        clearTimeout(waiter.timer);
        waiter.resolve(value[2]);
      } else if (this.#queue.length < 12) {
        this.#queue.push(value[2]);
      }
      return;
    }
    if (
      value[0] === "OK" &&
      typeof value[1] === "string" &&
      typeof value[2] === "boolean"
    ) {
      const acknowledgement = this.#acknowledgements.get(value[1]);
      if (!acknowledgement) return;
      this.#acknowledgements.delete(value[1]);
      clearTimeout(acknowledgement.timer);
      if (value[2]) acknowledgement.resolve();
      else
        acknowledgement.reject(
          new Error(
            `pairing relay rejected event: ${
              typeof value[3] === "string" ? value[3] : "unknown reason"
            }`,
          ),
        );
    }
  }

  async #waitForControl(
    type: "EOSE",
    timeoutMilliseconds: number,
  ): Promise<void> {
    const socket = this.#requiredSocket();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off("message", listener);
        reject(new Error(`timeout waiting for pairing relay ${type}`));
      }, timeoutMilliseconds);
      timer.unref();
      const listener = (data: RawData, binary: boolean): void => {
        if (binary) return;
        try {
          const message = JSON.parse(data.toString()) as unknown;
          if (
            Array.isArray(message) &&
            message[0] === type &&
            message[1] === "pair"
          ) {
            clearTimeout(timer);
            socket.off("message", listener);
            resolve();
          } else if (
            Array.isArray(message) &&
            message[0] === "CLOSED" &&
            message[1] === "pair"
          ) {
            clearTimeout(timer);
            socket.off("message", listener);
            reject(
              new Error(
                `pairing subscription rejected: ${String(message[2] ?? "")}`,
              ),
            );
          }
        } catch {
          // Ignore malformed control traffic; the bounded timeout still applies.
        }
      };
      socket.on("message", listener);
    });
  }

  #requiredSocket(): WebSocket {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
      throw this.#closedError ?? new Error("pairing relay is not connected");
    }
    return this.#socket;
  }

  #fail(error: Error): void {
    if (!this.#closedError) this.#closedError = error;
    if (this.#eventWaiter) {
      clearTimeout(this.#eventWaiter.timer);
      this.#eventWaiter.reject(error);
      this.#eventWaiter = undefined;
    }
    for (const acknowledgement of this.#acknowledgements.values()) {
      clearTimeout(acknowledgement.timer);
      acknowledgement.reject(error);
    }
    this.#acknowledgements.clear();
  }
}

function waitForOpen(
  socket: WebSocket,
  timeoutMilliseconds: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.terminate();
      reject(new Error("pairing relay connection timed out"));
    }, timeoutMilliseconds);
    timer.unref();
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}
