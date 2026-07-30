import type { ChannelService } from "./channels.js";
import type { AgentModelService } from "./agent-models.js";
import type { ArchiveService } from "./archive.js";
import type { BuilderlabService } from "./builderlab.js";
import type { DesktopEventBus } from "./event-bus.js";
import type { EntityReconcileService } from "./entity-reconcile.js";
import type { IdentityService } from "./identity.js";
import type { HuddleService } from "./huddle.js";
import type { IdentityArchiveService } from "./identity-archive.js";
import type { LocalEntityService } from "./local-entities.js";
import type { ManagedAgentService } from "./managed-agents.js";
import type { ManagedAgentMessageService } from "./managed-agent-messages.js";
import type { DesktopMediaService } from "./media.js";
import type { AgentMemoryService } from "./memory.js";
import type { MeshComputeService } from "./mesh-compute.js";
import type { PairingService } from "./pairing.js";
import type { ProfileService } from "./profile.js";
import type { ProjectGitService } from "./project-git.js";
import type { RuntimeCatalogService } from "./runtime-catalog.js";
import type { DesktopResetService } from "./reset.js";
import type { SocialService } from "./social.js";
import type { SnapshotService } from "./snapshot-service.js";
import type { WorkspaceService } from "./workspace.js";
import type { WorkflowService } from "./workflows.js";
import {
  fetchJoinPolicy,
  fetchLinkPreviewTitle,
  fetchRelaySelf,
  fetchWorkspaceIcon,
  relayRequiresMembership,
} from "./native-utilities.js";

export type CommandContext = {
  agentModels: AgentModelService;
  archive: ArchiveService;
  builderlab: BuilderlabService;
  channels: ChannelService;
  events: DesktopEventBus;
  huddle: HuddleService;
  entityReconcile: EntityReconcileService;
  identity: IdentityService;
  identityArchive: IdentityArchiveService;
  localEntities: LocalEntityService;
  managedAgents: ManagedAgentService;
  managedAgentMessages: ManagedAgentMessageService;
  media: DesktopMediaService;
  memory: AgentMemoryService;
  meshCompute: MeshComputeService;
  pairing: PairingService;
  profiles: ProfileService;
  projectGit: ProjectGitService;
  reset: DesktopResetService;
  runtimeCatalog: RuntimeCatalogService;
  social: SocialService;
  snapshots: SnapshotService;
  workspace: WorkspaceService;
  workflows: WorkflowService;
};

type Arguments = Record<string, unknown>;
type Handler = (args: Arguments) => unknown | Promise<unknown>;

export class CommandRegistry {
  readonly #handlers = new Map<string, Handler>();

