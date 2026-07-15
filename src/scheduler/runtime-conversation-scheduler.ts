import { resolveUserTimezone } from "../agents/date-time.js";
import {
  copyReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  shouldReplyPayloadBypassSourceSuppression,
} from "../auto-reply/reply-payload.js";
import { resolveCurrentTurnImages } from "../auto-reply/reply/current-turn-images.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { routeReply } from "../auto-reply/reply/route-reply.js";
import type { MsgContext, OriginatingChannelType } from "../auto-reply/templating.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import type { ChannelId, ChannelPlugin } from "../channels/plugins/types.public.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ConversationalOutcome } from "../infra/outbound/conversational-action.js";
import type { ImageContent } from "../llm/types.js";
import { hasOutboundReplyContent } from "../plugin-sdk/reply-payload.js";
import { getActivePluginChannelRegistry } from "../plugins/runtime.js";
import type { ConversationRoute } from "../routing/conversation-route.js";
import {
  buildCanonicalConversationLaneKey,
  parseAgentSessionKey,
  parseCanonicalConversationSessionKey,
} from "../routing/session-key.js";
import {
  buildPersistedUserTurnMediaInputsFromFields,
  createUserTurnTranscriptRecorder,
} from "../sessions/user-turn-transcript.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.types.js";
import {
  createConversationScheduler,
  type JsonValue,
  type ScheduledEvent,
  type ConversationScheduler,
  type SchedulerDispatchBatch,
  type SchedulerDispatchResult,
  type SchedulerInterruptedAttempt,
  type SchedulerInterruptedAttemptReconciliation,
  type SchedulerProducerKind,
} from "./conversation-scheduler.js";
import {
  attachHumanInboundNativeImageInputs,
  materializeHumanInboundBatch,
  renderHumanInboundBatch,
  type HumanInboundEventPayload,
} from "./human-inbound.js";
import { buildQueueBatchIdentity } from "./queue-batch-identity.js";
import {
  isRuntimeProducerStartedEvidence,
  readRuntimeProducerTerminalEvidence,
  resolveRuntimeProducerRoute,
} from "./runtime-producer-admission.js";
import { resolveSchedulerDebounceMs } from "./scheduler-policy.js";
import {
  createSchedulerProducerRegistry,
  type SchedulerProducerRegistration,
} from "./scheduler-producer-registry.js";

let runtimeScheduler: ConversationScheduler | undefined;
let unregisterHumanProducer: (() => void) | undefined;
let runtimeProducerRegistry = createRuntimeProducerRegistry();

const SUBAGENT_COMPLETION_PRODUCER_KINDS = new Set<SchedulerProducerKind>([
  "subagent_completion",
  "subagent_failure",
  "subagent_timeout",
  "subagent_interruption",
]);

function resolveDurableRuntimeProducerRoute(event: ScheduledEvent): ConversationRoute | undefined {
  if (
    !SUBAGENT_COMPLETION_PRODUCER_KINDS.has(event.producerKind) ||
    !event.route.sessionKey.includes(":subagent:")
  ) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(event.route.sessionKey);
  if (!parsed) {
    return undefined;
  }
  return resolveRuntimeProducerRoute({
    sessionKey: event.route.sessionKey,
    agentId: parsed.agentId,
  });
}

