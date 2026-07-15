import { createHash } from "node:crypto";
import type {
  JsonValue,
  SchedulerDispatchBatch,
  SchedulerDispatchResult,
} from "./conversation-scheduler.js";
import {
  getRuntimeConversationScheduler,
  registerRuntimeConversationSchedulerProducer,
} from "./runtime-conversation-scheduler.js";
import {
  buildRuntimeProducerEvent,
  completeRuntimeProducerDispatch,
  correlateRuntimeProducerDispatch,
  resolveRuntimeProducerRoute,
} from "./runtime-producer-admission.js";

export type RuntimeTurnProducerKind = "operator" | "talk" | "voice";

type ScheduledRuntimeTurnPayload = {
  version: 1;
  kind: "runtime_turn";
  producerKind: RuntimeTurnProducerKind;
  agentId: string;
  sessionKey: string;
  callId: string;
  turnId: string;
  runId: string;
  recoveryPayload?: JsonValue;
};

type PendingRuntimeTurn = {
  execute: (runId: string) => Promise<unknown>;
  waitUntilReady?: Promise<void>;
  markStarted: () => void;
  rejectStarted: (error: Error) => void;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

const pendingRuntimeTurns = new Map<string, Set<PendingRuntimeTurn>>();
let unregisterRuntimeTurnProducer: (() => void) | undefined;
let operatorRecoveryExecutor:
  | ((params: {
      agentId: string;
      sessionKey: string;
      runId: string;
      payload: JsonValue;
    }) => Promise<unknown>)
  | undefined;

/** Registers operator, talk, and voice recovery at their executable owner. */
export function ensureRuntimeTurnSchedulerProducerRegistered(): void {
  unregisterRuntimeTurnProducer ??= registerRuntimeConversationSchedulerProducer({
    producerKinds: ["operator", "talk", "voice"],
    dispatch: dispatchScheduledRuntimeTurnBatch,
  });
}

export function resetRuntimeTurnSchedulerProducerRegistrationForTests(): void {
  unregisterRuntimeTurnProducer?.();
  unregisterRuntimeTurnProducer = undefined;
}

/** Installs the Gateway-owned executor used only for never-started operator recovery. */
export function registerRuntimeOperatorTurnRecoveryExecutor(
  executor: NonNullable<typeof operatorRecoveryExecutor>,
): () => void {
  operatorRecoveryExecutor = executor;
  return () => {
    if (operatorRecoveryExecutor === executor) {
      operatorRecoveryExecutor = undefined;
    }
  };
}

function normalizedIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`runtime turn requires ${label}`);
  }
  return normalized;
}

function runtimeTurnIdentity(params: {
  producerKind: RuntimeTurnProducerKind;
  agentId: string;
  sessionKey: string;
  callId: string;
  turnId: string;
}): string {
  return createHash("sha256")
    .update(params.producerKind)
    .update("\0")
    .update(params.agentId)
    .update("\0")
    .update(params.sessionKey)
    .update("\0")
    .update(params.callId)
    .update("\0")
    .update(params.turnId)
    .digest("hex");
}

export function buildScheduledRuntimeTurnEvent(params: {
  producerKind: RuntimeTurnProducerKind;
  agentId: string;
  sessionKey: string;
  callId: string;
  turnId: string;
  runId?: string;
  recoveryPayload?: JsonValue;
}) {
  const agentId = normalizedIdentity(params.agentId, "agent id");
  const sessionKey = normalizedIdentity(params.sessionKey, "session key");
  const callId = normalizedIdentity(params.callId, "call id");
  const turnId = normalizedIdentity(params.turnId, "turn id");
  const identity = runtimeTurnIdentity({
    producerKind: params.producerKind,
    agentId,
    sessionKey,
    callId,
    turnId,
  });
  const runId = params.runId?.trim() || `${params.producerKind}:${identity}`;
  const payload: ScheduledRuntimeTurnPayload = {
    version: 1,
    kind: "runtime_turn",
    producerKind: params.producerKind,
    agentId,
    sessionKey,
    callId,
    turnId,
    runId,
    ...(params.recoveryPayload === undefined ? {} : { recoveryPayload: params.recoveryPayload }),
  };
  return buildRuntimeProducerEvent({
    id: identity,
    route: resolveRuntimeProducerRoute({ sessionKey, agentId }),
    producerKind: params.producerKind,
    payload: payload as unknown as JsonValue,
  });
}