  constructor(context: CommandContext) {
    const { identity } = context;
    this.register("create_save_subscription", (args) =>
      context.archive.createSubscription(args),
    );
    this.register("list_save_subscriptions", () =>
      context.archive.listSubscriptions(),
    );
    this.register("delete_save_subscription", (args) =>
      context.archive.deleteSubscription(args),
    );
    this.register("merge_save_subscription_kinds", (args) =>
      context.archive.mergeOwnerKind(args.kind),
    );
    this.register("remove_save_subscription_kind", (args) =>
      context.archive.removeOwnerKind(args.kind),
    );
    this.register("archive_events", (args) => context.archive.archive(args));
    this.register("read_archived_events", (args) => context.archive.read(args));
    this.register("index_observer_channel_id", (args) =>
      context.archive.indexObserver(args),
    );
    this.register("read_unindexed_observer_rows", () =>
      context.archive.readUnindexedObservers(),
    );
    this.register("read_archived_observer_events_for_channel", (args) =>
      context.archive.readObserversForChannel(args),
    );
    this.register("get_identity", () => identity.info());
    this.register("get_nsec", () => identity.nsec());
    this.register("sign_out", () => context.reset.request());
    this.register("poll_desktop_events", (args) =>
      context.events.poll(args.afterId),
    );
    this.register("start_huddle", (args) => context.huddle.start(args));
    this.register("join_huddle", (args) => context.huddle.join(args));
    this.register("leave_huddle", () => context.huddle.leave());
    this.register("end_huddle", (args) => context.huddle.end(args));
    this.register("confirm_huddle_active", () =>
      context.huddle.confirmActive(),
    );
    this.register("get_huddle_state", () => context.huddle.state());
    this.register("get_huddle_agent_pubkeys", () =>
      context.huddle.agentPubkeys(),
    );
    this.register("add_agent_to_huddle", (args) =>
      context.huddle.addAgent(args.agentPubkey),
    );
    this.register("speak_agent_message", (args) =>
      context.huddle.requestSpeech(args.text),
    );
    this.register("get_huddle_audio_config", () =>
      context.huddle.audioConfig(),
    );
    this.register("reconnect_huddle_audio", () =>
      context.huddle.reconnectConfig(),
    );
    this.register("sync_huddle_audio_roster", (args) =>
      context.huddle.syncRoster(args),
    );
    this.register("start_pairing", () => context.pairing.start());
    this.register("confirm_pairing_sas", () => context.pairing.confirmSas());
    this.register("cancel_pairing", () => context.pairing.cancel());
    this.register("reconcile_inbound_persona_event", (args) =>
      context.entityReconcile.reconcile(args.eventJson),
    );
    this.register("get_builderlab_auth", () => context.builderlab.getAuth());
    this.register("start_builderlab_login", () =>
      context.builderlab.startLogin(),
    );
    this.register("cancel_builderlab_login", () =>
      context.builderlab.cancelLogin(),
    );
    this.register("clear_builderlab_auth", () =>
      context.builderlab.clearAuth(),
    );
    this.register("get_builderlab_nostr_identity", () =>
      context.builderlab.currentIdentity(),
    );
    this.register("bind_builderlab_nostr_identity", () =>
      context.builderlab.bindIdentity(),
    );
    this.register("delete_builderlab_nostr_identity", () =>
      context.builderlab.deleteIdentity(),
    );
    this.register("list_builderlab_communities", () =>
      context.builderlab.listCommunities(),
    );
    this.register("check_builderlab_community_name", (args) =>
      context.builderlab.checkName(args.name),
    );
    this.register("create_builderlab_community", (args) =>
      context.builderlab.createCommunity(args.name),
    );
    this.register("archive_builderlab_community", (args) =>
      context.builderlab.archiveCommunity(args.communityId),
    );
    this.register("unarchive_builderlab_community", (args) =>
      context.builderlab.unarchiveCommunity(args.communityId),
    );
    this.register("transfer_builderlab_community", (args) =>
      context.builderlab.transferCommunity(
        args.communityId,
        args.transfereeNpub,
      ),
    );
    this.register("import_identity", (args) =>
      identity.import(requireString(args.nsec, "nsec")),
    );
    this.register("persist_current_identity", () => identity.persistCurrent());
    this.register("sign_event", (args) => JSON.stringify(identity.sign(args)));
    this.register("create_auth_event", (args) =>
      JSON.stringify(identity.createAuth(args.challenge, args.relayUrl)),
    );
    this.register("nip44_encrypt_to_self", (args) =>
      identity.encryptToSelf(args.plaintext),
    );
    this.register("nip44_decrypt_from_self", (args) =>
      identity.decryptFromSelf(args.ciphertext),
    );
    this.register("decrypt_observer_event", (args) =>
      identity.decryptObserverEvent(args.eventJson),
    );
    this.register("build_observer_control_event", (args) =>
      JSON.stringify(
        identity.buildObserverControlEvent(args.agentPubkey, args.payload),
      ),
    );
    this.register("sign_nostr_identity_binding", (args) =>
      JSON.stringify(identity.signIdentityBinding(args)),
    );
    this.register("resolve_oa_owner", (args) =>
      context.identityArchive.resolveOwner(args.targetPubkey),
    );
    this.register("archive_identity", (args) =>
      context.identityArchive.archive(args),
    );
    this.register("unarchive_identity", (args) =>
      context.identityArchive.unarchive(args),
    );
    this.register("list_archived_identities", () =>
      context.identityArchive.list(),
    );
    this.register("get_profile", () => context.profiles.get());
    this.register("get_user_profile", (args) =>
      context.profiles.get(
        typeof args.pubkey === "string"
          ? args.pubkey
          : context.identity.info().pubkey,
      ),
    );
    this.register("update_profile", (args) => context.profiles.update(args));
    this.register("update_profile_at_relay", (args) =>
      context.profiles.updateAtRelay(args),
    );
    this.register("get_users_batch", (args) =>
      context.profiles.usersBatch(args.pubkeys),
    );
    this.register("search_users", (args) =>
      context.profiles.search(args.query, args.limit),
    );
    this.register("get_channels", () => context.channels.list());
    this.register("get_channel_details", (args) =>
      context.channels.details(args.channelId),
    );
    this.register("get_channel_members", (args) =>
      context.channels.members(args.channelId),
    );
    this.register("create_channel", (args) => context.channels.create(args));
    this.register("ensure_starter_channels", () =>
      context.channels.ensureStarters(),
    );
    this.register("update_channel", (args) => context.channels.update(args));
    this.register("set_channel_topic", (args) =>
      context.channels.mutate("topic", args),
    );
    this.register("set_channel_purpose", (args) =>
      context.channels.mutate("purpose", args),
    );
    this.register("archive_channel", (args) =>
      context.channels.mutate("archive", args),
    );
    this.register("unarchive_channel", (args) =>
      context.channels.mutate("unarchive", args),
    );
    this.register("delete_channel", (args) =>
      context.channels.mutate("delete", args),
    );
    this.register("join_channel", (args) =>
      context.channels.mutate("join", args),
    );
    this.register("leave_channel", (args) =>
      context.channels.mutate("leave", args),
    );
    this.register("add_channel_members", (args) =>
      context.channels.addMembers(args),
    );
    this.register("remove_channel_member", (args) =>
      context.channels.changeMember(true, args),
    );
    this.register("change_channel_member_role", (args) =>
      context.channels.changeMember(false, args),
    );
    this.register("get_canvas", (args) =>
      context.channels.canvas(args.channelId),
    );
    this.register("set_canvas", (args) => context.channels.setCanvas(args));
    this.register("get_event", async (args) =>
      JSON.stringify(await context.channels.event(args.eventId)),
    );
    this.register("send_channel_message", (args) =>
      context.channels.sendMessage(args),
    );
    this.register("edit_message", (args) => context.channels.editMessage(args));
    this.register("delete_message", (args) =>
      context.channels.deleteMessage(args),
    );
    this.register("add_reaction", (args) =>
      context.channels.reaction(false, args),
    );
    this.register("remove_reaction", (args) =>
      context.channels.reaction(true, args),
    );
    this.register("search_messages", (args) => context.channels.search(args));
    this.register("get_feed", (args) => context.channels.feed(args));
    this.register("get_thread_replies", (args) =>
      context.channels.threadReplies(args),
    );
    this.register("get_channel_messages_before", (args) =>
      context.channels.messagesBefore(args),
    );
    this.register("get_channel_window", (args) =>
      context.channels.window(args),
    );
    this.register("get_forum_posts", (args) =>
      context.channels.forumPosts(args),
    );
    this.register("get_forum_thread", (args) =>
      context.channels.forumThread(args),
    );
    this.register("open_dm", (args) => context.channels.openDm(args));
    this.register("hide_dm", (args) => context.channels.hideDm(args.channelId));
    this.register("get_presence", (args) =>
      context.channels.presence(args.pubkeys),
    );
    this.register("list_relay_members", () => context.channels.relayMembers());
    this.register("get_my_relay_membership", () =>
      context.channels.myRelayMembership(),
    );
    this.register("add_relay_member", (args) =>
      context.channels.relayAdmin("add", args),
    );
    this.register("remove_relay_member", (args) =>
      context.channels.relayAdmin("remove", args),
    );
    this.register("change_relay_member_role", (args) =>
      context.channels.relayAdmin("role", args),
    );
    this.register("list_relay_agents", () => context.channels.relayAgents());
    this.register("get_note", (args) => context.social.note(args.noteId));
    this.register("get_user_notes", (args) =>
      context.social.notes({
        authors: [args.pubkey],
        before: args.before,
        beforeId: args.beforeId,
        limit: args.limit,
      }),
    );
    this.register("get_global_notes", (args) =>
      context.social.notes({
        before: args.before,
        beforeId: args.beforeId,
        limit: args.limit,
      }),
    );
    this.register("publish_note", (args) => context.social.publish(args));
    this.register("get_contact_list", (args) =>
      context.social.contactList(args.pubkey),
    );
    this.register("set_contact_list", (args) =>
      context.social.setContactList(args),
    );
    this.register("get_note_reactions", (args) =>
      context.social.reactions(args.noteIds),
    );
    this.register("get_liked_notes", (args) =>
      context.social.liked(args.authorPubkey, args.limit),
    );
    this.register("get_notes_timeline", (args) =>
      context.social.timeline(args.pubkeys, args.limitPerUser),
    );
    this.register("list_personas", () => context.localEntities.personas());
    this.register("create_persona", (args) =>
      context.localEntities.createPersona(args),
    );
    this.register("update_persona", (args) =>
      context.localEntities.updatePersona(args),
    );
    this.register("delete_persona", (args) =>
      context.localEntities.deletePersona(args.id),
    );
    this.register("set_persona_active", (args) =>
      context.localEntities.setPersonaActive(args.id, args.active),
    );
    this.register("list_teams", () => context.localEntities.teams());
    this.register("create_team", (args) =>
      context.localEntities.createTeam(args),
    );
    this.register("update_team", (args) =>
      context.localEntities.updateTeam(args),
    );
    this.register("delete_team", (args) =>
      context.localEntities.deleteTeam(args.id),
    );
    this.register("list_channel_templates", () =>
      context.localEntities.templates(),
    );
    this.register("create_channel_template", (args) =>
      context.localEntities.createTemplate(args),
    );
    this.register("update_channel_template", (args) =>
      context.localEntities.updateTemplate(args),
    );
    this.register("delete_channel_template", (args) =>
      context.localEntities.deleteTemplate(args.id),
    );
    this.register("duplicate_channel_template", (args) =>
      context.localEntities.duplicateTemplate(args.id),
    );
    this.register("get_global_agent_config", () =>
      context.localEntities.globalAgentConfig(),
    );
    this.register("set_global_agent_config", (args) =>
      context.localEntities.setGlobalAgentConfig(args),
    );
    this.register("encode_agent_snapshot_for_send", (args) =>
      context.snapshots.encodeAgent(args),
    );
    this.register("encode_team_snapshot_for_send", (args) =>
      context.snapshots.encodeTeam(args),
    );
    this.register("export_agent_snapshot", (args) =>
      context.snapshots.exportAgent(args),
    );
    this.register("export_team_snapshot", (args) =>
      context.snapshots.exportTeam(args),
    );
    this.register("preview_agent_snapshot_import", (args) =>
      context.snapshots.previewAgent(args),
    );
    this.register("confirm_agent_snapshot_import", (args) =>
      context.snapshots.confirmAgent(args),
    );
    this.register("preview_team_snapshot_import", (args) =>
      context.snapshots.previewTeam(args),
    );
    this.register("confirm_team_snapshot_import", (args) =>
      context.snapshots.confirmTeam(args),
    );
    this.register("list_managed_agents", () => context.managedAgents.list());
    this.register("create_managed_agent", (args) =>
      context.managedAgents.create(args),
    );
    this.register("start_managed_agent", (args) =>
      context.managedAgents.start(args.pubkey),
    );
    this.register("stop_managed_agent", (args) =>
      context.managedAgents.stop(args.pubkey),
    );
    this.register("delete_managed_agent", (args) =>
      context.managedAgents.remove(args.pubkey),
    );
    this.register("get_managed_agent_log", (args) =>
      context.managedAgents.log(args.pubkey, args.lineCount),
    );
    this.register("send_managed_agent_channel_message", (args) =>
      context.managedAgentMessages.send(args),
    );
    this.register("has_managed_agent_channel_message_marker", (args) =>
      context.managedAgentMessages.hasMarker(args),
    );
    this.register("get_agent_memory", (args) =>
      context.memory.list(args.agentPubkey),
    );
    this.register("update_managed_agent", (args) =>
      context.managedAgents.update(args),
    );
    this.register("set_managed_agent_start_on_app_launch", (args) =>
      context.managedAgents.setStartOnLaunch(
        args.pubkey,
        args.startOnAppLaunch,
      ),
    );
    this.register("set_managed_agent_auto_restart", (args) =>
      context.managedAgents.setAutoRestart(
        args.pubkey,
        args.autoRestartOnConfigChange,
      ),
    );
    this.register("list_managed_agent_runtimes", () =>
      context.managedAgents.runtimes(),
    );
    this.register("start_managed_agent_runtime", async (args) => {
      await context.managedAgents.start(args.pubkey);
      return context.managedAgents.runtimeStatus(args.pubkey, args.relayUrl);
    });
    this.register("stop_managed_agent_runtime", async (args) => {
      await context.managedAgents.stop(args.pubkey);
      return context.managedAgents.runtimeStatus(args.pubkey, args.relayUrl);
    });
    this.register("restart_managed_agent_runtime", async (args) => {
      await context.managedAgents.restart(args.pubkey);
      return context.managedAgents.runtimeStatus(args.pubkey, args.relayUrl);
    });
    this.register("reconcile_managed_agent_runtimes", () =>
      context.managedAgents.runtimes(),
    );
    this.register("put_managed_agent_runtime_lifecycle", (args) =>
      context.managedAgents.putRuntimeLifecycle(args.outerPubkey, args.payload),
    );
    this.register("get_agent_config_surface", (args) =>
      context.managedAgents.configSurface(args.pubkey),
    );
    this.register("put_agent_session_config", (args) =>
      context.managedAgents.putSessionConfig(args.pubkey, args.payload),
    );
    this.register("get_runtime_file_config", (args) =>
      context.runtimeCatalog.runtimeFileConfig(args.runtimeId),
    );
    this.register("get_git_identity", () => context.projectGit.gitIdentity());
    this.register("get_project_repo_snapshot", (args) =>
      context.projectGit.remoteSnapshot(args),
    );
    this.register("get_project_repo_diff", (args) =>
      context.projectGit.remoteDiff(args),
    );
    this.register("get_project_local_repo_snapshot", (args) =>
      context.projectGit.localSnapshot(args),
    );
    this.register("get_project_local_repo_diff", (args) =>
      context.projectGit.localDiff(args),
    );
    this.register("list_project_local_repositories", (args) =>
      context.projectGit.listLocal(args),
    );
    this.register("get_project_repo_sync_status", (args) =>
      context.projectGit.syncStatus(args),
    );
    this.register("clone_project_repository", (args) =>
      context.projectGit.clone(args),
    );
    this.register("push_project_local_repository", (args) =>
      context.projectGit.push(args),
    );
    this.register("pull_project_local_repository", (args) =>
      context.projectGit.pull(args),
    );
    this.register("create_project_remote_branch", (args) =>
      context.projectGit.createRemoteBranch(args),
    );
    this.register("delete_project_remote_branch", (args) =>
      context.projectGit.deleteRemoteBranch(args),
    );
    this.register("open_project_terminal", (args) =>
      context.projectGit.openTerminal(args),
    );
    this.register("open_project_merge_recovery_terminal", (args) =>
      context.projectGit.openMergeRecovery(args.input),
    );
    this.register("sign_project_pull_request_status", (args) =>
      context.projectGit.signStatus(args.input),
    );
    this.register("sign_project_pull_request_review_request", (args) =>
      context.projectGit.signReviewRequest(args.input),
    );
    this.register("publish_project_pull_request_merged_status", (args) =>
      context.projectGit.publishMergedStatus(args.input),
    );
    this.register("merge_project_pull_request", (args) =>
      context.projectGit.merge(args.input),
    );
    this.register("get_channel_workflows", (args) =>
      context.workflows.forChannel(args.channelId),
    );
    this.register("get_channels_workflows", (args) =>
      context.workflows.forChannels(args.channelIds),
    );
    this.register("get_workflow", (args) =>
      context.workflows.get(args.workflowId),
    );
    this.register("create_workflow", (args) =>
      context.workflows.create(args.channelId, args.yamlDefinition),
    );
    this.register("update_workflow", (args) =>
      context.workflows.update(args.workflowId, args.yamlDefinition),
    );
    this.register("delete_workflow", (args) =>
      context.workflows.remove(args.workflowId),
    );
    this.register("trigger_workflow", (args) =>
      context.workflows.trigger(args.workflowId),
    );
    this.register("get_workflow_runs", () => context.workflows.runs());
    this.register("get_run_approvals", () => context.workflows.approvals());
    this.register("grant_approval", (args) =>
      context.workflows.approval(true, args.token, args.note),
    );
    this.register("deny_approval", (args) =>
      context.workflows.approval(false, args.token, args.note),
    );

    this.register("apply_workspace", (args) => context.workspace.apply(args));
    this.register("get_active_workspace", () => ({
      pubkey: identity.info().pubkey,
      relay_url: context.workspace.relayUrl(),
    }));
    this.register("get_default_relay_url", () =>
      context.workspace.defaultRelayUrl(),
    );
    this.register("get_relay_ws_url", () => context.workspace.relayUrl());
    this.register("get_relay_http_url", () => context.workspace.relayHttpUrl());
    this.register("get_relay_self", () =>
      fetchRelaySelf(context.workspace.relayHttpUrl()),
    );
    this.register("auto_connect_default_relay_enabled", () => true);
    this.register("relay_requires_membership", () =>
      relayRequiresMembership(context.workspace.relayHttpUrl()),
    );
    this.register("fetch_join_policy", (args) =>
      fetchJoinPolicy(args.relayUrl),
    );
    this.register("fetch_workspace_icon", (args) =>
      fetchWorkspaceIcon(args.relayUrl),
    );
    this.register("fetch_link_preview_title", (args) =>
      fetchLinkPreviewTitle(args.href),
    );
    this.register("upload_media", (args) => context.media.uploadMedia(args));
    this.register("upload_media_bytes", (args) =>
      context.media.uploadBytes(args.data, args.filename),
    );
    this.register("pick_and_upload_media", () =>
      context.media.pickAndUploadMedia(),
    );
    this.register("pick_and_upload_image", () =>
      context.media.pickAndUploadImage(),
    );
    this.register("fetch_media_bytes", (args) =>
      context.media.fetchMedia(args.url),
    );
    this.register("fetch_snapshot_bytes", (args) =>
      context.media.fetchSnapshot(args),
    );
    this.register("download_file", (args) => context.media.downloadFile(args));
    this.register("download_image", (args) =>
      context.media.downloadImage(args),
    );
    this.register("copy_text_to_clipboard", (args) =>
      context.media.copyText(args),
    );
    this.register("copy_image_to_clipboard", (args) =>
      context.media.copyImage(args),
    );
    this.register("is_shared_identity", () => false);
    this.register("get_media_proxy_port", () => 0);
    this.register("get_baked_build_env", () => ({}));
    this.register("get_baked_build_env_keys", () => []);
    this.register("get_legacy_workspace_storage", () => ({
      activeWorkspaceId: null,
      onboardingCompletions: [],
      workspaces: null,
    }));
    this.register("take_pending_community_deep_link", () => null);
    this.register("acknowledge_pending_community_deep_link", () => false);
    this.register("get_os_idle_seconds", () => 0);
    this.register("is_auto_update_supported", () => false);
    this.register("relay_reconnect_hook_configured", () => false);
    this.register("relay_reconnect_hook", () => undefined);
    this.register("agent_metric_archive_default_enabled", () => true);
    this.register("observer_archive_default_enabled", () => true);

    this.register("perform_sidebar_default_haptic", () => undefined);
    this.register("set_window_vibrancy", () => undefined);
    this.register("set_prevent_sleep_active", () => undefined);
    this.register("title_bar_double_click", () => undefined);
    this.register("show_native_notification", () => undefined);
    this.register("set_audio_output_device", () => undefined);
    this.register("get_audio_output_device", () => null);
    this.register("set_voice_input_mode", (args) =>
      context.huddle.setVoiceInputMode(args.mode),
    );
    this.register("get_voice_input_mode", () =>
      context.huddle.voiceInputMode(),
    );
    this.register("set_tts_enabled", (args) =>
      context.huddle.setTtsEnabled(args.enabled),
    );
    this.register("set_huddle_transcription_enabled", (args) =>
      context.huddle.setTranscriptionEnabled(args.enabled),
    );
    this.register("check_pipeline_hotstart", () => undefined);
    this.register("download_voice_models", () => undefined);
    this.register("get_model_status", () => context.huddle.pipelineStatus());
    this.register("validate_repos_dir", (args) =>
      context.workspace.validateReposDirectory(args.dir),
    );
    this.register("set_agent_managed_profiles", (args) =>
      context.workspace.setAgentManagedProfiles(args.enabled),
    );
    this.register("discover_git_bash_prerequisite", () =>
      context.runtimeCatalog.gitBashPrerequisite(),
    );
    this.register("discover_backend_providers", () =>
      context.runtimeCatalog.discoverBackendProviders(),
    );
    this.register("probe_backend_provider", (args) =>
      context.runtimeCatalog.probeBackendProvider(args.binaryPath),
    );
    this.register("discover_acp_providers", () =>
      context.runtimeCatalog.discover(),
    );
    this.register("save_custom_harness", (args) =>
      context.runtimeCatalog.save(args.definition, args.originalId),
    );
    this.register("delete_custom_harness", (args) =>
      context.runtimeCatalog.remove(args.id),
    );
    this.register("install_acp_runtime", (args) =>
      context.runtimeCatalog.install(args.runtimeId),
    );
    this.register("discover_managed_agent_prereqs", (args) =>
      context.runtimeCatalog.prerequisites(args.input),
    );
    this.register("discover_acp_auth_methods", (args) =>
      context.runtimeCatalog.discoverAuthMethods(args.runtimeId),
    );
    this.register("connect_acp_runtime", (args) =>
      context.runtimeCatalog.connectAuth(args.request),
    );
    this.register("discover_agent_models", (args) =>
      context.agentModels.discover(args),
    );
    this.register("get_agent_models", (args) =>
      context.agentModels.get(args.pubkey),
    );
    this.register("mesh_start_node", (args) => context.meshCompute.start(args));
    this.register("mesh_stop_node", () => context.meshCompute.stop());
    this.register("mesh_installed_models", () =>
      context.meshCompute.installedModels(),
    );
    this.register("mesh_model_catalog", () =>
      context.meshCompute.modelCatalog(),
    );
    this.register("mesh_serving_usage", () =>
      context.meshCompute.servingUsage(),
    );
    this.register("mesh_node_status", () => context.meshCompute.status());
  }

  register(name: string, handler: Handler): void {
    if (this.#handlers.has(name)) {
      throw new Error(`duplicate desktop command registration: ${name}`);
    }
    this.#handlers.set(name, handler);
  }

  has(name: string): boolean {
    return this.#handlers.has(name);
  }

  list(): string[] {
    return [...this.#handlers.keys()].sort();
  }

  async invoke(name: string, args: unknown): Promise<unknown> {
    const handler = this.#handlers.get(name);
    if (!handler) {
      throw new Error(
        `Desktop command "${name}" has not been ported to TypeScript`,
      );
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new Error("command arguments must be an object");
    }
    return handler(args as Arguments);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}
