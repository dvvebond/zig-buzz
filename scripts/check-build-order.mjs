#!/usr/bin/env node
// Every script that compiles or runs TypeScript must first build the workspace
// dependencies it resolves: `tsc` needs their `dist/*.d.ts`, and vitest needs
// the entry named by their package `exports`. `pnpm -r <script>` hides this by
// running packages in topological order, but ordering only sequences scripts —
// it never builds anything a script did not ask for. So a package can look
// healthy in a full workspace run and still fail the moment CI runs it from a
// clean checkout.
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// `build`, `check`, and `typecheck` must each stand alone, because CI runs them
// per package. A bare `test` is the one exception: it assumes an already-built
// workspace, so the root runner builds once in topological order instead of
// every package rebuilding its own dependency chain. That assumption is only
// safe while the runner really does build first, which is asserted below.
const SELF_CONTAINED_SCRIPTS = ["build", "check", "typecheck"];
const RESOLVES_WORKSPACE = /\b(?:tsc|vitest)\b/;
const FILTER_BUILD = /--filter\s+(@buzz\/[a-z0-9-]+)\s+build/g;
const TEST_RUNNER_SCRIPT = "test:typescript";
const TEST_RUNNER_MUST_BUILD = "build:typescript";

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

  for (const scriptName of SELF_CONTAINED_SCRIPTS) {
    const script = scripts[scriptName];
    if (!script || !RESOLVES_WORKSPACE.test(script)) continue;
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
    "Scripts that resolve a workspace dependency without building it.\n" +
      "Add `pnpm --filter <dependency> build &&` (or extend a build:deps script)\n" +
      "so a clean checkout can run the package on its own:\n\n",
  );
  for (const failure of failures) {
    process.stderr.write(
      `  ${failure.package} (${failure.script}) is missing: ${failure.missing.join(", ")}\n`,
    );
  }
  process.exit(1);
}

// Per-package `test` scripts are allowed to skip dependency builds only because
// the root runner builds the workspace first. Without this the whole suite fails
// on a clean checkout at whichever package resolves an unbuilt entry.
const rootScripts =
  JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).scripts ??
  {};
const runner = rootScripts[TEST_RUNNER_SCRIPT] ?? "";
if (!new RegExp(`\\bpnpm (?:run )?${TEST_RUNNER_MUST_BUILD}\\b`).test(runner)) {
  process.stderr.write(
    `Root "${TEST_RUNNER_SCRIPT}" must run "${TEST_RUNNER_MUST_BUILD}" first, because\n` +
      "per-package test scripts rely on the workspace already being built.\n",
  );
  process.exit(1);
}

process.stdout.write(
  "build order: self-contained builds/checks, and the test runner builds first\n",
);
