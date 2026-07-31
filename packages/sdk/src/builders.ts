import {
  KIND_CANVAS,
  KIND_CONTACT_LIST,
  KIND_DELETION,
  KIND_DM_ADD_MEMBER,
  KIND_DM_OPEN,
  KIND_EMOJI_SET,
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_FORUM_VOTE,
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_GUIDELINES,
  KIND_HUDDLE_STARTED,
  KIND_IA_ARCHIVE_REQUEST,
  KIND_IA_UNARCHIVE_REQUEST,
  KIND_NIP29_CREATE_GROUP,
  KIND_NIP29_DELETE_EVENT,
  KIND_NIP29_DELETE_GROUP,
  KIND_NIP29_EDIT_METADATA,
  KIND_NIP29_JOIN_REQUEST,
  KIND_NIP29_LEAVE_REQUEST,
  KIND_NIP29_PUT_USER,
  KIND_NIP29_REMOVE_USER,
  KIND_PRESENCE_UPDATE,
  KIND_PROFILE,
  KIND_REACTION,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_TEXT_NOTE,
  KIND_WORKFLOW_DEF,
  KIND_WORKFLOW_TRIGGER,
  KIND_APPROVAL_GRANT,
  KIND_APPROVAL_DENY,
  signNostrEvent,
  unixNow,
  type NostrEvent,
  type NostrTag,
} from "@buzz/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_64 = /^[0-9a-f]{64}$/i;
const MAX_CONTENT_BYTES = 64 * 1024;
export const CUSTOM_EMOJI_SET_D_TAG = "buzz:custom-emoji";

export type EventTemplate = {
  readonly kind: number;
  readonly content: string;
  readonly tags: NostrTag[];
};

export type ThreadRef = {
  readonly rootEventId: string;
  readonly parentEventId: string;
};

export type MediaTag = readonly string[];
export type MemberRole = "owner" | "admin" | "member" | "guest" | "bot";
export type ChannelVisibility = "open" | "private";
export type ChannelType = "stream" | "forum" | "dm" | "workflow";
export type GitRepoCoordinate = {
  readonly owner: string;
  readonly id: string;
};
export type GitStatus = "open" | "merged" | "resolved" | "closed" | "draft";

export function signTemplate(
  template: EventTemplate,
  secretKey: Uint8Array,
  createdAt = unixNow(),
): NostrEvent {
  return signNostrEvent(
    {
      content: template.content,
      created_at: createdAt,
      kind: template.kind,
      tags: template.tags.map((tag) => [...tag]),
    },
    secretKey,
  );
}

export function buildMessage(input: {
  readonly channelId: string;
  readonly content: string;
  readonly thread?: ThreadRef;
  readonly mentions?: readonly string[];
  readonly broadcast?: boolean;
  readonly mediaTags?: readonly MediaTag[];
}): EventTemplate {
  assertContent(input.content, MAX_CONTENT_BYTES);
  const tags: NostrTag[] = [["h", assertUuid(input.channelId)]];
  appendThread(tags, input.thread);
  appendMentions(tags, input.mentions ?? []);
  if (input.broadcast) tags.push(["broadcast", "1"]);
  appendMedia(tags, input.mediaTags ?? []);
  return template(KIND_STREAM_MESSAGE, input.content, tags);
}

export function buildForumPost(input: {
  readonly channelId: string;
  readonly content: string;
  readonly mentions?: readonly string[];
  readonly mediaTags?: readonly MediaTag[];
}): EventTemplate {
  assertContent(input.content, MAX_CONTENT_BYTES);
  const tags: NostrTag[] = [["h", assertUuid(input.channelId)]];
  appendMentions(tags, input.mentions ?? []);
  appendMedia(tags, input.mediaTags ?? []);
  return template(KIND_FORUM_POST, input.content, tags);
}

export function buildForumComment(input: {
  readonly channelId: string;
  readonly content: string;
  readonly thread: ThreadRef;
  readonly mentions?: readonly string[];
  readonly mediaTags?: readonly MediaTag[];
}): EventTemplate {
  const built = buildForumPost(input);
  const tags: NostrTag[] = [["h", assertUuid(input.channelId)]];
  appendThread(tags, input.thread);
  appendMentions(tags, input.mentions ?? []);
  appendMedia(tags, input.mediaTags ?? []);
  return template(KIND_FORUM_COMMENT, built.content, tags);
}

