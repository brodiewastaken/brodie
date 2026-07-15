import type { ConversationRoute } from "../routing/conversation-route.js";
import {
  buildCanonicalConversationLaneKey,
  parseAgentSessionKey,
  parseCanonicalConversationSessionKey,
} from "../routing/session-key.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

/** Rebuilds the durable route attached to a canonical conversation session. */
export function resolveSubagentConversationRoute(params: {
  sessionKey: string;
  origin?: DeliveryContext;
  internal?: boolean;
}): ConversationRoute {
  const sessionKey = params.sessionKey.trim();
  const parsed = parseCanonicalConversationSessionKey(sessionKey);
  const origin = normalizeDeliveryContext(params.origin);
  const agentId = parsed?.agentId ?? parseAgentSessionKey(sessionKey)?.agentId ?? "main";
  const internal = params.internal === true && !parsed;
  const channel = parsed?.channel ?? (internal ? "internal" : origin?.channel) ?? "internal";
  const accountId = parsed?.accountId ?? (internal ? agentId : origin?.accountId) ?? agentId;
  const conversationKind = parsed?.conversationKind ?? "direct";
  const conversationId =
    parsed?.conversationId ?? (internal ? sessionKey : origin?.to) ?? sessionKey;
  const threadId =
    parsed?.threadId ??
    (internal || origin?.threadId == null ? undefined : String(origin.threadId));
  const queueLaneKey = buildCanonicalConversationLaneKey({
    channel,
    accountId,
    conversationKind,
    conversationId,
    threadId,
  });
  return {
    channel,
    accountId,
    conversationKind,
    conversationId,
    ...(threadId ? { threadId } : {}),
    sessionKey,
    queueLaneKey,
    transcriptOwner: { agentId, sessionKey },
  };
}