function resolveCanonicalRouteForSessionKey(sessionKey: string): ConversationRoute | undefined {
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

function createRuntimeProducerRegistry() {
  return createSchedulerProducerRegistry({
    onProducerAvailable: () => {
      void runtimeScheduler?.drain();
    },
  });
}

const SCHEDULER_SOURCE_DELIVERY_PROMPT = [
  "This turn is owned by the universal conversation scheduler.",
  "Use the message tool for every source-channel update and for the final answer.",
  "If you send progress with endTurn false, you must later call the message tool with the final visibleMessages and endTurn true.",
  "Never leave the final answer only in ordinary assistant text.",
].join(" ");

const SCHEDULER_ROOM_EVENT_DELIVERY_PROMPT = [
  "This turn is owned by the universal conversation scheduler.",
  "Treat ambient room activity as context and default to no response.",
  "Only use the message tool when directly addressed or when you have concrete value to add.",
  "Ordinary assistant text stays private.",
].join(" ");

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function parseOwnedEnvelope(event: ScheduledEvent): HumanInboundEventPayload | undefined {
  if (!event.human || !isRecord(event.payload)) {
    return undefined;
  }
  const channel = event.payload.channel;
  if (
    channel !== "whatsapp" &&
    channel !== "discord" &&
    channel !== "telegram" &&
    channel !== "slack"
  ) {
    return undefined;
  }
  const envelope = event.payload as unknown as HumanInboundEventPayload;
  if (
    envelope.version !== 1 ||
    envelope.sessionKey !== event.route.sessionKey ||
    !envelope.messageId?.trim() ||
    !Array.isArray(envelope.media) ||
    envelope.conversation?.sessionKey !== event.route.sessionKey ||
    !envelope.nativeMetadata
  ) {
    return undefined;
  }
  return envelope;
}

function isOwnedHumanEvent(event: ScheduledEvent): boolean {
  return parseOwnedEnvelope(event) !== undefined;
}

function buildScheduledBatchContext(
  batch: SchedulerDispatchBatch,
  cfg: OpenClawConfig,
  placementOverride?: "mid_turn_post_tool_result" | "post_turn",
): MsgContext {
  const envelopes = batch.events.map((event) => {
    const envelope = parseOwnedEnvelope(event);
    if (!envelope) {
      throw new Error("runtime scheduler received an unsupported channel event");
    }
    return envelope;
  });
  const first = envelopes[0];
  const last = envelopes.at(-1);
  if (!first || !last) {
    throw new Error("runtime scheduler cannot dispatch an empty batch");
  }
  if (
    envelopes.some(
      (envelope) =>
        envelope.channel !== first.channel ||
        envelope.accountId !== first.accountId ||
        envelope.sessionKey !== first.sessionKey ||
        envelope.conversationId !== first.conversationId,
    )
  ) {
    throw new Error("runtime scheduler batch crossed a conversation boundary");
  }
  const humanInboundBatch = materializeHumanInboundBatch({
    route: batch.events[0]!.route,
    placement:
      placementOverride ?? (batch.placement === "recovery" ? "failed_run_recovery" : "idle"),
    payloads: envelopes,
    timeZone: resolveUserTimezone(cfg.agents?.defaults?.userTimezone),
  });
  const bodyForAgent = renderHumanInboundBatch(humanInboundBatch);
  const media = envelopes.flatMap((envelope) => envelope.media);
  const quotedMedia = envelopes.flatMap((envelope) => envelope.quote?.media ?? []);
  const mediaLocations = media.map(
    (entry) => entry.managedLocalPath ?? entry.mediaRef ?? entry.url ?? "",
  );
  const destination =
    last.destination ??
    (first.channel === "discord"
      ? `channel:${last.nativeChannelId ?? last.conversationId}`
      : last.conversationId);
  const groupLabel =
    last.conversation.conversationName ??
    last.conversation.nativeChannel?.name ??
    last.conversation.thread?.name ??
    last.conversation.parentChannel?.name;
  const threadStarterBody = envelopes
    .map((envelope) => envelope.supplemental?.thread?.starterBody)
    .find(Boolean);
  const threadHistoryBody = envelopes
    .map((envelope) => envelope.supplemental?.thread?.historyBody)
    .find(Boolean);
  const threadLabel = envelopes
    .map((envelope) => envelope.supplemental?.thread?.label)
    .find(Boolean);
  const inboundEventKind = envelopes.every((envelope) => envelope.inboundEventKind === "room_event")
    ? "room_event"
    : "user_request";
  return {
    Body: bodyForAgent,
    BodyForAgent: bodyForAgent,
    HumanInboundBatch: humanInboundBatch,
    RawBody: envelopes.map((envelope) => envelope.body ?? "").join("\n"),
    CommandBody: envelopes
      .map((envelope) => envelope.commandBody ?? envelope.body ?? "")
      .join("\n"),
    BodyForCommands: "",
    From: last.conversationId,
    To: destination,
    SessionKey: batch.events[0]!.route.sessionKey,
    AgentId: batch.events[0]!.route.transcriptOwner.agentId,
    AccountId: last.accountId,
    MessageSid: last.messageId,
    MessageSids: envelopes.map((envelope) => envelope.messageId),
    MessageSidFirst: first.messageId,
    MessageSidLast: last.messageId,
    Timestamp: last.receivedAt,
    ChatType: last.chatType,
    ConversationLabel: last.conversation.conversationLabel ?? groupLabel,
    GroupSubject: groupLabel,
    GroupChannel: last.conversation.nativeChannel?.name ?? last.conversation.thread?.name,
    GroupSpace: last.conversation.guild?.id,
    ThreadStarterBody: threadStarterBody,
    ThreadHistoryBody: threadHistoryBody,
    ThreadLabel: threadLabel,
    GroupMembers: last.conversation.conversationMembers
      ?.map((member) => `${member.brodie ? "(brodie) " : ""}${member.label}`)
      .join(", "),
    GroupSystemPrompt:
      inboundEventKind === "room_event"
        ? SCHEDULER_ROOM_EVENT_DELIVERY_PROMPT
        : SCHEDULER_SOURCE_DELIVERY_PROMPT,
    MemberRoleIds: last.sender.roles,
    SenderId: last.sender.id,
    SenderName: last.sender.name ?? last.sender.displayName,
    SenderUsername: last.sender.username,
    SenderTag: last.sender.tag,
    SenderE164: last.sender.e164,
    SenderIsBot: last.sender.bot,
    Provider: last.channel,
    Surface: last.channel,
    OriginatingChannel: last.channel,
    OriginatingTo: destination,
    ExplicitDeliverRoute: true,
    NativeChannelId: last.nativeChannelId,
    MessageThreadId: last.threadId,
    ThreadParentId: last.conversation.parentChannel?.id,
    WasMentioned: envelopes.some((envelope) => envelope.wasMentioned === true),
    CommandAuthorized: envelopes.every((envelope) => envelope.commandAuthorized),
    InboundEventKind: inboundEventKind,
    InputProvenance: { kind: "external_user", sourceChannel: last.channel },
    SuppressMessageReceivedHooks: true,
    ...(last.quote
      ? {
          ReplyToId: last.quote.messageId,
          ReplyToIdFull: last.quote.messageId,
          ReplyToBody: last.quote.body,
          ReplyToSender: last.quote.sender,
          ...(last.quote.media && last.quote.media.length > 0
            ? {
                ReplyToMediaPath:
                  last.quote.media[0]?.managedLocalPath ??
                  last.quote.media[0]?.mediaRef ??
                  last.quote.media[0]?.url,
                ReplyToMediaPaths: last.quote.media.map(
                  (entry) => entry.managedLocalPath ?? entry.mediaRef ?? entry.url ?? "",
                ),
                ReplyToMediaUrls: last.quote.media.map(
                  (entry) => entry.url ?? entry.mediaRef ?? "",
                ),
                ReplyToMediaTypes: last.quote.media.map((entry) => entry.mimeType ?? ""),
                ReplyToMediaSourceMessageIds: last.quote.media.map(
                  (entry) => entry.sourceMessageId,
                ),
                ReplyToMediaSourceIndexes: last.quote.media.map((entry) => entry.sourceIndex),
              }
            : {}),
        }
      : {}),
    ...(media.length > 0
      ? {
          MediaPath: mediaLocations[0],
          MediaPaths: mediaLocations,
          MediaUrls: media.map((entry) => entry.url ?? entry.mediaRef ?? ""),
          MediaTypes: media.map((entry) => entry.mimeType ?? ""),
          MediaSourceMessageIds: media.map((entry) => entry.sourceMessageId),
          MediaSourceIndexes: media.map((entry) => entry.sourceIndex),
        }
      : {}),
    ...(quotedMedia.length > 0
      ? {
          ReplyToMediaUrl: quotedMedia[0]?.url ?? quotedMedia[0]?.mediaRef,
          ReplyToMediaType: quotedMedia[0]?.mimeType,
        }
      : {}),
  };
}

function resolveOwnedBatchResult(params: {
  batch: SchedulerDispatchBatch;
  runCorrelationId: string;
  runStarted: boolean;
  observedReplyDelivery: boolean;
  conversationOutcome?: ConversationalOutcome;
}): SchedulerDispatchResult {
  if (!params.runStarted) {
    return {
      outcome: "failed",
      failure: { kind: "source_run_not_started" },
      runCorrelationId: params.runCorrelationId,
    };
  }
  if (!params.conversationOutcome) {
    return {
      outcome: "failed",
      failure: { kind: "source_run_missing_terminal_outcome" },
      runCorrelationId: params.runCorrelationId,
    };
  }
  const transcriptEvidence = buildOwnedRunTerminalEvidence({
    sessionKey: params.batch.events[0]!.route.sessionKey,
    runCorrelationId: params.runCorrelationId,
    outcome: params.conversationOutcome,
  });
  if (params.observedReplyDelivery) {
    return { outcome: "sent", transcriptEvidence, runCorrelationId: params.runCorrelationId };
  }
  return {
    outcome: params.conversationOutcome,
    transcriptEvidence,
    runCorrelationId: params.runCorrelationId,
  };
}

function buildOwnedRunTerminalEvidence(params: {
  sessionKey: string;
  runCorrelationId: string;
  outcome: ConversationalOutcome;
}): string {
  return `session:${params.sessionKey}:run:${params.runCorrelationId}:outcome:${params.outcome}`;
}

function buildOwnedRunStartedEvidence(params: {
  sessionKey: string;
  runCorrelationId: string;
}): string {
  return `session:${params.sessionKey}:run:${params.runCorrelationId}:started`;
}

function readOwnedRunTerminalOutcome(params: {
  transcriptEvidence?: string;
  sessionKey: string;
  runCorrelationId: string;
}): ConversationalOutcome | undefined {
  const outcomes: ConversationalOutcome[] = [
    "sent",
    "reacted",
    "deliberate_silence",
    "implicit_silence",
  ];
  return outcomes.find(
    (outcome) =>
      params.transcriptEvidence ===
      buildOwnedRunTerminalEvidence({
        sessionKey: params.sessionKey,
        runCorrelationId: params.runCorrelationId,
        outcome,
      }),
  );
}

function beginOwnedBatchRun(batch: SchedulerDispatchBatch): string {
  if (!batch.recordRunCorrelationId) {
    throw new Error("runtime scheduler dispatch is missing run correlation persistence");
  }
  const runCorrelationId = batch.attemptId.trim();
  if (!runCorrelationId) {
    throw new Error("runtime scheduler dispatch is missing an attempt id");
  }
  batch.recordRunCorrelationId(runCorrelationId);
  return runCorrelationId;
}

type InterruptedAttemptEvidenceReader = {
  isRunLive: (runCorrelationId: string, sessionKey: string) => Promise<boolean>;
  hasCommittedDelivery: (sessionKey: string, runCorrelationId: string) => Promise<boolean>;
  readRunTerminalStatus?: (
    runCorrelationId: string,
  ) => Promise<"delivered" | "retryable" | undefined>;
};

function isRecordWithString(value: unknown, key: string): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[key] === "string"
  );
}

