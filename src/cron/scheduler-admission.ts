import { createHash } from "node:crypto";
import { formatErrorMessage } from "../infra/errors.js";
import { executeScheduledHeartbeatEvent } from "../infra/heartbeat-runner.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { JsonValue } from "../scheduler/conversation-scheduler.js";
import {
  beginRuntimeProducerDispatch,
  buildRuntimeProducerEvent,
  completeRuntimeProducerDispatch,
  resolveRuntimeProducerRoute,
} from "../scheduler/runtime-producer-admission.js";
import type { SchedulerProducerRegistration } from "../scheduler/scheduler-producer-registry.js";
import { resolveCronAgentSessionKey } from "./isolated-agent/session-key.js";
import type { CronServiceState } from "./service/state.js";
import type { CronDeliveryTrace, CronJob, CronRunOutcome, CronRunTelemetry } from "./types.js";

type CronExecutionResult = CronRunOutcome &
  CronRunTelemetry & {
    delivered?: boolean;
    deliveryAttempted?: boolean;
    delivery?: CronDeliveryTrace;
    triggerEval?: { fired: boolean; stateChanged: boolean; state?: unknown; busy?: true };
  };

type ScheduledCronPayload = {
  version: 1;
  kind: "cron_run";
  job: CronJob;
  sourceSessionKey: string;
  producerGeneration: string;
  dueSlotMs: number;
};

type PendingCronResult = { resolve: (result: CronExecutionResult) => void };
const pendingCronResults = new Map<string, Set<PendingCronResult>>();

function normalizeScheduledCronPayload(payload: ScheduledCronPayload): JsonValue {
  // JSON normalization intentionally strips optional undefined values before durable admission.
  // eslint-disable-next-line unicorn/prefer-structured-clone
  return JSON.parse(JSON.stringify(payload)) as JsonValue;
}

function parseScheduledCronPayload(value: unknown): ScheduledCronPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scheduled cron payload must be an object");
  }
  const payload = value as Partial<ScheduledCronPayload>;
  if (
    payload.version !== 1 ||
    payload.kind !== "cron_run" ||
    !payload.job ||
    typeof payload.job !== "object" ||
    typeof payload.job.id !== "string" ||
    typeof payload.sourceSessionKey !== "string" ||
    typeof payload.producerGeneration !== "string" ||
    typeof payload.dueSlotMs !== "number"
  ) {
    throw new Error("scheduled cron payload is invalid");
  }
  return payload as ScheduledCronPayload;
}

function resolveCronSourceSessionKey(params: {
  state: CronServiceState;
  job: CronJob;
  dueSlotMs: number;
}): string {
  const explicitSessionKey = params.job.sessionKey?.trim();
  if (explicitSessionKey) {
    return explicitSessionKey;
  }
  const agentId = normalizeAgentId(
    params.job.agentId ??
      resolveAgentIdFromSessionKey(params.job.sessionKey) ??
      params.state.deps.defaultAgentId,
  );
  if (params.job.sessionTarget === "main") {
    return `agent:${agentId}:main`;
  }
  return resolveCronAgentSessionKey({ sessionKey: `cron:${params.job.id}`, agentId });
}

export function buildScheduledCronEvent(params: {
  state: CronServiceState;
  job: CronJob;
  dueSlotMs: number;
  producerGeneration: string;
}) {
  const sourceSessionKey = resolveCronSourceSessionKey(params);
  const agentId = normalizeAgentId(
    params.job.agentId ??
      resolveAgentIdFromSessionKey(sourceSessionKey) ??
      params.state.deps.defaultAgentId,
  );
  const eventId = createHash("sha256")
    .update("cron\0")
    .update(params.job.id)
    .update("\0")
    .update(sourceSessionKey)
    .update("\0")
    .update(String(params.dueSlotMs))
    .update("\0")
    .update(params.producerGeneration)
    .digest("hex");
  return buildRuntimeProducerEvent({
    id: eventId,
    route: resolveRuntimeProducerRoute({ sessionKey: sourceSessionKey, agentId }),
    producerKind: "cron",
    createdAt: params.dueSlotMs,
    payload: normalizeScheduledCronPayload({
      version: 1,
      kind: "cron_run",
      job: params.job,
      sourceSessionKey,
      producerGeneration: params.producerGeneration,
      dueSlotMs: params.dueSlotMs,
    }),
  });
}

