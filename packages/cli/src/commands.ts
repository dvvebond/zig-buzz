import {
  buildEngramEvent,
  buildObserverFrame,
  engramConversationKey,
  engramDTag,
  encryptObserverPayload,
  KIND_AGENT_ENGRAM,
  KIND_IA_ARCHIVED_LIST,
  KIND_MANAGED_AGENT,
  KIND_TEAM,
  monotonicEngramCreatedAt,
  normalizeEngramSlug,
  selectEngramHead,
  validateAndDecryptEngram,
  verifyNostrEvent,
  type NostrEvent,
  type NostrFilter,
} from "@buzz/core";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import {
  buildAddMember,
  buildArchiveIdentityRequest,
  buildArchive,
  buildCreateChannel,
  buildContactList,
  buildCustomEmojiReaction,
  buildCustomEmojiSet,
  buildDeleteChannel,
  buildDeleteMessage,
  buildDiffMessage,
  buildDmAddMember,
  buildDmOpen,
  buildEdit,
  buildForumComment,
  buildForumPost,
  buildGitIssue,
  buildGitPatch,
  buildGitPullRequest,
  buildGitPullRequestUpdate,
  buildGitStatus,
  buildJoin,
  buildLeave,
  buildMessage,
  buildNote,
  buildPresenceUpdate,
  buildProfile,
  buildRepoAnnouncement,
  buildReaction,
  buildRemoveMember,
  buildRemoveReaction,
  buildSetCanvas,
  buildSetPurpose,
  buildSetTopic,
  buildUnarchive,
  buildUnarchiveIdentityRequest,
  buildUpdateChannel,
  buildVote,
  buildWorkflowApproval,
  buildWorkflowDefinition,
  buildWorkflowDelete,
  buildWorkflowTrigger,
  signTemplate,
  CUSTOM_EMOJI_SET_D_TAG,
  normalizeCustomEmojiShortcode,
  type EventTemplate,
} from "@buzz/sdk";
import { getPublicKey } from "nostr-tools/pure";
import {
  createEnrollmentInvitation,
  revokeRemoteWorker,
} from "@buzz/remote-agent-client";
import {
  remoteCapabilitySchema,
  type RemoteCapability,
} from "@buzz/remote-agent-protocol";
import { nip19 } from "nostr-tools";

export type CommandContext = {
  readonly relayUrl: string;
  readonly secretKey: Uint8Array;
  readonly allowInsecureLocalhost: boolean;
  readonly authTag?: readonly string[];
  readonly relay: {
    publish(event: NostrEvent): Promise<string>;
    query(filters: readonly NostrFilter[]): Promise<NostrEvent[]>;
    count(filter: NostrFilter): Promise<number>;
    info?(): Promise<Record<string, unknown>>;
    getAuthed?(
      path: string,
      ownerAuthTag?: readonly string[],
    ): Promise<unknown>;
    uploadFile?(path: string): Promise<unknown>;
    downloadMedia?(
      input: string,
      outputPath?: string,
    ): Promise<
      Uint8Array | { readonly size: number; readonly written: string }
    >;
  };
};