function hasCommittedMessageToolDelivery(messages: unknown[], runCorrelationId: string): boolean {
  const prefix = `${runCorrelationId}:message-tool:`;
  return messages.some(
    (message) =>
      isRecordWithString(message, "idempotencyKey") &&
      message.role === "assistant" &&
      (message.idempotencyKey as string).startsWith(prefix),
  );
}

async function createDefaultInterruptedAttemptEvidenceReader(
  attempt: SchedulerInterruptedAttempt,
): Promise<InterruptedAttemptEvidenceReader> {
  const sessionKey = attempt.events[0]?.route.sessionKey;
  const agentId = attempt.events[0]?.route.transcriptOwner.agentId;
  if (!sessionKey || !agentId) {
    return {
      isRunLive: async () => false,
      hasCommittedDelivery: async () => false,
      readRunTerminalStatus: async () => undefined,
    };
  }
  const [{ getAgentRunContext }, { loadSessionEntry }, { waitForAgentRun }] = await Promise.all([
    import("../infra/agent-events.js"),
    import("../gateway/session-utils.js"),
    import("../agents/run-wait.js"),
  ]);
  const loaded = loadSessionEntry(sessionKey, { agentId });
  return {
    isRunLive: async (runCorrelationId, expectedSessionKey) =>
      getAgentRunContext(runCorrelationId)?.sessionKey === expectedSessionKey,
    hasCommittedDelivery: async (expectedSessionKey, runCorrelationId) => {
      if (!loaded.entry) {
        return false;
      }
      const { visitSessionMessagesAsync } =
        await import("../gateway/session-transcript-readers.js");
      let found = false;
      await visitSessionMessagesAsync(
        {
          agentId,
          sessionKey: expectedSessionKey,
          sessionId: loaded.entry.sessionId,
          sessionFile: loaded.entry.sessionFile,
          sessionEntry: loaded.entry,
          storePath: loaded.storePath,
        },
        (message) => {
          if (!found && hasCommittedMessageToolDelivery([message], runCorrelationId)) {
            found = true;
          }
        },
        {
          mode: "full",
          reason: "conversation scheduler interrupted delivery reconciliation",
          cache: "skip",
        },
      );
      return found;
    },
    readRunTerminalStatus: async (runCorrelationId) => {
      const wait = await waitForAgentRun({ runId: runCorrelationId, timeoutMs: 1 });
      // The agent RPC publishes `ok` only after ingress has finished its transcript work.
      // Treating earlier accepted/live states as consumed would release completion cleanup twice.
      if (wait.status === "ok") {
        return "delivered";
      }
      if (wait.status === "error" || (wait.status === "timeout" && wait.endedAt !== undefined)) {
        return "retryable";
      }
      return undefined;
    },
  };
}

