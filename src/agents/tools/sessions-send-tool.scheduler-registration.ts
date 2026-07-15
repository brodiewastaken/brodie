import type {
  SchedulerDispatchBatch,
  SchedulerDispatchResult,
} from "../../scheduler/conversation-scheduler.js";
import { registerRuntimeConversationSchedulerProducer } from "../../scheduler/runtime-conversation-scheduler.js";

let unregisterSessionsSendProducer: (() => void) | undefined;

async function dispatchScheduledSessionsSendBatch(
  batch: SchedulerDispatchBatch,
): Promise<SchedulerDispatchResult> {
  const scheduler = await import("./sessions-send-tool.scheduler.js");
  return await scheduler.dispatchScheduledSessionsSendBatch(batch);
}

/** Register restart recovery without loading the sessions_send execution graph at gateway startup. */
export function ensureSessionsSendSchedulerProducerRegistered(): void {
  unregisterSessionsSendProducer ??= registerRuntimeConversationSchedulerProducer({
    producerKinds: ["sessions_send"],
    dispatch: dispatchScheduledSessionsSendBatch,
  });
}

export function resetSessionsSendSchedulerProducerRegistrationForTests(): void {
  unregisterSessionsSendProducer?.();
  unregisterSessionsSendProducer = undefined;
}
