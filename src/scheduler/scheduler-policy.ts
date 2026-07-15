import type {
  SchedulerConfig,
  SchedulerConversationClass,
  SchedulerCopyPair,
  SchedulerDebouncePair,
} from "../config/types.scheduler.js";
import type {
  ScheduledEvent,
  SchedulerDispatchBatch,
  SchedulerProducerKind,
} from "./conversation-scheduler.js";

export const SCHEDULER_PRODUCER_KINDS = [
  "human_message",
  "human_media",
  "human_reaction",
  "human_edit",
  "human_deletion",
  "human_reply",
  "human_forward",
  "human_location",
  "subagent_completion",
  "subagent_interruption",
  "subagent_timeout",
  "subagent_failure",
  "heartbeat",
  "cron",
  "exec_completion",
  "media_generation_completion",
  "sessions_send",
  "hook",
  "node",
  "restart",
  "recovery",
  "system",
  "operator",
  "talk",
  "voice",
] as const satisfies readonly SchedulerProducerKind[];

export type SchedulerPolicyConfig = SchedulerConfig;

const DEFAULT_DEBOUNCE: Record<SchedulerConversationClass, SchedulerDebouncePair> = {
  direct: { textMs: 0, mediaMs: 6_900 },
  two_member: { textMs: 0, mediaMs: 6_900 },
  shared: { textMs: 4_200, mediaMs: 6_900 },
};

const DEFAULT_SOURCE_COPY = Object.fromEntries(
  SCHEDULER_PRODUCER_KINDS.map((kind) => [
    kind,
    {
      singular: `[📋 QUEUE ENGINE]: [${kind.toUpperCase()} EVENT]`,
      plural: `[📋 QUEUE ENGINE]: [${kind.toUpperCase()} EVENTS]`,
    },
  ]),
) as Record<SchedulerProducerKind, SchedulerCopyPair>;

const DEFAULT_TIMING_COPY: Record<SchedulerDispatchBatch["placement"], SchedulerCopyPair> = {
  idle: {
    singular: "[📋 QUEUE ENGINE]: [THE FOLLOWING MESSAGE ARRIVED WHILE YOU WERE IDLE]",
    plural:
      "[📋 QUEUE ENGINE]: [THE FOLLOWING MESSAGES ARRIVED IN QUICK SUCCESSION WHILE YOU WERE IDLE]",
  },
  recovery: {
    singular:
      "[📋 QUEUE ENGINE]: [THE FOLLOWING MESSAGE IS RECOVERING AFTER AN EARLIER RUN FAILED]",
    plural:
      "[📋 QUEUE ENGINE]: [THE FOLLOWING MESSAGES ARE RECOVERING AFTER AN EARLIER RUN FAILED]",
  },
};

export function schedulerExactRouteKey(event: Pick<ScheduledEvent, "route">): string {
  const { route } = event;
  return JSON.stringify([
    route.channel.toLowerCase(),
    route.accountId,
    route.conversationId,
    route.threadId ?? null,
  ]);
}

export function resolveSchedulerDebounceMs(params: {
  event: ScheduledEvent;
  config?: SchedulerPolicyConfig;
  conversationClass?: SchedulerConversationClass;
}): number {
  if (!params.event.human) {
    return 0;
  }
  const conversationClass =
    params.conversationClass ??
    (params.event.route.conversationKind === "direct" ? "direct" : "shared");
  const field = params.event.media ? "mediaMs" : "textMs";
  const exact =
    params.config?.debounce?.exactRoutes?.[schedulerExactRouteKey(params.event)]?.[field];
  const channel =
    params.config?.debounce?.channels?.[params.event.route.channel.toLowerCase()]?.[
      conversationClass
    ]?.[field];
  const global = params.config?.debounce?.conversationClasses?.[conversationClass]?.[field];
  const value = exact ?? channel ?? global ?? DEFAULT_DEBOUNCE[conversationClass][field];
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`scheduler ${field} must be a finite non-negative number`);
  }
  return value;
}

export function validateSchedulerCopy(config?: SchedulerPolicyConfig): void {
  if (config?.copy?.genericSource) {
    assertPair(config.copy.genericSource, "generic source");
  }
  for (const kind of SCHEDULER_PRODUCER_KINDS) {
    const pair =
      config?.copy?.sources?.[kind] ?? DEFAULT_SOURCE_COPY[kind] ?? config?.copy?.genericSource;
    assertPair(pair, `source ${kind}`);
  }
  for (const placement of ["idle", "recovery"] as const) {
    assertPair(config?.copy?.timing?.[placement] ?? DEFAULT_TIMING_COPY[placement], placement);
  }
}

export function renderSchedulerEnvelope(params: {
  batch: SchedulerDispatchBatch;
  payload: string;
  config?: SchedulerPolicyConfig;
}): string {
  const count = params.batch.events.length;
  if (count === 0) {
    throw new Error("cannot render an empty scheduler batch");
  }
  const producerKinds = [...new Set(params.batch.events.map((event) => event.producerKind))];
  const sourcePairs = producerKinds.map((kind) => {
    const pair =
      params.config?.copy?.sources?.[kind] ??
      DEFAULT_SOURCE_COPY[kind] ??
      params.config?.copy?.genericSource;
    if (!pair) {
      throw new Error(`scheduler copy is missing source ${kind}`);
    }
    assertPair(pair, `source ${kind}`);
    return pair;
  });
  const source = sourcePairs.map((pair) => selectCopy(pair, count)).join(" ");
  const timingPair =
    params.config?.copy?.timing?.[params.batch.placement] ??
    DEFAULT_TIMING_COPY[params.batch.placement];
  assertPair(timingPair, `timing ${params.batch.placement}`);
  return `${source}\n${selectCopy(timingPair, count)}\n${params.payload}`;
}

function selectCopy(pair: SchedulerCopyPair, count: number): string {
  return count === 1 ? pair.singular : pair.plural;
}

function assertPair(pair: SchedulerCopyPair, label: string): void {
  if (!pair.singular.trim() || !pair.plural.trim()) {
    throw new Error(`scheduler ${label} copy requires singular and plural values`);
  }
}
