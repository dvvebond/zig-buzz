#!/usr/bin/env node
/**
 * Loopback TCP forwarder for a Harbor task container.
 *
 * Agents dial the relay's canonical localhost authority so the tenant-bound
 * Host header remains correct. This process forwards the byte stream to the
 * Docker-host gateway without interpreting WebSocket or Git traffic.
 */
import net from "node:net";

const [listenValue, targetValue, ...extra] = process.argv.slice(2);
if (!listenValue || !targetValue || extra.length > 0) {
  process.stderr.write(
    "usage: relay-forwarder <listen-host:port> <target-host:port>\n",
  );
  process.exit(2);
}

const listen = parseAuthority(listenValue, "listen");
const target = parseAuthority(targetValue, "target");
const server = net.createServer((client) => {
  client.setNoDelay(true);
  const upstream = net.createConnection(target);
  upstream.setNoDelay(true);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});
server.on("error", (error) => {
  process.stderr.write(`relay-forwarder failed: ${error.message}\n`);
  process.exitCode = 1;
});
server.listen(listen, () => {
  process.stdout.write(
    `forwarding ${formatAuthority(listen)} -> ${formatAuthority(target)}\n`,
  );
});

const close = (): void => server.close(() => process.exit(0));
process.once("SIGINT", close);
process.once("SIGTERM", close);

function parseAuthority(
  value: string,
  label: string,
): { host: string; port: number } {
  let url: URL;
  try {
    url = new URL(`tcp://${value}`);
  } catch {
    throw new Error(`${label} authority is invalid`);
  }
  const port = Number(url.port);
  if (
    url.username ||
    url.password ||
    url.pathname !== "" ||
    url.search ||
    url.hash ||
    !url.hostname ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(`${label} authority must be host:port`);
  }
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
}

function formatAuthority(value: { host: string; port: number }): string {
  return `${value.host.includes(":") ? `[${value.host}]` : value.host}:${value.port}`;
}
