#!/usr/bin/env node
// Every script that compiles TypeScript must first build the workspace
// dependencies whose `dist/*.d.ts` it consumes. `pnpm -r <script>` hides this
// by running packages in topological order, so a package can look healthy in a
// full workspace run and still fail the moment CI builds it on its own from a
// clean checkout.
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPILING_SCRIPTS = ["build", "check", "typecheck"];
const FILTER_BUILD = /--filter\s+(@buzz\/[a-z0-9-]+)\s+build/g;

function manifestPaths() {
  return globSync(
    [
      "apps/*/package.json",
      "packages/*/package.json",
      "examples/*/package.json",
      "desktop/package.json",
      "web/package.json",
      "admin-web/package.json",
    ],
    { cwd: repoRoot },
  ).sort();
}

/** Collect @buzz packages a script builds, following one level of indirection. */
function builtBy(script, scripts, seen = new Set()) {
  const built = new Set(
    [...script.matchAll(FILTER_BUILD)].map((match) => match[1]),
  );
  for (const [name, body] of Object.entries(scripts)) {
    if (name === "build" || seen.has(name)) continue;
    if (!new RegExp(`\\bpnpm (?:run )?${name}\\b`).test(script)) continue;
    seen.add(name);
    for (const dependency of builtBy(body, scripts, seen))
      built.add(dependency);
  }
  return built;
}

const failures = [];
for (const relativePath of manifestPaths()) {
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, relativePath), "utf8"),
  );
  const scripts = manifest.scripts ?? {};
  const workspaceDependencies = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })
    .filter((name) => name.startsWith("@buzz/"))
    .sort();
  if (workspaceDependencies.length === 0) continue;

  for (const scriptName of COMPILING_SCRIPTS) {
    const script = scripts[scriptName];
    if (!script?.includes("tsc")) continue;
    const built = builtBy(script, scripts);
    const missing = workspaceDependencies.filter((name) => !built.has(name));
    if (missing.length > 0) {
      failures.push({
        missing,
        package: relativePath.replace("/package.json", ""),
        script: scriptName,
      });
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    "Scripts that compile TypeScript without building a workspace dependency.\n" +
      "Add `pnpm --filter <dependency> build &&` (or extend a build:deps script)\n" +
      "so a clean checkout can build the package on its own:\n\n",
  );
  for (const failure of failures) {
    process.stderr.write(
      `  ${failure.package} (${failure.script}) is missing: ${failure.missing.join(", ")}\n`,
    );
  }
  process.exit(1);
}

process.stdout.write(
  "build order: every TypeScript compile builds its workspace dependencies\n",
);
