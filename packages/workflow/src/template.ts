import { nip19 } from "nostr-tools";

import type { TriggerContext } from "./types.js";

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function resolveTemplate(
  template: string,
  trigger: TriggerContext,
  stepOutputs: Readonly<Record<string, unknown>>,
): string {
  return template.replace(TEMPLATE, (literal, rawExpression: string) => {
    const [rawPath, rawFilter, ...extra] = rawExpression.split("|");
    if (extra.length > 0 || !rawPath) return literal;
    const value = resolveVariable(rawPath.trim(), trigger, stepOutputs);
    if (value === undefined) return literal;
    return applyTemplateFilter(value, rawFilter?.trim());
  });
}

export function resolveVariable(
  path: string,
  trigger: TriggerContext,
  stepOutputs: Readonly<Record<string, unknown>>,
): string | undefined {
  if (path.startsWith("trigger.")) {
    const field = path.slice("trigger.".length);
    const standard: Readonly<Record<string, string>> = {
      author: trigger.author,
      channel_id: trigger.channelId,
      emoji: trigger.emoji,
      message_id: trigger.messageId,
      text: trigger.text,
      timestamp: String(trigger.timestamp),
    };
    return standard[field] ?? trigger.webhookFields[field];
  }
  const match = /^steps\.([A-Za-z0-9_]+)\.output\.([A-Za-z0-9_]+)$/.exec(path);
  if (!match?.[1] || !match[2]) return undefined;
  const output = stepOutputs[match[1]];
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return undefined;
  }
  const value = (output as Record<string, unknown>)[match[2]];
  return scalarString(value);
}

function applyTemplateFilter(
  value: string,
  filter: string | undefined,
): string {
  if (!filter) return value;
  const truncate = /^truncate\(\s*([0-9]+)\s*\)$/.exec(filter);
  if (truncate?.[1]) return [...value].slice(0, Number(truncate[1])).join("");
  if (filter === "npub" || filter === "truncate_pubkey") {
    return /^[0-9a-f]{64}$/.test(value) ? nip19.npubEncode(value) : value;
  }
  throw new TemplateResolutionError(`unknown template filter: ${filter}`);
}

function scalarString(value: unknown): string | undefined {
  if (value === null) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return undefined;
}

export class TemplateResolutionError extends Error {
  public override readonly name = "TemplateResolutionError";
}
