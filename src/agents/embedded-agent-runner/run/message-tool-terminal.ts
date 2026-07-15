import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import { parseSessionDeliveryRoute } from "../../../routing/session-key.js";
import { normalizeMessageChannel } from "../../../utils/message-channel.js";
/**
 * Detects message-tool-only sends that delivered a visible source reply.
 */
import {
  isDeliveredMessageToolOnlySourceReplyResult,
  isDeliveredMessagingToolResult,
} from "../../embedded-agent-message-tool-source-reply.js";
import {
  mergeMessageToolDeliveryState,
  mergeMessageToolSourceReplyDeliveryState,
  readMessageToolDeliveryState,
  type MessageToolDeliveryState,
  type MessageToolSourceReplyDeliveryState,
} from "../../embedded-agent-messaging.types.js";
import type { AfterToolCallContext, AfterToolCallResult, Agent } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";

function argsRecordForToolCall(context: AfterToolCallContext): Record<string, unknown> {
  if (context.args && typeof context.args === "object" && !Array.isArray(context.args)) {
    return context.args as Record<string, unknown>;
  }
  const fallbackArgs = context.toolCall.arguments;
  return fallbackArgs && typeof fallbackArgs === "object" && !Array.isArray(fallbackArgs)
    ? fallbackArgs
    : {};
}

function argsRecordForDeliveryEvidence(context: AfterToolCallContext): Record<string, unknown> {
  const authoredArgs = context.toolCall.arguments;
  const authoredRecord =
    authoredArgs && typeof authoredArgs === "object" && !Array.isArray(authoredArgs)
      ? authoredArgs
      : {};
  return {
    ...authoredRecord,
    ...argsRecordForToolCall(context),
  };
}

function isExplicitSourceReplyAction(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "reply";
}

/**
 * Determines whether a message tool call delivered a visible source reply in
 * message-tool-only delivery mode. Implicit sends and explicit `reply` actions
 * qualify; unrelated explicit routes and errors do not.
 */
export function isDeliveredMessageToolOnlySourceReply(params: {
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  context: AfterToolCallContext;
  hookResult?: AfterToolCallResult;
}): boolean {
  const args = argsRecordForDeliveryEvidence(params.context);
  const authoredArgs = params.context.toolCall.arguments;
  const authoredAction =
    authoredArgs && typeof authoredArgs === "object" && !Array.isArray(authoredArgs)
      ? authoredArgs.action
      : undefined;
  const allowExplicitSourceRoute =
    isExplicitSourceReplyAction(authoredAction) || isExplicitSourceReplyAction(args.action);
  if (allowExplicitSourceRoute) {
    args.action = "reply";
  }
  return isDeliveredMessageToolOnlySourceReplyResult({
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    toolName: params.context.toolCall.name,
    args,
    result: params.context.result,
    hookResult: params.hookResult,
    isError: params.hookResult?.isError ?? params.context.isError,
    allowExplicitSourceRoute,
  });
}

function resolveMessageToolDeliveryState(context: AfterToolCallContext): MessageToolDeliveryState {
  const resultState = readMessageToolDeliveryState(context.result);
  if (resultState) {
    return resultState;
  }
  const originalArgs = context.toolCall.arguments;
  const originalEndTurn =
    originalArgs && typeof originalArgs === "object" && !Array.isArray(originalArgs)
      ? originalArgs.endTurn
      : undefined;
  return (originalEndTurn ?? argsRecordForToolCall(context).endTurn) === false
    ? "provisional"
    : "terminal";
}

/**
 * Recovers delivery state from persisted current-attempt tool results when
 * runtime hooks and subscriber state cross a split plugin/runtime boundary.
 */
export function resolveAttemptMessageToolDeliveryState(params: {
  authoredState?: MessageToolDeliveryState;
  observedState?: MessageToolDeliveryState;
  messagingToolSentTargets?: readonly unknown[];
  messages: readonly unknown[];
  prePromptMessageCount: number;
  transcriptEntries?: readonly unknown[];
}): MessageToolDeliveryState | undefined {
  let state = params.authoredState ?? params.observedState;
  if (state) {
    return state;
  }
  for (const target of params.messagingToolSentTargets ?? []) {
    const persistedState = readMessageToolDeliveryState(target);
    if (persistedState) {
      state = mergeMessageToolDeliveryState(state, persistedState);
    }
  }
  if (state) {
    return state;
  }
  for (const message of params.messages.slice(Math.max(0, params.prePromptMessageCount))) {
    const persistedState = readMessageToolDeliveryState(message);
    if (persistedState) {
      state = mergeMessageToolDeliveryState(state, persistedState);
    }
  }
  if (state || !params.transcriptEntries) {
    return state;
  }
  let currentTurnStart = -1;
  for (let index = params.transcriptEntries.length - 1; index >= 0; index -= 1) {
    const entry = params.transcriptEntries[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const message = (entry as { message?: unknown }).message;
    if (
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as { role?: unknown }).role === "user"
    ) {
      currentTurnStart = index;
      break;
    }
  }
  for (const entry of params.transcriptEntries.slice(currentTurnStart + 1)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const persistedState = readMessageToolDeliveryState((entry as { message?: unknown }).message);
    if (persistedState) {
      state = mergeMessageToolDeliveryState(state, persistedState);
    }
  }
  return state;
}