function parseScheduledRuntimeTurn(
  event: SchedulerDispatchBatch["events"][number],
): ScheduledRuntimeTurnPayload {
  const value = event.payload;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scheduled runtime turn payload must be an object");
  }
  const payload = value as unknown as Partial<ScheduledRuntimeTurnPayload>;
  if (
    payload.version !== 1 ||
    payload.kind !== "runtime_turn" ||
    (payload.producerKind !== "operator" &&
      payload.producerKind !== "talk" &&
      payload.producerKind !== "voice") ||
    payload.producerKind !== event.producerKind ||
    typeof payload.agentId !== "string" ||
    typeof payload.sessionKey !== "string" ||
    payload.sessionKey !== event.route.sessionKey ||
    typeof payload.callId !== "string" ||
    typeof payload.turnId !== "string" ||
    typeof payload.runId !== "string"
  ) {
    throw new Error("scheduled runtime turn payload is invalid");
  }
  return payload as ScheduledRuntimeTurnPayload;
}

function rejectPendingRuntimeTurns(eventId: string, reason: string): void {
  const error = new Error(reason);
  for (const pending of pendingRuntimeTurns.get(eventId) ?? []) {
    pending.rejectStarted(error);
    pending.reject(error);
  }
  pendingRuntimeTurns.delete(eventId);
}

