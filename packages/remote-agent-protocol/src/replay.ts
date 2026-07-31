import { RemoteProtocolError } from "./errors.js";
import { SESSION_STATE_TTL_SECONDS } from "./schema.js";

export type ReplayCandidate = {
  readonly messageId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly expiresAt: number;
};

type SeenMessage = {
  readonly expiresAt: number;
};

/**
 * Bounded in-memory replay and ordering gate.
 *
 * Accepted message IDs are forgotten once they expire, because an expired
 * message is already rejected by the expiry check. A session's sequence
 * position is held for the longer replay window instead, so an idle session
 * cannot be restarted at sequence zero.
 *
 * Durable deployments should persist the last accepted session/sequence so a
 * worker restart cannot reopen an old session. This class deliberately mutates
 * state only after every check succeeds.
 */
export class ReplayGuard {
  readonly #seen = new Map<string, SeenMessage>();
  readonly #lastSequenceBySession = new Map<string, number>();
  readonly #sessionExpiresAt = new Map<string, number>();
  readonly #maxRememberedMessages: number;
  readonly #sessionTtlSeconds: number;

  public constructor(
    maxRememberedMessages = 10_000,
    sessionTtlSeconds = SESSION_STATE_TTL_SECONDS,
  ) {
    if (
      !Number.isSafeInteger(maxRememberedMessages) ||
      maxRememberedMessages < 1
    ) {
      throw new RangeError("maxRememberedMessages must be a positive integer");
    }
    if (!Number.isSafeInteger(sessionTtlSeconds) || sessionTtlSeconds < 1) {
      throw new RangeError("sessionTtlSeconds must be a positive integer");
    }
    this.#maxRememberedMessages = maxRememberedMessages;
    this.#sessionTtlSeconds = sessionTtlSeconds;
  }

  public accept(candidate: ReplayCandidate, now: number): void {
    this.#sweepExpired(now);

    if (candidate.expiresAt < now) {
      throw new RemoteProtocolError("MESSAGE_EXPIRED", "message has expired");
    }
    if (this.#seen.has(candidate.messageId)) {
      throw new RemoteProtocolError(
        "REPLAY_DETECTED",
        "message ID has already been accepted",
      );
    }

    const last = this.#lastSequenceBySession.get(candidate.sessionId) ?? -1;
    if (candidate.sequence !== last + 1) {
      throw new RemoteProtocolError(
        "SEQUENCE_INVALID",
        `expected sequence ${last + 1}`,
      );
    }
    if (this.#seen.size >= this.#maxRememberedMessages) {
      throw new RemoteProtocolError(
        "REPLAY_DETECTED",
        "replay window is at capacity",
      );
    }
    if (
      !this.#lastSequenceBySession.has(candidate.sessionId) &&
      this.#lastSequenceBySession.size >= this.#maxRememberedMessages
    ) {
      throw new RemoteProtocolError(
        "REPLAY_DETECTED",
        "session replay window is at capacity",
      );
    }

    this.#seen.set(candidate.messageId, {
      expiresAt: candidate.expiresAt,
    });
    this.#lastSequenceBySession.set(candidate.sessionId, candidate.sequence);
    this.#sessionExpiresAt.set(
      candidate.sessionId,
      now + this.#sessionTtlSeconds,
    );
  }

  public resetSession(sessionId: string): void {
    this.#lastSequenceBySession.delete(sessionId);
    this.#sessionExpiresAt.delete(sessionId);
  }

  #sweepExpired(now: number): void {
    for (const [messageId, seen] of this.#seen) {
      if (seen.expiresAt < now) this.#seen.delete(messageId);
    }
    for (const [sessionId, expiresAt] of this.#sessionExpiresAt) {
      if (expiresAt < now) {
        this.#sessionExpiresAt.delete(sessionId);
        this.#lastSequenceBySession.delete(sessionId);
      }
    }
  }
}