export function buildDiffMessage(input: {
  readonly channelId: string;
  readonly content: string;
  readonly repoUrl: string;
  readonly commitSha: string;
  readonly filePath?: string;
  readonly parentCommit?: string;
  readonly branch?: readonly [source: string, target: string];
  readonly pullRequestNumber?: number;
  readonly language?: string;
  readonly description?: string;
  readonly truncated?: boolean;
  readonly altText?: string;
  readonly thread?: ThreadRef;
}): EventTemplate {
  assertContent(input.content, 60 * 1024);
  assertHttpUrl(input.repoUrl, "repoUrl");
  assertAbbreviatedHex(input.commitSha, "commitSha");
  if (input.parentCommit)
    assertAbbreviatedHex(input.parentCommit, "parentCommit");
  if (input.branch?.some((value) => value.length === 0)) {
    throw new TypeError("branch source and target must be non-empty");
  }
  if (
    input.pullRequestNumber !== undefined &&
    (!Number.isSafeInteger(input.pullRequestNumber) ||
      input.pullRequestNumber < 1)
  ) {
    throw new TypeError("pullRequestNumber must be positive");
  }
  const tags: NostrTag[] = [
    ["h", assertUuid(input.channelId)],
    ["repo", input.repoUrl],
    ["commit", input.commitSha],
  ];
  if (input.filePath) tags.push(["file", input.filePath]);
  if (input.parentCommit) tags.push(["parent-commit", input.parentCommit]);
  if (input.branch) tags.push(["branch", ...input.branch]);
  if (input.pullRequestNumber)
    tags.push(["pr", String(input.pullRequestNumber)]);
  if (input.language) tags.push(["l", input.language]);
  if (input.description) tags.push(["description", input.description]);
  if (input.truncated) tags.push(["truncated", "true"]);
  if (input.altText) tags.push(["alt", input.altText]);
  appendThread(tags, input.thread);
  return template(KIND_STREAM_MESSAGE_DIFF, input.content, tags);
}

export function buildEdit(
  channelId: string,
  targetEventId: string,
  content: string,
): EventTemplate {
  assertContent(content, MAX_CONTENT_BYTES);
  return template(KIND_STREAM_MESSAGE_EDIT, content, [
    ["h", assertUuid(channelId)],
    ["e", assertHex64(targetEventId, "targetEventId")],
  ]);
}

export function buildDeleteMessage(
  channelId: string,
  targetEventId: string,
  options: {
    readonly actionId?: string;
    readonly reasonCode?: string;
    readonly publicReason?: string;
  } = {},
): EventTemplate {
  const tags: NostrTag[] = [
    ["h", assertUuid(channelId)],
    ["e", assertHex64(targetEventId, "targetEventId")],
  ];
  if (options.actionId) tags.push(["action_id", assertUuid(options.actionId)]);
  if (options.reasonCode) tags.push(["reason_code", options.reasonCode]);
  if (options.publicReason) tags.push(["public_reason", options.publicReason]);
  return template(KIND_NIP29_DELETE_EVENT, "", tags);
}

export function buildDeleteCompatibility(
  channelId: string,
  targetEventId: string,
): EventTemplate {
  return template(KIND_DELETION, "", [
    ["h", assertUuid(channelId)],
    ["e", assertHex64(targetEventId, "targetEventId")],
  ]);
}

export function buildVote(
  channelId: string,
  targetEventId: string,
  direction: "up" | "down",
): EventTemplate {
  return template(KIND_FORUM_VOTE, direction === "up" ? "+" : "-", [
    ["h", assertUuid(channelId)],
    ["e", assertHex64(targetEventId, "targetEventId")],
  ]);
}

export function buildReaction(
  targetEventId: string,
  emoji: string,
): EventTemplate {
  if ([...emoji].length > 64)
    throw new RangeError("emoji exceeds 64 characters");
  return template(KIND_REACTION, emoji, [
    ["e", assertHex64(targetEventId, "targetEventId")],
  ]);
}

export function normalizeCustomEmojiShortcode(value: string): string {
  const shortcode = value.trim().replace(/^:+|:+$/g, "");
  if (
    shortcode.length < 1 ||
    utf8Length(shortcode) > 64 ||
    !/^[A-Za-z0-9_-]+$/.test(shortcode)
  ) {
    throw new TypeError(
      "emoji shortcode must use 1-64 ASCII letters, digits, hyphens, or underscores",
    );
  }
  return shortcode.toLowerCase();
}

export function buildCustomEmojiReaction(
  targetEventId: string,
  shortcodeValue: string,
  url: string,
): EventTemplate {
  const shortcode = normalizeCustomEmojiShortcode(shortcodeValue);
  assertHttpUrl(url, "emoji URL");
  return template(KIND_REACTION, `:${shortcode}:`, [
    ["e", assertHex64(targetEventId, "targetEventId")],
    ["emoji", shortcode, url],
  ]);
}

