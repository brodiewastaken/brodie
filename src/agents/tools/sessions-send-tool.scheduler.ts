import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { callGateway } from "../../gateway/call.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type {
  JsonValue,
  ScheduledEvent,
  SchedulerDispatchBatch,
  SchedulerDispatchResult,
} from "../../scheduler/conversation-scheduler.js";
import { getRuntimeConversationScheduler } from "../../scheduler/runtime-conversation-scheduler.js";
import {
  beginRuntimeProducerDispatch,
  buildRuntimeProducerEvent,
  completeRuntimeProducerDispatch,
  correlateRuntimeProducerDispatch,
  resolveRuntimeProducerRoute,
} from "../../scheduler/runtime-producer-admission.js";
import { isCronRunSessionKey, parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  type EmbeddedAgentQueueMessageOptions,
  type EmbeddedAgentQueueMessageOutcome,
  formatEmbeddedAgentQueueFailureSummary,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunCorrelationId,
  resolveActiveEmbeddedRunSessionId,
  waitForEmbeddedAgentRunEnd,
} from "../embedded-agent-runner/runs.js";
import { isRecoverableAgentWaitError, waitForAgentRun } from "../run-wait.js";
import { jsonResult } from "./common.js";
import {
  ensureSessionsSendSchedulerProducerRegistered,
  resetSessionsSendSchedulerProducerRegistrationForTests,
} from "./sessions-send-tool.scheduler-registration.js";

export { ensureSessionsSendSchedulerProducerRegistered } from "./sessions-send-tool.scheduler-registration.js";

type GatewayCaller = typeof callGateway;

export type SessionsSendStartResult =
  | {
      ok: true;
      runId: string;
      activeRunQueue?: boolean;
      activeRunQueueSessionId?: string;
      activeRunCorrelationId?: string;
      a2aSessionKey?: string;
      a2aDisplayKey?: string;
      alreadyDelivered?: true;
    }
  | { ok: false; result: ReturnType<typeof jsonResult> };

type ScheduledSessionsSendPayload = {
  version: 1;
  runId: string;
  targetSessionKey: string;
  displayKey: string;
  sendParams: Record<string, JsonValue>;
  deliveryTimeoutMs?: number;
  allowActiveRunQueueDelivery: boolean;
};

type PendingSessionsSend = {
  callGateway: GatewayCaller;
  resolve: (result: SessionsSendStartResult) => void;
};

const pendingSessionsSends = new Map<string, Set<PendingSessionsSend>>();

function isRunScopedAgentSessionKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(normalizeOptionalString(sessionKey));
  return Boolean(parsed && /(?:^|:)run:[^:]+(?::|$)/.test(parsed.rest));
}

export function resolveCronRunScopedFallbackSessionKey(sessionKey: string): string | undefined {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey || !isCronRunSessionKey(normalizedSessionKey)) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(normalizedSessionKey);
  if (!parsed) {
    return undefined;
  }
  const runMarker = ":run:";
  const runMarkerIndex = parsed.rest.lastIndexOf(runMarker);
  if (runMarkerIndex <= 0) {
    return undefined;
  }
  const runId = parsed.rest.slice(runMarkerIndex + runMarker.length);
  if (!runId || runId.includes(":")) {
    return undefined;
  }
  const fallbackRest = parsed.rest.slice(0, runMarkerIndex);
  if (!fallbackRest) {
    return undefined;
  }
  return `agent:${parsed.agentId}:${fallbackRest}`;
}

function shouldFallbackCronRunScopedActiveDelivery(
  outcome: EmbeddedAgentQueueMessageOutcome,
): boolean {
  return (
    !outcome.queued && (outcome.reason === "not_streaming" || outcome.reason === "no_active_run")
  );
}

