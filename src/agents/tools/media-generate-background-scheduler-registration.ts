import type {
  SchedulerDispatchBatch,
  SchedulerDispatchResult,
} from "../../scheduler/conversation-scheduler.js";
import { registerRuntimeConversationSchedulerProducer } from "../../scheduler/runtime-conversation-scheduler.js";

let unregisterMediaGenerationCompletionProducer: (() => void) | undefined;

async function dispatchScheduledMediaGenerationCompletionBatch(
  batch: SchedulerDispatchBatch,
): Promise<SchedulerDispatchResult> {
  const mediaGeneration = await import("./media-generate-background-shared.js");
  return await mediaGeneration.dispatchScheduledMediaCompletion(batch);
}

/** Register restart recovery without loading media provider execution graphs at gateway startup. */
export function ensureMediaGenerationCompletionSchedulerProducerRegistered(): void {
  unregisterMediaGenerationCompletionProducer ??= registerRuntimeConversationSchedulerProducer({
    producerKinds: ["media_generation_completion"],
    dispatch: dispatchScheduledMediaGenerationCompletionBatch,
  });
}

export function resetMediaGenerationCompletionSchedulerProducerRegistrationForTests(): void {
  unregisterMediaGenerationCompletionProducer?.();
  unregisterMediaGenerationCompletionProducer = undefined;
}