export async function executeCommand(
  resource: string,
  action: string,
  input: unknown,
  context: CommandContext,
): Promise<unknown> {
  const value = objectInput(input);
  if (
    resource === "agents" &&
    (action === "draft-create" || action === "draft-update")
  ) {
    const ownerPubkey = requireOwnerPubkey(context.authTag);
    const channelId = requiredUuid(
      requiredStringFrom(value, ["channelId", "channel"]),
      "channel",
    );
    const requestId = crypto.randomUUID();
    const request =
      action === "draft-create"
        ? {
            channelId,
            displayName: boundedRequiredString(
              value.displayName,
              "displayName",
              120,
            ),
            systemPrompt: boundedRequiredString(
              value.systemPrompt,
              "systemPrompt",
              20_000,
            ),
          }
        : agentDraftUpdate(value, channelId);
    const payload = {
      agentIndex: null,
      channelId,
      kind: "agent_management_request",
      payload: {
        action: action === "draft-create" ? "create" : "update",
        request,
        requestId,
        type: "agent_management_request",
      },
      seq: 0,
      sessionId: null,
      timestamp: new Date().toISOString(),
      turnId: null,
    };
    const agentPubkey = getPublicKey(context.secretKey);
    const encrypted = encryptObserverPayload(
      context.secretKey,
      ownerPubkey,
      payload,
    );
    const event = buildObserverFrame({
      agentPubkey,
      content: encrypted,
      frame: "telemetry",
      recipientPubkey: ownerPubkey,
      secretKey: context.secretKey,
    });
    const message = await context.relay.publish(event);
    return {
      accepted: true,
      action: action === "draft-create" ? "create" : "update",
      event_id: event.id,
      message:
        "Draft sent to Buzz Desktop for owner review. Nothing changes until the owner saves it.",
      relay_message: message,
      request_id: requestId,
      saved: false,
    };
  }
  if (
    resource === "agents" &&
    (action === "archive" || action === "unarchive")
  ) {
    const targetPubkey = hex64(
      requiredStringFrom(value, ["targetPubkey", "target"]),
      "targetPubkey",
    );
    const auth = await resolveIdentityOwnerAuth(context, targetPubkey);
    const common = {
      ...(auth ? { auth } : {}),
      content: optionalString(value.content) ?? "",
      ...(value.reason !== undefined
        ? { reason: requiredString(value.reason, "reason", true) }
        : {}),
      targetPubkey,
    };
    const built =
      action === "archive"
        ? buildArchiveIdentityRequest({
            ...common,
            ...(value.replacedBy !== undefined
              ? {
                  replacedBy: hex64(
                    requiredString(value.replacedBy, "replacedBy"),
                    "replacedBy",
                  ),
                }
              : {}),
          })
        : buildUnarchiveIdentityRequest(common);
    const event = signTemplateWithAuth(context, built, false);
    await context.relay.publish(event);
    return {
      action,
      event_id: event.id,
      ok: true,
      target: targetPubkey,
    };
  }
  if (resource === "agents" && action === "archived") {
    if (!context.relay.info) {
      throw new Error("relay information is unavailable");
    }
    const info = await context.relay.info();
    const relayPubkey = hex64(info.self, "relay self");
    const events = await context.relay.query([
      {
        authors: [relayPubkey],
        kinds: [KIND_IA_ARCHIVED_LIST],
        limit: 1,
      },
    ]);
    if (events.length === 0) return { archived: [] };
    const event = newestEvent(events);
    if (
      event.pubkey.toLowerCase() !== relayPubkey ||
      !verifyNostrEvent(event) ||
      event.tags.filter((tag) => tag[0] === "-").length !== 1
    ) {
      throw new Error("relay archived-identities snapshot failed verification");
    }
    return {
      archived: event.tags
        .filter(
          (tag) =>
            tag.length === 2 &&
            tag[0] === "p" &&
            /^[0-9a-f]{64}$/i.test(tag[1] ?? ""),
        )
        .map((tag) => (tag[1] as string).toLowerCase()),
      event_id: event.id,
      relay: relayPubkey,
    };
  }
  if (resource === "events" && action === "publish") {
    const event = value.event;
    if (!isNostrEventShape(event)) throw new TypeError("event is required");
    return publish(context, event);
  }
  if (resource === "events" && action === "query") {
    return context.relay.query(filtersInput(value));
  }
  if (resource === "events" && action === "count") {
    return { count: await context.relay.count(filterInput(value.filter)) };
  }
  if (resource === "feed" && action === "get") {
    const types = optionalString(value.types)
      ?.split(",")
      .map((item) => item.trim());
    const validTypes = new Set([
      "mentions",
      "needs_action",
      "activity",
      "agent_activity",
    ]);
    if (types?.some((type) => !validTypes.has(type))) {
      throw new TypeError(
        "feed types must be mentions, needs_action, activity, or agent_activity",
      );
    }
    const since = optionalInteger(value.since);
    return (
      await context.relay.query([
        {
          "#p": [getPublicKey(context.secretKey)],
          limit: Math.min(optionalInteger(value.limit) ?? 20, 50),
          ...(since !== undefined ? { since } : {}),
          ...(types ? { feed_types: types } : {}),
        },
      ])
    ).sort(
      (left, right) =>
        right.created_at - left.created_at || left.id.localeCompare(right.id),
    );
  }
  if (
    resource === "social" &&
    (action === "publish" || action === "publish-note")
  ) {
    const replyTo = optionalString(value.replyTo);
    return publishTemplate(
      context,
      buildNote(
        requiredString(value.content, "content", true),
        replyTo ? hex64(replyTo, "replyTo") : undefined,
      ),
    );
  }
  if (
    resource === "social" &&
    (action === "set-contacts" || action === "set-contact-list")
  ) {
    const contacts = parseJsonArray(value.contacts, "contacts").map(
      (entry, index) => {
        const contact = objectInput(entry);
        return {
          pubkey: hex64(contact.pubkey, `contacts[${index}].pubkey`),
          ...(optionalString(contact.relayUrl ?? contact.relay_url)
            ? {
                relayUrl: optionalString(
                  contact.relayUrl ?? contact.relay_url,
                ) as string,
              }
            : {}),
          ...(optionalString(contact.petname)
            ? { petname: optionalString(contact.petname) as string }
            : {}),
        };
      },
    );
    return publishTemplate(context, buildContactList(contacts));
  }
  if (resource === "social" && (action === "event" || action === "get-event")) {
    return context.relay.query([
      { ids: [hex64(value.event ?? value.eventId, "event")], limit: 1 },
    ]);
  }
  if (
    resource === "social" &&
    (action === "notes" || action === "get-user-notes")
  ) {
    const before = optionalInteger(value.before);
    const beforeId = optionalString(value.beforeId);
    return context.relay.query([
      {
        authors: [hex64(value.pubkey, "pubkey")],
        kinds: [1],
        limit: Math.min(optionalInteger(value.limit) ?? 50, 100),
        ...(before !== undefined ? { until: before } : {}),
        ...(beforeId ? { before_id: hex64(beforeId, "beforeId") } : {}),
      },
    ]);
  }
  if (
    resource === "social" &&
    (action === "contacts" || action === "get-contact-list")
  ) {
    return context.relay.query([
      {
        authors: [hex64(value.pubkey, "pubkey")],
        kinds: [3],
        limit: 1,
      },
    ]);
  }
  if (resource === "social" && action === "set-list") {
    const kind = requiredSupportedSocialKind(value.kind);
    const tags = parseTagMatrix(value.tags, "tags");
    if (
      (kind === 30_000 || kind === 30_003) &&
      !tags.some((tag) => tag[0] === "d")
    ) {
      throw new TypeError(`kind ${kind} requires a d tag`);
    }
    return publishTemplate(
      context,
      rawTemplate(kind, optionalString(value.content) ?? "", tags),
    );
  }
  if (resource === "social" && (action === "list" || action === "get-list")) {
    const kind = requiredSupportedSocialKind(value.kind);
    const dTag = optionalString(value.dTag);
    if (dTag && kind !== 30_000 && kind !== 30_003) {
      throw new TypeError(`kind ${kind} is not parameterized; omit dTag`);
    }
    return context.relay.query([
      {
        authors: [hex64(value.pubkey, "pubkey")],
        kinds: [kind],
        limit: 10,
        ...(dTag ? { "#d": [dTag] } : {}),
      },
    ]);
  }
  if (resource === "emoji" && action === "list") {
    return {
      emojis: unionCustomEmoji(
        await context.relay.query([
          { "#d": [CUSTOM_EMOJI_SET_D_TAG], kinds: [30_030] },
        ]),
      ),
    };
  }
  if (
    resource === "emoji" &&
    (action === "set" || action === "rm" || action === "import")
  ) {
    const own = await ownCustomEmoji(context);
    let next = own;
    if (action === "set") {
      const shortcode = normalizeCustomEmojiShortcode(
        requiredString(value.shortcode, "shortcode"),
      );
      next = [
        ...own.filter((entry) => entry.shortcode !== shortcode),
        {
          shortcode,
          url: requiredString(value.url, "url"),
        },
      ];
    } else if (action === "rm") {
      const shortcode = normalizeCustomEmojiShortcode(
        requiredString(value.shortcode, "shortcode"),
      );
      next = own.filter((entry) => entry.shortcode !== shortcode);
      if (next.length === own.length) {
        return { accepted: true, message: "not present" };
      }
    } else {
      const imported = customEmojiManifest(value);
      next = optionalBoolean(value.replace)
        ? imported
        : [
            ...own,
            ...imported.filter(
              (entry) =>
                !own.some(
                  (candidate) => candidate.shortcode === entry.shortcode,
                ),
            ),
          ];
      if (optionalBoolean(value.dryRun)) {
        return { dry_run: true, emojis: next };
      }
    }
    return publishTemplate(context, buildCustomEmojiSet(next));
  }
  if (resource === "emoji" && action === "export") {
    const scope = optionalString(value.scope) ?? "own";
    if (scope !== "own" && scope !== "workspace") {
      throw new TypeError("scope must be own or workspace");
    }
    return {
      emojis: (scope === "own"
        ? await ownCustomEmoji(context)
        : unionCustomEmoji(
            await context.relay.query([
              { "#d": [CUSTOM_EMOJI_SET_D_TAG], kinds: [30_030] },
            ]),
          )
      ).sort(
        (left, right) =>
          left.shortcode.localeCompare(right.shortcode) ||
          left.url.localeCompare(right.url),
      ),
    };
  }
  if (resource === "messages" && action === "send") {
    const broadcast = optionalBoolean(value.broadcast);
    const channelId = requiredStringFrom(value, ["channelId", "channel"]);
    const thread = await resolveThreadInput(value, context);
    const kind = optionalInteger(value.kind) ?? 9;
    const uploadedTags = await uploadMessageFiles(
      context,
      value.files ?? value.file,
    );
    const common = {
      channelId,
      content: requiredString(value.content, "content", true),
      mediaTags: [...optionalStringMatrix(value.mediaTags), ...uploadedTags],
      mentions: optionalStringArray(value.mentions),
    };
    const built =
      kind === 9
        ? buildMessage({
            ...common,
            ...(broadcast !== undefined ? { broadcast } : {}),
            ...(thread ? { thread } : {}),
          })
        : kind === 45_001
          ? buildForumPost(common)
          : kind === 45_003 && thread
            ? buildForumComment({ ...common, thread })
            : (() => {
                throw new TypeError(
                  kind === 45_003
                    ? "replyTo is required for forum comments"
                    : "kind must be 9, 45001, or 45003",
                );
              })();
    return publishTemplate(context, built);
  }
  if (resource === "messages" && (action === "list" || action === "get")) {
    const channelId = requiredStringFrom(value, ["channelId", "channel"]);
    const limit = optionalInteger(value.limit);
    const since = optionalInteger(value.since);
    const until = optionalInteger(value.before) ?? optionalInteger(value.until);
    return context.relay.query([
      {
        "#h": [channelId],
        kinds: commaSeparatedIntegers(value.kinds) ?? [
          9, 40_002, 40_008, 45_001, 45_003,
        ],
        limit: Math.min(limit ?? 50, 200),
        ...(since !== undefined ? { since } : {}),
        ...(until !== undefined ? { until } : {}),
      },
    ]);
  }
  if (resource === "messages" && action === "thread") {
    const channelId = requiredStringFrom(value, ["channelId", "channel"]);
    const eventId = requiredStringFrom(value, ["eventId", "event"]);
    const depthLimit = optionalInteger(value.depthLimit);
    return context.relay.query([
      {
        "#e": [eventId],
        "#h": [channelId],
        kinds: [9, 40_002, 40_003, 40_008, 45_003],
        limit: Math.min(optionalInteger(value.limit) ?? 100, 500),
        ...(depthLimit !== undefined ? { depth_limit: depthLimit } : {}),
      },
      { ids: [eventId], limit: 1 },
    ]);
  }
  if (resource === "messages" && action === "search") {
    const query = optionalString(value.query);
    const author = optionalString(value.author);
    if (!query && !author) throw new TypeError("query or author is required");
    const authorPubkey = author
      ? await resolveAuthorPubkey(context, author)
      : undefined;
    const since = optionalInteger(value.since);
    return context.relay.query([
      {
        kinds: [9, 40_002, 45_001, 45_003],
        limit: Math.min(optionalInteger(value.limit) ?? 20, 100),
        ...(query ? { search: query } : {}),
        ...(authorPubkey ? { authors: [authorPubkey] } : {}),
        ...(since !== undefined ? { since } : {}),
      },
    ]);
  }
  if (resource === "messages" && action === "send-diff") {
    const sourceBranch = optionalString(value.sourceBranch);
    const targetBranch = optionalString(value.targetBranch);
    if ((sourceBranch === undefined) !== (targetBranch === undefined)) {
      throw new TypeError(
        "sourceBranch and targetBranch must both be provided or both omitted",
      );
    }
    const filePath =
      optionalString(value.filePath) ?? optionalString(value.file);
    const description = optionalString(value.description);
    const diff = truncateUtf8(
      requiredString(value.diff, "diff", true),
      60 * 1024,
    );
    const thread = await resolveThreadInput(value, context);
    const language =
      optionalString(value.language) ?? optionalString(value.lang);
    const parentCommit = optionalString(value.parentCommit);
    const pullRequestNumber =
      optionalInteger(value.pullRequestNumber) ?? optionalInteger(value.pr);
    return publishTemplate(
      context,
      buildDiffMessage({
        altText: filePath
          ? `Diff: ${filePath}${description ? ` — ${description}` : ""}`
          : "Diff",
        channelId: requiredStringFrom(value, ["channelId", "channel"]),
        commitSha: requiredStringFrom(value, ["commitSha", "commit"]),
        content: diff.value,
        repoUrl: requiredStringFrom(value, ["repoUrl", "repo"]),
        ...(description ? { description } : {}),
        ...(filePath ? { filePath } : {}),
        ...(language ? { language } : {}),
        ...(parentCommit ? { parentCommit } : {}),
        ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
        ...(sourceBranch && targetBranch
          ? { branch: [sourceBranch, targetBranch] as const }
          : {}),
        ...(thread ? { thread } : {}),
        ...(diff.truncated ? { truncated: true } : {}),
      }),
    );
  }
  if (
    resource === "messages" &&
    (action === "edit" || action === "delete" || action === "vote")
  ) {
    const eventId = requiredStringFrom(value, ["eventId", "event"]);
    const channelId =
      optionalString(value.channelId) ??
      optionalString(value.channel) ??
      (await resolveEventChannel(context, eventId));
    if (action === "edit") {
      return publishTemplate(
        context,
        buildEdit(
          channelId,
          eventId,
          requiredString(value.content, "content", true),
        ),
      );
    }
    if (action === "delete") {
      const actionId = optionalString(value.actionId);
      const publicReason = optionalString(value.publicReason);
      const reasonCode = optionalString(value.reasonCode);
      return publishTemplate(
        context,
        buildDeleteMessage(channelId, eventId, {
          ...(actionId ? { actionId } : {}),
          ...(publicReason ? { publicReason } : {}),
          ...(reasonCode ? { reasonCode } : {}),
        }),
      );
    }
    const direction = requiredString(value.direction, "direction");
    if (direction !== "up" && direction !== "down") {
      throw new TypeError("direction must be up or down");
    }
    return publishTemplate(context, buildVote(channelId, eventId, direction));
  }
  if (resource === "channels" && action === "create") {
    const templateName = optionalString(value.template);
    if (templateName) {
      return createChannelFromTemplate(context, value, templateName);
    }
    const channelId = optionalString(value.channelId) ?? crypto.randomUUID();
    const channelType = requiredChannelType(
      value.channelType ?? value.type,
      false,
    );
    const visibility = requiredChannelVisibility(value.visibility);
    const result = await publishTemplate(
      context,
      buildCreateChannel({
        channelId,
        name: requiredString(value.name, "name"),
        ...(channelDescription(value) !== undefined
          ? { about: channelDescription(value) as string }
          : {}),
        channelType,
        ...(optionalPositiveInteger(value.ttl, "ttl") !== undefined
          ? { ttl: optionalPositiveInteger(value.ttl, "ttl") as number }
          : {}),
        visibility,
      }),
    );
    return { ...writeResultObject(result), channel_id: channelId };
  }
  if (resource === "channels" && action === "update") {
    const noTtl = optionalBoolean(value.noTtl) ?? false;
    if (noTtl && value.ttl !== undefined) {
      throw new TypeError("--ttl and --no-ttl cannot be used together");
    }
    return publishTemplate(
      context,
      buildUpdateChannel({
        channelId: requiredStringFrom(value, ["channelId", "channel"]),
        ...(value.about !== undefined || value.description !== undefined
          ? {
              about: requiredString(
                value.about ?? value.description,
                "description",
                true,
              ),
            }
          : {}),
        ...(value.name !== undefined
          ? { name: requiredString(value.name, "name", true) }
          : {}),
        ...(noTtl || value.ttl === null
          ? { ttl: null }
          : optionalPositiveInteger(value.ttl, "ttl") !== undefined
            ? { ttl: optionalPositiveInteger(value.ttl, "ttl") as number }
            : {}),
      }),
    );
  }
  if (resource === "channels" && action === "list") {
    const limit = Math.min(optionalInteger(value.limit) ?? 500, 10_000);
    const member = optionalBoolean(value.member) ?? false;
    let channelIds: string[] | undefined;
    if (member) {
      const membership = await queryPaginated(
        context,
        {
          "#p": [getPublicKey(context.secretKey)],
          kinds: [39_002],
        },
        limit,
      );
      channelIds = uniqueTagValues(membership, "d");
      if (channelIds.length === 0) return [];
    }
    const events = await queryPaginated(
      context,
      {
        ...(channelIds ? { "#d": channelIds } : {}),
        kinds: [39_000],
      },
      limit,
    );
    const visibility = optionalChannelVisibility(value.visibility);
    return events
      .filter(
        (event) =>
          !visibility ||
          channelMetadataVisibility(event) ===
            (visibility === "open" ? "public" : "private"),
      )
      .map(channelListProjection);
  }
  if (resource === "channels" && (action === "get" || action === "members")) {
    const channelId = requiredStringFrom(value, ["channelId", "channel"]);
    requiredUuid(channelId, "channel");
    const events = await context.relay.query([
      {
        "#d": [channelId],
        kinds: [action === "get" ? 39_000 : 39_002],
        limit: 1,
      },
    ]);
    const event = newestEvent(events, true);
    if (action === "members") {
      return event ? uniqueTagValues([event], "p") : [];
    }
    return event ? channelGetProjection(event) : null;
  }
  if (resource === "channels" && action === "search") {
    const query = requiredString(value.query, "query").trim();
    if (!query) throw new TypeError("query cannot be empty");
    const exact = optionalBoolean(value.exact) ?? false;
    const includeArchived = optionalBoolean(value.includeArchived) ?? false;
    const events = await queryPaginated(
      context,
      { kinds: [39_000] },
      Math.min(optionalInteger(value.limit) ?? 1_000, 10_000),
    );
    const needle = query.toLowerCase();
    return events
      .map(channelSearchProjection)
      .filter(
        (channel): channel is ChannelSearchProjection => channel !== undefined,
      )
      .filter((channel) => includeArchived || !channel.archived)
      .filter((channel) =>
        exact
          ? channel.name.toLowerCase() === needle
          : channel.name.toLowerCase().includes(needle),
      )
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.channel_id.localeCompare(right.channel_id),
      );
  }
  if (resource === "channels" && action === "topic") {
    return publishTemplate(
      context,
      buildSetTopic(
        requiredStringFrom(value, ["channelId", "channel"]),
        requiredString(value.topic, "topic", true),
      ),
    );
  }
  if (resource === "channels" && action === "purpose") {
    return publishTemplate(
      context,
      buildSetPurpose(
        requiredStringFrom(value, ["channelId", "channel"]),
        requiredString(value.purpose, "purpose", true),
      ),
    );
  }
  if (resource === "channels" && action === "set-add-policy") {
    const policy = requiredString(value.policy, "policy");
    if (!["anyone", "owner_only", "nobody"].includes(policy)) {
      throw new TypeError("policy must be anyone, owner_only, or nobody");
    }
    return publishTemplate(
      context,
      rawTemplate(10_100, JSON.stringify({ channel_add_policy: policy })),
    );
  }
  if (resource === "channels" && action === "add-member") {
    return publishTemplate(
      context,
      buildAddMember(
        requiredStringFrom(value, ["channelId", "channel"]),
        requiredString(value.pubkey, "pubkey"),
        optionalString(value.role) as
          | "owner"
          | "admin"
          | "member"
          | "guest"
          | "bot"
          | undefined,
      ),
    );
  }
  if (resource === "channels" && action === "remove-member") {
    return publishTemplate(
      context,
      buildRemoveMember(
        requiredStringFrom(value, ["channelId", "channel"]),
        requiredString(value.pubkey, "pubkey"),
      ),
    );
  }
  if (resource === "channels") {
    const channelId = requiredStringFrom(value, ["channelId", "channel"]);
    const channelCommands: Record<string, () => EventTemplate> = {
      archive: () => buildArchive(channelId),
      delete: () => buildDeleteChannel(channelId),
      join: () => buildJoin(channelId),
      leave: () => buildLeave(channelId),
      unarchive: () => buildUnarchive(channelId),
    };
    const build = channelCommands[action];
    if (build) return publishTemplate(context, build());
  }
  if (resource === "members" && action === "add") {
    return publishTemplate(
      context,
      buildAddMember(
        requiredStringFrom(value, ["channelId", "channel"]),
        requiredString(value.pubkey, "pubkey"),
        optionalString(value.role) as
          | "owner"
          | "admin"
          | "member"
          | "guest"
          | "bot"
          | undefined,
      ),
    );
  }
  if (resource === "members" && action === "remove") {
    return publishTemplate(
      context,
      buildRemoveMember(
        requiredStringFrom(value, ["channelId", "channel"]),
        requiredString(value.pubkey, "pubkey"),
      ),
    );
  }
  if (resource === "reactions" && action === "add") {
    const eventId = requiredStringFrom(value, ["eventId", "event"]);
    const template =
      value.shortcode !== undefined || value.emojiUrl !== undefined
        ? buildCustomEmojiReaction(
            eventId,
            optionalString(value.shortcode) ??
              requiredString(value.emoji, "emoji"),
            optionalString(value.url) ??
              requiredString(value.emojiUrl, "emojiUrl"),
          )
        : buildReaction(eventId, requiredString(value.emoji, "emoji"));
    return publishTemplate(context, template);
  }
  if (resource === "reactions" && action === "remove") {
    const eventId =
      optionalString(value.eventId) ?? optionalString(value.event);
    const emoji = optionalString(value.emoji);
    let reactionEventId = optionalString(value.reactionEventId);
    if (!reactionEventId && eventId && emoji) {
      const mine = getPublicKey(context.secretKey);
      const candidates = await context.relay.query([
        { "#e": [eventId], authors: [mine], kinds: [7] },
      ]);
      reactionEventId = candidates.find(
        (candidate) => candidate.content === emoji,
      )?.id;
    }
    if (!reactionEventId) throw new TypeError("reaction event was not found");
    return publishTemplate(context, buildRemoveReaction(reactionEventId));
  }
  if (resource === "reactions" && action === "get") {
    const events = await context.relay.query([
      {
        "#e": [requiredStringFrom(value, ["eventId", "event"])],
        kinds: [7],
      },
    ]);
    const grouped = new Map<string, string[]>();
    for (const event of events) {
      const emoji = event.content || "+";
      grouped.set(emoji, [...(grouped.get(emoji) ?? []), event.pubkey]);
    }
    return {
      reactions: [...grouped]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([emoji, pubkeys]) => ({
          count: pubkeys.length,
          emoji,
          pubkeys,
        })),
    };
  }
  if (resource === "profile" && action === "set") {
    return publishTemplate(
      context,
      buildProfile({
        ...(optionalString(value.about) !== undefined
          ? { about: optionalString(value.about) as string }
          : {}),
        ...(optionalString(value.displayName) !== undefined
          ? { displayName: optionalString(value.displayName) as string }
          : {}),
        ...(optionalString(value.name) !== undefined
          ? { name: optionalString(value.name) as string }
          : {}),
        ...(optionalString(value.nip05) !== undefined
          ? { nip05: optionalString(value.nip05) as string }
          : {}),
        ...(optionalString(value.picture) !== undefined
          ? { picture: optionalString(value.picture) as string }
          : {}),
      }),
    );
  }
  if (resource === "notes" && (action === "set" || action === "create")) {
    const slug = requiredNoteSlug(value.name ?? value.slug);
    const author = getPublicKey(context.secretKey);
    const priorEvent = newestEvent(
      await context.relay.query([
        {
          "#d": [slug],
          authors: [author],
          kinds: [30_023],
          limit: 1,
        },
      ]),
      true,
    );
    const prior = priorEvent ? noteSnapshot(priorEvent) : undefined;
    const title =
      value.title !== undefined
        ? requiredString(value.title, "title", true)
        : prior?.title;
    if (title === undefined) {
      throw new TypeError("title is required on first publish");
    }
    const summary =
      value.summary !== undefined
        ? requiredString(value.summary, "summary", true)
        : prior?.summary;
    const requestedTags = optionalStringArray(value.tags);
    if (optionalBoolean(value.clearTags) && requestedTags.length > 0) {
      throw new TypeError("clearTags is mutually exclusive with tags");
    }
    const tags = optionalBoolean(value.clearTags)
      ? []
      : requestedTags.length > 0
        ? requestedTags
        : (prior?.tags ?? []);
    const content = requiredString(value.content, "content", true);
    if (!content && !optionalBoolean(value.allowEmpty)) {
      throw new TypeError(
        "refusing to publish an empty note without allowEmpty",
      );
    }
    const now = Math.floor(Date.now() / 1_000);
    const eventTags = [
      ["d", slug],
      ["title", title],
      ...(summary !== undefined ? [["summary", summary]] : []),
      ...tags.map((tag) => ["t", tag]),
      ["published_at", String(prior?.publishedAt ?? now)],
    ];
    const event = signTemplate(
      rawTemplate(30_023, content, eventTags),
      context.secretKey,
      Math.max(now, (prior?.updatedAt ?? -1) + 1),
    );
    const message = await context.relay.publish(event);
    assertAuthoritativeWrite(
      message,
      "relay reported note as dominated by a newer head",
    );
    return {
      accepted: true,
      coordinate: `30023:${author}:${slug}`,
      event_id: event.id,
      message,
      naddr: nip19.naddrEncode({
        identifier: slug,
        kind: 30_023,
        pubkey: author,
        relays: [],
      }),
      slug,
      title,
    };
  }
  if (resource === "notes" && action === "get") {
    const coordinate = optionalString(value.naddr);
    const name = optionalString(value.name);
    if ((coordinate ? 1 : 0) + (name ? 1 : 0) !== 1) {
      throw new TypeError("exactly one of naddr or name is required");
    }
    const authorReference = optionalString(value.author);
    const latest = optionalBoolean(value.latest) ?? false;
    if (coordinate && (authorReference || latest)) {
      throw new TypeError("author and latest only apply with name");
    }
    if (authorReference && latest) {
      throw new TypeError("author and latest are mutually exclusive");
    }
    let events: NostrEvent[];
    if (coordinate) {
      const decoded = decodeLongFormCoordinate(coordinate);
      events = await context.relay.query([
        {
          "#d": [decoded.identifier],
          authors: [decoded.pubkey],
          kinds: [30_023],
          limit: 1,
        },
      ]);
    } else {
      const slug = requiredNoteSlug(name);
      const author = authorReference
        ? await resolveAuthorPubkey(context, authorReference)
        : undefined;
      events = await context.relay.query([
        {
          "#d": [slug],
          kinds: [30_023],
          limit: author ? 1 : 50,
          ...(author ? { authors: [author] } : {}),
        },
      ]);
      if (!author && events.length > 1 && !latest) {
        throw new TypeError(
          `note name ${JSON.stringify(slug)} is ambiguous; pass author or latest`,
        );
      }
    }
    const event = newestEvent(events, true);
    if (!event) throw new Error("note not found");
    const snapshot = noteSnapshot(event);
    return optionalBoolean(value.contentOnly) ? snapshot.content : snapshot;
  }
  if (resource === "notes" && (action === "ls" || action === "list")) {
    const authorReference = optionalString(value.author) ?? "me";
    const author =
      authorReference === "all"
        ? undefined
        : await resolveAuthorPubkey(context, authorReference);
    const tag = optionalString(value.tag);
    return (
      await context.relay.query([
        {
          kinds: [30_023],
          limit: Math.min(optionalInteger(value.limit) ?? 50, 200),
          ...(author ? { authors: [author] } : {}),
          ...(tag ? { "#t": [tag] } : {}),
        },
      ])
    )
      .map(noteSnapshot)
      .sort(
        (left, right) =>
          right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
      );
  }
  if (resource === "notes" && action === "rm") {
    const slug = requiredNoteSlug(value.name ?? value.slug);
    const author = getPublicKey(context.secretKey);
    const existing = await context.relay.query([
      {
        "#d": [slug],
        authors: [author],
        kinds: [30_023],
        limit: 1,
      },
    ]);
    if (existing.length === 0) throw new Error("note not found");
    return publishTemplate(
      context,
      rawTemplate(5, "", [["a", `30023:${author}:${slug}`]]),
    );
  }
  if (resource === "canvas" && action === "set") {
    return publishTemplate(
      context,
      buildSetCanvas(
        requiredStringFrom(value, ["channelId", "channel"]),
        requiredString(value.content, "content", true),
      ),
    );
  }
  if (resource === "canvas" && action === "get") {
    const events = await context.relay.query([
      {
        "#h": [requiredStringFrom(value, ["channelId", "channel"])],
        kinds: [40_100],
        limit: 1,
      },
    ]);
    return newestEvent(events, true)?.content ?? null;
  }
  if (resource === "presence" && action === "set") {
    return publishTemplate(
      context,
      buildPresenceUpdate(requiredString(value.status, "status")),
    );
  }
  if (resource === "dms" && action === "list") {
    return context.relay.query([
      {
        "#p": [getPublicKey(context.secretKey)],
        kinds: [41_001],
        limit: Math.min(optionalInteger(value.limit) ?? 50, 200),
      },
    ]);
  }
  if (resource === "dms" && action === "open") {
    const pubkeys = optionalStringArray(value.pubkeys);
    if (pubkeys.length < 1 || pubkeys.length > 8) {
      throw new TypeError("pubkeys must contain 1-8 identities");
    }
    const dmId = crypto.randomUUID();
    const built = buildDmOpen(pubkeys);
    const result = await publishTemplate(context, {
      ...built,
      tags: [...built.tags, ["d", dmId]],
    });
    return { ...(result as Record<string, unknown>), dm_id: dmId };
  }
  if (resource === "dms" && action === "add-member") {
    return publishTemplate(
      context,
      buildDmAddMember(
        requiredStringFrom(value, ["channelId", "channel"]),
        requiredString(value.pubkey, "pubkey"),
      ),
    );
  }
  if (resource === "dms" && action === "hide") {
    return publishTemplate(
      context,
      rawTemplate(41_012, "", [
        ["h", requiredStringFrom(value, ["channelId", "channel"])],
      ]),
    );
  }
  if (resource === "users" && action === "get") {
    const pubkeys = optionalStringArray(value.pubkeys);
    const name = optionalString(value.name);
    if (name && pubkeys.length > 0) {
      throw new TypeError("name and pubkeys are mutually exclusive");
    }
    return context.relay.query([
      {
        kinds: [0],
        limit: name ? 100 : Math.max(pubkeys.length, 1),
        ...(name ? { search: name } : {}),
        ...(!name
          ? {
              authors:
                pubkeys.length > 0
                  ? pubkeys
                  : [getPublicKey(context.secretKey)],
            }
          : {}),
      },
    ]);
  }
  if (resource === "users" && action === "set-profile") {
    const currentEvents = await context.relay.query([
      {
        authors: [getPublicKey(context.secretKey)],
        kinds: [0],
        limit: 1,
      },
    ]);
    const current = parseJsonObject(currentEvents[0]?.content);
    return publishTemplate(
      context,
      buildProfile({
        about:
          optionalString(value.about) ??
          optionalRecordString(current, "about") ??
          "",
        displayName:
          optionalString(value.name) ??
          optionalString(value.displayName) ??
          optionalRecordString(current, "display_name") ??
          optionalRecordString(current, "name") ??
          "",
        nip05:
          optionalString(value.nip05) ??
          optionalRecordString(current, "nip05") ??
          "",
        picture:
          optionalString(value.avatar) ??
          optionalString(value.picture) ??
          optionalRecordString(current, "picture") ??
          "",
      }),
    );
  }
  if (resource === "users" && action === "presence") {
    const pubkeys =
      typeof value.pubkeys === "string"
        ? value.pubkeys
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        : optionalStringArray(value.pubkeys);
    return context.relay.query([
      { authors: pubkeys, kinds: [40_902], limit: pubkeys.length },
    ]);
  }
  if (resource === "users" && action === "set-presence") {
    return publishTemplate(
      context,
      buildPresenceUpdate(requiredString(value.status, "status")),
    );
  }
  if (resource === "repos" && action === "create") {
    return publishTemplate(
      context,
      buildRepoAnnouncement({
        id: requiredStringFrom(value, ["id", "identifier"]),
        ...(value.name !== undefined
          ? { name: requiredString(value.name, "name", true) }
          : {}),
        ...(value.description !== undefined
          ? {
              description: requiredString(
                value.description,
                "description",
                true,
              ),
            }
          : {}),
        cloneUrls: optionalStringArray(value.cloneUrls),
        ...(value.web !== undefined
          ? { webUrl: requiredString(value.web, "web") }
          : {}),
        relays: optionalStringArray(value.relays),
      }),
    );
  }
  if (resource === "repos" && action === "get") {
    const owner = optionalString(value.owner);
    return context.relay.query([
      {
        "#d": [requiredRepoId(value.id ?? value.identifier)],
        kinds: [30_617],
        ...(owner ? { authors: [hex64(owner, "owner")] } : {}),
      },
    ]);
  }
  if (resource === "repos" && action === "list") {
    const owner =
      optionalString(value.owner) ?? getPublicKey(context.secretKey);
    return context.relay.query([
      {
        authors: [hex64(owner, "owner")],
        kinds: [30_617],
        ...(value.limit !== undefined
          ? { limit: boundedLimit(value.limit, 200) }
          : {}),
      },
    ]);
  }
  if (
    resource === "repos" &&
    ["protect-list", "protect-set", "protect-remove"].includes(action)
  ) {
    const repoId = requiredRepoId(value.id ?? value.identifier);
    const existing = newestEvent(
      await context.relay.query([
        {
          "#d": [repoId],
          authors: [getPublicKey(context.secretKey)],
          kinds: [30_617],
          limit: 1,
        },
      ]),
      true,
    );
    if (!existing) {
      throw new Error(`repository ${JSON.stringify(repoId)} was not found`);
    }
    if (action === "protect-list") {
      return repositoryProtectionView(existing);
    }
    const reference = requiredRefPattern(value.ref ?? value.refPattern);
    const retained = existing.tags
      .filter(
        (tag) =>
          tag[0] !== "auth" &&
          !(tag[0] === "buzz-protect" && tag[1] === reference),
      )
      .map((tag) => [...tag]);
    if (action === "protect-remove") {
      if (
        !existing.tags.some(
          (tag) => tag[0] === "buzz-protect" && tag[1] === reference,
        )
      ) {
        throw new Error(
          `repository has no protection rule for ${JSON.stringify(reference)}`,
        );
      }
    } else {
      const rule = ["buzz-protect", reference];
      const push = optionalString(value.push);
      if (push && !["owner", "admin", "member"].includes(push)) {
        throw new TypeError("push must be owner, admin, or member");
      }
      if (push) rule.push(`push:${push}`);
      if (optionalBoolean(value.noForcePush)) rule.push("no-force-push");
      if (optionalBoolean(value.noDelete)) rule.push("no-delete");
      if (optionalBoolean(value.requirePatch)) rule.push("require-patch");
      retained.push(rule);
    }
    const template = rawTemplate(30_617, existing.content, retained);
    const event = signTemplate(
      context.authTag
        ? {
            ...template,
            tags: [...template.tags, [...context.authTag]],
          }
        : template,
      context.secretKey,
      existing.created_at + 1,
    );
    const result = await publish(context, event);
    assertAuthoritativeWrite(
      (result as { readonly message?: unknown }).message,
      "repository changed concurrently; fetch the latest rules and retry",
    );
    return result;
  }
  if (resource === "patches" && action === "send") {
    return publishTemplate(
      context,
      buildGitPatch({
        repo: gitRepoFrom(value),
        content: requiredStringFrom(
          value,
          ["patch", "patchFile", "content"],
          true,
        ),
        ...(value.euc !== undefined
          ? { euc: requiredString(value.euc, "euc") }
          : {}),
        recipients: optionalStringArray(value.recipients),
        ...(value.replyTo !== undefined
          ? { replyTo: hex64(value.replyTo, "replyTo") }
          : {}),
        ...(value.root !== undefined
          ? { root: optionalBoolean(value.root) as boolean }
          : {}),
        ...(value.rootRevision !== undefined
          ? {
              rootRevision: optionalBoolean(value.rootRevision) as boolean,
            }
          : {}),
        ...(value.commit !== undefined
          ? { commit: requiredString(value.commit, "commit") }
          : {}),
        ...(value.parentCommit !== undefined
          ? {
              parentCommit: requiredString(value.parentCommit, "parentCommit"),
            }
          : {}),
        ...(value.commitPgpSig !== undefined
          ? {
              commitPgpSignature: requiredString(
                value.commitPgpSig,
                "commitPgpSig",
                true,
              ),
            }
          : {}),
        ...(value.committer !== undefined
          ? { committer: parseCommitter(value.committer) }
          : {}),
      }),
    );
  }
  if (
    (resource === "patches" || resource === "issues" || resource === "pr") &&
    action === "get"
  ) {
    const kind =
      resource === "patches" ? 1_617 : resource === "issues" ? 1_621 : 1_618;
    return context.relay.query([
      {
        ids: [hex64(value.event, "event")],
        kinds: [kind],
        limit: 1,
      },
    ]);
  }
  if (
    (resource === "patches" || resource === "issues" || resource === "pr") &&
    action === "list"
  ) {
    const repo = gitRepoFrom(value);
    const author = optionalString(value.author);
    const label = optionalString(value.label);
    return context.relay.query([
      {
        "#a": [`30617:${repo.owner}:${repo.id}`],
        kinds: [
          resource === "patches"
            ? 1_617
            : resource === "issues"
              ? 1_621
              : 1_618,
        ],
        ...(author ? { authors: [hex64(author, "author")] } : {}),
        ...(label && resource !== "patches" ? { "#t": [label] } : {}),
        ...(value.limit !== undefined
          ? { limit: boundedLimit(value.limit, 500) }
          : {}),
      },
    ]);
  }
  if (resource === "issues" && action === "create") {
    return publishTemplate(
      context,
      buildGitIssue({
        repo: gitRepoFrom(value),
        subject: requiredStringFrom(value, ["title", "subject"]),
        content: requiredString(value.content, "content", true),
        labels: optionalStringArray(value.labels),
        recipients: optionalStringArray(value.recipients),
      }),
    );
  }
  if (resource === "pr" && action === "open") {
    return publishTemplate(
      context,
      buildGitPullRequest({
        repo: gitRepoFrom(value),
        content: optionalString(value.body ?? value.content) ?? "",
        subject: requiredStringFrom(value, ["subject", "title"]),
        commit: requiredString(value.commit, "commit"),
        cloneUrls: nonEmptyStringArray(value.cloneUrls, "cloneUrls"),
        ...(value.branchName !== undefined
          ? {
              branchName: requiredString(value.branchName, "branchName"),
            }
          : {}),
        ...(value.mergeBase !== undefined
          ? { mergeBase: requiredString(value.mergeBase, "mergeBase") }
          : {}),
        ...(value.euc !== undefined
          ? { euc: requiredString(value.euc, "euc") }
          : {}),
        labels: optionalStringArray(value.labels),
        recipients: optionalStringArray(value.recipients),
        ...(value.channel !== undefined
          ? { channelId: requiredString(value.channel, "channel") }
          : {}),
        ...(value.revisionOf !== undefined
          ? { revisionOf: hex64(value.revisionOf, "revisionOf") }
          : {}),
      }),
    );
  }
  if (resource === "pr" && action === "update") {
    return publishTemplate(
      context,
      buildGitPullRequestUpdate({
        repo: gitRepoFrom(value),
        content: optionalString(value.body ?? value.content) ?? "",
        prEvent: hex64(value.pr, "pr"),
        prAuthor: hex64(value.prAuthor, "prAuthor"),
        commit: requiredString(value.commit, "commit"),
        cloneUrls: nonEmptyStringArray(value.cloneUrls, "cloneUrls"),
        ...(value.mergeBase !== undefined
          ? { mergeBase: requiredString(value.mergeBase, "mergeBase") }
          : {}),
        ...(value.euc !== undefined
          ? { euc: requiredString(value.euc, "euc") }
          : {}),
        recipients: optionalStringArray(value.recipients),
      }),
    );
  }
  if (["patches", "issues", "pr"].includes(resource) && action === "status") {
    const rootEvent = hex64(
      value.root ?? value.issue ?? value.pr,
      resource === "patches" ? "root" : resource,
    );
    const status = requiredGitStatus(value.status, resource);
    const repo = optionalGitRepoFrom(value);
    const recipients = optionalStringArray(value.recipients);
    if (repo && !recipients.includes(repo.owner))
      recipients.unshift(repo.owner);
    return publishTemplate(
      context,
      buildGitStatus({
        status,
        rootEvent,
        content: optionalString(value.content ?? value.body) ?? "",
        ...(value.revision !== undefined
          ? { revision: hex64(value.revision, "revision") }
          : {}),
        ...(repo ? { repo } : {}),
        ...(value.euc !== undefined
          ? { euc: requiredString(value.euc, "euc") }
          : {}),
        recipients,
        appliedPatches: optionalStringArray(value.appliedPatches).map(
          parseAppliedPatchReference,
        ),
        ...(value.mergeCommit !== undefined
          ? {
              mergeCommit: requiredString(value.mergeCommit, "mergeCommit"),
            }
          : {}),
        appliedAsCommits: optionalStringArray(value.appliedAsCommits),
      }),
    );
  }
  if (
    resource === "moderation" &&
    ["reports", "restricted", "audit"].includes(action)
  ) {
    if (!context.relay.getAuthed) {
      throw new Error("authenticated relay HTTP is unavailable");
    }
    const limit =
      action === "restricted"
        ? undefined
        : boundedLimit(value.limit ?? 50, 500);
    const status = optionalString(value.status);
    if (
      action === "reports" &&
      status &&
      !["open", "resolved", "dismissed", "escalated"].includes(status)
    ) {
      throw new TypeError("report status is invalid");
    }
    const parameters = new URLSearchParams();
    if (limit !== undefined) parameters.set("limit", String(limit));
    if (status) parameters.set("status", status);
    return context.relay.getAuthed(
      `/moderation/${action}${parameters.size ? `?${parameters}` : ""}`,
      context.authTag,
    );
  }
  if (
    resource === "moderation" &&
    ["ban", "unban", "timeout", "untimeout", "resolve"].includes(action)
  ) {
    if (action === "resolve") {
      const status = requiredString(value.status, "status");
      const resolutionAction = requiredString(value.action, "action");
      if (!["resolved", "dismissed"].includes(status)) {
        throw new TypeError("status must be resolved or dismissed");
      }
      if (
        !["delete", "kick", "ban", "timeout", "dismiss", "escalate"].includes(
          resolutionAction,
        )
      ) {
        throw new TypeError("moderation resolution action is invalid");
      }
      const tags = [
        ["report", hex64(value.report, "report")],
        ["status", status],
        ["action", resolutionAction],
      ];
      if (value.reason !== undefined) {
        tags.push(["reason", requiredString(value.reason, "reason", true)]);
      }
      return publishTemplate(context, rawTemplate(9_044, "", tags));
    }
    const target = hex64(value.pubkey, "pubkey");
    const kind = {
      ban: 9_040,
      unban: 9_041,
      timeout: 9_042,
      untimeout: 9_043,
    }[action] as number;
    const tags = [["p", target]];
    if (action === "ban" || action === "timeout") {
      const expiresIn = optionalInteger(value.expiresIn);
      const expiresAt = optionalInteger(value.expiresAt);
      if (expiresIn !== undefined && expiresAt !== undefined) {
        throw new TypeError("expiresIn and expiresAt are mutually exclusive");
      }
      const expiry =
        expiresIn !== undefined
          ? Math.floor(Date.now() / 1_000) + expiresIn
          : expiresAt;
      if (action === "timeout" && expiry === undefined) {
        throw new TypeError("timeout requires expiresIn or expiresAt");
      }
      if (expiry !== undefined) tags.push(["expiration", String(expiry)]);
      if (value.reason !== undefined) {
        tags.push(["reason", requiredString(value.reason, "reason", true)]);
      }
    }
    return publishTemplate(context, rawTemplate(kind, "", tags));
  }
  if (
    resource === "mem" &&
    ["ls", "get", "hash", "set", "patch", "rm"].includes(action)
  ) {
    const slug =
      action === "ls"
        ? undefined
        : normalizeEngramSlug(requiredString(value.slug, "slug"));
    const reader = resolveEngramReader(context, value, action);
    if (action === "ls") {
      const candidates = await context.relay.query([
        {
          "#p": [reader.owner],
          authors: [reader.agent],
          kinds: [KIND_AGENT_ENGRAM],
          limit: 5_000,
        },
      ]);
      const groups = new Map<
        string,
        Array<{
          readonly body: ReturnType<typeof validateAndDecryptEngram>;
          readonly event: NostrEvent;
        }>
      >();
      for (const event of candidates) {
        const validated = tryValidateEngram(context, reader, event);
        if (!validated) continue;
        const d = event.tags.find((tag) => tag[0] === "d")?.[1];
        if (!d) continue;
        groups.set(d, [...(groups.get(d) ?? []), validated]);
      }
      return [...groups.values()]
        .flatMap((group) => {
          const head = selectEngramHead(group);
          if (
            !head ||
            head.body.slug === "core" ||
            !("value" in head.body) ||
            head.body.value === null
          ) {
            return [];
          }
          return [
            {
              created_at: head.event.created_at,
              event_id: head.event.id,
              slug: head.body.slug,
            },
          ];
        })
        .sort((left, right) => left.slug.localeCompare(right.slug));
    }
    const head = await fetchEngramHead(context, reader, slug as string);
    if (action === "get" || action === "hash") {
      const body = head?.body;
      const current =
        body && "profile" in body
          ? body.profile
          : body && "value" in body && body.value !== null
            ? body.value
            : undefined;
      if (current === undefined) throw new Error("memory not found");
      return action === "hash"
        ? createHash("sha256").update(current, "utf8").digest("hex")
        : current;
    }
    if (action === "rm" && slug === "core") {
      throw new TypeError("core cannot be tombstoned");
    }
    let nextValue: string | null;
    if (action === "rm") {
      nextValue = null;
    } else if (action === "set") {
      nextValue = requiredString(value.value, "value", true);
      if (!nextValue && !optionalBoolean(value.allowEmpty)) {
        throw new TypeError(
          "refusing to write an empty memory without allowEmpty",
        );
      }
    } else {
      const body = head?.body;
      const current =
        body && "profile" in body
          ? body.profile
          : body && "value" in body && body.value !== null
            ? body.value
            : undefined;
      if (current === undefined) throw new Error("memory not found");
      const baseHash = optionalString(value.baseHash);
      const noBaseHash = optionalBoolean(value.noBaseHash) ?? false;
      if ((baseHash ? 1 : 0) + (noBaseHash ? 1 : 0) !== 1) {
        throw new TypeError("provide exactly one of baseHash or noBaseHash");
      }
      if (
        baseHash &&
        createHash("sha256").update(current, "utf8").digest("hex") !==
          hex64(baseHash, "baseHash")
      ) {
        throw new Error(
          "conflict: memory changed since the patch was generated; re-fetch and regenerate the patch",
        );
      }
      nextValue = applyStrictUnifiedDiff(
        current,
        requiredStringFrom(value, ["patch", "patchFile"], true),
      );
      if (!nextValue && !optionalBoolean(value.allowEmpty)) {
        throw new TypeError(
          "refusing to write an empty patch result without allowEmpty",
        );
      }
      if (optionalBoolean(value.dryRun)) {
        return {
          dry_run: true,
          sha256: createHash("sha256").update(nextValue, "utf8").digest("hex"),
          slug,
          value: nextValue,
        };
      }
    }
    const owner = resolveEngramOwner(context, value.owner);
    const now = Math.floor(Date.now() / 1_000);
    const event = buildEngramEvent({
      agentSecretKey: context.secretKey,
      body:
        slug === "core"
          ? { profile: nextValue as string, slug: "core" }
          : { slug: slug as string, value: nextValue },
      createdAt: monotonicEngramCreatedAt(now, head?.event.created_at),
      ownerPubkey: owner,
    });
    const message = await context.relay.publish(event);
    assertAuthoritativeWrite(
      message,
      "relay reported memory as dominated by a newer head",
    );
    return {
      accepted: true,
      created_at: event.created_at,
      event_id: event.id,
      message,
      slug,
    };
  }
  if (resource === "upload" && action === "file") {
    if (!context.relay.uploadFile) {
      throw new Error("media upload is unavailable");
    }
    return context.relay.uploadFile(requiredString(value.file, "file"));
  }
  if (resource === "media" && action === "get") {
    if (!context.relay.downloadMedia) {
      throw new Error("media download is unavailable");
    }
    const output = optionalString(value.output);
    return context.relay.downloadMedia(
      requiredStringFrom(value, ["input", "url", "media"]),
      output,
    );
  }
  if (
    resource === "workflows" &&
    (action === "create" || action === "update")
  ) {
    const workflowId =
      action === "create"
        ? (optionalString(value.workflowId) ?? crypto.randomUUID())
        : requiredString(value.workflowId, "workflowId");
    return publishTemplate(
      context,
      buildWorkflowDefinition({
        channelId: requiredStringFrom(value, ["channelId", "channel"]),
        workflowId,
        yaml: requiredString(value.yaml, "yaml"),
      }),
    );
  }
  if (resource === "workflows" && action === "delete") {
    return publishTemplate(
      context,
      buildWorkflowDelete(
        getPublicKey(context.secretKey),
        requiredString(value.workflowId, "workflowId"),
      ),
    );
  }
  if (resource === "workflows" && action === "trigger") {
    return publishTemplate(
      context,
      buildWorkflowTrigger(
        requiredString(value.workflowId, "workflowId"),
        optionalObject(value.inputs),
      ),
    );
  }
  if (resource === "workflows" && action === "approve") {
    return publishTemplate(
      context,
      buildWorkflowApproval(
        requiredString(value.token, "token"),
        requiredBoolean(value.approved, "approved"),
        optionalString(value.note) ?? "",
      ),
    );
  }
  if (resource === "workflows" && action === "list") {
    const channelId = requiredString(value.channelId, "channelId");
    return context.relay.query([
      {
        "#h": [channelId],
        kinds: [30_620],
        limit: optionalInteger(value.limit) ?? 100,
      },
    ]);
  }
  if (resource === "workflows" && action === "get") {
    return context.relay.query([
      {
        "#d": [requiredString(value.workflowId, "workflowId")],
        kinds: [30_620],
        limit: 1,
      },
    ]);
  }
  if (resource === "workflows" && action === "runs") {
    return context.relay.query([
      {
        "#d": [requiredString(value.workflowId, "workflowId")],
        kinds: [46_001, 46_002, 46_003, 46_004, 46_005, 46_006, 46_007],
        limit: optionalInteger(value.limit) ?? 20,
      },
    ]);
  }
  if (resource === "remote" && action === "invite") {
    const lifetimeSeconds = optionalInteger(value.lifetimeSeconds);
    return createEnrollmentInvitation({
      allowInsecureLocalhost: context.allowInsecureLocalhost,
      ...(value.capabilities
        ? {
            capabilities: capabilityArray(value.capabilities),
          }
        : {}),
      ...(lifetimeSeconds !== undefined ? { lifetimeSeconds } : {}),
      ownerSecretKey: context.secretKey,
      relayUrl: context.relayUrl,
    });
  }
  if (resource === "remote" && action === "revoke") {
    await revokeRemoteWorker({
      allowInsecureLocalhost: context.allowInsecureLocalhost,
      ownerSecretKey: context.secretKey,
      relayUrl: context.relayUrl,
      workerPubkey: requiredString(value.workerPubkey, "workerPubkey"),
    });
    return { revoked: true };
  }
  throw new Error(`unsupported command: ${resource} ${action}`);
}

