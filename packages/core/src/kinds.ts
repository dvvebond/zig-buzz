// Authoritative numeric protocol registry. New code imports kinds from here
// instead of scattering integer literals.
export const KIND_PROFILE = 0 as const;
export const KIND_TEXT_NOTE = 1 as const;
export const KIND_CONTACT_LIST = 3 as const;
export const KIND_DELETION = 5 as const;
export const KIND_REACTION = 7 as const;
export const KIND_STREAM_MESSAGE = 9 as const;
export const KIND_CHANNEL_METADATA = 41 as const;
export const KIND_GIFT_WRAP = 1059 as const;
export const KIND_FILE_METADATA = 1063 as const;
export const KIND_GIT_PATCH = 1617 as const;
export const KIND_GIT_PULL_REQUEST = 1618 as const;
export const KIND_GIT_PR_UPDATE = 1619 as const;
export const KIND_GIT_ISSUE = 1621 as const;
export const KIND_GIT_STATUS_OPEN = 1630 as const;
export const KIND_GIT_STATUS_MERGED = 1631 as const;
export const KIND_GIT_STATUS_CLOSED = 1632 as const;
export const KIND_GIT_STATUS_DRAFT = 1633 as const;
export const KIND_REPORT = 1984 as const;
export const KIND_NIP43_MEMBER_ADDED = 8000 as const;
export const KIND_NIP43_MEMBER_REMOVED = 8001 as const;
export const KIND_IA_ARCHIVED = 8002 as const;
export const KIND_IA_UNARCHIVED = 8003 as const;
export const KIND_NIP29_PUT_USER = 9000 as const;
export const KIND_NIP29_REMOVE_USER = 9001 as const;
export const KIND_NIP29_EDIT_METADATA = 9002 as const;
export const KIND_NIP29_DELETE_EVENT = 9005 as const;
export const KIND_NIP29_CREATE_GROUP = 9007 as const;
export const KIND_NIP29_DELETE_GROUP = 9008 as const;
export const KIND_NIP29_CREATE_INVITE = 9009 as const;
export const KIND_NIP29_JOIN_REQUEST = 9021 as const;
export const KIND_NIP29_LEAVE_REQUEST = 9022 as const;
export const RELAY_ADMIN_ADD_MEMBER = 9030 as const;
export const RELAY_ADMIN_REMOVE_MEMBER = 9031 as const;
export const RELAY_ADMIN_CHANGE_ROLE = 9032 as const;
export const RELAY_ADMIN_SET_WORKSPACE_PROFILE = 9033 as const;
export const KIND_IA_ARCHIVE_REQUEST = 9035 as const;
export const KIND_IA_UNARCHIVE_REQUEST = 9036 as const;
export const KIND_MODERATION_BAN = 9040 as const;
export const KIND_MODERATION_UNBAN = 9041 as const;
export const KIND_MODERATION_TIMEOUT = 9042 as const;
export const KIND_MODERATION_UNTIMEOUT = 9043 as const;
export const KIND_MODERATION_RESOLVE_REPORT = 9044 as const;
export const KIND_MUTE_LIST = 10000 as const;
export const KIND_PIN_LIST = 10001 as const;
export const KIND_NIP65_RELAY_LIST_METADATA = 10002 as const;
export const KIND_BOOKMARK_LIST = 10003 as const;
export const KIND_EMOJI_LIST = 10030 as const;
export const KIND_AGENT_PROFILE = 10100 as const;
export const KIND_NIP43_MEMBERSHIP_LIST = 13534 as const;
export const KIND_IA_ARCHIVED_LIST = 13535 as const;
export const EPHEMERAL_KIND_MIN = 20000 as const;
export const KIND_PRESENCE_UPDATE = 20001 as const;
export const KIND_TYPING_INDICATOR = 20002 as const;
export const KIND_AUTH = 22242 as const;
export const KIND_PAIRING = 24134 as const;
export const KIND_AGENT_OBSERVER_FRAME = 24200 as const;
export const KIND_REMOTE_AGENT_ENROLLMENT = 24210 as const;
export const KIND_REMOTE_AGENT_COMMAND = 24211 as const;
export const KIND_REMOTE_AGENT_STATUS = 24212 as const;
export const KIND_REMOTE_AGENT_ACK = 24213 as const;
export const KIND_BLOSSOM_AUTH = 24242 as const;
export const KIND_NOSTR_IDENTITY_BINDING = 24243 as const;
export const KIND_HUDDLE_REACTION = 24810 as const;
export const KIND_HTTP_AUTH = 27235 as const;
export const EPHEMERAL_KIND_MAX = 29999 as const;
export const KIND_NIP43_LEAVE_REQUEST = 28936 as const;
export const PARAM_REPLACEABLE_KIND_MIN = 30000 as const;
export const KIND_FOLLOW_SET = 30000 as const;
export const KIND_BOOKMARK_SET = 30003 as const;
export const KIND_LONG_FORM = 30023 as const;
export const KIND_EMOJI_SET = 30030 as const;
export const KIND_READ_STATE = 30078 as const;
export const KIND_AGENT_ENGRAM = 30174 as const;
export const KIND_PERSONA = 30175 as const;
export const KIND_TEAM = 30176 as const;
export const KIND_MANAGED_AGENT = 30177 as const;
export const KIND_EVENT_REMINDER = 30300 as const;
export const KIND_USER_STATUS = 30315 as const;
export const KIND_PUSH_LEASE = 30350 as const;
export const KIND_GIT_REPO_ANNOUNCEMENT = 30617 as const;
export const KIND_GIT_REPO_STATE = 30618 as const;
export const KIND_WORKFLOW_DEF = 30620 as const;
export const KIND_DM_VISIBILITY = 30622 as const;
export const PARAM_REPLACEABLE_KIND_MAX = 39999 as const;
export const KIND_NIP29_GROUP_METADATA = 39000 as const;
export const KIND_NIP29_GROUP_ADMINS = 39001 as const;
export const KIND_NIP29_GROUP_MEMBERS = 39002 as const;
export const KIND_NIP29_GROUP_ROLES = 39003 as const;
export const KIND_THREAD_SUMMARY = 39005 as const;
export const KIND_WINDOW_BOUNDS = 39006 as const;
export const KIND_STREAM_MESSAGE_V2 = 40002 as const;
export const KIND_STREAM_MESSAGE_EDIT = 40003 as const;
export const KIND_STREAM_MESSAGE_PINNED = 40004 as const;
export const KIND_STREAM_MESSAGE_BOOKMARKED = 40005 as const;
export const KIND_STREAM_MESSAGE_SCHEDULED = 40006 as const;
export const KIND_STREAM_REMINDER = 40007 as const;
export const KIND_STREAM_MESSAGE_DIFF = 40008 as const;
export const KIND_SYSTEM_MESSAGE = 40099 as const;
export const KIND_CANVAS = 40100 as const;
export const KIND_CHANNEL_SUMMARY = 40901 as const;
export const KIND_PRESENCE_SNAPSHOT = 40902 as const;
export const KIND_DM_CREATED = 41001 as const;
export const KIND_DM_OPEN = 41010 as const;
export const KIND_DM_ADD_MEMBER = 41011 as const;
export const KIND_DM_HIDE = 41012 as const;
export const KIND_PRODUCT_FEEDBACK = 42000 as const;
export const KIND_JOB_REQUEST = 43001 as const;
export const KIND_JOB_ACCEPTED = 43002 as const;
export const KIND_JOB_PROGRESS = 43003 as const;
export const KIND_JOB_RESULT = 43004 as const;
export const KIND_JOB_CANCEL = 43005 as const;
export const KIND_JOB_ERROR = 43006 as const;
export const KIND_MEMBER_ADDED_NOTIFICATION = 44100 as const;
export const KIND_MEMBER_REMOVED_NOTIFICATION = 44101 as const;
export const KIND_AGENT_TURN_METRIC = 44200 as const;
export const KIND_FORUM_POST = 45001 as const;
export const KIND_FORUM_VOTE = 45002 as const;
export const KIND_FORUM_COMMENT = 45003 as const;
export const KIND_WORKFLOW_TRIGGERED = 46001 as const;
export const KIND_WORKFLOW_STEP_STARTED = 46002 as const;
export const KIND_WORKFLOW_STEP_COMPLETED = 46003 as const;
export const KIND_WORKFLOW_STEP_FAILED = 46004 as const;
export const KIND_WORKFLOW_COMPLETED = 46005 as const;
export const KIND_WORKFLOW_FAILED = 46006 as const;
export const KIND_WORKFLOW_CANCELLED = 46007 as const;
export const KIND_WORKFLOW_APPROVAL_REQUESTED = 46010 as const;
export const KIND_WORKFLOW_APPROVAL_GRANTED = 46011 as const;
export const KIND_WORKFLOW_APPROVAL_DENIED = 46012 as const;
export const KIND_WORKFLOW_TRIGGER = 46020 as const;
export const KIND_APPROVAL_GRANT = 46030 as const;
export const KIND_APPROVAL_DENY = 46031 as const;
export const KIND_AUDIT_ENTRY = 48001 as const;
export const KIND_HUDDLE_STARTED = 48100 as const;
export const KIND_HUDDLE_PARTICIPANT_JOINED = 48101 as const;
export const KIND_HUDDLE_PARTICIPANT_LEFT = 48102 as const;
export const KIND_HUDDLE_ENDED = 48103 as const;
export const KIND_HUDDLE_GUIDELINES = 48106 as const;
export const KIND_MEDIA_UPLOAD = 49001 as const;

