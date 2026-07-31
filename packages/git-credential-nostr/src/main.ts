#!/usr/bin/env node
import {
  canonicalRepositoryUrl,
  createNip98Credential,
  loadAuthTag,
  loadSecretKey,
  parseChallengeMethod,
  parseCredentialRequest,
} from "./index.js";

const operation = process.argv[2] ?? "get";
if (operation !== "get") process.exit(0);

let input = "";
for await (const chunk of process.stdin) {
  input += Buffer.from(chunk).toString("utf8");
  if (Buffer.byteLength(input) > 64 * 1024) {
    process.stderr.write("error: credential request exceeds 64 KiB\n");
    process.exit(1);
  }
}
const request = parseCredentialRequest(input);
if (!request.hasAuthtypeCapability) {
  process.stdout.write("\n");
  process.exit(0);
}
const method = request.wwwauth
  ? parseChallengeMethod(request.wwwauth)
  : undefined;
if (!request.wwwauth || !method) process.exit(0);

try {
  if (!request.protocol)
    throw new Error("missing protocol in credential request");
  if (!request.host) throw new Error("missing host in credential request");
  if (!request.path) {
    throw new Error("credential.useHttpPath must be true for NIP-98 auth");
  }
  const url = canonicalRepositoryUrl({
    protocol: request.protocol,
    host: request.host,
    path: request.path,
  });
  const authTag = loadAuthTag();
  const { credential } = createNip98Credential({
    secretKey: loadSecretKey(),
    url,
    method,
    ...(authTag ? { authTag } : {}),
  });
  process.stdout.write(
    [
      "capability[]=authtype",
      "authtype=Nostr",
      `credential=${credential}`,
      "ephemeral=true",
      "quit=true",
      "",
      "",
    ].join("\n"),
  );
} catch (error) {
  process.stderr.write(
    `error: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