type UploadDescriptor = {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly type: string;
  readonly dim?: string;
  readonly blurhash?: string;
  readonly thumb?: string;
  readonly duration?: number;
};

async function uploadMessageFiles(
  context: CommandContext,
  rawFiles: unknown,
): Promise<string[][]> {
  const files = stringList(rawFiles, "file", 32);
  if (files.length === 0) return [];
  if (!context.relay.uploadFile) {
    throw new Error("media upload is unavailable");
  }
  const tags: string[][] = [];
  for (const file of files) {
    const descriptor = uploadDescriptor(await context.relay.uploadFile(file));
    const tag = [
      "imeta",
      `url ${descriptor.url}`,
      `m ${descriptor.type}`,
      `x ${descriptor.sha256}`,
      `size ${descriptor.size}`,
    ];
    if (descriptor.dim) tag.push(`dim ${descriptor.dim}`);
    if (descriptor.blurhash) tag.push(`blurhash ${descriptor.blurhash}`);
    if (descriptor.thumb) tag.push(`thumb ${descriptor.thumb}`);
    if (descriptor.duration !== undefined) {
      tag.push(`duration ${descriptor.duration}`);
    }
    tags.push(tag);
  }
  return tags;
}

function uploadDescriptor(value: unknown): UploadDescriptor {
  const input = objectInput(value);
  const url = requiredString(input.url, "upload url");
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new TypeError("upload url must use http or https");
  }
  const type = requiredString(input.type, "upload type");
  if (
    ![
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "video/mp4",
    ].includes(type)
  ) {
    throw new TypeError("upload response contains an unsupported media type");
  }
  const size = optionalInteger(input.size);
  if (size === undefined) throw new TypeError("upload size is required");
  const duration =
    input.duration === undefined
      ? undefined
      : typeof input.duration === "number" &&
          Number.isFinite(input.duration) &&
          input.duration >= 0
        ? input.duration
        : (() => {
            throw new TypeError("upload duration is invalid");
          })();
  return {
    ...(input.blurhash !== undefined
      ? { blurhash: requiredString(input.blurhash, "blurhash") }
      : {}),
    ...(input.dim !== undefined
      ? { dim: requiredString(input.dim, "dimensions") }
      : {}),
    ...(duration !== undefined ? { duration } : {}),
    sha256: hex64(input.sha256, "upload sha256"),
    size,
    ...(input.thumb !== undefined
      ? { thumb: requiredString(input.thumb, "thumbnail url") }
      : {}),
    type,
    url,
  };
}

