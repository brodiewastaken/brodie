import { randomUUID } from "node:crypto";
import type { ConversationRoute } from "../routing/conversation-route.js";
import {
  buildCanonicalConversationLaneKey,
  normalizeAgentId,
  parseCanonicalConversationSessionKey,
} from "../routing/session-key.js";
import type {
  JsonValue,
  ScheduledEvent,
  SchedulerDispatchBatch,
  SchedulerDispatchResult,
  SchedulerProducerKind,
} from "./conversation-scheduler.js";

type RuntimeProducerSuccessOutcome = Extract<
  SchedulerDispatchResult,
  { outcome: "sent" | "reacted" | "deliberate_silence" | "implicit_silence" | "completed" }
>["outcome"];

function routeFromCanonicalSessionKey(sessionKey: string): ConversationRoute | undefined {
  const parsed = parseCanonicalConversationSessionKey(sessionKey);
  if (!parsed) {
    return undefined;
  }
  const queueLaneKey = buildCanonicalConversationLaneKey(parsed);
  return {
    channel: parsed.channel,
    accountId: parsed.accountId,
    conversationKind: parsed.conversationKind,
    conversationId: parsed.conversationId,
    ...(parsed.threadId ? { threadId: parsed.threadId } : {}),
    sessionKey,
    queueLaneKey,
    transcriptOwner: { agentId: parsed.agentId, sessionKey },
  };
}

function routeFromInternalSessionKey(sessionKey: string, agentId: string): ConversationRoute {
  const normalizedAgentId = normalizeAgentId(agentId);
  const routeIdentity = {
    channel: "internal",
    accountId: normalizedAgentId,
    conversationKind: "direct" as const,
    conversationId: sessionKey,
  };
  return {
    ...routeIdentity,
    sessionKey,
    queueLaneKey: buildCanonicalConversationLaneKey(routeIdentity),
    transcriptOwner: { agentId: normalizedAgentId, sessionKey },
  };
}

/** Resolves a canonical source route or an exact internal lane for the source session. */
export function resolveRuntimeProducerRoute(params: {
  sessionKey: string;
  agentId: string;
}): ConversationRoute {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("runtime producer route requires a source session key");
  }
  return (
    routeFromCanonicalSessionKey(sessionKey) ??
    routeFromInternalSessionKey(sessionKey, params.agentId)
  );
}

/** Builds one normalized runtime-producer event without claiming scheduler ownership. */
export function buildRuntimeProducerEvent(params: {
  route: ConversationRoute;
  producerKind: SchedulerProducerKind;
  payload: JsonValue;
  id?: string;
  createdAt?: number;
}): ScheduledEvent {
  return {
    id: params.id?.trim() || randomUUID(),
    route: params.route,
    producerKind: params.producerKind,
    createdAt: params.createdAt ?? Date.now(),
    human: false,
    media: false,
    payload: params.payload,
  };
}

function runtimeProducerEvidencePrefix(params: {
  producerKind: SchedulerProducerKind;
  sessionKey: string;
  runCorrelationId: string;
}): string {
  return `producer:${params.producerKind}:session:${params.sessionKey}:run:${params.runCorrelationId}`;
}

function requireRuntimeProducerBatchOwner(batch: SchedulerDispatchBatch): ScheduledEvent {
  const first = batch.events[0];
  if (!first) {
    throw new Error("runtime producer dispatch requires at least one event");
  }
  for (const event of batch.events.slice(1)) {
    if (
      event.producerKind !== first.producerKind ||
      event.route.sessionKey !== first.route.sessionKey
    ) {
      throw new Error("runtime producer dispatch cannot mix producer or session ownership");
    }
  }
  return first;
}

export function buildRuntimeProducerStartedEvidence(params: {
  producerKind: SchedulerProducerKind;
  sessionKey: string;
  runCorrelationId: string;
}): string {
  return `${runtimeProducerEvidencePrefix(params)}:started`;
}

