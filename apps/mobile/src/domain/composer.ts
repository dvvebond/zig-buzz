import type { NostrTag } from "@buzz/core";

export type TextSelection = {
  readonly start: number;
  readonly end: number;
};

export type SelectedMention = {
  readonly token: string;
  readonly pubkey: string;
};

export function activeMentionQuery(content: string): string | undefined {
  return activeToken(content, /(?:^|\s)@([a-z0-9._-]{0,64})$/i);
}

export function activeEmojiQuery(content: string): string | undefined {
  return activeToken(content, /(?:^|\s):([a-z0-9_-]{0,64})$/i);
}

export function replaceActiveToken(
  content: string,
  marker: "@" | ":",
  replacement: string,
): string {
  const pattern =
    marker === "@" ? /(^|\s)@[a-z0-9._-]{0,64}$/i : /(^|\s):[a-z0-9_-]{0,64}$/i;
  return content.replace(
    pattern,
    (_, prefix: string) =>
      `${prefix}${marker}${replacement}${marker === ":" ? ":" : ""} `,
  );
}

export function applyMarkup(
  content: string,
  selection: TextSelection,
  prefix: string,
  suffix = prefix,
): { readonly content: string; readonly selection: TextSelection } {
  const start = Math.max(0, Math.min(selection.start, content.length));
  const end = Math.max(start, Math.min(selection.end, content.length));
  const selected = content.slice(start, end);
  const insert = `${prefix}${selected}${suffix}`;
  return {
    content: `${content.slice(0, start)}${insert}${content.slice(end)}`,
    selection: {
      end: start + prefix.length + selected.length,
      start: start + prefix.length,
    },
  };
}

export function buildMentionTags(
  content: string,
  mentions: readonly SelectedMention[],
): readonly NostrTag[] {
  const emitted = new Set<string>();
  const tags: NostrTag[] = [];
  for (const mention of mentions) {
    if (
      !/^[0-9a-f]{64}$/.test(mention.pubkey) ||
      !content.includes(`@${mention.token}`) ||
      emitted.has(mention.pubkey)
    ) {
      continue;
    }
    emitted.add(mention.pubkey);
    tags.push(["p", mention.pubkey]);
  }
  return tags;
}

function activeToken(content: string, pattern: RegExp): string | undefined {
  const match = content.match(pattern);
  return match?.[1]?.toLowerCase();
}