type ChannelTemplateRecord = {
  readonly name: string;
  readonly description?: string;
  readonly channelType: "stream" | "forum";
  readonly visibility: "open" | "private";
  readonly canvasTemplate?: string;
  readonly personas: readonly string[];
  readonly teams: readonly string[];
};

type ResolvedTemplateAgent = {
  readonly persona_id: string;
  readonly pubkey: string;
};

type TemplateRosterResolution = {
  readonly agents: readonly ResolvedTemplateAgent[];
  readonly archived_excluded: readonly ResolvedTemplateAgent[];
  readonly skipped: readonly {
    readonly persona_id: string;
    readonly reason: string;
  }[];
  readonly archive_state_warning?: string;
};

async function createChannelFromTemplate(
  context: CommandContext,
  value: Record<string, unknown>,
  templateName: string,
): Promise<unknown> {
  const template = await loadChannelTemplate(
    templateName,
    optionalString(value.templatesFile),
  );
  const channelType =
    value.channelType !== undefined || value.type !== undefined
      ? requiredChannelType(value.channelType ?? value.type, false)
      : template.channelType;
  const visibility =
    value.visibility !== undefined
      ? requiredChannelVisibility(value.visibility)
      : template.visibility;
  const description = channelDescription(value) ?? template.description;
  const ttl = optionalPositiveInteger(value.ttl, "ttl");
  if (ttl !== undefined && ttl > 2_147_483_647) {
    throw new TypeError("ttl is too large (maximum 2147483647 seconds)");
  }
  const name = requiredString(value.name, "name");
  const owner = effectiveOwnerPubkey(context);

  // Resolve every ambiguous dependency before the first write.
  const roster = await resolveTemplateRoster(context, owner, template);
  const channelId = optionalString(value.channelId) ?? crypto.randomUUID();
  await publishTemplate(
    context,
    buildCreateChannel({
      ...(description !== undefined ? { about: description } : {}),
      channelId,
      channelType,
      name,
      ...(ttl !== undefined ? { ttl } : {}),
      visibility,
    }),
  );

  let canvasApplied = false;
  if (template.canvasTemplate !== undefined) {
    const content = template.canvasTemplate
      .replaceAll("{channel.name}", name)
      .replaceAll("{template.name}", template.name);
    try {
      await publishTemplate(context, buildSetCanvas(channelId, content));
      canvasApplied = true;
    } catch {
      // The original desktop contract treats canvas application as best effort.
    }
  }

  const membersAdded: ResolvedTemplateAgent[] = [];
  const memberFailures: Array<
    ResolvedTemplateAgent & { readonly error: string }
  > = [];
  for (const agent of roster.agents) {
    try {
      await publishTemplate(
        context,
        buildAddMember(channelId, agent.pubkey, "bot"),
      );
      membersAdded.push(agent);
    } catch (error) {
      memberFailures.push({
        ...agent,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ...(roster.archive_state_warning
      ? { archive_state_warning: roster.archive_state_warning }
      : {}),
    archived_excluded: roster.archived_excluded,
    canvas_applied: canvasApplied,
    channel_id: channelId,
    member_failures: memberFailures,
    members_added: membersAdded,
    skipped: roster.skipped,
    status: memberFailures.length === 0 ? "ok" : "partial",
    template: template.name,
  };
}

async function loadChannelTemplate(
  requestedName: string,
  overridePath?: string,
): Promise<ChannelTemplateRecord> {
  const path = overridePath ?? defaultChannelTemplatesPath();
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code === "ENOENT") {
      throw new Error(
        `no channel templates store found at ${path} (create a template in Buzz Desktop first, or pass --templates-file)`,
      );
    }
    throw new Error(
      `failed to read channel templates at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (raw.byteLength > 4 * 1024 * 1024) {
    throw new TypeError("channel templates store exceeds 4 MiB");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new TypeError(`failed to parse channel templates at ${path}`);
  }
  if (!Array.isArray(parsed) || parsed.length > 10_000) {
    throw new TypeError("channel templates store must be a bounded JSON array");
  }
  const records = parsed.map(parseChannelTemplate);
  const needle = requestedName.toLowerCase();
  const found = records.find((record) => record.name.toLowerCase() === needle);
  if (!found) {
    throw new Error(
      `no channel template named '${requestedName}' (available: ${
        records.length
          ? records.map((record) => record.name).join(", ")
          : "<none>"
      })`,
    );
  }
  return found;
}

function defaultChannelTemplatesPath(): string {
  const bundle = "xyz.block.buzz.app";
  const dataDirectory =
    platform() === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : platform() === "win32"
        ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
        : (process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));
  return join(dataDirectory, bundle, "templates", "channel-templates.json");
}

function parseChannelTemplate(
  value: unknown,
  index: number,
): ChannelTemplateRecord {
  const record = objectInput(value);
  const agents =
    record.agents === undefined ? {} : optionalObject(record.agents);
  const personas = parseTemplateRosterEntries(
    agents.personas,
    "personaId",
    `templates[${index}].agents.personas`,
  );
  const teams = parseTemplateRosterEntries(
    agents.teams,
    "teamId",
    `templates[${index}].agents.teams`,
  );
  return {
    ...(record.canvas_template !== undefined && record.canvas_template !== null
      ? {
          canvasTemplate: requiredString(
            record.canvas_template,
            `templates[${index}].canvas_template`,
            true,
          ),
        }
      : {}),
    channelType:
      record.channel_type === undefined
        ? "stream"
        : requiredChannelType(record.channel_type, false),
    ...(record.description !== undefined && record.description !== null
      ? {
          description: requiredString(
            record.description,
            `templates[${index}].description`,
            true,
          ),
        }
      : {}),
    name: boundedRequiredString(record.name, `templates[${index}].name`, 256),
    personas,
    teams,
    visibility:
      record.visibility === undefined
        ? "open"
        : requiredChannelVisibility(record.visibility),
  };
}

function parseTemplateRosterEntries(
  value: unknown,
  key: "personaId" | "teamId",
  name: string,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new TypeError(`${name} must be a bounded array`);
  }
  const unique = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const record = objectInput(raw);
    unique.add(
      boundedRequiredString(record[key], `${name}[${index}].${key}`, 256),
    );
  }
  return [...unique];
}

async function resolveTemplateRoster(
  context: CommandContext,
  owner: string,
  template: ChannelTemplateRecord,
): Promise<TemplateRosterResolution> {
  const slugs = new Set(template.personas);
  for (const teamId of template.teams) {
    const teams = await context.relay.query([
      {
        "#d": [teamId],
        authors: [owner],
        kinds: [KIND_TEAM],
        limit: 1,
      },
    ]);
    const team = newestEvent(teams, true);
    if (!team) {
      throw new Error(
        `team '${teamId}' not found for effective owner ${owner}`,
      );
    }
    const content = parseJsonObject(team.content);
    for (const slug of stringList(content.persona_ids, "persona_ids", 1_000)) {
      slugs.add(slug);
    }
  }
  if (slugs.size === 0) {
    return { agents: [], archived_excluded: [], skipped: [] };
  }

  const managed = await queryPaginated(
    context,
    { authors: [owner], kinds: [KIND_MANAGED_AGENT] },
    10_000,
  );
  const found: ResolvedTemplateAgent[] = [];
  for (const event of managed) {
    const pubkey = firstTagValue(event, "d");
    if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) continue;
    const personaId = parseJsonObject(event.content).persona_id;
    if (typeof personaId === "string" && slugs.has(personaId)) {
      found.push({
        persona_id: personaId,
        pubkey: pubkey.toLowerCase(),
      });
    }
  }

  const archivedResult = await trustedArchivedIdentities(context);
  const archivedExcluded = found.filter((agent) =>
    archivedResult.archived.has(agent.pubkey),
  );
  const live = found.filter(
    (agent) => !archivedResult.archived.has(agent.pubkey),
  );
  const agents: ResolvedTemplateAgent[] = [];
  const skipped: Array<{ persona_id: string; reason: string }> = [];
  for (const slug of slugs) {
    const matches = live.filter((agent) => agent.persona_id === slug);
    if (matches.length > 1) {
      throw new TypeError(
        `persona '${slug}' has ${matches.length} live instances for this owner (${matches
          .map((agent) => agent.pubkey)
          .join(
            ", ",
          )}); resolve the duplicate in Buzz Desktop before creating the channel${
          archivedResult.warning ? ` (warning: ${archivedResult.warning})` : ""
        }`,
      );
    }
    if (matches[0]) {
      agents.push(matches[0]);
    } else {
      skipped.push({
        persona_id: slug,
        reason: archivedExcluded.some((agent) => agent.persona_id === slug)
          ? "all instances archived"
          : "no live instances",
      });
    }
  }
  return {
    ...(archivedResult.warning
      ? { archive_state_warning: archivedResult.warning }
      : {}),
    agents,
    archived_excluded: archivedExcluded,
    skipped,
  };
}

async function trustedArchivedIdentities(context: CommandContext): Promise<{
  readonly archived: ReadonlySet<string>;
  readonly warning?: string;
}> {
  try {
    if (!context.relay.info) {
      throw new Error("relay information is unavailable");
    }
    const info = await context.relay.info();
    const relayPubkey = hex64(info.self, "relay self");
    const events = await context.relay.query([
      {
        authors: [relayPubkey],
        kinds: [KIND_IA_ARCHIVED_LIST],
        limit: 1,
      },
    ]);
    const event = newestEvent(events, true);
    if (!event) return { archived: new Set() };
    if (
      event.pubkey.toLowerCase() !== relayPubkey ||
      !verifyNostrEvent(event) ||
      event.tags.filter((tag) => tag[0] === "-").length !== 1
    ) {
      throw new Error("relay archived-identities snapshot failed verification");
    }
    return {
      archived: new Set(
        uniqueTagValues([event], "p")
          .filter((pubkey) => /^[0-9a-f]{64}$/i.test(pubkey))
          .map((pubkey) => pubkey.toLowerCase()),
      ),
    };
  } catch (error) {
    return {
      archived: new Set(),
      warning: `archived-identities snapshot untrusted, proceeding without archive filtering: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

type ChannelSearchProjection = {
  readonly channel_id: string;
  readonly name: string;
  readonly channel_type?: string;
  readonly visibility?: string;
  readonly archived: boolean;
  readonly about?: string;
  readonly topic?: string;
  readonly purpose?: string;
};

function channelListProjection(event: NostrEvent): Record<string, unknown> {
  return {
    channel_id: firstTagValue(event, "d") ?? "",
    name: firstTagValue(event, "name") ?? "",
    description: firstTagValue(event, "about") ?? null,
    created_at: event.created_at,
  };
}

function channelGetProjection(event: NostrEvent): Record<string, unknown> {
  return { ...channelListProjection(event), pubkey: event.pubkey };
}

function channelSearchProjection(
  event: NostrEvent,
): ChannelSearchProjection | undefined {
  const channelId = firstTagValue(event, "d");
  const name = firstTagValue(event, "name");
  if (!channelId || !name) return undefined;
  const channelType =
    firstTagValue(event, "t") ?? firstTagValue(event, "channel_type");
  const visibility = channelMetadataVisibility(event);
  const about = firstTagValue(event, "about");
  const topic = firstTagValue(event, "topic");
  const purpose = firstTagValue(event, "purpose");
  return {
    ...(about !== undefined ? { about } : {}),
    archived: firstTagValue(event, "archived") === "true",
    channel_id: channelId,
    ...(channelType !== undefined ? { channel_type: channelType } : {}),
    name,
    ...(purpose !== undefined ? { purpose } : {}),
    ...(topic !== undefined ? { topic } : {}),
    ...(visibility !== undefined ? { visibility } : {}),
  };
}

function channelMetadataVisibility(event: NostrEvent): string | undefined {
  if (event.tags.some((tag) => tag.length === 1 && tag[0] === "private")) {
    return "private";
  }
  if (event.tags.some((tag) => tag.length === 1 && tag[0] === "public")) {
    return "public";
  }
  const explicit = firstTagValue(event, "visibility");
  return explicit === "open" ? "public" : explicit;
}

function channelDescription(
  value: Record<string, unknown>,
): string | undefined {
  const raw = value.description ?? value.about;
  return raw === undefined
    ? undefined
    : requiredString(raw, "description", true);
}

function requiredChannelType(
  value: unknown,
  allowExtended: boolean,
): "stream" | "forum" {
  const input = requiredString(value, "type");
  if (input === "stream" || input === "forum") return input;
  if (allowExtended && (input === "dm" || input === "workflow")) {
    throw new TypeError("channel templates support only stream or forum");
  }
  throw new TypeError("type must be stream or forum");
}

function optionalChannelVisibility(
  value: unknown,
): "open" | "private" | undefined {
  return value === undefined ? undefined : requiredChannelVisibility(value);
}

function requiredChannelVisibility(value: unknown): "open" | "private" {
  const input = requiredString(value, "visibility");
  if (input === "open" || input === "private") return input;
  throw new TypeError("visibility must be open or private");
}

function optionalPositiveInteger(
  value: unknown,
  name: string,
): number | undefined {
  const parsed = optionalInteger(value);
  if (parsed !== undefined && parsed < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return parsed;
}

function effectiveOwnerPubkey(context: CommandContext): string {
  const owner =
    context.authTag?.[0] === "auth" ? context.authTag[1] : undefined;
  return owner && /^[0-9a-f]{64}$/i.test(owner)
    ? owner.toLowerCase()
    : getPublicKey(context.secretKey);
}

function firstTagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find(
    (tag) => tag[0] === name && typeof tag[1] === "string",
  )?.[1];
}

function uniqueTagValues(
  events: readonly NostrEvent[],
  name: string,
): string[] {
  return [
    ...new Set(
      events.flatMap((event) =>
        event.tags
          .filter((tag) => tag[0] === name && typeof tag[1] === "string")
          .map((tag) => tag[1] as string),
      ),
    ),
  ];
}

async function queryPaginated(
  context: CommandContext,
  filter: NostrFilter,
  maximum: number,
): Promise<NostrEvent[]> {
  const result: NostrEvent[] = [];
  const seen = new Set<string>();
  let cursor: { readonly createdAt: number; readonly id: string } | undefined;
  while (result.length < maximum) {
    const pageSize = Math.min(500, maximum - result.length);
    const page = await context.relay.query([
      {
        ...filter,
        ...(cursor ? { before_id: cursor.id, until: cursor.createdAt } : {}),
        limit: pageSize,
      },
    ]);
    for (const event of page) {
      if (!seen.has(event.id)) {
        seen.add(event.id);
        result.push(event);
      }
    }
    if (page.length < pageSize) break;
    const oldest = [...page].sort(
      (left, right) =>
        left.created_at - right.created_at || right.id.localeCompare(left.id),
    )[0];
    if (!oldest) break;
    const next = { createdAt: oldest.created_at, id: oldest.id };
    if (
      cursor &&
      cursor.createdAt === next.createdAt &&
      cursor.id === next.id
    ) {
      break;
    }
    cursor = next;
  }
  return result;
}

function stringList(value: unknown, name: string, maximum: number): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (
    values.length > maximum ||
    !values.every(
      (item) =>
        typeof item === "string" && Buffer.byteLength(item, "utf8") <= 16_384,
    )
  ) {
    throw new TypeError(`${name} must be a bounded string or string array`);
  }
  return values as string[];
}

function writeResultObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("relay write returned an invalid result");
  }
  return value as Record<string, unknown>;
}

function capabilityArray(value: unknown): RemoteCapability[] {
  return optionalStringArray(value).map((item) =>
    remoteCapabilitySchema.parse(item),
  );
}

async function publishTemplate(
  context: CommandContext,
  template: EventTemplate,
): Promise<unknown> {
  return publish(context, signTemplateWithAuth(context, template));
}

function signTemplateWithAuth(
  context: CommandContext,
  template: EventTemplate,
  includeContextAuth = true,
): NostrEvent {
  return signTemplate(
    includeContextAuth && context.authTag
      ? {
          ...template,
          tags: [...template.tags.map((tag) => [...tag]), [...context.authTag]],
        }
      : template,
    context.secretKey,
  );
}

async function publish(
  context: CommandContext,
  event: NostrEvent,
): Promise<unknown> {
  const message = await context.relay.publish(event);
  return { event, message };
}

function assertAuthoritativeWrite(message: unknown, detail: string): void {
  if (
    typeof message === "string" &&
    (message === "duplicate" || message.startsWith("duplicate:"))
  ) {
    throw new Error(`conflict: ${detail}`);
  }
}

function objectInput(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("command input must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  name: string,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > 1024 * 1024
  ) {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredString(value, "value", true);
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new TypeError("value must be boolean");
  return value;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean")
    throw new TypeError(`${name} must be boolean`);
  return value;
}

function optionalObject(value: unknown): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("inputs must be a JSON object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("value must be a non-negative integer");
  }
  return value as number;
}

function optionalStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 10_000 ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new TypeError("value must be a string array");
  }
  return value as string[];
}

