import { createHash } from "node:crypto";
import type { CronJob } from "../../cron/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { executeScheduledHeartbeatEvent } from "../../infra/heartbeat-runner.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type {
  AdmissionResult,
  JsonValue,
  SchedulerDispatchResult,
} from "../../scheduler/conversation-scheduler.js";
import {
  getRuntimeConversationScheduler,
  registerRuntimeConversationSchedulerProducer,
} from "../../scheduler/runtime-conversation-scheduler.js";
import {
  beginRuntimeProducerDispatch,
  buildRuntimeProducerEvent,
  completeRuntimeProducerDispatch,
  resolveRuntimeProducerRoute,
} from "../../scheduler/runtime-producer-admission.js";
import type { SchedulerProducerRegistration } from "../../scheduler/scheduler-producer-registry.js";

export type ScheduledHookPayload = {
  version: 1;
  kind: "hook_run";
  job: CronJob;
  message: string;
  sessionKey: string;
  lane: "cron";
  runId: string;
  sourcePath: string;
  sourceGeneration: string;
};

type HookSchedulerExecutor = (
  payload: ScheduledHookPayload,
) => Promise<{ ok: true } | { ok: false; reason: string }>;

let executeScheduledHook: HookSchedulerExecutor | undefined;
let unregisterHookSchedulerProducer: (() => void) | undefined;

function normalizeScheduledHookPayload(payload: ScheduledHookPayload): JsonValue {
  return structuredClone(payload) as JsonValue;
}

function parseScheduledHookPayload(value: unknown): ScheduledHookPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scheduled hook payload must be an object");
  }
  const payload = value as Partial<ScheduledHookPayload>;
  if (
    payload.version !== 1 ||
    payload.kind !== "hook_run" ||
    !payload.job ||
    typeof payload.job !== "object" ||
    typeof payload.job.id !== "string" ||
    typeof payload.message !== "string" ||
    typeof payload.sessionKey !== "string" ||
    payload.lane !== "cron" ||
    typeof payload.runId !== "string" ||
    typeof payload.sourcePath !== "string" ||
    typeof payload.sourceGeneration !== "string"
  ) {
    throw new Error("scheduled hook payload is invalid");
  }
  return payload as ScheduledHookPayload;
}

export function buildScheduledHookEvent(payload: ScheduledHookPayload) {
  const agentId = normalizeAgentId(
    payload.job.agentId ?? resolveAgentIdFromSessionKey(payload.sessionKey) ?? "main",
  );
  const eventId = createHash("sha256")
    .update("hook\0")
    .update(payload.job.id)
    .update("\0")
    .update(payload.sessionKey)
    .update("\0")
    .update(payload.sourceGeneration)
    .digest("hex");
  return buildRuntimeProducerEvent({
    id: eventId,
    route: resolveRuntimeProducerRoute({ sessionKey: payload.sessionKey, agentId }),
    producerKind: "hook",
    createdAt: payload.job.createdAtMs,
    payload: normalizeScheduledHookPayload(payload),
  });
}

async function dispatchScheduledHookBatch(
  batch: Parameters<SchedulerProducerRegistration["dispatch"]>[0],
): Promise<SchedulerDispatchResult> {
  const runCorrelationId = beginRuntimeProducerDispatch(batch);
  const failures: Array<{ eventId: string; reason: string }> = [];
  for (const event of batch.events) {
    const rawPayload = event.payload as { kind?: unknown };
    if (rawPayload?.kind === "heartbeat_wake") {
      const result = await executeScheduledHeartbeatEvent(event);
      if (result.status === "failed") {
        failures.push({ eventId: event.id, reason: result.reason });
      }
      continue;
    }
    try {
      const payload = parseScheduledHookPayload(event.payload);
      if (!executeScheduledHook) {
        throw new Error("hook scheduler executor is unavailable");
      }
      const result = await executeScheduledHook(payload);
      if (!result.ok) {
        failures.push({ eventId: event.id, reason: result.reason });
      }
    } catch (error) {
      failures.push({ eventId: event.id, reason: formatErrorMessage(error) });
    }
  }
  if (failures.length > 0) {
    return {
      outcome: "failed",
      failure: { kind: "hook_failed", failures },
      runCorrelationId,
    };
  }
  return completeRuntimeProducerDispatch({ batch, runCorrelationId });
}

/** Installs the sole durable owner for direct hook turns and hook-originated heartbeat wakes. */
export function ensureHookSchedulerProducerRegistered(executor: HookSchedulerExecutor): void {
  executeScheduledHook = executor;
  unregisterHookSchedulerProducer ??= registerRuntimeConversationSchedulerProducer({
    producerKinds: ["hook"],
    dispatch: dispatchScheduledHookBatch,
  });
}

/** Durably transfers a direct hook turn before the HTTP request is acknowledged. */
export async function admitScheduledHook(payload: ScheduledHookPayload): Promise<AdmissionResult> {
  if (!executeScheduledHook) {
    throw new Error("hook scheduler producer must be registered before admission");
  }
  return await getRuntimeConversationScheduler().admit(buildScheduledHookEvent(payload));
}

export function resetHookSchedulerProducerRegistrationForTests(): void {
  unregisterHookSchedulerProducer?.();
  unregisterHookSchedulerProducer = undefined;
  executeScheduledHook = undefined;
}

export const hookSchedulerAdmissionTesting = {
  dispatchScheduledHookBatch,
  parseScheduledHookPayload,
};
