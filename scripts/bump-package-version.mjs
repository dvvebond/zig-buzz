#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [file, version] = process.argv.slice(2);
if (!file || !version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("usage: bump-package-version.mjs <package.json> <semver>");
}
const root = process.cwd();
const target = path.resolve(root, file);
const relative = path.relative(root, target);
if (relative.startsWith("..") || path.isAbsolute(relative)) {
  throw new Error("package path must remain inside the workspace");
}
const value = JSON.parse(await readFile(target, "utf8"));
value.version = version;
await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