async function reconcileOwnedInterruptedAttempt(
  attempt: SchedulerInterruptedAttempt,
  evidenceReader?: InterruptedAttemptEvidenceReader,
): Promise<SchedulerInterruptedAttemptReconciliation> {
  const sessionKey = attempt.events[0]?.route.sessionKey;
  const replayableOperatorTurn =
    attempt.events.length === 1 &&
    attempt.events[0]?.producerKind === "operator" &&
    attempt.events[0].payload !== null &&
    !Array.isArray(attempt.events[0].payload) &&
    typeof attempt.events[0].payload === "object" &&
    attempt.events[0].payload.kind === "runtime_turn" &&
    attempt.events[0].payload.producerKind === "operator" &&
    attempt.events[0].payload.recoveryPayload !== undefined;
  if (sessionKey && !attempt.transcriptEvidence && replayableOperatorTurn) {
    return {
      status: "replayable",
      evidence: { kind: "authorized_operator_turn_never_started" },
    };
  }
  const runCorrelationId = attempt.runCorrelationId?.trim();
  if (!sessionKey || !runCorrelationId) {
    return { status: "unresolved" };
  }
  const persistedOutcome = readOwnedRunTerminalOutcome({
    transcriptEvidence: attempt.transcriptEvidence,
    sessionKey,
    runCorrelationId,
  });
  if (persistedOutcome) {
    return {
      status: "delivered",
      transcriptEvidence: attempt.transcriptEvidence!,
      runCorrelationId,
    };
  }
  const firstEvent = attempt.events[0];
  if (
    firstEvent &&
    readRuntimeProducerTerminalEvidence({
      batchEvent: firstEvent,
      runCorrelationId,
      transcriptEvidence: attempt.transcriptEvidence,
    })
  ) {
    return {
      status: "delivered",
      transcriptEvidence: attempt.transcriptEvidence!,
      runCorrelationId,
    };
  }
  const evidence = evidenceReader ?? (await createDefaultInterruptedAttemptEvidenceReader(attempt));
  if (await evidence.isRunLive(runCorrelationId, sessionKey)) {
    return { status: "live" };
  }
  if (await evidence.hasCommittedDelivery(sessionKey, runCorrelationId)) {
    return {
      status: "delivered",
      transcriptEvidence: `session:${sessionKey}:run:${runCorrelationId}`,
      runCorrelationId,
    };
  }
  const isControllerCompletion =
    attempt.events.length > 0 &&
    attempt.events.every((event) => SUBAGENT_COMPLETION_PRODUCER_KINDS.has(event.producerKind));
  const terminalStatus = await evidence.readRunTerminalStatus?.(runCorrelationId);
  if (isControllerCompletion && terminalStatus === "delivered") {
    return {
      status: "delivered",
      transcriptEvidence: `controller-run:${runCorrelationId}:consumed`,
      runCorrelationId,
    };
  }
  if (
    firstEvent &&
    isRuntimeProducerStartedEvidence({
      batchEvent: firstEvent,
      runCorrelationId,
      transcriptEvidence: attempt.transcriptEvidence,
    })
  ) {
    if (terminalStatus === "delivered") {
      return {
        status: "delivered",
        transcriptEvidence: `session:${sessionKey}:run:${runCorrelationId}:completed`,
        runCorrelationId,
      };
    }
    if (terminalStatus === undefined) {
      return { status: "unresolved" };
    }
    return {
      status: "retryable",
      evidence: { kind: "runtime_producer_terminal_without_committed_delivery" },
    };
  }
  const startedEvidence = buildOwnedRunStartedEvidence({ sessionKey, runCorrelationId });
  if (!attempt.transcriptEvidence) {
    return {
      status: "retryable",
      evidence: { kind: "source_run_never_started" },
    };
  }
  if (attempt.transcriptEvidence !== startedEvidence) {
    return { status: "unresolved" };
  }
  if (terminalStatus === "delivered") {
    return {
      status: "retryable",
      evidence: { kind: "source_run_completed_without_committed_delivery" },
    };
  }
  if (terminalStatus === "retryable") {
    return {
      status: "retryable",
      evidence: { kind: "controller_run_terminal_without_committed_delivery" },
    };
  }
  return { status: "unresolved" };
}