export const AUTHOR_ONLY_KINDS = new Set<number>([
  KIND_EVENT_REMINDER,
  KIND_PUSH_LEASE,
]);

export const REMOTE_AGENT_KINDS = new Set<number>([
  KIND_REMOTE_AGENT_ENROLLMENT,
  KIND_REMOTE_AGENT_COMMAND,
  KIND_REMOTE_AGENT_STATUS,
  KIND_REMOTE_AGENT_ACK,
]);

/**
 * Durable/event-command kinds accepted from an authenticated client by the
 * ordinary relay ingest path. WebSocket-only ephemeral events are handled as
 * a separate NIP-16 class; everything else is rejected closed when absent
 * from this registry.
 */
export const CLIENT_INGEST_EVENT_KINDS = new Set<number>([
  KIND_PROFILE,
  KIND_TEXT_NOTE,
  KIND_CONTACT_LIST,
  KIND_DELETION,
  KIND_REACTION,
  KIND_GIFT_WRAP,
  KIND_GIT_PATCH,
  KIND_GIT_PULL_REQUEST,
  KIND_GIT_PR_UPDATE,
  KIND_GIT_ISSUE,
  KIND_GIT_STATUS_OPEN,
  KIND_GIT_STATUS_MERGED,
  KIND_GIT_STATUS_CLOSED,
  KIND_GIT_STATUS_DRAFT,
  KIND_REPORT,
  KIND_NIP29_PUT_USER,
  KIND_NIP29_REMOVE_USER,
  KIND_NIP29_EDIT_METADATA,
  KIND_NIP29_DELETE_EVENT,
  KIND_NIP29_CREATE_GROUP,
  KIND_NIP29_DELETE_GROUP,
  KIND_NIP29_JOIN_REQUEST,
  KIND_NIP29_LEAVE_REQUEST,
  RELAY_ADMIN_ADD_MEMBER,
  RELAY_ADMIN_REMOVE_MEMBER,
  RELAY_ADMIN_CHANGE_ROLE,
  RELAY_ADMIN_SET_WORKSPACE_PROFILE,
  KIND_IA_ARCHIVE_REQUEST,
  KIND_IA_UNARCHIVE_REQUEST,
  KIND_MODERATION_BAN,
  KIND_MODERATION_UNBAN,
  KIND_MODERATION_TIMEOUT,
  KIND_MODERATION_UNTIMEOUT,
  KIND_MODERATION_RESOLVE_REPORT,
  KIND_MUTE_LIST,
  KIND_PIN_LIST,
  KIND_NIP65_RELAY_LIST_METADATA,
  KIND_BOOKMARK_LIST,
  KIND_EMOJI_LIST,
  KIND_AGENT_PROFILE,
  KIND_NIP43_LEAVE_REQUEST,
  KIND_FOLLOW_SET,
  KIND_BOOKMARK_SET,
  KIND_LONG_FORM,
  KIND_EMOJI_SET,
  KIND_READ_STATE,
  KIND_AGENT_ENGRAM,
  KIND_PERSONA,
  KIND_TEAM,
  KIND_MANAGED_AGENT,
  KIND_EVENT_REMINDER,
  KIND_USER_STATUS,
  KIND_PUSH_LEASE,
  KIND_GIT_REPO_ANNOUNCEMENT,
  KIND_GIT_REPO_STATE,
  KIND_WORKFLOW_DEF,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_STREAM_MESSAGE_PINNED,
  KIND_STREAM_MESSAGE_BOOKMARKED,
  KIND_STREAM_MESSAGE_SCHEDULED,
  KIND_STREAM_REMINDER,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_CANVAS,
  KIND_DM_OPEN,
  KIND_DM_ADD_MEMBER,
  KIND_DM_HIDE,
  KIND_PRODUCT_FEEDBACK,
  KIND_AGENT_TURN_METRIC,
  KIND_FORUM_POST,
  KIND_FORUM_VOTE,
  KIND_FORUM_COMMENT,
  KIND_WORKFLOW_TRIGGER,
  KIND_APPROVAL_GRANT,
  KIND_APPROVAL_DENY,
  KIND_HUDDLE_STARTED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_GUIDELINES,
]);

