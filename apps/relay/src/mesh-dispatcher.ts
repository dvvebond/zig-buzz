import {
  type FencedHeader,
  type MeshInboundHandler,
  type MeshSessionStream,
  type SessionDirectory,
  type RuntimeId,
} from "@buzz/relay-mesh";

/** Tenant huddle consumer registered behind the deployment-wide mesh node. */
export interface HuddleMeshConsumer {
  onDatagram(
    from: RuntimeId,
    datagram: {
      readonly fenced: FencedHeader;
      readonly seq: bigint;
      readonly payload: Uint8Array;
    },
  ): Promise<void> | void;
  onSessionStream(
    from: RuntimeId,
    stream: MeshSessionStream,
  ): Promise<void> | void;
}

/**
 * Routes authenticated mesh application traffic after a durable Redis fence
 * check. A frame is accepted only on the owner pod or when sent by the owner.
 */
export class RelayMeshDispatcher implements MeshInboundHandler {
  readonly #huddles = new Map<string, HuddleMeshConsumer>();

  public constructor(
    private readonly directory: SessionDirectory,
    private readonly localRuntimeId: RuntimeId,
    private readonly demo?: {
      readonly communityId: string;
      readonly echo: boolean;
    },
  ) {}

  /** Register one live tenant backend and return its exact unregister handle. */
  public registerHuddle(
    communityId: string,
    consumer: HuddleMeshConsumer,
  ): () => void {
    if (this.#huddles.has(communityId)) {
      throw new Error("huddle mesh consumer is already registered");
    }
    this.#huddles.set(communityId, consumer);
    return () => {
      if (this.#huddles.get(communityId) === consumer) {
        this.#huddles.delete(communityId);
      }
    };
  }

  public async validateFence(
    fenced: FencedHeader,
    from: RuntimeId,
  ): Promise<boolean> {
    const verdict = await this.directory.validateFence(fenced);
    return (
      verdict.ok &&
      (fenced.ownerRuntimeId === this.localRuntimeId ||
        fenced.ownerRuntimeId === from)
    );
  }

  public async onDatagram(
    from: RuntimeId,
    datagram: {
      readonly fenced: FencedHeader;
      readonly seq: bigint;
      readonly payload: Uint8Array;
    },
  ): Promise<void> {
    await this.#huddles
      .get(datagram.fenced.communityId)
      ?.onDatagram(from, datagram);
  }

  public async onSessionStream(
    from: RuntimeId,
    stream: MeshSessionStream,
  ): Promise<void> {
    if (stream.profile === "huddle_control") {
      const consumer = this.#huddles.get(stream.fenced.communityId);
      if (!consumer) {
        stream.close("session_ended");
        return;
      }
      await consumer.onSessionStream(from, stream);
      return;
    }
    if (
      stream.profile !== "reliable_stream" ||
      !this.demo?.echo ||
      stream.fenced.communityId !== this.demo.communityId
    ) {
      stream.close("session_ended");
      return;
    }
    try {
      for await (const payload of stream) stream.send(payload);
    } finally {
      stream.close("session_ended");
    }
  }
}
