#!/usr/bin/env node
import { PairRelay } from "./relay.js";

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "5000");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("BUZZ_PAIR_RELAY_PORT must be an integer from 1 to 65535");
  }
  return port;
}

const relay = new PairRelay({
  host: process.env.BUZZ_PAIR_RELAY_HOST ?? "127.0.0.1",
  path: process.env.BUZZ_PAIR_RELAY_PATH ?? "/pair",
  port: parsePort(process.env.BUZZ_PAIR_RELAY_PORT),
});

try {
  const address = await relay.listen();
  process.stderr.write(`buzz-pair-relay listening on ${address.url}\n`);
} catch (error) {
  process.stderr.write(
    `fatal: ${error instanceof Error ? error.message : "pair relay failed"}\n`,
  );
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void relay.close().finally(() => {
      process.exitCode = 0;
    });
  });
}