async function startSessionsSendAgentRun(params: {
  callGateway: GatewayCaller;
  runId: string;
  sendParams: Record<string, unknown>;
  sessionKey: string;
  deliveryTimeoutMs?: number;
  allowActiveRunQueueDelivery?: boolean;
}): Promise<SessionsSendStartResult> {
  try {
    const activeRunSessionId =
      params.allowActiveRunQueueDelivery && isRunScopedAgentSessionKey(params.sessionKey)
        ? resolveActiveEmbeddedRunSessionId(params.sessionKey)
        : undefined;
    const messageText =
      typeof params.sendParams.message === "string" ? params.sendParams.message : undefined;
    if (activeRunSessionId && messageText) {
      const sourceReplyDeliveryMode =
        params.sendParams.sourceReplyDeliveryMode === "automatic" ||
        params.sendParams.sourceReplyDeliveryMode === "message_tool_only"
          ? params.sendParams.sourceReplyDeliveryMode
          : undefined;
      const queueOptions: EmbeddedAgentQueueMessageOptions = {
        steeringMode: "all",
        debounceMs: 0,
        deliveryTimeoutMs: params.deliveryTimeoutMs,
        waitForTranscriptCommit: true,
        ...(sourceReplyDeliveryMode ? { sourceReplyDeliveryMode } : {}),
      };
      let queueOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
        activeRunSessionId,
        messageText,
        queueOptions,
      );
      if (!queueOutcome.queued && queueOutcome.reason === "transcript_commit_wait_unsupported") {
        const bestEffortQueueOptions = { ...queueOptions };
        delete bestEffortQueueOptions.waitForTranscriptCommit;
        queueOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
          activeRunSessionId,
          messageText,
          bestEffortQueueOptions,
        );
      }
      if (queueOutcome.queued) {
        return {
          ok: true,
          runId: params.runId,
          activeRunQueue: true,
          activeRunQueueSessionId: activeRunSessionId,
          activeRunCorrelationId:
            resolveActiveEmbeddedRunCorrelationId(activeRunSessionId) ?? activeRunSessionId,
        };
      }
      const fallbackSessionKey = resolveCronRunScopedFallbackSessionKey(params.sessionKey);
      if (fallbackSessionKey && shouldFallbackCronRunScopedActiveDelivery(queueOutcome)) {
        const response = await params.callGateway<{ runId: string }>({
          method: "agent",
          params: {
            ...params.sendParams,
            sessionKey: fallbackSessionKey,
            idempotencyKey: createHash("sha256")
              .update(params.runId)
              .update("\0cron-parent")
              .digest("hex"),
          },
          timeoutMs: 10_000,
        });
        return {
          ok: true,
          runId:
            typeof response?.runId === "string" && response.runId ? response.runId : params.runId,
          a2aSessionKey: fallbackSessionKey,
          a2aDisplayKey: fallbackSessionKey,
        };
      }
      const queueSummary =
        formatEmbeddedAgentQueueFailureSummary(queueOutcome) ?? "active run queue rejected";
      throw new Error(queueSummary);
    }
    const response = await params.callGateway<{ runId: string }>({
      method: "agent",
      params: params.sendParams,
      timeoutMs: 10_000,
    });
    return {
      ok: true,
      runId: typeof response?.runId === "string" && response.runId ? response.runId : params.runId,
    };
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : typeof error === "string" ? error : "error";
    return {
      ok: false,
      result: jsonResult({
        runId: params.runId,
        status: "error",
        error: messageText,
        sessionKey: params.sessionKey,
      }),
    };
  }
}

function normalizeJsonValue(value: unknown, seen = new Set<object>()): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("sessions_send scheduler payload contains a non-finite number");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`sessions_send scheduler payload contains unsupported ${typeof value}`);
  }
  if (seen.has(value)) {
    throw new TypeError("sessions_send scheduler payload contains a cycle");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const normalized = value.flatMap((entry) => {
      const item = normalizeJsonValue(entry, seen);
      return item === undefined ? [] : [item];
    });
    seen.delete(value);
    return normalized;
  }
  const normalized: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const item = normalizeJsonValue(entry, seen);
    if (item !== undefined) {
      normalized[key] = item;
    }
  }
  seen.delete(value);
  return normalized;
}

function normalizeSendParams(sendParams: Record<string, unknown>): Record<string, JsonValue> {
  return normalizeJsonValue(sendParams) as Record<string, JsonValue>;
}

function buildSessionsSendEvent(params: {
  runId: string;
  sendParams: Record<string, unknown>;
  targetSessionKey: string;
  displayKey: string;
  deliveryTimeoutMs?: number;
  allowActiveRunQueueDelivery?: boolean;
}): ScheduledEvent {
  const idempotencyKey = normalizeOptionalString(params.sendParams.idempotencyKey);
  if (!idempotencyKey) {
    throw new Error("sessions_send scheduler admission requires an idempotency key");
  }
  const eventId = createHash("sha256")
    .update("sessions_send\0")
    .update(params.targetSessionKey)
    .update("\0")
    .update(idempotencyKey)
    .digest("hex");
  const payload: ScheduledSessionsSendPayload = {
    version: 1,
    runId: params.runId,
    targetSessionKey: params.targetSessionKey,
    displayKey: params.displayKey,
    sendParams: normalizeSendParams(params.sendParams),
    ...(params.deliveryTimeoutMs === undefined
      ? {}
      : { deliveryTimeoutMs: params.deliveryTimeoutMs }),
    allowActiveRunQueueDelivery: params.allowActiveRunQueueDelivery === true,
  };
  return buildRuntimeProducerEvent({
    id: eventId,
    route: resolveRuntimeProducerRoute({
      sessionKey: params.targetSessionKey,
      agentId: resolveAgentIdFromSessionKey(params.targetSessionKey),
    }),
    producerKind: "sessions_send",
    payload: payload as unknown as JsonValue,
  });
}