export function buildRemoveReaction(reactionEventId: string): EventTemplate {
  return template(KIND_DELETION, "", [
    ["e", assertHex64(reactionEventId, "reactionEventId")],
  ]);
}

export function buildArchiveIdentityRequest(input: {
  readonly targetPubkey: string;
  readonly content?: string;
  readonly reason?: string;
  readonly replacedBy?: string;
  readonly auth?: readonly string[];
}): EventTemplate {
  return buildIdentityArchiveRequest(KIND_IA_ARCHIVE_REQUEST, input);
}

export function buildUnarchiveIdentityRequest(input: {
  readonly targetPubkey: string;
  readonly content?: string;
  readonly reason?: string;
  readonly auth?: readonly string[];
}): EventTemplate {
  return buildIdentityArchiveRequest(KIND_IA_UNARCHIVE_REQUEST, input);
}

export function buildRepoAnnouncement(input: {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly cloneUrls?: readonly string[];
  readonly webUrl?: string;
  readonly relays?: readonly string[];
}): EventTemplate {
  const id = assertRepoId(input.id);
  if (input.name !== undefined && [...input.name].length > 128) {
    throw new RangeError("repository name exceeds 128 characters");
  }
  if (
    input.description !== undefined &&
    [...input.description].length > 1_024
  ) {
    throw new RangeError("repository description exceeds 1,024 characters");
  }
  const cloneUrls = input.cloneUrls ?? [];
  const relays = input.relays ?? [];
  if (cloneUrls.length > 5) throw new RangeError("too many clone URLs (max 5)");
  if (relays.length > 10) throw new RangeError("too many relays (max 10)");
  for (const url of cloneUrls) boundedUrl(url, "clone URL", 512);
  if (input.webUrl !== undefined) {
    const url = boundedUrl(input.webUrl, "web URL", 512);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError("web URL must use HTTP(S)");
    }
  }
  for (const relay of relays) {
    const url = boundedUrl(relay, "relay", 256);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new TypeError("repository relay must use WS(S)");
    }
  }
  const tags: NostrTag[] = [["d", id]];
  if (input.name !== undefined) tags.push(["name", input.name]);
  if (input.description !== undefined)
    tags.push(["description", input.description]);
  if (cloneUrls.length > 0) tags.push(["clone", ...cloneUrls]);
  if (input.webUrl !== undefined) tags.push(["web", input.webUrl]);
  if (relays.length > 0) tags.push(["relays", ...relays]);
  return template(30_617, "", tags);
}

export function buildGitPatch(input: {
  readonly repo: GitRepoCoordinate;
  readonly content: string;
  readonly euc?: string;
  readonly recipients?: readonly string[];
  readonly replyTo?: string;
  readonly root?: boolean;
  readonly rootRevision?: boolean;
  readonly commit?: string;
  readonly parentCommit?: string;
  readonly commitPgpSignature?: string;
  readonly committer?: readonly [string, string, string, string];
}): EventTemplate {
  if (!input.content.trim()) throw new TypeError("patch content is required");
  assertContent(input.content, 60 * 1_024);
  const tags = gitRepoTags(input.repo);
  if (input.euc) tags.push(["r", assertCommit(input.euc, "euc"), "euc"]);
  appendRecipients(tags, input.recipients ?? []);
  if (input.replyTo)
    tags.push(["e", assertHex64(input.replyTo, "replyTo"), "", "reply"]);
  if (input.root && input.rootRevision) {
    throw new TypeError("patch cannot be both root and rootRevision");
  }
  if (input.root) tags.push(["t", "root"]);
  if (input.rootRevision) tags.push(["t", "root-revision"]);
  if (input.commit) {
    const commit = assertCommit(input.commit, "commit");
    tags.push(["commit", commit], ["r", commit]);
  }
  if (input.parentCommit)
    tags.push([
      "parent-commit",
      assertCommit(input.parentCommit, "parentCommit"),
    ]);
  if (input.commitPgpSignature !== undefined)
    tags.push(["commit-pgp-sig", input.commitPgpSignature]);
  if (input.committer) tags.push(["committer", ...input.committer]);
  return template(1_617, input.content, tags);
}

export function buildGitIssue(input: {
  readonly repo: GitRepoCoordinate;
  readonly subject: string;
  readonly content: string;
  readonly labels?: readonly string[];
  readonly recipients?: readonly string[];
}): EventTemplate {
  assertContent(input.content, MAX_CONTENT_BYTES);
  if (!input.subject || [...input.subject].length > 256) {
    throw new TypeError("issue subject must contain 1-256 characters");
  }
  const tags = gitRepoTags(input.repo);
  appendRecipients(tags, input.recipients ?? []);
  tags.push(["subject", input.subject]);
  for (const label of input.labels ?? []) tags.push(["t", label]);
  return template(1_621, input.content, tags);
}