export function isClientIngestEventKind(kind: number): boolean {
  return CLIENT_INGEST_EVENT_KINDS.has(kind);
}

/** Client kinds whose durable coordinate must contain exactly one valid `h`. */
export const CHANNEL_SCOPED_KINDS = new Set<number>([
  KIND_NIP29_PUT_USER,
  KIND_NIP29_REMOVE_USER,
  KIND_NIP29_EDIT_METADATA,
  KIND_NIP29_DELETE_EVENT,
  KIND_NIP29_DELETE_GROUP,
  KIND_NIP29_LEAVE_REQUEST,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_STREAM_MESSAGE_PINNED,
  KIND_STREAM_MESSAGE_BOOKMARKED,
  KIND_STREAM_MESSAGE_SCHEDULED,
  KIND_STREAM_REMINDER,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_CANVAS,
  KIND_FORUM_POST,
  KIND_FORUM_VOTE,
  KIND_FORUM_COMMENT,
  KIND_HUDDLE_STARTED,
  KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT,
  KIND_HUDDLE_ENDED,
  KIND_HUDDLE_GUIDELINES,
]);

export function requiresChannelScope(kind: number): boolean {
  return CHANNEL_SCOPED_KINDS.has(kind);
}

export const P_GATED_KINDS = new Set<number>([
  KIND_AGENT_OBSERVER_FRAME,
  KIND_MEMBER_ADDED_NOTIFICATION,
  KIND_MEMBER_REMOVED_NOTIFICATION,
  KIND_GIFT_WRAP,
  KIND_DM_VISIBILITY,
  KIND_AGENT_TURN_METRIC,
  ...REMOTE_AGENT_KINDS,
]);

