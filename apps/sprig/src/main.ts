#!/usr/bin/env node
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { personalityTarget, usage } from "./index.js";

const invoked = basename(process.argv[1] ?? "").replace(/\.(?:js|exe)$/i, "");
const explicit =
  invoked === "main" || invoked === "sprig" ? process.argv[2] : invoked;
if (!explicit || explicit === "-h" || explicit === "--help") {
  process.stdout.write(usage());
  process.exitCode = explicit ? 0 : 1;
} else if (explicit === "-V" || explicit === "--version") {
  process.stdout.write("sprig 0.1.0\n");
} else {
  const target = personalityTarget(explicit);
  if (!target) {
    process.stderr.write(
      `${usage()}\nUnknown Sprig personality: ${explicit}\n`,
    );
    process.exitCode = 1;
  } else {
    const forwarded =
      invoked === "main" || invoked === "sprig"
        ? process.argv.slice(3)
        : process.argv.slice(2);
    const child = spawn(process.execPath, [target, ...forwarded], {
      env: process.env,
      stdio: "inherit",
    });
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (value, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        resolve(value ?? 1);
      });
    });
    process.exitCode = code;
  }
}
