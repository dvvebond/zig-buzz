export type NostrTag = string[];

export type UnsignedNostrEvent = {
  readonly kind: number;
  readonly created_at: number;
  readonly tags: NostrTag[];
  readonly content: string;
  readonly pubkey?: string;
};

export type NostrEvent = {
  readonly id: string;
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: NostrTag[];
  readonly content: string;
  readonly sig: string;
};

export type NostrFilter = {
  readonly ids?: readonly string[];
  readonly authors?: readonly string[];
  readonly kinds?: readonly number[];
  readonly since?: number;
  readonly until?: number;
  /** Buzz bridge extension: composite keyset tiebreak paired with `until`. */
  readonly before_id?: string;
  /** Buzz bridge extension: request only channel-window timeline rows. */
  readonly top_level?: boolean;
  /** Buzz bridge extension: include reactions, edits, and deletion closure. */
  readonly include_aux?: boolean;
  /** Buzz bridge extension: include relay-signed thread summary overlays. */
  readonly include_summaries?: boolean;
  readonly limit?: number;
  readonly search?: string;
  readonly [tagName: `#${string}`]: readonly string[] | undefined;
};
