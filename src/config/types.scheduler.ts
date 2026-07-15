import type { SchedulerProducerKind } from "../scheduler/conversation-scheduler.js";

export type SchedulerConversationClass = "direct" | "two_member" | "shared";
export type SchedulerCopyPair = { singular: string; plural: string };
export type SchedulerDebouncePair = { textMs: number; mediaMs: number };

export type SchedulerConfig = {
  enabled?: boolean;
  capacity?: {
    maxRows?: number;
    maxBytes?: number;
  };
  debounce?: {
    exactRoutes?: Record<string, Partial<SchedulerDebouncePair>>;
    channels?: Partial<
      Record<string, Partial<Record<SchedulerConversationClass, Partial<SchedulerDebouncePair>>>>
    >;
    conversationClasses?: Partial<
      Record<SchedulerConversationClass, Partial<SchedulerDebouncePair>>
    >;
  };
  copy?: {
    sources?: Partial<Record<SchedulerProducerKind, SchedulerCopyPair>>;
    timing?: Partial<Record<"idle" | "recovery", SchedulerCopyPair>>;
    genericSource?: SchedulerCopyPair;
  };
};
