/**
 * Parse the harness command line into a flag map.
 *
 * Every flag takes exactly one value. An empty string is a value: a runtime
 * that needs no extra arguments is launched as `--agent-args ""`, which the
 * caller reads back as the empty list.
 */
export function parseArguments(values: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index];
    if (!current?.startsWith("--")) {
      throw new Error(`unexpected argument ${current ?? ""}`);
    }
    const name = current.slice(2);
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${name}`);
    }
    parsed.set(name, value);
    index += 1;
  }
  return parsed;
}