/** Events whose authoritative signer is the relay, never an ordinary client. */
export const RELAY_ONLY_KINDS = new Set<number>([
  KIND_NIP43_MEMBERSHIP_LIST,
  KIND_CHANNEL_SUMMARY,
  KIND_PRESENCE_SNAPSHOT,
  KIND_DM_VISIBILITY,
  KIND_THREAD_SUMMARY,
  KIND_WINDOW_BOUNDS,
]);

export function isRelayOnlyKind(kind: number): boolean {
  return RELAY_ONLY_KINDS.has(kind);
}

/** Kinds whose durable coordinate is community-global even with a stray `h`. */
export const GLOBAL_ONLY_KINDS = new Set<number>([
  KIND_PROFILE,
  KIND_TEXT_NOTE,
  KIND_CONTACT_LIST,
  KIND_GIFT_WRAP,
  KIND_LONG_FORM,
  KIND_USER_STATUS,
  KIND_READ_STATE,
  KIND_MUTE_LIST,
  KIND_PIN_LIST,
  KIND_NIP65_RELAY_LIST_METADATA,
  KIND_BOOKMARK_LIST,
  KIND_FOLLOW_SET,
  KIND_BOOKMARK_SET,
  KIND_EMOJI_SET,
  KIND_EMOJI_LIST,
  KIND_AGENT_ENGRAM,
  KIND_EVENT_REMINDER,
  KIND_AGENT_PROFILE,
  KIND_PERSONA,
  KIND_TEAM,
  KIND_MANAGED_AGENT,
  KIND_GIT_REPO_ANNOUNCEMENT,
  KIND_GIT_REPO_STATE,
  KIND_GIT_PATCH,
  KIND_GIT_PULL_REQUEST,
  KIND_GIT_PR_UPDATE,
  KIND_GIT_ISSUE,
  KIND_GIT_STATUS_OPEN,
  KIND_GIT_STATUS_MERGED,
  KIND_GIT_STATUS_CLOSED,
  KIND_GIT_STATUS_DRAFT,
  KIND_MODERATION_BAN,
  KIND_MODERATION_UNBAN,
  KIND_MODERATION_TIMEOUT,
  KIND_MODERATION_UNTIMEOUT,
  KIND_MODERATION_RESOLVE_REPORT,
  RELAY_ADMIN_ADD_MEMBER,
  RELAY_ADMIN_REMOVE_MEMBER,
  RELAY_ADMIN_CHANGE_ROLE,
  RELAY_ADMIN_SET_WORKSPACE_PROFILE,
  KIND_NIP43_LEAVE_REQUEST,
  KIND_IA_ARCHIVE_REQUEST,
  KIND_IA_UNARCHIVE_REQUEST,
  KIND_AGENT_TURN_METRIC,
  KIND_PUSH_LEASE,
  KIND_DM_VISIBILITY,
  KIND_MEMBER_ADDED_NOTIFICATION,
  KIND_MEMBER_REMOVED_NOTIFICATION,
]);

export function isGlobalOnlyKind(kind: number): boolean {
  return GLOBAL_ONLY_KINDS.has(kind);
}

export function isEphemeralKind(kind: number): boolean {
  return kind >= EPHEMERAL_KIND_MIN && kind <= EPHEMERAL_KIND_MAX;
}

export function isParameterizedReplaceableKind(kind: number): boolean {
  return (
    kind >= PARAM_REPLACEABLE_KIND_MIN && kind <= PARAM_REPLACEABLE_KIND_MAX
  );
}

export function isModerationCommandKind(kind: number): boolean {
  return (
    kind === KIND_MODERATION_BAN ||
    kind === KIND_MODERATION_UNBAN ||
    kind === KIND_MODERATION_TIMEOUT ||
    kind === KIND_MODERATION_UNTIMEOUT ||
    kind === KIND_MODERATION_RESOLVE_REPORT
  );
}
