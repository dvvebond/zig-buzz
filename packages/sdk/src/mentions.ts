const NOSTR_URI =
  /\bnostr:(npub1[023456789acdefghjklmnpqrstuvwxyz]{20,}|nprofile1[023456789acdefghjklmnpqrstuvwxyz]{20,})\b/gi;

export type MentionProfile = {
  readonly pubkey: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly nip05?: string;
};

export function stripCodeRegions(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, (value) => " ".repeat(value.length))
    .replace(/`[^`\n]*`/g, (value) => " ".repeat(value.length));
}

export function extractAtNames(content: string): string[] {
  const clean = stripCodeRegions(content);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const match of clean.matchAll(
    /(^|[\s([{"'.,!?;:])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g,
  )) {
    const name = match[2]?.toLowerCase();
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

export function extractAtMentionsWithKnown(
  content: string,
  knownNames: readonly string[],
): string[] {
  const known = new Map(
    knownNames
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => [name.toLowerCase(), name] as const),
  );
  return extractAtNames(content)
    .map((name) => known.get(name))
    .filter((name): name is string => name !== undefined);
}

export function matchNamesToProfiles(
  names: readonly string[],
  profiles: readonly MentionProfile[],
): string[] {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const result: string[] = [];
  for (const profile of profiles) {
    const candidates = [
      profile.name,
      profile.displayName,
      profile.nip05?.split("@")[0],
    ]
      .filter((value): value is string => value !== undefined)
      .map((value) => value.toLowerCase());
    if (candidates.some((candidate) => wanted.has(candidate))) {
      result.push(profile.pubkey.toLowerCase());
    }
  }
  return normalizeMentionPubkeys(result);
}

export function mergeMentions(
  explicit: readonly string[],
  automatic: readonly string[],
  cap = 50,
): string[] {
  return normalizeMentionPubkeys([...explicit, ...automatic]).slice(0, cap);
}

export function normalizeMentionPubkeys(
  pubkeys: readonly string[],
  senderPubkey?: string,
): string[] {
  const sender = senderPubkey?.toLowerCase();
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of pubkeys) {
    const normalized = value.toLowerCase();
    if (
      /^[0-9a-f]{64}$/.test(normalized) &&
      normalized !== sender &&
      !seen.has(normalized)
    ) {
      seen.add(normalized);
      output.push(normalized);
    }
  }
  return output;
}

export function extractNostrUris(content: string): string[] {
  const clean = stripCodeRegions(content);
  const seen = new Set<string>();
  const values: string[] = [];
  for (const match of clean.matchAll(NOSTR_URI)) {
    const value = match[1]?.toLowerCase();
    if (value && !seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  }
  return values;
}