/**
 * Recovers source-reply evidence when message-tool argument normalization has
 * erased an authored `reply` action before the subscriber and after-tool hook
 * observe it. A delivered target only qualifies when it resolves to the
 * current canonical conversation route.
 */
export function resolveAttemptMessageToolSourceReplyDeliveryState(params: {
  messageChannel?: string;
  messageThreadId?: string | number;
  messageTo?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  sessionKey?: string;
  messagingToolSentTargets?: readonly unknown[];
}): MessageToolSourceReplyDeliveryState | undefined {
  const route = parseSessionDeliveryRoute(params.sessionKey);
  const routeChannel =
    normalizeMessageChannel(params.messageChannel) ?? normalizeMessageChannel(route?.channel);
  const routePeerId = normalizeOptionalLowercaseString(route?.peerId);
  const messageTo = normalizeOptionalLowercaseString(params.messageTo);
  if (!routeChannel || (!messageTo && !routePeerId)) {
    return undefined;
  }
  const routeThreadId = normalizeOptionalLowercaseString(params.messageThreadId ?? route?.threadId);
  const routeTargets = new Set<string>();
  if (messageTo) {
    routeTargets.add(messageTo);
  }
  if (route && routePeerId) {
    routeTargets.add(routePeerId);
    routeTargets.add(
      normalizeOptionalLowercaseString(`${route.peerKind}:${route.peerId}`) ?? routePeerId,
    );
    routeTargets.add(normalizeOptionalLowercaseString(`channel:${route.peerId}`) ?? routePeerId);
    routeTargets.add(normalizeOptionalLowercaseString(`user:${route.peerId}`) ?? routePeerId);
  }
  let state: MessageToolSourceReplyDeliveryState | undefined;
  for (const target of params.messagingToolSentTargets ?? []) {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      continue;
    }
    const record = target as { provider?: unknown; threadId?: unknown; to?: unknown };
    const provider = normalizeMessageChannel(
      typeof record.provider === "string" ? record.provider : undefined,
    );
    const to = normalizeOptionalLowercaseString(record.to);
    const threadId = normalizeOptionalLowercaseString(record.threadId);
    if (
      provider !== routeChannel ||
      !to ||
      !routeTargets.has(to) ||
      (threadId && routeThreadId && threadId !== routeThreadId)
    ) {
      continue;
    }
    const persistedState = readMessageToolDeliveryState(target);
    if (persistedState) {
      state = mergeMessageToolSourceReplyDeliveryState(state, persistedState);
    }
  }
  return state;
}

/**
 * Recovers current-turn delivery state after the embedded runner throws before
 * returning its normal result envelope.
 */
export function resolvePersistedAttemptMessageToolDeliveryState(
  sessionFile?: string,
): MessageToolDeliveryState | undefined {
  if (!sessionFile) {
    return undefined;
  }
  try {
    return resolveAttemptMessageToolDeliveryState({
      messages: [],
      prePromptMessageCount: 0,
      transcriptEntries: SessionManager.open(sessionFile).getBranch(),
    });
  } catch {
    return undefined;
  }
}

/**
 * Installs an after-tool hook that preserves authored delivery controls and
 * records source reply delivery evidence.
 */
export function installMessageToolOnlyTerminalHook(params: {
  agent: Agent;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  onDeliveredMessageTool?: (state: MessageToolDeliveryState) => void;
  onDeliveredSourceReply?: (state: MessageToolSourceReplyDeliveryState) => void;
}): void {
  const previousAfterToolCall = params.agent.afterToolCall?.bind(params.agent);
  params.agent.afterToolCall = async (context, signal) => {
    const hookResult = await previousAfterToolCall?.(context, signal);
    const deliveryState = resolveMessageToolDeliveryState(context);
    if (
      context.toolCall.name === "message" &&
      isDeliveredMessagingToolResult({
        toolName: context.toolCall.name,
        args: argsRecordForDeliveryEvidence(context),
        result: context.result,
        hookResult,
        isError: hookResult?.isError ?? context.isError,
      })
    ) {
      params.onDeliveredMessageTool?.(deliveryState);
    }
    if (
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        context,
        hookResult,
      })
    ) {
      params.onDeliveredSourceReply?.(deliveryState);
      return hookResult;
    }
    return hookResult;
  };
}