type OwnedBatchReplyResolver = (
  ctx: MsgContext,
  opts: InternalGetReplyOptions,
  cfg: OpenClawConfig,
) => Promise<ReplyPayload | ReplyPayload[] | undefined>;

type OwnedReturnedReplyDeliverer = (params: {
  payload: ReplyPayload;
  target: NonNullable<ConversationRoute["currentReplyTarget"]>;
  route: ConversationRoute;
  ctx: MsgContext;
  cfg: OpenClawConfig;
  runCorrelationId: string;
}) => Promise<boolean>;

async function deliverOwnedReturnedReply(
  params: Parameters<OwnedReturnedReplyDeliverer>[0],
): Promise<boolean> {
  const payload =
    params.payload.replyToId || !params.target.messageId
      ? params.payload
      : copyReplyPayloadMetadata(params.payload, {
          ...params.payload,
          replyToId: params.target.messageId,
        });
  const result = await routeReply({
    payload,
    channel: params.target.channel as OriginatingChannelType,
    to: params.target.target,
    sessionKey: params.route.sessionKey,
    policyConversationType: params.route.conversationKind === "direct" ? "direct" : "group",
    accountId: params.target.accountId,
    requesterSenderId: params.ctx.SenderId,
    requesterSenderName: params.ctx.SenderName,
    requesterSenderUsername: params.ctx.SenderUsername,
    requesterSenderE164: params.ctx.SenderE164,
    threadId: params.target.threadId,
    cfg: params.cfg,
    isGroup: params.route.conversationKind !== "direct",
    groupId: params.route.conversationId,
    replyKind: "final",
    runId: params.runCorrelationId,
  });
  return result.ok && result.suppressed !== true && Boolean(result.messageId?.trim());
}

type MidTurnQueueOptions = {
  images?: ImageContent[];
  userTurnTranscriptRecorder: UserTurnTranscriptRecorder;
};

type ActiveRunNativeImagePolicy = {
  maxNativeImages: number;
  omissionReason: "policy_ceiling" | "model_not_image_capable";
};

function batchContainsImage(ctx: MsgContext): boolean {
  return Boolean(
    ctx.HumanInboundBatch?.inbounds.some((inbound) =>
      [...(inbound.quote?.media ?? []), ...inbound.media].some((media) => media.kind === "image"),
    ),
  );
}

