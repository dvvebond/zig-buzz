import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version) {
  console.error("Usage: node scripts/set-version-from-tag.mjs <version>");
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid semver version: ${version}`);
  process.exit(1);
}

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
for (const packagePath of [
  path.join(desktopRoot, "package.json"),
  path.join(desktopRoot, "../apps/desktop-host/package.json"),
]) {
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  packageJson.version = version;
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  console.log(`Set ${packagePath} to ${version}`);
}
