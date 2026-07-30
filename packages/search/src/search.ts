import type { Pool, QueryResultRow } from "pg";

const HEX_32_BYTES = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_TEXT_MAX_CHARACTERS = 4_096;
const PAGE_MAXIMUM = 1_000;
const PAGE_SIZE_MAXIMUM = 500;
const PAGE_SIZE_DEFAULT = 100;

export type ChannelScope =
  | { readonly type: "any" }
  | { readonly type: "channel-less-only" }
  | { readonly type: "channels"; readonly channelIds: readonly string[] }
  | {
      readonly type: "channels-or-channel-less";
      readonly channelIds: readonly string[];
    };

export type SearchMode = "full-text" | "prefix";

export type SearchQuery = {
  /** A server-resolved community UUID, never a client-supplied tenant. */
  readonly communityId: string;
  readonly text: string;
  readonly channelScope: ChannelScope;
  readonly kinds?: readonly number[];
  readonly authors?: readonly string[];
  readonly since?: number;
  readonly until?: number;
  readonly page?: number;
  readonly perPage?: number;
  readonly mode?: SearchMode;
};

export type SearchHit = {
  readonly eventId: string;
  readonly kind: number;
  readonly pubkey: string;
  readonly channelId: string | null;
  readonly createdAt: number;
  readonly rank: number;
};

export type SearchResult = {
  readonly hits: readonly SearchHit[];
  readonly page: number;
};

type SearchRow = QueryResultRow & {
  readonly event_id: string;
  readonly kind: number;
  readonly pubkey: string;
  readonly channel_id: string | null;
  readonly created_at_s: string;
  readonly rank: number;
};

export class SearchService {
  public constructor(private readonly pool: Pool) {}

  public async search(query: SearchQuery): Promise<SearchResult> {
    const built = buildSearchQuery(query);
    if (!built) {
      return { hits: [], page: clampPage(query.page) };
    }
    const result = await this.pool.query<SearchRow>(built.text, built.values);
    return {
      hits: result.rows.map((row) => {
        const createdAt = Number(row.created_at_s);
        if (!Number.isSafeInteger(createdAt)) {
          throw new Error("database returned an invalid search timestamp");
        }
        if (
          !HEX_32_BYTES.test(row.event_id) ||
          !HEX_32_BYTES.test(row.pubkey)
        ) {
          throw new Error("database returned malformed search identity bytes");
        }
        return {
          channelId: row.channel_id,
          createdAt,
          eventId: row.event_id,
          kind: row.kind,
          pubkey: row.pubkey,
          rank: row.rank,
        };
      }),
      page: built.page,
    };
  }
}

export function buildSearchQuery(query: SearchQuery): {
  readonly text: string;
  readonly values: unknown[];
  readonly page: number;
} | null {
  validateQuery(query);
  const searchText = normalizeSearchText(query.text);
  if (!searchText) return null;
  const values: unknown[] = [];
  const bind = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  const mode = query.mode ?? "full-text";
  const queryExpression =
    mode === "full-text"
      ? `websearch_to_tsquery('simple', ${bind(searchText)})`
      : prefixQueryExpression(bind(searchText));
  const clauses = [
    `e.community_id = ${bind(query.communityId)}::uuid`,
    "e.deleted_at IS NULL",
    "e.search_tsv @@ search_query.query",
  ];
  switch (query.channelScope.type) {
    case "any":
      break;
    case "channel-less-only":
      clauses.push("e.channel_id IS NULL");
      break;
    case "channels":
      clauses.push(
        `e.channel_id = ANY(${bind(query.channelScope.channelIds)}::uuid[])`,
      );
      break;
    case "channels-or-channel-less":
      clauses.push(
        `(e.channel_id = ANY(${bind(
          query.channelScope.channelIds,
        )}::uuid[]) OR e.channel_id IS NULL)`,
      );
      break;
  }
  if (query.kinds?.length) {
    clauses.push(`e.kind = ANY(${bind(query.kinds)}::int[])`);
  }
  if (query.authors?.length) {
    clauses.push(
      `e.pubkey = ANY(SELECT decode(value, 'hex') FROM unnest(${bind(
        query.authors,
      )}::text[]) AS value)`,
    );
  }
  if (query.since !== undefined) {
    clauses.push(`e.created_at >= to_timestamp(${bind(query.since)})`);
  }
  if (query.until !== undefined) {
    clauses.push(`e.created_at <= to_timestamp(${bind(query.until)})`);
  }
  const page = clampPage(query.page);
  const perPage = clampPerPage(query.perPage);
  const offset = (page - 1) * perPage;
  return {
    page,
    text: `SELECT encode(e.id, 'hex') AS event_id,
                  e.kind,
                  encode(e.pubkey, 'hex') AS pubkey,
                  e.channel_id,
                  EXTRACT(EPOCH FROM e.created_at)::bigint::text AS created_at_s,
                  ts_rank_cd(e.search_tsv, search_query.query) AS rank
           FROM events e
           CROSS JOIN LATERAL (SELECT ${queryExpression} AS query) search_query
           WHERE ${clauses.join(" AND ")}
           ORDER BY rank DESC, e.created_at DESC, e.id
           LIMIT ${bind(perPage)} OFFSET ${bind(offset)}`,
    values,
  };
}