function buildMidTurnTranscriptRecorder(params: {
  batch: SchedulerDispatchBatch;
  ctx: MsgContext;
  nativeImageCount: number;
}): UserTurnTranscriptRecorder {
  const sourceMessageIds = params.batch.events.map((event) => event.id);
  const queueBatchIdentity = buildQueueBatchIdentity({
    routeKey: params.batch.events[0]!.route.queueLaneKey,
    sourceMessageIds,
    nativeImageCount: params.nativeImageCount,
  });
  const sender = {
    id: params.ctx.SenderId,
    name: params.ctx.SenderName,
    username: params.ctx.SenderUsername,
  };
  return createUserTurnTranscriptRecorder({
    input: {
      text: params.ctx.BodyForAgent,
      sourceMessage: params.ctx.RawBody,
      media: buildPersistedUserTurnMediaInputsFromFields(params.ctx),
      ...(typeof params.ctx.Timestamp === "number" ? { timestamp: params.ctx.Timestamp } : {}),
      ...(queueBatchIdentity ? { queueBatchIdentity } : {}),
      ...(params.ctx.HumanInboundBatch ? { humanInboundBatch: params.ctx.HumanInboundBatch } : {}),
      ...(params.ctx.InputProvenance ? { provenance: params.ctx.InputProvenance } : {}),
      sender,
    },
    target: () => undefined,
    errorContext: "mid-turn injected user transcript",
  });
}

async function prepareMidTurnInjection(params: {
  batch: SchedulerDispatchBatch;
  cfg: OpenClawConfig;
  runCorrelationId: string;
  resolveNativeImagePolicy: (
    runId: string,
  ) => ActiveRunNativeImagePolicy | undefined | Promise<ActiveRunNativeImagePolicy | undefined>;
  resolveImages: typeof resolveCurrentTurnImages;
}): Promise<{ text: string; options: MidTurnQueueOptions }> {
  const ctx = buildScheduledBatchContext(
    { ...params.batch, events: params.batch.events },
    params.cfg,
    "mid_turn_post_tool_result",
  );
  const nativeImagePolicy = await params.resolveNativeImagePolicy(params.runCorrelationId);
  if (!nativeImagePolicy && batchContainsImage(ctx)) {
    throw new Error("active run image policy is unavailable");
  }
  const resolvedImages = nativeImagePolicy
    ? await params.resolveImages({
        ctx,
        cfg: params.cfg,
        maxNativeImages: nativeImagePolicy.maxNativeImages,
        nativeImageOmissionReason: nativeImagePolicy.omissionReason,
      })
    : {};
  if (
    ctx.HumanInboundBatch &&
    (resolvedImages.nativeImageInputs?.length || resolvedImages.nativeImageOmissions?.length)
  ) {
    ctx.HumanInboundBatch = attachHumanInboundNativeImageInputs({
      batch: ctx.HumanInboundBatch,
      inputs: resolvedImages.nativeImageInputs ?? [],
      omissions: resolvedImages.nativeImageOmissions,
    });
    const bodyForAgent = renderHumanInboundBatch(ctx.HumanInboundBatch);
    ctx.Body = bodyForAgent;
    ctx.BodyForAgent = bodyForAgent;
  }
  return {
    text: ctx.BodyForAgent ?? "",
    options: {
      ...(resolvedImages.images?.length ? { images: resolvedImages.images } : {}),
      userTurnTranscriptRecorder: buildMidTurnTranscriptRecorder({
        batch: params.batch,
        ctx,
        nativeImageCount: resolvedImages.images?.length ?? 0,
      }),
    },
  };
}

function createQueuedFollowupCompletion() {
  let enqueued = false;
  let complete!: () => void;
  const completion = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    lifecycle: {
      onEnqueued: () => {
        enqueued = true;
      },
      onComplete: complete,
    },
    wait: async () => {
      if (enqueued) {
        await completion;
      }
    },
  };
}

type ReplyTypingCallbacks = Pick<InternalGetReplyOptions, "onReplyStart" | "onTypingCleanup">;

function resolveReplyTypingPlugin(channel: string): ChannelPlugin | undefined {
  return (
    getActivePluginChannelRegistry()?.channels.find((entry) => entry.plugin.id === channel)
      ?.plugin ?? getChannelPlugin(channel as ChannelId)
  );
}

function resolveReplyTypingCallbacks(params: {
  cfg: OpenClawConfig;
  target: NonNullable<ConversationRoute["currentReplyTarget"]>;
  resolvePlugin?: (channel: string) => ChannelPlugin | undefined;
}): ReplyTypingCallbacks | undefined {
  const heartbeat = (params.resolvePlugin ?? resolveReplyTypingPlugin)(
    params.target.channel,
  )?.heartbeat;
  if (!heartbeat?.sendTyping) {
    return undefined;
  }
  const target = {
    cfg: params.cfg,
    to: params.target.target,
    accountId: params.target.accountId,
    ...(params.target.threadId ? { threadId: params.target.threadId } : {}),
  };
  return {
    onReplyStart: async () => {
      await Promise.resolve(heartbeat.sendTyping?.(target)).catch(() => undefined);
    },
    ...(heartbeat.clearTyping
      ? {
          onTypingCleanup: () => {
            void Promise.resolve(heartbeat.clearTyping?.(target)).catch(() => undefined);
          },
        }
      : {}),
  };
}