export async function runCronThroughScheduler(params: {
  state: CronServiceState;
  job: CronJob;
  dueSlotMs: number;
  producerGeneration: string;
  runDirect: (job: CronJob) => Promise<CronExecutionResult>;
}): Promise<CronExecutionResult> {
  const scheduler = params.state.deps.conversationScheduler;
  if (!scheduler) {
    return await params.runDirect(params.job);
  }
  const event = buildScheduledCronEvent(params);
  let resolveResult!: (result: CronExecutionResult) => void;
  const resultPromise = new Promise<CronExecutionResult>((resolve) => {
    resolveResult = resolve;
  });
  const pendingResult = { resolve: resolveResult };
  const pending = pendingCronResults.get(event.id) ?? new Set<PendingCronResult>();
  pending.add(pendingResult);
  pendingCronResults.set(event.id, pending);
  const admission = await scheduler.admit(event);
  if (admission.accepted) {
    const settleFromDurableReceipt = async () => {
      const receiptState = await scheduler.waitForReceiptTerminal?.(admission.receiptId);
      if (
        receiptState !== "delivered" &&
        receiptState !== "failed" &&
        receiptState !== "storage_error" &&
        receiptState !== "cancelled"
      ) {
        return;
      }
      if (!pendingCronResults.get(event.id)?.has(pendingResult)) {
        return;
      }
      pending.delete(pendingResult);
      if (pending.size === 0) {
        pendingCronResults.delete(event.id);
      }
      resolveResult(
        receiptState === "delivered"
          ? { status: "ok" }
          : { status: "error", error: `duplicate cron receipt is ${receiptState}` },
      );
    };
    void settleFromDurableReceipt();
    return await resultPromise;
  }
  pending.delete(pendingResult);
  if (pending.size === 0) {
    pendingCronResults.delete(event.id);
  }
  return await params.runDirect(params.job);
}

export function registerCronSchedulerProducer(params: {
  state: CronServiceState;
  runDirect: (
    job: CronJob,
    context: { producerGeneration: string; dueSlotMs: number },
  ) => Promise<CronExecutionResult>;
  runHeartbeatEvent?: typeof executeScheduledHeartbeatEvent;
}): (() => void) | undefined {
  const register = params.state.deps.registerConversationSchedulerProducer;
  if (!params.state.deps.conversationScheduler || !register) {
    return undefined;
  }
  const registration: SchedulerProducerRegistration = {
    producerKinds: ["cron"],
    dispatch: async (batch) => {
      const runCorrelationId = beginRuntimeProducerDispatch(batch);
      const failures: Array<{ eventId: string; reason: string }> = [];
      for (const event of batch.events) {
        const rawPayload = event.payload as { kind?: unknown };
        if (rawPayload?.kind === "heartbeat_wake") {
          const heartbeatResult = await (
            params.runHeartbeatEvent ?? executeScheduledHeartbeatEvent
          )(event);
          if (heartbeatResult.status === "failed") {
            failures.push({ eventId: event.id, reason: heartbeatResult.reason });
          }
          continue;
        }
        let result: CronExecutionResult;
        try {
          const payload = parseScheduledCronPayload(event.payload);
          result = await params.runDirect(payload.job, {
            producerGeneration: payload.producerGeneration,
            dueSlotMs: payload.dueSlotMs,
          });
        } catch (error) {
          result = { status: "error", error: formatErrorMessage(error) };
        }
        for (const pending of pendingCronResults.get(event.id) ?? []) {
          pending.resolve(result);
        }
        pendingCronResults.delete(event.id);
        if (result.status === "error") {
          failures.push({ eventId: event.id, reason: result.error ?? "cron run failed" });
        }
      }
      if (failures.length > 0) {
        return {
          outcome: "failed",
          failure: { kind: "cron_failed", failures },
          runCorrelationId,
        };
      }
      return completeRuntimeProducerDispatch({ batch, runCorrelationId });
    },
  };
  return register(registration);
}

export const cronSchedulerAdmissionTesting = {
  parseScheduledCronPayload,
  resolveCronSourceSessionKey,
};