export function buildGitStatus(input: {
  readonly status: GitStatus;
  readonly rootEvent: string;
  readonly content?: string;
  readonly revision?: string;
  readonly repo?: GitRepoCoordinate;
  readonly euc?: string;
  readonly recipients?: readonly string[];
  readonly appliedPatches?: readonly (readonly string[])[];
  readonly mergeCommit?: string;
  readonly appliedAsCommits?: readonly string[];
}): EventTemplate {
  const statusKind = {
    open: 1_630,
    merged: 1_631,
    resolved: 1_631,
    closed: 1_632,
    draft: 1_633,
  }[input.status];
  if (statusKind === undefined) throw new TypeError("git status is invalid");
  const content = input.content ?? "";
  assertContent(content, MAX_CONTENT_BYTES);
  const tags: NostrTag[] = [
    ["e", assertHex64(input.rootEvent, "rootEvent"), "", "root"],
  ];
  if (input.revision)
    tags.push(["e", assertHex64(input.revision, "revision"), "", "reply"]);
  appendRecipients(tags, input.recipients ?? []);
  if (input.repo) tags.push(["a", repoCoordinate(input.repo)]);
  if (input.euc) tags.push(["r", assertCommit(input.euc, "euc")]);
  const mergedOnly =
    (input.appliedPatches?.length ?? 0) > 0 ||
    input.mergeCommit !== undefined ||
    (input.appliedAsCommits?.length ?? 0) > 0;
  if (statusKind !== 1_631 && mergedOnly) {
    throw new TypeError("merge metadata requires merged or resolved status");
  }
  for (const reference of input.appliedPatches ?? []) {
    if (reference.length < 1 || reference.length > 3) {
      throw new TypeError("applied patch reference is invalid");
    }
    const [id, relay, pubkey] = reference;
    const tag = ["q", assertHex64(id ?? "", "applied patch")] as string[];
    if (relay !== undefined) tag.push(relay);
    if (pubkey !== undefined) tag.push(assertHex64(pubkey, "patch pubkey"));
    tags.push(tag);
  }
  if (input.mergeCommit) {
    const commit = assertCommit(input.mergeCommit, "mergeCommit");
    tags.push(["merge-commit", commit], ["r", commit]);
  }
  if ((input.appliedAsCommits?.length ?? 0) > 0) {
    const commits = (input.appliedAsCommits ?? []).map((commit) =>
      assertCommit(commit, "appliedAsCommit"),
    );
    tags.push(["applied-as-commits", ...commits]);
    for (const commit of commits) tags.push(["r", commit]);
  }
  return template(statusKind, content, tags);
}

export function buildGitPullRequest(input: {
  readonly repo: GitRepoCoordinate;
  readonly content?: string;
  readonly subject: string;
  readonly commit: string;
  readonly cloneUrls: readonly string[];
  readonly branchName?: string;
  readonly mergeBase?: string;
  readonly euc?: string;
  readonly labels?: readonly string[];
  readonly recipients?: readonly string[];
  readonly channelId?: string;
  readonly revisionOf?: string;
}): EventTemplate {
  const content = input.content ?? "";
  assertContent(content, MAX_CONTENT_BYTES);
  if (!input.subject || [...input.subject].length > 256) {
    throw new TypeError("pull request subject must contain 1-256 characters");
  }
  if (input.cloneUrls.length < 1) {
    throw new TypeError("pull request requires at least one clone URL");
  }
  const tags = gitRepoTags(input.repo);
  if (input.euc) tags.push(["r", assertCommit(input.euc, "euc")]);
  appendRecipients(tags, input.recipients ?? []);
  tags.push(["subject", input.subject]);
  for (const label of input.labels ?? []) tags.push(["t", label]);
  tags.push(["c", assertCommit(input.commit, "commit")]);
  if (input.channelId) tags.push(["h", assertUuid(input.channelId)]);
  tags.push(["clone", ...input.cloneUrls]);
  if (input.branchName) tags.push(["branch-name", input.branchName]);
  if (input.mergeBase)
    tags.push(["merge-base", assertCommit(input.mergeBase, "mergeBase")]);
  if (input.revisionOf)
    tags.push(["e", assertHex64(input.revisionOf, "revisionOf")]);
  return template(1_618, content, tags);
}