export function buildRuntimeProducerTerminalEvidence(params: {
  producerKind: SchedulerProducerKind;
  sessionKey: string;
  runCorrelationId: string;
  outcome: RuntimeProducerSuccessOutcome;
}): string {
  return `${runtimeProducerEvidencePrefix(params)}:outcome:${params.outcome}`;
}

export function beginRuntimeProducerDispatch(batch: SchedulerDispatchBatch): string {
  const runCorrelationId = batch.attemptId.trim();
  if (!runCorrelationId) {
    throw new Error("runtime producer dispatch requires an attempt id");
  }
  return correlateRuntimeProducerDispatch(batch, runCorrelationId);
}

/** Rebinds a pending producer attempt to the exact external run it started. */
export function correlateRuntimeProducerDispatch(
  batch: SchedulerDispatchBatch,
  runCorrelationId: string,
): string {
  const first = requireRuntimeProducerBatchOwner(batch);
  const normalizedRunCorrelationId = runCorrelationId.trim();
  if (!batch.recordRunCorrelationId || !batch.recordRunStarted) {
    throw new Error("runtime producer dispatch is missing durable start ownership");
  }
  if (!normalizedRunCorrelationId) {
    throw new Error("runtime producer dispatch requires a run correlation id");
  }
  batch.recordRunCorrelationId(normalizedRunCorrelationId);
  batch.recordRunStarted(
    buildRuntimeProducerStartedEvidence({
      producerKind: first.producerKind,
      sessionKey: first.route.sessionKey,
      runCorrelationId: normalizedRunCorrelationId,
    }),
  );
  return normalizedRunCorrelationId;
}

export function completeRuntimeProducerDispatch(params: {
  batch: SchedulerDispatchBatch;
  runCorrelationId: string;
  outcome?: RuntimeProducerSuccessOutcome;
}): SchedulerDispatchResult {
  const first = requireRuntimeProducerBatchOwner(params.batch);
  if (!params.batch.recordRunTerminalOutcome) {
    throw new Error("runtime producer dispatch is missing durable terminal ownership");
  }
  const outcome = params.outcome ?? "completed";
  const transcriptEvidence = buildRuntimeProducerTerminalEvidence({
    producerKind: first.producerKind,
    sessionKey: first.route.sessionKey,
    runCorrelationId: params.runCorrelationId,
    outcome,
  });
  params.batch.recordRunTerminalOutcome(outcome, transcriptEvidence);
  return { outcome, transcriptEvidence, runCorrelationId: params.runCorrelationId };
}

export function readRuntimeProducerTerminalEvidence(params: {
  batchEvent: ScheduledEvent;
  runCorrelationId: string;
  transcriptEvidence?: string;
}): RuntimeProducerSuccessOutcome | undefined {
  const outcomes: RuntimeProducerSuccessOutcome[] = [
    "sent",
    "reacted",
    "deliberate_silence",
    "implicit_silence",
    "completed",
  ];
  return outcomes.find(
    (outcome) =>
      params.transcriptEvidence ===
      buildRuntimeProducerTerminalEvidence({
        producerKind: params.batchEvent.producerKind,
        sessionKey: params.batchEvent.route.sessionKey,
        runCorrelationId: params.runCorrelationId,
        outcome,
      }),
  );
}

export function isRuntimeProducerStartedEvidence(params: {
  batchEvent: ScheduledEvent;
  runCorrelationId: string;
  transcriptEvidence?: string;
}): boolean {
  return (
    params.transcriptEvidence ===
    buildRuntimeProducerStartedEvidence({
      producerKind: params.batchEvent.producerKind,
      sessionKey: params.batchEvent.route.sessionKey,
      runCorrelationId: params.runCorrelationId,
    })
  );
}

export const runtimeProducerAdmissionTesting = {
  routeFromCanonicalSessionKey,
  routeFromInternalSessionKey,
};
