export type RootStackParams = {
  Tabs: undefined;
  Channel: {
    readonly channelId: string;
    readonly focusEventId?: string;
  };
  Thread: {
    readonly channelId: string;
    readonly rootId: string;
  };
  CreateChannel: undefined;
  Members: {
    readonly channelId: string;
  };
  Canvas: {
    readonly channelId: string;
  };
  Settings: undefined;
  ChannelSections: undefined;
  Pairing: {
    readonly initialValue?: string;
  };
  Profile: {
    readonly pubkey: string;
  };
  AgentActivity: {
    readonly agentPubkey: string;
    readonly channelId?: string;
  };
  MediaViewer: {
    readonly url: string;
    readonly kind: "image" | "video";
    readonly alt?: string;
    readonly posterUrl?: string;
  };
  ComposeNote: {
    readonly replyToEventId?: string;
  };
  Invite: {
    readonly relayUrl: string;
    readonly code: string;
    readonly policyReceipt?: string;
  };
};

export type MainTabParams = {
  Channels: undefined;
  Activity: undefined;
  Pulse: undefined;
  Search: undefined;
};