export function buildGitPullRequestUpdate(input: {
  readonly repo: GitRepoCoordinate;
  readonly content?: string;
  readonly prEvent: string;
  readonly prAuthor: string;
  readonly commit: string;
  readonly cloneUrls: readonly string[];
  readonly mergeBase?: string;
  readonly euc?: string;
  readonly recipients?: readonly string[];
}): EventTemplate {
  const content = input.content ?? "";
  assertContent(content, MAX_CONTENT_BYTES);
  if (input.cloneUrls.length < 1) {
    throw new TypeError("pull request update requires at least one clone URL");
  }
  const tags = gitRepoTags(input.repo);
  if (input.euc) tags.push(["r", assertCommit(input.euc, "euc")]);
  appendRecipients(tags, input.recipients ?? []);
  tags.push(
    ["E", assertHex64(input.prEvent, "prEvent")],
    ["P", assertHex64(input.prAuthor, "prAuthor")],
    ["c", assertCommit(input.commit, "commit")],
    ["clone", ...input.cloneUrls],
  );
  if (input.mergeBase)
    tags.push(["merge-base", assertCommit(input.mergeBase, "mergeBase")]);
  return template(1_619, content, tags);
}

export function buildCustomEmojiSet(
  emojis: readonly { readonly shortcode: string; readonly url: string }[],
): EventTemplate {
  const tags: NostrTag[] = [["d", CUSTOM_EMOJI_SET_D_TAG]];
  const seen = new Set<string>();
  for (const emoji of emojis) {
    const shortcode = normalizeCustomEmojiShortcode(emoji.shortcode);
    assertHttpUrl(emoji.url, "emoji URL");
    if (seen.has(shortcode)) {
      throw new TypeError(`duplicate emoji shortcode: ${shortcode}`);
    }
    seen.add(shortcode);
    tags.push(["emoji", shortcode, emoji.url]);
  }
  return template(KIND_EMOJI_SET, "", tags);
}

export function buildSetCanvas(
  channelId: string,
  content: string,
): EventTemplate {
  return template(KIND_CANVAS, content, [["h", assertUuid(channelId)]]);
}

export function buildProfile(profile: {
  readonly displayName?: string;
  readonly name?: string;
  readonly picture?: string;
  readonly about?: string;
  readonly nip05?: string;
}): EventTemplate {
  const content: Record<string, string> = {};
  if (profile.displayName !== undefined)
    content.display_name = profile.displayName;
  if (profile.name !== undefined) content.name = profile.name;
  if (profile.picture !== undefined) content.picture = profile.picture;
  if (profile.about !== undefined) content.about = profile.about;
  if (profile.nip05 !== undefined) content.nip05 = profile.nip05;
  return template(KIND_PROFILE, JSON.stringify(content), []);
}

export function buildAddMember(
  channelId: string,
  pubkey: string,
  role?: MemberRole,
): EventTemplate {
  const tags: NostrTag[] = [
    ["h", assertUuid(channelId)],
    ["p", assertHex64(pubkey, "pubkey")],
  ];
  if (role) tags.push(["role", role]);
  return template(KIND_NIP29_PUT_USER, "", tags);
}

export function buildRemoveMember(
  channelId: string,
  pubkey: string,
): EventTemplate {
  return template(KIND_NIP29_REMOVE_USER, "", [
    ["h", assertUuid(channelId)],
    ["p", assertHex64(pubkey, "pubkey")],
  ]);
}

export function buildLeave(channelId: string): EventTemplate {
  return channelOnly(KIND_NIP29_LEAVE_REQUEST, channelId);
}

export function buildHuddleStarted(
  parentChannelId: string,
  ephemeralChannelId: string,
): EventTemplate {
  return buildHuddleLifecycle(
    KIND_HUDDLE_STARTED,
    parentChannelId,
    ephemeralChannelId,
  );
}

export function buildHuddleEnded(
  parentChannelId: string,
  ephemeralChannelId: string,
): EventTemplate {
  return buildHuddleLifecycle(
    KIND_HUDDLE_ENDED,
    parentChannelId,
    ephemeralChannelId,
  );
}

export function buildHuddleGuidelines(
  ephemeralChannelId: string,
  content: string,
): EventTemplate {
  assertContent(content, MAX_CONTENT_BYTES);
  return template(KIND_HUDDLE_GUIDELINES, content, [
    ["h", assertUuid(ephemeralChannelId)],
  ]);
}

