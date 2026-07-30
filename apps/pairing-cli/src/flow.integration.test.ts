import { PairRelay } from "@buzz/pair-relay";
import { afterEach, describe, expect, it } from "vitest";

import { runSourceFlow, runTargetFlow } from "./flow.js";

const relays: PairRelay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.close()));
});

describe("NIP-AB full transport", () => {
  it("transfers an encrypted payload over one socket per endpoint", async () => {
    const relay = new PairRelay({ port: 0 });
    relays.push(relay);
    const { url } = await relay.listen();
    let target:
      | Promise<{ readonly payload: string; readonly type: string }>
      | undefined;
    const source = runSourceFlow({
      confirmSas: async (sourceSas) => {
        const targetResult = targetSasPromise;
        expect(sourceSas).toBe(await targetResult);
        return true;
      },
      onQr(uri) {
        target = runTargetFlow({
          confirmSas: () => true,
          onSas: resolveTargetSas,
          qrUri: uri,
        });
      },
      payload: "top-secret-test-payload",
      payloadType: "custom",
      relay: url,
      timeoutMilliseconds: 10_000,
    });
    let resolveTargetSas!: (sas: string) => void;
    const targetSasPromise = new Promise<string>((resolve) => {
      resolveTargetSas = resolve;
    });
    await source;
    expect(target).toBeDefined();
    await expect(target).resolves.toEqual({
      payload: "top-secret-test-payload",
      type: "custom",
    });
  });

  it("aborts without transferring when either device rejects the SAS", async () => {
    const relay = new PairRelay({ port: 0 });
    relays.push(relay);
    const { url } = await relay.listen();
    let target: Promise<unknown> | undefined;
    const source = runSourceFlow({
      confirmSas: () => false,
      onQr(uri) {
        target = runTargetFlow({
          confirmSas: () => true,
          qrUri: uri,
          timeoutMilliseconds: 5_000,
        });
        void target.catch(() => undefined);
      },
      payload: "must-not-transfer",
      payloadType: "custom",
      relay: url,
      timeoutMilliseconds: 5_000,
    });
    await expect(source).rejects.toThrow(/SAS was rejected/);
    expect(target).toBeDefined();
    await expect(target).rejects.toThrow();
  }, 15_000);
});
