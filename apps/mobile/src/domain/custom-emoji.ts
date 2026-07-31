import type { NostrEvent, NostrTag } from "@buzz/core";

export type CustomEmoji = {
  readonly shortcode: string;
  readonly url: string;
};

export const CUSTOM_EMOJI_SET_D_TAG = "buzz:custom-emoji";

export function normalizeShortcode(value: string): string | undefined {
  const normalized = value
    .trim()
    .replace(/^:+|:+$/g, "")
    .toLowerCase();
  return /^[a-z0-9_-]+$/.test(normalized) ? normalized : undefined;
}

export function customEmojiFromTags(
  tags: readonly NostrTag[],
): readonly CustomEmoji[] {
  const byShortcode = new Map<string, CustomEmoji>();
  for (const tag of tags) {
    if (tag[0] !== "emoji") continue;
    const shortcode = normalizeShortcode(tag[1] ?? "");
    const url = safeImageUrl(tag[2]);
    if (shortcode && url && !byShortcode.has(shortcode)) {
      byShortcode.set(shortcode, { shortcode, url });
    }
  }
  return [...byShortcode.values()];
}

export function unionCustomEmoji(
  events: readonly NostrEvent[],
): readonly CustomEmoji[] {
  const winners = new Map<
    string,
    { readonly createdAt: number; readonly url: string }
  >();
  for (const event of events) {
    for (const emoji of customEmojiFromTags(event.tags)) {
      const winner = winners.get(emoji.shortcode);
      if (
        !winner ||
        event.created_at > winner.createdAt ||
        (event.created_at === winner.createdAt && emoji.url < winner.url)
      ) {
        winners.set(emoji.shortcode, {
          createdAt: event.created_at,
          url: emoji.url,
        });
      }
    }
  }
  return [...winners]
    .map(([shortcode, value]) => ({ shortcode, url: value.url }))
    .sort((left, right) => left.shortcode.localeCompare(right.shortcode));
}

export function buildCustomEmojiTags(
  content: string,
  palette: readonly CustomEmoji[],
): readonly NostrTag[] {
  const byShortcode = new Map(
    palette.map((emoji) => [emoji.shortcode, emoji.url]),
  );
  const emitted = new Set<string>();
  const tags: NostrTag[] = [];
  for (const match of content.matchAll(/:([a-z0-9_-]+):/gi)) {
    const shortcode = match[1]?.toLowerCase();
    if (!shortcode || emitted.has(shortcode)) continue;
    const url = byShortcode.get(shortcode);
    if (!url) continue;
    emitted.add(shortcode);
    tags.push(["emoji", shortcode, url]);
  }
  return tags;
}

export function emojiUrlFromTags(
  shortcode: string,
  tags: readonly NostrTag[],
): string | undefined {
  const normalized = normalizeShortcode(shortcode);
  if (!normalized) return undefined;
  return customEmojiFromTags(tags).find(
    (emoji) => emoji.shortcode === normalized,
  )?.url;
}

function safeImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