export function buildUpdateChannel(input: {
  readonly channelId: string;
  readonly name?: string;
  readonly about?: string;
  readonly visibility?: ChannelVisibility;
  /** undefined leaves unchanged, null clears it, an integer sets seconds. */
  readonly ttl?: number | null;
}): EventTemplate {
  if (
    input.name === undefined &&
    input.about === undefined &&
    input.visibility === undefined &&
    input.ttl === undefined
  ) {
    throw new TypeError("at least one channel field must be provided");
  }
  const tags: NostrTag[] = [["h", assertUuid(input.channelId)]];
  if (input.name !== undefined) {
    const name = canonicalChannelName(input.name);
    if (!name.trim()) throw new TypeError("channel name is required");
    tags.push(["name", name]);
  }
  if (input.about !== undefined) tags.push(["about", input.about]);
  if (input.visibility !== undefined)
    tags.push(["visibility", input.visibility]);
  if (input.ttl !== undefined) {
    if (
      input.ttl !== null &&
      (!Number.isSafeInteger(input.ttl) || input.ttl < 1)
    ) {
      throw new TypeError("channel ttl must be a positive integer or null");
    }
    tags.push(["ttl", input.ttl === null ? "" : String(input.ttl)]);
  }
  return template(KIND_NIP29_EDIT_METADATA, "", tags);
}

export function buildSetTopic(channelId: string, topic: string): EventTemplate {
  return template(KIND_NIP29_EDIT_METADATA, "", [
    ["h", assertUuid(channelId)],
    ["topic", topic],
  ]);
}

export function buildSetPurpose(
  channelId: string,
  purpose: string,
): EventTemplate {
  return template(KIND_NIP29_EDIT_METADATA, "", [
    ["h", assertUuid(channelId)],
    ["purpose", purpose],
  ]);
}

export function buildCreateChannel(input: {
  readonly channelId: string;
  readonly name: string;
  readonly visibility?: ChannelVisibility;
  readonly channelType?: ChannelType;
  readonly about?: string;
  readonly ttl?: number;
}): EventTemplate {
  const name = canonicalChannelName(input.name);
  if (!name.trim()) throw new TypeError("channel name is required");
  const tags: NostrTag[] = [
    ["h", assertUuid(input.channelId)],
    ["name", name],
  ];
  if (input.visibility) tags.push(["visibility", input.visibility]);
  if (input.channelType) tags.push(["channel_type", input.channelType]);
  if (input.about) tags.push(["about", input.about]);
  if (input.ttl !== undefined) {
    if (!Number.isSafeInteger(input.ttl) || input.ttl < 1) {
      throw new TypeError("channel ttl must be a positive integer");
    }
    tags.push(["ttl", String(input.ttl)]);
  }
  return template(KIND_NIP29_CREATE_GROUP, "", tags);
}

export function buildJoin(channelId: string): EventTemplate {
  return channelOnly(KIND_NIP29_JOIN_REQUEST, channelId);
}

export function buildArchive(channelId: string): EventTemplate {
  return template(KIND_NIP29_EDIT_METADATA, "", [
    ["h", assertUuid(channelId)],
    ["archived", "true"],
  ]);
}

export function buildUnarchive(channelId: string): EventTemplate {
  return template(KIND_NIP29_EDIT_METADATA, "", [
    ["h", assertUuid(channelId)],
    ["archived", "false"],
  ]);
}

export function buildDeleteChannel(channelId: string): EventTemplate {
  return channelOnly(KIND_NIP29_DELETE_GROUP, channelId);
}

function buildHuddleLifecycle(
  kind: typeof KIND_HUDDLE_STARTED | typeof KIND_HUDDLE_ENDED,
  parentChannelId: string,
  ephemeralChannelId: string,
): EventTemplate {
  const ephemeral = assertUuid(ephemeralChannelId);
  return template(kind, JSON.stringify({ ephemeral_channel_id: ephemeral }), [
    ["h", assertUuid(parentChannelId)],
  ]);
}

export function buildNote(
  content: string,
  replyToEventId?: string,
): EventTemplate {
  assertContent(content, MAX_CONTENT_BYTES);
  return template(
    KIND_TEXT_NOTE,
    content,
    replyToEventId
      ? [["e", assertHex64(replyToEventId, "replyToEventId"), "", "reply"]]
      : [],
  );
}

export function buildContactList(
  contacts: readonly {
    readonly pubkey: string;
    readonly relayUrl?: string;
    readonly petname?: string;
  }[],
): EventTemplate {
  if (contacts.length > 10_000)
    throw new RangeError("contact list exceeds 10,000 contacts");
  const seen = new Set<string>();
  const tags: NostrTag[] = [];
  for (const contact of contacts) {
    const pubkey = assertHex64(contact.pubkey, "contact pubkey");
    if (seen.has(pubkey)) continue;
    if (contact.relayUrl && utf8Length(contact.relayUrl) > 2_048) {
      throw new RangeError("contact relay URL exceeds 2,048 bytes");
    }
    if (contact.petname && utf8Length(contact.petname) > 256) {
      throw new RangeError("contact petname exceeds 256 bytes");
    }
    seen.add(pubkey);
    tags.push(["p", pubkey, contact.relayUrl ?? "", contact.petname ?? ""]);
  }
  return template(KIND_CONTACT_LIST, "", tags);
}