export function normalizeSearchText(value: string): string | null {
  const cleaned = [...value.trim()]
    .slice(0, SEARCH_TEXT_MAX_CHARACTERS)
    .join("")
    .replaceAll("\0", " ")
    .trim();
  return cleaned || null;
}

function prefixQueryExpression(binding: string): string {
  return `(SELECT COALESCE(
    string_agg(
      quote_literal(lexeme) ||
        CASE WHEN token_ord = max_token_ord THEN ':*' ELSE '' END,
      ' & ' ORDER BY token_ord, lex_ord
    ),
    ''
  )::tsquery
  FROM (
    SELECT raw_token.token_ord, normalized.lexeme,
           normalized.lex_ord, raw_token.max_token_ord
    FROM (
      SELECT token, token_ord, max(token_ord) OVER () AS max_token_ord
      FROM regexp_split_to_table(${binding}, '\\s+')
        WITH ORDINALITY AS split(token, token_ord)
    ) raw_token
    CROSS JOIN LATERAL
      unnest(tsvector_to_array(to_tsvector('simple', raw_token.token)))
      WITH ORDINALITY AS normalized(lexeme, lex_ord)
  ) prefix_terms)`;
}

function validateQuery(query: SearchQuery): void {
  if (!UUID.test(query.communityId)) {
    throw new TypeError("search communityId must be a UUID");
  }
  if (
    query.mode !== undefined &&
    !["full-text", "prefix"].includes(query.mode)
  ) {
    throw new TypeError("invalid search mode");
  }
  for (const channelId of "channelIds" in query.channelScope
    ? query.channelScope.channelIds
    : []) {
    if (!UUID.test(channelId)) throw new TypeError("invalid search channel ID");
  }
  for (const kind of query.kinds ?? []) {
    if (!Number.isSafeInteger(kind) || kind < 0 || kind > 0x7fffffff) {
      throw new TypeError("invalid search event kind");
    }
  }
  for (const author of query.authors ?? []) {
    if (!HEX_32_BYTES.test(author)) {
      throw new TypeError("invalid search author pubkey");
    }
  }
  for (const timestamp of [query.since, query.until]) {
    if (
      timestamp !== undefined &&
      (!Number.isSafeInteger(timestamp) || timestamp < 0)
    ) {
      throw new TypeError("invalid search timestamp");
    }
  }
}

function clampPage(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(PAGE_MAXIMUM, Math.trunc(value)));
}

function clampPerPage(value: number | undefined): number {
  if (value === undefined || value === 0 || !Number.isFinite(value)) {
    return PAGE_SIZE_DEFAULT;
  }
  return Math.max(1, Math.min(PAGE_SIZE_MAXIMUM, Math.trunc(value)));
}