function parseScheduledSessionsSendPayload(event: ScheduledEvent): ScheduledSessionsSendPayload {
  const payload = event.payload;
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    throw new Error("scheduled sessions_send payload must be an object");
  }
  const value = payload as Record<string, JsonValue>;
  if (
    value.version !== 1 ||
    typeof value.runId !== "string" ||
    typeof value.targetSessionKey !== "string" ||
    value.targetSessionKey !== event.route.sessionKey ||
    typeof value.displayKey !== "string" ||
    value.sendParams === null ||
    Array.isArray(value.sendParams) ||
    typeof value.sendParams !== "object" ||
    typeof value.allowActiveRunQueueDelivery !== "boolean"
  ) {
    throw new Error("scheduled sessions_send payload is invalid");
  }
  return value as unknown as ScheduledSessionsSendPayload;
}

export async function dispatchScheduledSessionsSendBatch(
  batch: SchedulerDispatchBatch,
): Promise<SchedulerDispatchResult> {
  const runCorrelationId = beginRuntimeProducerDispatch(batch);
  const failures: Array<{ eventId: string; reason: string }> = [];
  const successfulStarts: Array<{
    event: SchedulerDispatchBatch["events"][number];
    result: Extract<SessionsSendStartResult, { ok: true }>;
    callGateway: GatewayCaller;
  }> = [];
  for (const event of batch.events) {
    const pending = pendingSessionsSends.get(event.id);
    const owner = pending?.values().next().value;
    let result: SessionsSendStartResult;
    try {
      const payload = parseScheduledSessionsSendPayload(event);
      result = await startSessionsSendAgentRun({
        callGateway: owner?.callGateway ?? callGateway,
        runId: payload.runId,
        sendParams: payload.sendParams,
        sessionKey: payload.displayKey,
        deliveryTimeoutMs: payload.deliveryTimeoutMs,
        allowActiveRunQueueDelivery: payload.allowActiveRunQueueDelivery,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      result = {
        ok: false,
        result: jsonResult({
          runId: event.id,
          status: "error",
          error: reason,
          sessionKey: event.route.sessionKey,
        }),
      };
    }
    for (const waiter of pending ?? []) {
      waiter.resolve(result);
    }
    pendingSessionsSends.delete(event.id);
    if (!result.ok) {
      failures.push({
        eventId: event.id,
        reason:
          (result.result.details as { error?: string } | undefined)?.error ??
          "sessions_send dispatch failed",
      });
    } else {
      successfulStarts.push({
        event,
        result,
        callGateway: owner?.callGateway ?? callGateway,
      });
    }
  }
  if (failures.length > 0) {
    return {
      outcome: "failed",
      failure: { kind: "sessions_send_failed", failures },
      runCorrelationId,
    };
  }
  const started = successfulStarts[0];
  if (!started) {
    return {
      outcome: "failed",
      failure: { kind: "sessions_send_failed", failures: [] },
      runCorrelationId,
    };
  }
  const actualRunCorrelationId = started.result.activeRunCorrelationId ?? started.result.runId;
  correlateRuntimeProducerDispatch(batch, actualRunCorrelationId);
  const settlementTimer = setTimeout(() => {
    void settleStartedSessionsSendBatch({
      batch,
      runCorrelationId: actualRunCorrelationId,
      starts: successfulStarts,
    });
  }, 0);
  settlementTimer.unref?.();
  return { outcome: "pending", runCorrelationId: actualRunCorrelationId };
}

async function waitForSessionsSendTerminal(params: {
  runId: string;
  callGateway: GatewayCaller;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  while (true) {
    const wait = await waitForAgentRun({
      runId: params.runId,
      timeoutMs: 30_000,
      callGateway: params.callGateway,
    });
    if (wait.status === "ok") {
      return { ok: true };
    }
    if (wait.status === "pending" || (wait.status === "timeout" && wait.endedAt === undefined)) {
      continue;
    }
    if (wait.status === "error" && isRecoverableAgentWaitError(wait.error)) {
      continue;
    }
    return {
      ok: false,
      reason: wait.error?.trim() || `agent run ended with ${wait.status}`,
    };
  }
}

async function settleStartedSessionsSendBatch(params: {
  batch: SchedulerDispatchBatch;
  runCorrelationId: string;
  starts: Array<{
    event: SchedulerDispatchBatch["events"][number];
    result: Extract<SessionsSendStartResult, { ok: true }>;
    callGateway: GatewayCaller;
  }>;
}): Promise<void> {
  const terminalFailures: Array<{ eventId: string; reason: string }> = [];
  for (const start of params.starts) {
    if (start.result.activeRunQueueSessionId) {
      try {
        while (!(await waitForEmbeddedAgentRunEnd(start.result.activeRunQueueSessionId, 30_000))) {
          // A timeout is not a terminal outcome. Keep ownership until this exact run ends.
        }
        const terminal = await waitForSessionsSendTerminal({
          runId: start.result.activeRunCorrelationId ?? start.result.runId,
          callGateway: start.callGateway,
        });
        if (!terminal.ok) {
          terminalFailures.push({ eventId: start.event.id, reason: terminal.reason });
        }
      } catch (error) {
        terminalFailures.push({
          eventId: start.event.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    const terminal = await waitForSessionsSendTerminal({
      runId: start.result.runId,
      callGateway: start.callGateway,
    });
    if (!terminal.ok) {
      terminalFailures.push({ eventId: start.event.id, reason: terminal.reason });
    }
  }
  let result: Exclude<SchedulerDispatchResult, { outcome: "pending" }>;
  if (terminalFailures.length > 0) {
    result = {
      outcome: "failed",
      failure: { kind: "sessions_send_terminal_failed", failures: terminalFailures },
      runCorrelationId: params.runCorrelationId,
    };
  } else {
    const completion = completeRuntimeProducerDispatch({
      batch: params.batch,
      runCorrelationId: params.runCorrelationId,
    });
    if (completion.outcome === "pending") {
      throw new Error("sessions_send terminal completion remained pending");
    }
    result = completion;
  }
  const scheduler = getRuntimeConversationScheduler();
  await Promise.all(params.batch.events.map((event) => scheduler.settle(event.receiptId, result)));
}

export async function startSessionsSendThroughScheduler(params: {
  callGateway: GatewayCaller;
  runId: string;
  sendParams: Record<string, unknown>;
  targetSessionKey: string;
  displayKey: string;
  deliveryTimeoutMs?: number;
  allowActiveRunQueueDelivery?: boolean;
}): Promise<SessionsSendStartResult> {
  ensureSessionsSendSchedulerProducerRegistered();
  const event = buildSessionsSendEvent(params);
  let resolveResult!: (result: SessionsSendStartResult) => void;
  const resultPromise = new Promise<SessionsSendStartResult>((resolve) => {
    resolveResult = resolve;
  });
  const pendingResult = { callGateway: params.callGateway, resolve: resolveResult };
  const pending = pendingSessionsSends.get(event.id) ?? new Set<PendingSessionsSend>();
  pending.add(pendingResult);
  pendingSessionsSends.set(event.id, pending);
  const scheduler = getRuntimeConversationScheduler();
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
      if (!pendingSessionsSends.get(event.id)?.has(pendingResult)) {
        return;
      }
      pending.delete(pendingResult);
      if (pending.size === 0) {
        pendingSessionsSends.delete(event.id);
      }
      resolveResult(
        receiptState === "delivered"
          ? { ok: true, runId: params.runId, alreadyDelivered: true }
          : {
              ok: false,
              result: jsonResult({
                runId: params.runId,
                status: "error",
                error: `duplicate sessions_send receipt is ${receiptState}`,
                sessionKey: params.displayKey,
              }),
            },
      );
    };
    void settleFromDurableReceipt();
    return await resultPromise;
  }
  pending.delete(pendingResult);
  if (pending.size === 0) {
    pendingSessionsSends.delete(event.id);
  }
  // The native path retains ownership only when the scheduler never committed the event.
  return await startSessionsSendAgentRun({
    callGateway: params.callGateway,
    runId: params.runId,
    sendParams: params.sendParams,
    sessionKey: params.displayKey,
    deliveryTimeoutMs: params.deliveryTimeoutMs,
    allowActiveRunQueueDelivery: params.allowActiveRunQueueDelivery,
  });
}

export const sessionsSendSchedulerTesting = {
  buildSessionsSendEvent,
  dispatchScheduledSessionsSendBatch,
  settleStartedSessionsSendBatch,
  parseScheduledSessionsSendPayload,
  reset() {
    resetSessionsSendSchedulerProducerRegistrationForTests();
    pendingSessionsSends.clear();
  },
};