export function buildDmOpen(pubkeys: readonly string[]): EventTemplate {
  if (pubkeys.length < 1 || pubkeys.length > 100) {
    throw new RangeError("DM open requires 1-100 pubkeys");
  }
  const unique = [...new Set(pubkeys.map((key) => assertHex64(key, "pubkey")))];
  return template(
    KIND_DM_OPEN,
    "",
    unique.sort().map((key) => ["p", key]),
  );
}

export function buildDmAddMember(
  channelId: string,
  pubkey: string,
): EventTemplate {
  return template(KIND_DM_ADD_MEMBER, "", [
    ["h", assertUuid(channelId)],
    ["p", assertHex64(pubkey, "pubkey")],
  ]);
}

export function buildPresenceUpdate(status: string): EventTemplate {
  if (!["online", "away", "busy", "offline"].includes(status)) {
    throw new TypeError("presence status is invalid");
  }
  return template(KIND_PRESENCE_UPDATE, status, []);
}

export function buildWorkflowDefinition(input: {
  readonly channelId: string;
  readonly workflowId: string;
  readonly yaml: string;
}): EventTemplate {
  assertContent(input.yaml, 64 * 1024);
  return template(KIND_WORKFLOW_DEF, input.yaml, [
    ["d", assertUuid(input.workflowId)],
    ["h", assertUuid(input.channelId)],
  ]);
}

export function buildWorkflowDelete(
  authorPubkey: string,
  workflowId: string,
): EventTemplate {
  return template(KIND_DELETION, "", [
    [
      "a",
      `${KIND_WORKFLOW_DEF}:${assertHex64(authorPubkey, "authorPubkey")}:${assertUuid(workflowId)}`,
    ],
  ]);
}

export function buildWorkflowTrigger(
  workflowId: string,
  inputs: Readonly<Record<string, unknown>> = {},
): EventTemplate {
  const content = JSON.stringify(inputs);
  assertContent(content, 64 * 1024);
  return template(KIND_WORKFLOW_TRIGGER, content, [
    ["d", assertUuid(workflowId)],
  ]);
}

export function buildWorkflowApproval(
  approvalToken: string,
  approved: boolean,
  note = "",
): EventTemplate {
  assertUuid(approvalToken);
  assertContent(note, 8_192);
  const tokenHash = bytesToHex(sha256(utf8ToBytes(approvalToken)));
  return template(approved ? KIND_APPROVAL_GRANT : KIND_APPROVAL_DENY, note, [
    ["d", tokenHash],
  ]);
}

export function extractChannelId(
  event: Pick<NostrEvent, "tags">,
): string | null {
  return (
    event.tags.find(
      (tag) => tag[0] === "h" && tag[1] !== undefined && UUID.test(tag[1]),
    )?.[1] ?? null
  );
}

