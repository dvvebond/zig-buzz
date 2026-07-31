import {
  signNostrEvent,
  unixNow,
  type NostrEvent,
  type NostrFilter,
} from "@buzz/core";
import {
  AuthenticatedRelayClient,
  type RelayClientEvent,
  type RelaySocket,
  type RelaySubscription,
} from "@buzz/ws-client";
import WebSocket from "ws";

export interface OkResponse {
  readonly eventId: string;
  readonly accepted: boolean;
  readonly message: string;
}

export class BuzzTestClient {
  readonly #client: AuthenticatedRelayClient;
  readonly #listeners = new Set<(event: RelayClientEvent) => void>();
  readonly #unlisten: () => void;

  private constructor(
    relayUrl: string,
    secretKey: Uint8Array,
    allowInsecureLocalhost: boolean,
  ) {
    this.#client = new AuthenticatedRelayClient({
      relayUrl,
      secretKey,
      allowInsecureLocalhost,
      socketFactory: (url) => new WebSocket(url) as unknown as RelaySocket,
    });
    this.#unlisten = this.#client.on((event) => {
      for (const listener of this.#listeners) listener(event);
    });
  }

  public static async connect(
    relayUrl: string,
    secretKey: Uint8Array,
    options: { readonly allowInsecureLocalhost?: boolean } = {},
  ): Promise<BuzzTestClient> {
    const client = new BuzzTestClient(
      relayUrl,
      secretKey,
      options.allowInsecureLocalhost ?? false,
    );
    await client.#client.connect();
    return client;
  }

  public on(listener: (event: RelayClientEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async sendEvent(event: NostrEvent): Promise<OkResponse> {
    try {
      const message = await this.#client.publish(event);
      return { eventId: event.id, accepted: true, message };
    } catch (error) {
      return {
        eventId: event.id,
        accepted: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  public async sendTextMessage(input: {
    readonly secretKey: Uint8Array;
    readonly channelId: string;
    readonly content: string;
    readonly kind?: number;
    readonly tags?: readonly string[][];
  }): Promise<OkResponse> {
    const event = signNostrEvent(
      {
        kind: input.kind ?? 9,
        created_at: unixNow(),
        content: input.content,
        tags: [["h", input.channelId], ...(input.tags ?? [])],
      },
      input.secretKey,
    );
    return await this.sendEvent(event);
  }

  public subscribe(
    filters: readonly NostrFilter[],
    id?: string,
  ): RelaySubscription {
    return this.#client.subscribe(filters, id);
  }

  public collectUntilEose(
    filters: readonly NostrFilter[],
    timeoutMs = 15_000,
    id = crypto.randomUUID(),
  ): Promise<NostrEvent[]> {
    const events: NostrEvent[] = [];
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("timeout waiting for EOSE"));
      }, timeoutMs);
      let subscription: RelaySubscription | undefined;
      const unlisten = this.on((event) => {
        if (event.type === "event" && event.subscriptionId === id) {
          events.push(event.event);
        } else if (event.type === "eose" && event.subscriptionId === id) {
          cleanup();
          resolve(events);
        } else if (event.type === "disconnected") {
          cleanup();
          reject(new Error("relay disconnected before EOSE"));
        }
      });
      const cleanup = (): void => {
        clearTimeout(timeout);
        unlisten();
        subscription?.close();
      };
      subscription = this.subscribe(filters, id);
    });
  }

  public disconnect(): void {
    this.#unlisten();
    this.#listeners.clear();
    this.#client.close();
  }
}