function optionalStringMatrix(value: unknown): string[][] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    !value.every(
      (row) =>
        Array.isArray(row) &&
        row.length <= 100 &&
        row.every((item) => typeof item === "string"),
    )
  ) {
    throw new TypeError("value must be a string matrix");
  }
  return value as string[][];
}

function threadInput(value: unknown): {
  readonly rootEventId: string;
  readonly parentEventId: string;
} {
  const input = objectInput(value);
  return {
    parentEventId: requiredString(input.parentEventId, "parentEventId"),
    rootEventId: requiredString(input.rootEventId, "rootEventId"),
  };
}

async function resolveThreadInput(
  value: Record<string, unknown>,
  context: CommandContext,
): Promise<
  | {
      readonly rootEventId: string;
      readonly parentEventId: string;
    }
  | undefined
> {
  if (value.thread !== undefined) return threadInput(value.thread);
  const parentEventId =
    optionalString(value.replyTo) ?? optionalString(value.replyToEventId);
  if (!parentEventId) return undefined;
  const [parent] = await context.relay.query([
    { ids: [parentEventId], limit: 1 },
  ]);
  if (!parent)
    throw new TypeError(`parent event ${parentEventId} was not found`);
  const markedRoot = parent.tags.find(
    (tag) =>
      tag[0] === "e" &&
      typeof tag[1] === "string" &&
      (tag[3] === "root" || tag[3] === "reply"),
  )?.[1];
  return {
    parentEventId,
    rootEventId: markedRoot ?? parentEventId,
  };
}

