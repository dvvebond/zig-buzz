import {
  PairingError,
  PairingSession,
  decodePairingQr,
  encodePairingQr,
  type PayloadType,
} from "@buzz/pairing";

import { PairingRelayClient } from "./relay-client.js";

export type SasConfirmation = (sas: string) => boolean | Promise<boolean>;

export type SourceFlowOptions = {
  readonly relay: string;
  readonly payload: string;
  readonly payloadType: PayloadType;
  readonly confirmSas: SasConfirmation;
  readonly onQr: (uri: string) => void | Promise<void>;
  readonly timeoutMilliseconds?: number;
};

export type TargetFlowOptions = {
  readonly qrUri: string;
  readonly relayOverride?: string;
  readonly onSas?: (sas: string) => void | Promise<void>;
  readonly confirmSas: SasConfirmation;
  readonly timeoutMilliseconds?: number;
};

export async function runSourceFlow(options: SourceFlowOptions): Promise<void> {
  const timeout = options.timeoutMilliseconds ?? 120_000;
  const { qr, session } = PairingSession.source(options.relay, timeout);
  const client = new PairingRelayClient(options.relay, session.pubkey);
  try {
    await client.connect(Math.min(timeout, 10_000));
    await options.onQr(encodePairingQr(qr));
    const sas = await nextAccepted(client, timeout, (event) =>
      session.handleOffer(event),
    );
    if (!(await options.confirmSas(sas))) {
      const abort = session.abort("sas_mismatch");
      if (abort) await client.publish(abort);
      throw new PairingError("TRANSCRIPT_MISMATCH", "SAS was rejected");
    }
    await client.publish(session.confirmSas());
    await client.publish(
      session.sendPayload(options.payloadType, options.payload),
    );
    await nextAccepted(client, timeout, (event) => {
      rejectPeerAbort(session, event);
      session.handleComplete(event);
      return undefined;
    });
  } finally {
    client.close();
    session.dispose();
    qr.sessionSecret.fill(0);
  }
}

export async function runTargetFlow(
  options: TargetFlowOptions,
): Promise<{ readonly payload: string; readonly type: PayloadType }> {
  const timeout = options.timeoutMilliseconds ?? 120_000;
  const decoded = decodePairingQr(options.qrUri);
  const qr =
    options.relayOverride === undefined
      ? decoded
      : { ...decoded, relays: [options.relayOverride] };
  const relay = qr.relays[0];
  if (!relay) throw new Error("pairing QR has no relay");
  const { offer, session } = PairingSession.target(qr, timeout);
  const client = new PairingRelayClient(relay, session.pubkey);
  try {
    const initialSas = session.sasCode;
    if (!initialSas) throw new Error("target could not derive a SAS");
    await options.onSas?.(initialSas);
    await client.connect(Math.min(timeout, 10_000));
    await client.publish(offer);
    await nextAccepted(client, timeout, (event) => {
      rejectPeerAbort(session, event);
      return session.handleSasConfirm(event);
    });
    const sas = session.sasCode;
    if (!sas || !(await options.confirmSas(sas))) {
      const abort = session.abort("sas_mismatch");
      if (abort) await client.publish(abort);
      throw new PairingError("TRANSCRIPT_MISMATCH", "SAS was rejected");
    }
    session.confirmTargetSas();
    const payload = await nextAccepted(client, timeout, (event) =>
      session.handlePayload(event),
    );
    await client.publish(session.sendComplete());
    return payload;
  } finally {
    client.close();
    session.dispose();
    decoded.sessionSecret.fill(0);
  }
}

function rejectPeerAbort(
  session: PairingSession,
  event: Awaited<ReturnType<PairingRelayClient["nextEvent"]>>,
): void {
  try {
    const reason = session.handleAbort(event);
    throw new PeerAbortError(`pairing peer aborted: ${reason}`);
  } catch (error) {
    if (error instanceof PeerAbortError) throw error;
    if (error instanceof PairingError && error.code === "TRANSCRIPT_MISMATCH") {
      throw error;
    }
  }
}

async function nextAccepted<T>(
  client: PairingRelayClient,
  timeoutMilliseconds: number,
  accept: (event: Awaited<ReturnType<PairingRelayClient["nextEvent"]>>) => T,
): Promise<T> {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const event = await client.nextEvent(remaining);
    try {
      return accept(event);
    } catch (error) {
      lastError = error;
      if (
        error instanceof PeerAbortError ||
        (error instanceof PairingError && error.code === "TRANSCRIPT_MISMATCH")
      ) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("timeout waiting for a valid pairing event");
}

class PeerAbortError extends Error {
  public override readonly name = "PeerAbortError";
}
