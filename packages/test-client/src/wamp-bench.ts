#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { BuzzTestClient } from "./index.js";

const [channelId, qpsRaw, durationRaw, connectionsRaw, latencyFile] =
  process.argv.slice(2);
const qps = Number(qpsRaw);
const durationSeconds = Number(durationRaw);
const connections = Number(connectionsRaw);
const keyHex = process.env.BENCH_PRIVATE_KEY;
if (
  !channelId ||
  !latencyFile ||
  !Number.isFinite(qps) ||
  qps <= 0 ||
  !Number.isSafeInteger(durationSeconds) ||
  durationSeconds <= 0 ||
  !Number.isSafeInteger(connections) ||
  connections <= 0 ||
  !keyHex ||
  !/^[0-9a-f]{64}$/.test(keyHex)
) {
  throw new Error(
    "Usage: buzz-wamp-bench-ts <channel_uuid> <qps> <duration_secs> <conns> <latency_out>; BENCH_PRIVATE_KEY is required",
  );
}
const secretKey = Uint8Array.from(Buffer.from(keyHex, "hex"));
const deadline = performance.now() + durationSeconds * 1_000;
const perConnectionDelay = (connections / qps) * 1_000;
const relayUrl = process.env.BUZZ_RELAY_URL ?? "ws://localhost:3000";
const results = await Promise.all(
  Array.from({ length: connections }, async (_, connectionIndex) => {
    const client = await BuzzTestClient.connect(relayUrl, secretKey, {
      allowInsecureLocalhost: true,
    });
    const latencies: number[] = [];
    let sent = 0;
    let rejected = 0;
    while (performance.now() < deadline) {
      const started = performance.now();
      const response = await client.sendTextMessage({
        secretKey,
        channelId,
        content: `wamp-bench c${connectionIndex} m${sent + 1} payload: the quick brown fox jumps over the lazy dog 0123456789`,
      });
      sent += 1;
      if (response.accepted) latencies.push(performance.now() - started);
      else rejected += 1;
      const remaining = perConnectionDelay - (performance.now() - started);
      if (remaining > 0)
        await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    client.disconnect();
    return { latencies, rejected, sent };
  }),
);
const latencies = results
  .flatMap((result) => result.latencies)
  .sort((a, b) => a - b);
const sent = results.reduce((sum, result) => sum + result.sent, 0);
const rejected = results.reduce((sum, result) => sum + result.rejected, 0);
const percentile = (p: number): number | null => {
  if (latencies.length === 0) return null;
  return latencies[Math.round((latencies.length - 1) * p)] ?? null;
};
await writeFile(
  latencyFile,
  latencies.map((value) => value.toFixed(3)).join("\n") + "\n",
  {
    mode: 0o600,
  },
);
process.stdout.write(
  `${JSON.stringify({
    sent,
    accepted: sent - rejected,
    rejected,
    qps_target: qps,
    duration_secs: durationSeconds,
    conns: connections,
    ok_latency_ms: {
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: latencies.at(-1) ?? null,
    },
  })}\n`,
);