export function canonicalChannelName(value: string): string {
  return value.trimEnd().trimStart().replace(/^#+/, "");
}

function appendThread(tags: NostrTag[], thread: ThreadRef | undefined): void {
  if (!thread) return;
  const root = assertHex64(thread.rootEventId, "rootEventId");
  const parent = assertHex64(thread.parentEventId, "parentEventId");
  if (root === parent) tags.push(["e", root, "", "reply"]);
  else {
    tags.push(["e", root, "", "root"]);
    tags.push(["e", parent, "", "reply"]);
  }
}

function appendMentions(tags: NostrTag[], mentions: readonly string[]): void {
  if (mentions.length > 50) throw new RangeError("too many mentions (max 50)");
  const unique = new Set<string>();
  for (const mention of mentions) {
    const normalized = assertHex64(mention, "mention pubkey");
    if (!unique.has(normalized)) {
      tags.push(["p", normalized]);
      unique.add(normalized);
    }
  }
}

function appendMedia(tags: NostrTag[], media: readonly MediaTag[]): void {
  for (const tag of media) {
    if (tag.length < 1 || tag.some((value) => value.includes("\0"))) {
      throw new TypeError("invalid media tag");
    }
    tags.push([...tag]);
  }
}

function template(
  kind: number,
  content: string,
  tags: NostrTag[],
): EventTemplate {
  return { content, kind, tags };
}

function buildIdentityArchiveRequest(
  kind: typeof KIND_IA_ARCHIVE_REQUEST | typeof KIND_IA_UNARCHIVE_REQUEST,
  input: {
    readonly targetPubkey: string;
    readonly content?: string;
    readonly reason?: string;
    readonly replacedBy?: string;
    readonly auth?: readonly string[];
  },
): EventTemplate {
  const content = input.content ?? "";
  assertContent(content, MAX_CONTENT_BYTES);
  const target = assertHex64(input.targetPubkey, "targetPubkey");
  const tags: NostrTag[] = [["-"], ["p", target]];
  if (input.reason !== undefined) {
    if (
      utf8Length(input.reason) > 64 ||
      [...input.reason].some((character) => /\p{Cc}/u.test(character))
    ) {
      throw new TypeError(
        "reason must be at most 64 UTF-8 bytes without control characters",
      );
    }
    tags.push(["reason", input.reason]);
  }
  if (input.replacedBy !== undefined) {
    if (kind !== KIND_IA_ARCHIVE_REQUEST) {
      throw new TypeError("replacedBy is only valid for archive requests");
    }
    const replacement = assertHex64(input.replacedBy, "replacedBy");
    if (replacement === target) {
      throw new TypeError("replacedBy must differ from targetPubkey");
    }
    tags.push(["replaced-by", replacement]);
  }
  if (input.auth !== undefined) {
    if (
      input.auth.length !== 4 ||
      input.auth[0] !== "auth" ||
      !HEX_64.test(input.auth[1] ?? "") ||
      !/^[0-9a-f]{128}$/i.test(input.auth[3] ?? "")
    ) {
      throw new TypeError("auth tag has an invalid structure");
    }
    tags.push([
      "auth",
      (input.auth[1] as string).toLowerCase(),
      input.auth[2] as string,
      (input.auth[3] as string).toLowerCase(),
    ]);
  }
  return template(kind, content, tags);
}

function channelOnly(kind: number, channelId: string): EventTemplate {
  return template(kind, "", [["h", assertUuid(channelId)]]);
}

function assertContent(content: string, maximumBytes: number): void {
  const size = utf8Length(content);
  if (size > maximumBytes) {
    throw new RangeError(
      `content exceeds maximum size of ${maximumBytes} bytes (got ${size})`,
    );
  }
}

function assertUuid(value: string): string {
  if (!UUID.test(value)) throw new TypeError("channel ID must be a UUID");
  return value.toLowerCase();
}

function assertHex64(value: string, field: string): string {
  if (!HEX_64.test(value)) {
    throw new TypeError(`${field} must be a 64-character hex string`);
  }
  return value.toLowerCase();
}

function assertHttpUrl(value: string, field: string): void {
  if (utf8Length(value) > 2_048) {
    throw new RangeError(`${field} exceeds 2,048 bytes`);
  }
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new TypeError(`${field} must be an HTTP(S) URL without credentials`);
  }
}

function assertAbbreviatedHex(value: string, field: string): void {
  if (value.length < 7 || !/^[0-9a-f]+$/i.test(value)) {
    throw new TypeError(`${field} must contain at least seven hex characters`);
  }
}

function assertRepoId(value: string): string {
  if (
    value.length < 1 ||
    value.length > 64 ||
    value.startsWith(".") ||
    value.includes("..") ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new TypeError(
      "repository ID must use 1-64 letters, digits, dots, underscores, or hyphens without a leading or doubled dot",
    );
  }
  return value;
}

function repoCoordinate(repo: GitRepoCoordinate): string {
  return `30617:${assertHex64(repo.owner, "repo owner")}:${assertRepoId(repo.id)}`;
}

function gitRepoTags(repo: GitRepoCoordinate): NostrTag[] {
  return [
    ["a", repoCoordinate(repo)],
    ["p", assertHex64(repo.owner, "repo owner")],
  ];
}

function appendRecipients(
  tags: NostrTag[],
  recipients: readonly string[],
): void {
  for (const recipient of recipients) {
    tags.push(["p", assertHex64(recipient, "recipient")]);
  }
}

function assertCommit(value: string, field: string): string {
  if (value.length < 7 || value.length > 128 || !/^[0-9a-f]+$/i.test(value)) {
    throw new TypeError(`${field} must be 7-128 hexadecimal characters`);
  }
  return value.toLowerCase();
}

function boundedUrl(value: string, field: string, maximum: number): URL {
  if (!value || utf8Length(value) > maximum) {
    throw new TypeError(`${field} must contain 1-${maximum} UTF-8 bytes`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${field} is not a valid URL`);
  }
  if (url.username || url.password) {
    throw new TypeError(`${field} must not contain credentials`);
  }
  return url;
}

function utf8Length(value: string): number {
  return utf8ToBytes(value).byteLength;
}
