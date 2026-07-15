// Fixed brodie-owned status sections and failure-contained probe helpers.
import type { RunPolicy } from "../agents/run-policy.js";
import type { SchedulerSnapshot } from "../scheduler/conversation-scheduler.js";
import { getRuntimeConversationScheduler } from "../scheduler/runtime-conversation-scheduler.js";

export type BoundedStatusProbeResult<T> =
  | { status: "available"; value: T }
  | { status: "unavailable"; reason: "rejected" | "timeout" };

/**
 * Contain an operator probe behind one timeout and cancellation boundary.
 * The terminal guard prevents a late completion from mutating a later refresh,
 * while the attached handlers contain late rejections.
 */
export async function runBoundedStatusProbe<T>(params: {
  timeoutMs: number;
  probe: (signal: AbortSignal) => Promise<T>;
}): Promise<BoundedStatusProbeResult<T>> {
  const controller = new AbortController();
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const probePromise = Promise.resolve()
    .then(() => params.probe(controller.signal))
    .then(
      (value) => ({ kind: "value" as const, value }),
      () => ({ kind: "rejected" as const }),
    );
  const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(
      () => {
        if (!settled) {
          controller.abort();
          resolve({ kind: "timeout" });
        }
      },
      Math.max(1, params.timeoutMs),
    );
  });
  const result = await Promise.race([probePromise, timeoutPromise]);
  settled = true;
  if (timer) {
    clearTimeout(timer);
  }
  if (result.kind === "value") {
    return { status: "available", value: result.value };
  }
  return { status: "unavailable", reason: result.kind };
}

export function formatRunPolicyStatusLine(policy: RunPolicy | undefined): string {
  if (!policy) {
    return "🧭 Run policy: native runtime";
  }
  const primary = `${policy.primary.provider}/${policy.primary.model}`;
  const fallbacks = policy.fallbacks.length;
  return [
    `🧭 Run policy: ${primary}`,
    `reasoning ${policy.reasoning}`,
    `fast ${policy.fastMode ? "on" : "off"}`,
    `${fallbacks} fallback${fallbacks === 1 ? "" : "s"}`,
    `${policy.maxNativeImages} native image${policy.maxNativeImages === 1 ? "" : "s"}`,
    `journals ${policy.startupJournals}`,
  ].join(" · ");
}

export function formatSchedulerStatusLine(
  result: BoundedStatusProbeResult<SchedulerSnapshot>,
): string {
  if (result.status === "unavailable") {
    return `🪢 Scheduler: unavailable (${result.reason})`;
  }
  const snapshot = result.value;
  const pending = snapshot.lanes.reduce((sum, lane) => sum + lane.pendingCount, 0);
  const failures = snapshot.lanes.reduce((sum, lane) => sum + lane.failureCount, 0);
  const recovery = snapshot.lanes.reduce((sum, lane) => sum + lane.callbackPendingCount, 0);
  return [
    `🪢 Scheduler: ${snapshot.lanes.length} lane${snapshot.lanes.length === 1 ? "" : "s"}`,
    `${pending} pending`,
    `${failures} failed`,
    `${recovery} recovery`,
    `storage ${snapshot.storageHealthy ? "healthy" : "error"}`,
  ].join(" · ");
}

export async function collectSchedulerStatusLine(timeoutMs = 1_000): Promise<string> {
  const result = await runBoundedStatusProbe({
    timeoutMs,
    probe: async () => await getRuntimeConversationScheduler().snapshot(),
  });
  return formatSchedulerStatusLine(result);
}
