export type TriggerContext = {
  readonly text: string;
  readonly author: string;
  readonly channelId: string;
  readonly timestamp: number;
  readonly emoji: string;
  readonly messageId: string;
  readonly webhookFields: Readonly<Record<string, string>>;
};

export type WorkflowTraceEntry = {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly status: "completed" | "skipped" | "waiting_approval" | "failed";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly output?: unknown;
  readonly error?: string;
};

export type WorkflowRunResult =
  | {
      readonly status: "completed";
      readonly currentStep: number;
      readonly outputs: Readonly<Record<string, unknown>>;
      readonly trace: readonly WorkflowTraceEntry[];
    }
  | {
      readonly status: "waiting_approval";
      readonly currentStep: number;
      readonly approval: {
        readonly token: string;
        readonly stepId: string;
        readonly approver: string;
        readonly message: string;
        readonly expiresAt: string;
      };
      readonly outputs: Readonly<Record<string, unknown>>;
      readonly trace: readonly WorkflowTraceEntry[];
    }
  | {
      readonly status: "failed";
      readonly currentStep: number;
      readonly error: string;
      readonly outputs: Readonly<Record<string, unknown>>;
      readonly trace: readonly WorkflowTraceEntry[];
    };
