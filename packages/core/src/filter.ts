import type { NostrEvent, NostrFilter } from "./types.js";

const STANDARD_FILTER_KEYS = new Set([
  "ids",
  "authors",
  "kinds",
  "since",
  "until",
  "before_id",
  "top_level",
  "include_aux",
  "include_summaries",
  "limit",
  "search",
]);

export function eventMatchesFilter(
  event: NostrEvent,
  filter: NostrFilter,
): boolean {
  if (filter.ids && !matchesPrefix(event.id, filter.ids)) return false;
  if (filter.authors && !matchesPrefix(event.pubkey, filter.authors)) {
    return false;
  }
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since)
    return false;
  if (filter.until !== undefined && event.created_at > filter.until)
    return false;
  if (
    filter.before_id !== undefined &&
    filter.until !== undefined &&
    event.created_at === filter.until &&
    event.id <= filter.before_id
  ) {
    return false;
  }

  for (const [key, rawValues] of Object.entries(filter)) {
    if (STANDARD_FILTER_KEYS.has(key) || !key.startsWith("#")) continue;
    if (!rawValues || !Array.isArray(rawValues)) return false;
    const tagName = key.slice(1);
    const hasMatchingTag = event.tags.some(
      (tag) =>
        tag[0] === tagName &&
        tag[1] !== undefined &&
        rawValues.includes(tag[1]),
    );
    if (!hasMatchingTag) return false;
  }

  return true;
}

export function eventMatchesAnyFilter(
  event: NostrEvent,
  filters: readonly NostrFilter[],
): boolean {
  return filters.some((filter) => eventMatchesFilter(event, filter));
}

function matchesPrefix(value: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => value.startsWith(prefix));
}