async function resolveEventChannel(
  context: CommandContext,
  eventId: string,
): Promise<string> {
  const [event] = await context.relay.query([{ ids: [eventId], limit: 1 }]);
  const channelId = event?.tags.find(
    (tag) => tag[0] === "h" && typeof tag[1] === "string",
  )?.[1];
  if (!channelId) {
    throw new TypeError(`event ${eventId} has no channel h tag`);
  }
  return channelId;
}

async function resolveAuthorPubkey(
  context: CommandContext,
  author: string,
): Promise<string> {
  const normalized = author.trim();
  if (normalized === "me") return getPublicKey(context.secretKey);
  if (/^[0-9a-f]{64}$/i.test(normalized)) return normalized.toLowerCase();
  if (normalized.startsWith("npub1")) {
    const decoded = nip19.decode(normalized);
    if (decoded.type !== "npub") throw new TypeError("author npub is invalid");
    return decoded.data;
  }
  const profiles = await context.relay.query([
    { kinds: [0], limit: 100, search: normalized },
  ]);
  const matches = profiles.filter((event) => {
    const profile = parseJsonObject(event.content);
    return [profile.display_name, profile.name].some(
      (value) =>
        typeof value === "string" &&
        value.toLowerCase() === normalized.toLowerCase(),
    );
  });
  const pubkeys = [...new Set(matches.map((event) => event.pubkey))];
  if (pubkeys.length !== 1) {
    throw new TypeError(
      pubkeys.length === 0
        ? `no user found with name '${normalized}'`
        : `name '${normalized}' is ambiguous; pass a pubkey`,
    );
  }
  return pubkeys[0] as string;
}

