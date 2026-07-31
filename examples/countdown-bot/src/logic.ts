import type { NostrEvent } from "@buzz/core";

const HELP = "Please use a number from 1 to 100.";

export function commandReply(content: string): string | undefined {
  const [command, count] = content.trim().split(/\s+/, 3);
  if (command === "!countdown") return countdownReply(count);
  if (command === "!fib") return fibonacciReply(count);
  return undefined;
}

export function mentionCommandReply(content: string): string | undefined {
  const tokens = content.trim().split(/\s+/);
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const command = tokens[index];
    const count = tokens[index + 1];
    if (command === "countdown") return countdownReply(count);
    if (command === "fib") return fibonacciReply(count);
  }
  return undefined;
}

export function eventMentionsPubkey(
  event: NostrEvent,
  pubkey: string,
): boolean {
  return event.tags.some(
    (tag) => tag[0] === "p" && tag[1]?.toLowerCase() === pubkey.toLowerCase(),
  );
}

function countdownReply(raw: string | undefined): string {
  const count = parseBounded(raw);
  if (count === undefined) return HELP;
  return [
    ...Array.from({ length: count }, (_, index) => String(count - index)),
    "🚀",
  ].join(" ");
}

function fibonacciReply(raw: string | undefined): string {
  const count = parseBounded(raw);
  if (count === undefined) return HELP;
  const values: bigint[] = [];
  let a = 0n;
  let b = 1n;
  for (let index = 0; index < count; index += 1) {
    values.push(a);
    [a, b] = [b, a + b];
  }
  return values.reverse().map(String).join(" ");
}

function parseBounded(raw: string | undefined): number | undefined {
  if (!raw || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(raw)) return undefined;
  return Number(raw);
}
