import { redactSensitiveText } from "@buzz/remote-agent-protocol";

/** Lines the harness marks for the user, e.g. `buzz-acp: <reason>`. */
const HARNESS_ERROR_LINE = /^buzz-acp:\s*(.+)$/;
const MAX_HARNESS_ERROR_LENGTH = 512;

/**
 * Decide whether a harness stderr line is a failure worth showing the user, and
 * return it redacted and bounded.
 *
 * The harness prefixes what it wants surfaced with `buzz-acp:`. Everything else
 * on stderr is noise from the underlying CLI: still logged, never promoted to
 * the agent's status. `buzz-acp ready` is progress, not a failure.
 */
export function promotableHarnessError(line: string): string | null {
  const match = HARNESS_ERROR_LINE.exec(line.trim());
  const reported = match?.[1]?.trim();
  if (!reported) return null;
  return redactSensitiveText(reported).slice(0, MAX_HARNESS_ERROR_LENGTH);
}