async function dispatchOwnedBatchWithReply(params: {
  batch: SchedulerDispatchBatch;
  cfg: OpenClawConfig;
  getReply: OwnedBatchReplyResolver;
  queueActiveRun?: (runId: string, text: string, options: MidTurnQueueOptions) => Promise<boolean>;
  resolveActiveRunNativeImagePolicy?: (
    runId: string,
  ) => ActiveRunNativeImagePolicy | undefined | Promise<ActiveRunNativeImagePolicy | undefined>;
  resolveMidTurnImages?: typeof resolveCurrentTurnImages;
  resolveTypingCallbacks?: typeof resolveReplyTypingCallbacks;
  deliverReturnedReply?: OwnedReturnedReplyDeliverer;
}): Promise<SchedulerDispatchResult> {
  const { batch, cfg, getReply } = params;
  const ctx = buildScheduledBatchContext(batch, cfg);
  const runCorrelationId = beginOwnedBatchRun(batch);
  const queuedCompletion = createQueuedFollowupCompletion();
  let runStarted = false;
  let observedReplyDelivery = false;
  let conversationOutcome: ConversationalOutcome | undefined;
  const currentReplyTarget = batch.events[0]?.route.currentReplyTarget;
  const typingCallbacks = currentReplyTarget
    ? (params.resolveTypingCallbacks ?? resolveReplyTypingCallbacks)({
        cfg,
        target: currentReplyTarget,
      })
    : undefined;
  const replyOptions: InternalGetReplyOptions = {
    runId: runCorrelationId,
    queueModeOverride: "followup",
    queuedFollowupLifecycle: queuedCompletion.lifecycle,
    sourceReplyDeliveryMode: "message_tool_only",
    disableBlockStreaming: true,
    ...typingCallbacks,
    onAgentRunStart: (startedRunId) => {
      if (startedRunId !== runCorrelationId) {
        throw new Error("runtime scheduler model run correlation changed after persistence");
      }
      if (!batch.recordRunStarted) {
        throw new Error("runtime scheduler dispatch is missing run-start persistence");
      }
      batch.recordRunStarted(
        buildOwnedRunStartedEvidence({
          sessionKey: batch.events[0]!.route.sessionKey,
          runCorrelationId,
        }),
      );
      runStarted = true;
    },
    onConversationOutcome: (outcome) => {
      if (!batch.recordRunTerminalOutcome) {
        throw new Error("runtime scheduler dispatch is missing terminal-outcome persistence");
      }
      conversationOutcome = outcome;
      batch.recordRunTerminalOutcome(
        outcome,
        buildOwnedRunTerminalEvidence({
          sessionKey: batch.events[0]!.route.sessionKey,
          runCorrelationId,
          outcome,
        }),
      );
    },
    onObservedReplyDelivery: () => {
      observedReplyDelivery = true;
    },
    onToolStreamBoundary: async () => {
      const claimed = await batch.claimMidTurnHumanEvents?.();
      if (!claimed || claimed.length === 0) {
        return;
      }
      let injected = false;
      try {
        const claimedBatch = { ...batch, events: claimed };
        const resolveNativeImagePolicy =
          params.resolveActiveRunNativeImagePolicy ??
          (async (runId: string) => {
            const { resolveActiveEmbeddedRunNativeImagePolicy } =
              await import("../agents/embedded-agent-runner/runs.js");
            return resolveActiveEmbeddedRunNativeImagePolicy(runId);
          });
        const injection = await prepareMidTurnInjection({
          batch: claimedBatch,
          cfg,
          runCorrelationId,
          resolveNativeImagePolicy,
          resolveImages: params.resolveMidTurnImages ?? resolveCurrentTurnImages,
        });
        const queueActiveRun =
          params.queueActiveRun ??
          (async (runId: string, text: string, options: MidTurnQueueOptions) => {
            const { queueEmbeddedAgentMessageForRunId } =
              await import("../agents/embedded-agent-runner/runs.js");
            return await queueEmbeddedAgentMessageForRunId(runId, text, {
              sourceReplyDeliveryMode: "message_tool_only",
              ...options,
            });
          });
        injected = await queueActiveRun(runCorrelationId, injection.text, injection.options);
      } catch {
        // The durable claim returns to the lane below. The active turn must not
        // fail merely because an optional mid-turn injection could not be prepared.
      } finally {
        if (!injected) {
          await batch.releaseMidTurnHumanEvents?.(claimed.map((event) => event.id));
        }
      }
    },
  };
  const replyResult = await getReply(ctx, replyOptions, cfg);
  const returnedReplies = replyResult
    ? (Array.isArray(replyResult) ? replyResult : [replyResult]).filter(
        (payload) =>
          shouldReplyPayloadBypassSourceSuppression(payload) &&
          hasOutboundReplyContent(payload, { trimText: true }),
      )
    : [];
  if (currentReplyTarget && returnedReplies.length > 0) {
    const deliver = params.deliverReturnedReply ?? deliverOwnedReturnedReply;
    let terminalReturnedReplyDelivered = false;
    for (const payload of returnedReplies) {
      const delivered = await deliver({
        payload,
        target: currentReplyTarget,
        route: batch.events[0]!.route,
        ctx,
        cfg,
        runCorrelationId,
      });
      terminalReturnedReplyDelivered =
        terminalReturnedReplyDelivered || (delivered && !isReplyPayloadStatusNotice(payload));
    }
    observedReplyDelivery = terminalReturnedReplyDelivered || observedReplyDelivery;
    if (terminalReturnedReplyDelivered && conversationOutcome !== "sent") {
      conversationOutcome = "sent";
      if (!batch.recordRunTerminalOutcome) {
        throw new Error("runtime scheduler dispatch is missing terminal-outcome persistence");
      }
      batch.recordRunTerminalOutcome(
        conversationOutcome,
        buildOwnedRunTerminalEvidence({
          sessionKey: batch.events[0]!.route.sessionKey,
          runCorrelationId,
          outcome: conversationOutcome,
        }),
      );
    }
  }
  await queuedCompletion.wait();
  return resolveOwnedBatchResult({
    batch,
    runCorrelationId,
    runStarted,
    observedReplyDelivery,
    conversationOutcome,
  });
}

