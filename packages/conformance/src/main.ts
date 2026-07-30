#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { checkTrace, parseJsonLines } from "./index.js";

const [file, ...required] = process.argv.slice(2);
if (!file) {
  process.stderr.write(
    "Usage: buzz-conformance-ts TRACE.jsonl [required_action ...]\n",
  );
  process.exitCode = 2;
} else {
  try {
    const trace = parseJsonLines(await readFile(file, "utf8"));
    checkTrace({ trace, requiredCriticalActions: new Set(required) });
    process.stdout.write(`conformant: ${trace.length} trace steps\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