export async function dispatchScheduledRuntimeTurnBatch(
  batch: SchedulerDispatchBatch,
): Promise<SchedulerDispatchResult> {
  const event = batch.events[0];
  if (!event || batch.events.length !== 1) {
    return {
      outcome: "failed",
      failure: { kind: "runtime_turn_invalid_batch" },
      runCorrelationId: batch.attemptId,
    };
  }
  let payload: ScheduledRuntimeTurnPayload;
  try {
    payload = parseScheduledRuntimeTurn(event);
  } catch (error) {
    return {
      outcome: "failed",
      failure: {
        kind: "runtime_turn_invalid_payload",
        reason: error instanceof Error ? error.message : String(error),
      },
      runCorrelationId: batch.attemptId,
    };
  }
  const pending = pendingRuntimeTurns.get(event.id);
  if (
    payload.producerKind === "operator" &&
    (!pending || pending.size === 0) &&
    payload.recoveryPayload !== undefined &&
    operatorRecoveryExecutor
  ) {
    try {
      correlateRuntimeProducerDispatch(batch, payload.runId);
      await operatorRecoveryExecutor({
        agentId: payload.agentId,
        sessionKey: payload.sessionKey,
        runId: payload.runId,
        payload: payload.recoveryPayload,
      });
      return completeRuntimeProducerDispatch({
        batch,
        runCorrelationId: payload.runId,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        outcome: "failed",
        failure: { kind: "runtime_turn_failed", reason },
        runCorrelationId: payload.runId,
      };
    }
  }
  if (batch.placement === "recovery" || !pending || pending.size === 0) {
    const reason = `interrupted ${payload.producerKind} turn ${payload.callId}/${payload.turnId} cannot be replayed without its live transport context`;
    rejectPendingRuntimeTurns(event.id, reason);
    return {
      outcome: "failed",
      failure: { kind: "runtime_turn_interrupted", reason },
      runCorrelationId: payload.runId,
    };
  }
  const owner = pending.values().next().value;
  if (!owner) {
    throw new Error("runtime turn pending owner disappeared");
  }
  try {
    await owner.waitUntilReady;
    correlateRuntimeProducerDispatch(batch, payload.runId);
    for (const waiter of pending) {
      waiter.markStarted();
    }
    const result = await owner.execute(payload.runId);
    for (const waiter of pending) {
      waiter.resolve(result);
    }
    pendingRuntimeTurns.delete(event.id);
    return completeRuntimeProducerDispatch({
      batch,
      runCorrelationId: payload.runId,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    rejectPendingRuntimeTurns(event.id, reason);
    return {
      outcome: "failed",
      failure: { kind: "runtime_turn_failed", reason },
      runCorrelationId: payload.runId,
    };
  }
}

export async function admitRuntimeTurnThroughScheduler<T>(params: {
  producerKind: RuntimeTurnProducerKind;
  agentId: string;
  sessionKey: string;
  callId: string;
  turnId: string;
  runId?: string;
  recoveryPayload?: JsonValue;
  startBarrier?: Promise<void>;
  execute: (runId: string) => Promise<T>;
}): Promise<{
  durablyAccepted: boolean;
  existingTerminalState?: "delivered" | "failed" | "storage_error" | "cancelled";
  started: Promise<void>;
  completion: Promise<T>;
}> {
  ensureRuntimeTurnSchedulerProducerRegistered();
  const event = buildScheduledRuntimeTurnEvent(params);
  let resolveResult!: (result: T) => void;
  let rejectResult!: (error: Error) => void;
  let resolveStarted!: () => void;
  let rejectStarted!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  const completion = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const pending: PendingRuntimeTurn = {
    execute: params.execute,
    waitUntilReady: params.startBarrier,
    markStarted: resolveStarted,
    rejectStarted,
    resolve: (result) => resolveResult(result as T),
    reject: rejectResult,
  };
  const waiters = pendingRuntimeTurns.get(event.id) ?? new Set<PendingRuntimeTurn>();
  waiters.add(pending);
  pendingRuntimeTurns.set(event.id, waiters);
  const scheduler = getRuntimeConversationScheduler();
  const admission = await scheduler.admit(event);
  if (!admission.accepted) {
    waiters.delete(pending);
    if (waiters.size === 0) {
      pendingRuntimeTurns.delete(event.id);
    }
    resolveStarted();
    void params
      .execute((event.payload as unknown as ScheduledRuntimeTurnPayload).runId)
      .then(resolveResult, (error: unknown) =>
        rejectResult(error instanceof Error ? error : new Error(String(error))),
      );
    return { durablyAccepted: false, started, completion };
  }
  const existingReceiptState = admission.existingState;
  if (
    existingReceiptState === "delivered" ||
    existingReceiptState === "failed" ||
    existingReceiptState === "storage_error" ||
    existingReceiptState === "cancelled"
  ) {
    waiters.delete(pending);
    if (waiters.size === 0) {
      pendingRuntimeTurns.delete(event.id);
    }
    resolveStarted();
    resolveResult(undefined as T);
    return {
      durablyAccepted: true,
      existingTerminalState: existingReceiptState,
      started,
      completion,
    };
  }
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
    if (!pendingRuntimeTurns.get(event.id)?.has(pending)) {
      return;
    }
    waiters.delete(pending);
    if (waiters.size === 0) {
      pendingRuntimeTurns.delete(event.id);
    }
    const error = new Error(
      receiptState === "delivered"
        ? `${params.producerKind} turn was already completed`
        : `${params.producerKind} turn is already ${receiptState}`,
    );
    rejectStarted(error);
    rejectResult(error);
  };
  void settleFromDurableReceipt();
  return { durablyAccepted: true, started, completion };
}

/** Runs one turn only after durable ownership and resolves at exact embedded terminal outcome. */
export async function runRuntimeTurnThroughScheduler<T>(params: {
  producerKind: RuntimeTurnProducerKind;
  agentId: string;
  sessionKey: string;
  callId: string;
  turnId: string;
  execute: (runId: string) => Promise<T>;
}): Promise<T> {
  const admitted = await admitRuntimeTurnThroughScheduler(params);
  if (admitted.existingTerminalState) {
    throw new Error(
      admitted.existingTerminalState === "delivered"
        ? `${params.producerKind} turn was already completed`
        : `${params.producerKind} turn is already ${admitted.existingTerminalState}`,
    );
  }
  const [, result] = await Promise.all([admitted.started, admitted.completion]);
  return result;
}