async function dispatchOwnedBatch(batch: SchedulerDispatchBatch): Promise<SchedulerDispatchResult> {
  const cfg = getRuntimeConfig();
  const { getReplyFromConfig } = await import("../auto-reply/reply.js");
  return await dispatchOwnedBatchWithReply({ batch, cfg, getReply: getReplyFromConfig });
}

function ensureHumanProducerRegistered(): void {
  unregisterHumanProducer ??= runtimeProducerRegistry.register({
    producerKinds: [
      "human_message",
      "human_media",
      "human_reaction",
      "human_edit",
      "human_deletion",
      "human_reply",
      "human_forward",
      "human_location",
    ],
    dispatch: dispatchOwnedBatch,
  });
}

/** Registers the sole runtime owner for one or more durable producer kinds. */
export function registerRuntimeConversationSchedulerProducer(
  registration: SchedulerProducerRegistration,
): () => void {
  return runtimeProducerRegistry.register(registration);
}

/** Cancels durable scheduler work when a canonical conversation lifecycle command wins priority. */
export async function stopRuntimeConversationSchedulerSession(
  sessionKey: string,
  options: { descendants: boolean },
): Promise<boolean> {
  const route = resolveCanonicalRouteForSessionKey(sessionKey);
  if (!route) {
    return false;
  }
  await getRuntimeConversationScheduler().stopSession(route, options);
  return true;
}

/** Shared durable scheduler used by runtime producers. */
export function getRuntimeConversationScheduler(): ConversationScheduler {
  ensureHumanProducerRegistered();
  runtimeScheduler ??= createConversationScheduler({
    enabled: getRuntimeConfig().scheduler?.enabled,
    maxRows: getRuntimeConfig().scheduler?.capacity?.maxRows,
    maxBytes: getRuntimeConfig().scheduler?.capacity?.maxBytes,
    shouldDispatch: (event) =>
      runtimeProducerRegistry.owns(event.producerKind) &&
      (!event.human || isOwnedHumanEvent(event)),
    resolveDurableRoute: resolveDurableRuntimeProducerRoute,
    resolveDebounceMs: (event) => {
      const cfg = getRuntimeConfig();
      const envelope = parseOwnedEnvelope(event);
      return resolveSchedulerDebounceMs({
        event,
        config: cfg.scheduler,
        conversationClass:
          envelope?.duoRoom === true
            ? "two_member"
            : event.route.conversationKind === "direct"
              ? "direct"
              : "shared",
      });
    },
    dispatch: async (batch) => await runtimeProducerRegistry.dispatch(batch),
    reconcileInterruptedAttempt: reconcileOwnedInterruptedAttempt,
    settleCallback: async (settlement) => await runtimeProducerRegistry.settle(settlement),
  });
  return runtimeScheduler;
}

export function resetRuntimeConversationSchedulerForTests(): void {
  runtimeScheduler = undefined;
  unregisterHumanProducer = undefined;
  runtimeProducerRegistry = createRuntimeProducerRegistry();
}

export const runtimeConversationSchedulerTesting = {
  resolveCanonicalRouteForSessionKey,
  buildScheduledBatchContext,
  isOwnedHumanEvent,
  resolveOwnedBatchResult,
  buildOwnedRunTerminalEvidence,
  buildOwnedRunStartedEvidence,
  readOwnedRunTerminalOutcome,
  beginOwnedBatchRun,
  dispatchOwnedBatchWithReply,
  resolveReplyTypingCallbacks,
  hasCommittedMessageToolDelivery,
  reconcileOwnedInterruptedAttempt,
  resolveDurableRuntimeProducerRoute,
};
