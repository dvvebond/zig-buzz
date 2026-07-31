import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE = "desktop-port.json";
const MIN_PORT = 1_024;
const MAX_PORT = 65_535;

/**
 * Remember the port the desktop host listened on.
 *
 * The UI keeps per-origin state in the browser — the active identity and
 * community among it — and `http://127.0.0.1:<port>` is that origin. Listening
 * on a fresh ephemeral port each launch therefore presented the user with an
 * empty app that looked like a first run, even though the host still held their
 * identity and agents. Reusing the previous port keeps the origin stable.
 *
 * This is a hint only: the caller falls back to an ephemeral port when the
 * remembered one is taken, and a missing or malformed file is not an error.
 */
export async function readRememberedPort(
  dataDirectory: string,
): Promise<number | undefined> {
  try {
    const raw = await readFile(path.join(dataDirectory, FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const port =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { port?: unknown }).port
        : undefined;
    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < MIN_PORT ||
      port > MAX_PORT
    ) {
      return undefined;
    }
    return port;
  } catch {
    return undefined;
  }
}

export async function rememberPort(
  dataDirectory: string,
  port: number,
): Promise<void> {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) return;
  await writeFile(
    path.join(dataDirectory, FILE),
    `${JSON.stringify({ port }, null, 2)}\n`,
    { mode: 0o600 },
  );
}