function requiredStringFrom(
  input: Record<string, unknown>,
  names: readonly string[],
  allowEmpty = false,
): string {
  for (const name of names) {
    if (input[name] !== undefined) {
      return requiredString(input[name], name, allowEmpty);
    }
  }
  throw new TypeError(`${names.join(" or ")} is required`);
}

function commaSeparatedIntegers(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const parsed = raw.map((item) => Number(String(item).trim()));
  if (
    parsed.length < 1 ||
    parsed.length > 100 ||
    parsed.some(
      (item) => !Number.isSafeInteger(item) || item < 0 || item > 65_535,
    )
  ) {
    throw new TypeError("kinds must be comma-separated unsigned integers");
  }
  return parsed;
}

function truncateUtf8(
  value: string,
  maximumBytes: number,
): { readonly truncated: boolean; readonly value: string } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return { truncated: false, value };
  let end = maximumBytes;
  while (
    end > 0 &&
    (bytes[end] as number) >= 0x80 &&
    (bytes[end] as number) < 0xc0
  ) {
    end -= 1;
  }
  return {
    truncated: true,
    value: bytes.subarray(0, end).toString("utf8"),
  };
}

function rawTemplate(
  kind: number,
  content: string,
  tags: readonly (readonly string[])[] = [],
): EventTemplate {
  if (!Number.isSafeInteger(kind) || kind < 0 || kind > 65_535) {
    throw new TypeError("event kind is invalid");
  }
  return {
    content,
    kind,
    tags: tags.map((tag) => [...tag]),
  };
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function optionalRecordString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof value[key] === "string" ? (value[key] as string) : undefined;
}

function requireOwnerPubkey(authTag: readonly string[] | undefined): string {
  if (
    !authTag ||
    authTag.length !== 4 ||
    authTag[0] !== "auth" ||
    !/^[0-9a-f]{64}$/i.test(authTag[1] ?? "")
  ) {
    throw new TypeError(
      "agent draft requests require a valid BUZZ_AUTH_TAG owner attestation",
    );
  }
  return (authTag[1] as string).toLowerCase();
}

function agentDraftUpdate(
  value: Record<string, unknown>,
  channelId: string,
): Record<string, unknown> {
  const request: Record<string, unknown> = {
    agentName: boundedRequiredString(value.agentName, "agentName", 120),
    channelId,
  };
  for (const [key, maximum] of [
    ["displayName", 300],
    ["runtime", 300],
    ["provider", 300],
    ["model", 300],
  ] as const) {
    if (value[key] !== undefined) {
      request[key] = boundedRequiredString(value[key], key, maximum);
    }
  }
  if (value.systemPrompt !== undefined) {
    request.systemPrompt = boundedRequiredString(
      value.systemPrompt,
      "systemPrompt",
      20_000,
    );
  }
  if (value.respondTo !== undefined) {
    const respondTo = boundedRequiredString(value.respondTo, "respondTo", 300);
    if (respondTo !== "owner-only" && respondTo !== "anyone") {
      throw new TypeError("respondTo must be owner-only or anyone");
    }
    request.respondTo = respondTo;
  }
  if (Object.keys(request).length === 2) {
    throw new TypeError("include at least one field to update");
  }
  return request;
}

function boundedRequiredString(
  value: unknown,
  name: string,
  maximumCharacters: number,
): string {
  const parsed = requiredString(value, name).trim();
  if ([...parsed].length > maximumCharacters) {
    throw new RangeError(
      `${name} is too long (max ${maximumCharacters} characters)`,
    );
  }
  return parsed;
}

function requiredUuid(value: string, name: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function hex64(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new TypeError(`${name} must be a 64-character hexadecimal value`);
  }
  return value.toLowerCase();
}

async function resolveIdentityOwnerAuth(
  context: CommandContext,
  targetPubkey: string,
): Promise<readonly string[] | undefined> {
  const signer = getPublicKey(context.secretKey).toLowerCase();
  if (signer === targetPubkey) return undefined;
  const profile = newestEvent(
    await context.relay.query([
      { authors: [targetPubkey], kinds: [0], limit: 1 },
    ]),
    true,
  );
  if (!profile) return undefined;
  const candidates = profile.tags.filter((tag) => tag[0] === "auth");
  if (candidates.length !== 1) return undefined;
  const tag = candidates[0] as string[];
  if (
    tag.length !== 4 ||
    tag[1]?.toLowerCase() !== signer ||
    !/^[0-9a-f]{64}$/i.test(tag[1] ?? "") ||
    !/^[0-9a-f]{128}$/i.test(tag[3] ?? "")
  ) {
    return undefined;
  }
  return [...tag];
}

function newestEvent(
  events: readonly NostrEvent[],
  optional?: false,
): NostrEvent;
function newestEvent(
  events: readonly NostrEvent[],
  optional: true,
): NostrEvent | undefined;
function newestEvent(
  events: readonly NostrEvent[],
  optional = false,
): NostrEvent | undefined {
  const newest = [...events].sort(
    (left, right) =>
      right.created_at - left.created_at || left.id.localeCompare(right.id),
  )[0];
  if (!newest && !optional) throw new Error("expected relay event");
  return newest;
}

function parseJsonArray(value: unknown, name: string): unknown[] {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            throw new TypeError(`${name} must be valid JSON`);
          }
        })()
      : value;
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${name} must be a JSON array`);
  }
  return parsed;
}

function parseTagMatrix(
  value: unknown,
  name: string,
): readonly (readonly string[])[] {
  return parseJsonArray(value, name).map((raw, index) => {
    if (
      !Array.isArray(raw) ||
      raw.length < 1 ||
      raw.length > 32 ||
      !raw.every(
        (part) =>
          typeof part === "string" && Buffer.byteLength(part, "utf8") <= 16_384,
      )
    ) {
      throw new TypeError(`${name}[${index}] must be a bounded string array`);
    }
    return raw as string[];
  });
}

function requiredSupportedSocialKind(value: unknown): number {
  const kind = optionalInteger(value);
  if (
    kind === undefined ||
    ![10_000, 10_001, 10_002, 10_003, 30_000, 30_003].includes(kind)
  ) {
    throw new TypeError(
      "kind must be 10000, 10001, 10002, 10003, 30000, or 30003",
    );
  }
  return kind;
}

type CustomEmojiEntry = {
  readonly shortcode: string;
  readonly url: string;
};

function emojiTagsOf(event: NostrEvent): CustomEmojiEntry[] {
  return event.tags.flatMap((tag) =>
    tag.length >= 3 &&
    tag[0] === "emoji" &&
    typeof tag[1] === "string" &&
    typeof tag[2] === "string"
      ? [{ shortcode: tag[1], url: tag[2] }]
      : [],
  );
}

function unionCustomEmoji(events: readonly NostrEvent[]): CustomEmojiEntry[] {
  const latest = new Map<
    string,
    { readonly createdAt: number; readonly url: string }
  >();
  for (const event of events) {
    for (const emoji of emojiTagsOf(event)) {
      const current = latest.get(emoji.shortcode);
      if (
        !current ||
        event.created_at > current.createdAt ||
        (event.created_at === current.createdAt && emoji.url < current.url)
      ) {
        latest.set(emoji.shortcode, {
          createdAt: event.created_at,
          url: emoji.url,
        });
      }
    }
  }
  return [...latest]
    .map(([shortcode, { url }]) => ({ shortcode, url }))
    .sort(
      (left, right) =>
        left.shortcode.localeCompare(right.shortcode) ||
        left.url.localeCompare(right.url),
    );
}

async function ownCustomEmoji(
  context: CommandContext,
): Promise<CustomEmojiEntry[]> {
  const events = await context.relay.query([
    {
      "#d": [CUSTOM_EMOJI_SET_D_TAG],
      authors: [getPublicKey(context.secretKey)],
      kinds: [30_030],
      limit: 1,
    },
  ]);
  const newest = newestEvent(events, true);
  return newest ? emojiTagsOf(newest) : [];
}

function customEmojiManifest(
  value: Record<string, unknown>,
): CustomEmojiEntry[] {
  const raw =
    value.emojis ??
    (typeof value.manifest === "string"
      ? parseJsonObject(value.manifest).emojis
      : undefined);
  const seen = new Set<string>();
  const output: CustomEmojiEntry[] = [];
  for (const [index, entryValue] of parseJsonArray(raw, "emojis").entries()) {
    const entry = objectInput(entryValue);
    const shortcode = normalizeCustomEmojiShortcode(
      requiredString(entry.shortcode, `emojis[${index}].shortcode`),
    );
    if (seen.has(shortcode)) continue;
    seen.add(shortcode);
    output.push({
      shortcode,
      url: requiredString(entry.url, `emojis[${index}].url`),
    });
  }
  return output;
}

function requiredRepoId(value: unknown): string {
  const id = requiredString(value, "repository id");
  if (
    id.length > 64 ||
    id.startsWith(".") ||
    id.includes("..") ||
    !/^[A-Za-z0-9._-]+$/.test(id)
  ) {
    throw new TypeError("repository id has an invalid format");
  }
  return id;
}

function boundedLimit(value: unknown, maximum: number): number {
  const limit = optionalInteger(value);
  if (limit === undefined || limit < 1) {
    throw new TypeError("limit must be a positive integer");
  }
  return Math.min(limit, maximum);
}

function gitRepoFrom(value: Record<string, unknown>): {
  readonly owner: string;
  readonly id: string;
} {
  return {
    owner: hex64(value.repoOwner ?? value.owner, "repoOwner"),
    id: requiredRepoId(value.repoId ?? value.id),
  };
}

function optionalGitRepoFrom(
  value: Record<string, unknown>,
): { readonly owner: string; readonly id: string } | undefined {
  const owner = value.repoOwner ?? value.owner;
  const id = value.repoId ?? value.id;
  if (owner === undefined && id === undefined) return undefined;
  if (owner === undefined || id === undefined) {
    throw new TypeError("repoOwner and repoId must be given together");
  }
  return {
    owner: hex64(owner, "repoOwner"),
    id: requiredRepoId(id),
  };
}

function requiredRefPattern(value: unknown): string {
  const pattern = requiredString(value, "ref");
  if (
    pattern.length > 512 ||
    !/^refs\/(?:heads|tags)\/[A-Za-z0-9._*?[\]/-]+$/.test(pattern) ||
    pattern.includes("..") ||
    pattern.includes("//")
  ) {
    throw new TypeError(
      "ref must be a valid refs/heads/* or refs/tags/* pattern",
    );
  }
  return pattern;
}

function repositoryProtectionView(event: NostrEvent): Record<string, unknown> {
  const repoId = event.tags.find((tag) => tag[0] === "d" && tag[1])?.[1] ?? "";
  const protections = event.tags
    .filter((tag) => tag[0] === "buzz-protect")
    .map((tag) => ({
      ref: tag[1] ?? "",
      rules: tag.slice(2),
    }));
  return {
    protections,
    repo_id: repoId,
    unknown_rules: protections.flatMap(({ rules }) =>
      rules.filter(
        (rule) =>
          ![
            "push:owner",
            "push:admin",
            "push:member",
            "no-force-push",
            "no-delete",
            "require-patch",
          ].includes(rule),
      ),
    ),
    validation_error: null,
  };
}

function parseCommitter(
  value: unknown,
): readonly [string, string, string, string] {
  const fields = requiredString(value, "committer").split("|");
  if (fields.length !== 4 || fields.some((field) => !field)) {
    throw new TypeError(
      "committer must be name|email|timestamp|tz-offset-minutes",
    );
  }
  return fields as [string, string, string, string];
}

function nonEmptyStringArray(value: unknown, name: string): string[] {
  const result = optionalStringArray(value);
  if (result.length < 1) throw new TypeError(`${name} is required`);
  return result;
}

function requiredGitStatus(
  value: unknown,
  resource: string,
): "open" | "merged" | "resolved" | "closed" | "draft" {
  const status = requiredString(value, "status");
  const allowed =
    resource === "issues"
      ? ["open", "resolved", "closed", "draft"]
      : ["open", "merged", "closed", "draft"];
  if (!allowed.includes(status)) {
    throw new TypeError(`status must be ${allowed.join(", ")}`);
  }
  return status as "open" | "merged" | "resolved" | "closed" | "draft";
}

function parseAppliedPatchReference(value: string): readonly string[] {
  const id = value.slice(0, 64);
  hex64(id, "applied patch");
  if (value.length === 64) return [id.toLowerCase()];
  if (value[64] !== ":") {
    throw new TypeError("applied patch reference is invalid");
  }
  const remainder = value.slice(65);
  const lastColon = remainder.lastIndexOf(":");
  if (lastColon > 0) {
    const candidatePubkey = remainder.slice(lastColon + 1);
    if (/^[0-9a-f]{64}$/i.test(candidatePubkey)) {
      return [
        id.toLowerCase(),
        remainder.slice(0, lastColon),
        candidatePubkey.toLowerCase(),
      ];
    }
  }
  return [id.toLowerCase(), remainder];
}

function requiredNoteSlug(value: unknown): string {
  const slug = requiredString(value, "note name");
  if (slug.length > 80 || !/^[a-z0-9._-]+$/.test(slug)) {
    throw new TypeError(
      "note name must use 1-80 lowercase letters, digits, dots, underscores, or hyphens",
    );
  }
  return slug;
}

type NoteSnapshot = {
  readonly id: string;
  readonly pubkey: string;
  readonly slug: string;
  readonly title: string;
  readonly summary?: string;
  readonly tags: string[];
  readonly publishedAt?: number;
  readonly updatedAt: number;
  readonly content: string;
  readonly coordinate: string;
  readonly naddr: string;
};

function noteSnapshot(event: NostrEvent): NoteSnapshot {
  if (event.kind !== 30_023)
    throw new TypeError("event is not a long-form note");
  const slug = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (!slug) throw new TypeError("long-form note is missing its d tag");
  const title = event.tags.find((tag) => tag[0] === "title")?.[1] ?? "";
  const summary = event.tags.find((tag) => tag[0] === "summary")?.[1];
  const publishedRaw = event.tags.find((tag) => tag[0] === "published_at")?.[1];
  const publishedAt =
    publishedRaw && /^\d+$/.test(publishedRaw)
      ? Number(publishedRaw)
      : undefined;
  return {
    id: event.id,
    pubkey: event.pubkey,
    slug,
    title,
    ...(summary !== undefined ? { summary } : {}),
    tags: event.tags
      .filter((tag) => tag[0] === "t" && tag[1])
      .map((tag) => tag[1] as string),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    updatedAt: event.created_at,
    content: event.content,
    coordinate: `30023:${event.pubkey}:${slug}`,
    naddr: nip19.naddrEncode({
      identifier: slug,
      kind: 30_023,
      pubkey: event.pubkey,
      relays: [],
    }),
  };
}

function decodeLongFormCoordinate(value: string): {
  readonly identifier: string;
  readonly pubkey: string;
} {
  const raw = value.startsWith("nostr:") ? value.slice(6) : value;
  if (raw.startsWith("30023:")) {
    const [, pubkey, ...identifierParts] = raw.split(":");
    return {
      identifier: requiredNoteSlug(identifierParts.join(":")),
      pubkey: hex64(pubkey, "coordinate pubkey"),
    };
  }
  let decoded: ReturnType<typeof nip19.decode>;
  try {
    decoded = nip19.decode(raw);
  } catch {
    throw new TypeError("naddr is invalid");
  }
  if (decoded.type !== "naddr" || decoded.data.kind !== 30_023) {
    throw new TypeError("coordinate must address kind 30023");
  }
  return {
    identifier: requiredNoteSlug(decoded.data.identifier),
    pubkey: hex64(decoded.data.pubkey, "coordinate pubkey"),
  };
}

type EngramReader = {
  readonly agent: string;
  readonly owner: string;
  readonly peer: string;
};

function resolveEngramOwner(
  context: CommandContext,
  ownerValue: unknown,
): string {
  if (ownerValue !== undefined) return hex64(ownerValue, "owner");
  return requireOwnerPubkey(context.authTag);
}

function resolveEngramReader(
  context: CommandContext,
  value: Record<string, unknown>,
  action: string,
): EngramReader {
  const me = getPublicKey(context.secretKey);
  const agentValue = optionalString(value.agent);
  if (agentValue) {
    if (!["ls", "get", "hash"].includes(action)) {
      throw new TypeError("agent recovery applies only to read commands");
    }
    if (value.owner !== undefined) {
      throw new TypeError("owner and agent are mutually exclusive");
    }
    const agent = hex64(agentValue, "agent");
    if (agent === me) {
      throw new TypeError("agent must differ from the CLI identity");
    }
    return { agent, owner: me, peer: agent };
  }
  const owner = resolveEngramOwner(context, value.owner);
  return { agent: me, owner, peer: owner };
}

function tryValidateEngram(
  context: CommandContext,
  reader: EngramReader,
  event: NostrEvent,
):
  | {
      readonly body: ReturnType<typeof validateAndDecryptEngram>;
      readonly event: NostrEvent;
    }
  | undefined {
  try {
    return {
      body: validateAndDecryptEngram({
        event,
        expectedAgent: reader.agent,
        expectedOwner: reader.owner,
        mySecretKey: context.secretKey,
        theirPubkey: reader.peer,
      }),
      event,
    };
  } catch {
    return undefined;
  }
}

async function fetchEngramHead(
  context: CommandContext,
  reader: EngramReader,
  slug: string,
) {
  const key = engramConversationKey(context.secretKey, reader.peer);
  const events = await context.relay.query([
    {
      "#d": [engramDTag(key, slug)],
      "#p": [reader.owner],
      authors: [reader.agent],
      kinds: [KIND_AGENT_ENGRAM],
      limit: 16,
    },
  ]);
  return selectEngramHead(
    events.flatMap((event) => {
      const validated = tryValidateEngram(context, reader, event);
      return validated ? [validated] : [];
    }),
  );
}

type UnifiedHunk = {
  readonly oldStart: number;
  readonly oldLength: number;
  readonly newLength: number;
  readonly lines: readonly string[];
};

function applyStrictUnifiedDiff(current: string, patch: string): string {
  if (!patch.trim()) throw new TypeError("patch is empty");
  const fileHeaders = patch
    .split("\n")
    .filter((line) => line.startsWith("--- ")).length;
  if (fileHeaders > 1) {
    throw new TypeError("multi-file memory patches are not supported");
  }
  const patchLines = splitLinesKeepingNewline(patch);
  const hunks: UnifiedHunk[] = [];
  for (let index = 0; index < patchLines.length; index += 1) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(
      (patchLines[index] as string).replace(/\n$/, ""),
    );
    if (!header) continue;
    const lines: string[] = [];
    index += 1;
    while (index < patchLines.length && !patchLines[index]?.startsWith("@@ ")) {
      const line = patchLines[index] as string;
      if (
        line.startsWith(" ") ||
        line.startsWith("+") ||
        line.startsWith("-")
      ) {
        lines.push(line);
      } else if (!line.startsWith("\\ No newline at end of file")) {
        throw new TypeError("malformed unified diff hunk");
      }
      index += 1;
    }
    index -= 1;
    hunks.push({
      lines,
      newLength: Number(header[4] ?? "1"),
      oldLength: Number(header[2] ?? "1"),
      oldStart: Number(header[1]),
    });
  }
  if (hunks.length === 0) throw new TypeError("patch contains no hunks");
  const original = splitLinesKeepingNewline(current);
  for (const [number, hunk] of hunks.entries()) {
    const preimage = hunk.lines
      .filter((line) => !line.startsWith("+"))
      .map((line) => line.slice(1));
    if (preimage.length !== hunk.oldLength) {
      throw new TypeError(`hunk #${number + 1} old line count is invalid`);
    }
    const resultLines = hunk.lines.filter((line) => !line.startsWith("-"));
    if (resultLines.length !== hunk.newLength) {
      throw new TypeError(`hunk #${number + 1} new line count is invalid`);
    }
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (preimage.length === 0 && hunk.oldStart !== 0 && original.length > 0) {
      throw new TypeError(
        `hunk #${number + 1} has no context at a nonzero line`,
      );
    }
    for (const [offset, expected] of preimage.entries()) {
      if (original[start + offset] !== expected) {
        throw new TypeError(
          `hunk #${number + 1} does not match at declared line ${start + offset + 1}`,
        );
      }
    }
  }
  const output = [...original];
  let delta = 0;
  for (const hunk of hunks) {
    const start = (hunk.oldStart === 0 ? 0 : hunk.oldStart - 1) + delta;
    const replacement = hunk.lines
      .filter((line) => !line.startsWith("-"))
      .map((line) => line.slice(1));
    output.splice(start, hunk.oldLength, ...replacement);
    delta += replacement.length - hunk.oldLength;
  }
  return output.join("");
}

function splitLinesKeepingNewline(value: string): string[] {
  if (!value) return [];
  return value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function filtersInput(input: Record<string, unknown>): NostrFilter[] {
  if (input.filters !== undefined) {
    if (
      !Array.isArray(input.filters) ||
      input.filters.length < 1 ||
      input.filters.length > 10
    ) {
      throw new TypeError("filters must contain 1-10 objects");
    }
    return input.filters.map(filterInput);
  }
  return [filterInput(input.filter)];
}

function filterInput(value: unknown): NostrFilter {
  const input = objectInput(value);
  return structuredClone(input) as NostrFilter;
}

function isNostrEventShape(value: unknown): value is NostrEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { sig?: unknown }).sig === "string"
  );
}
