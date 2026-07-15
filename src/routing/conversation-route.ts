import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentRoute, type RoutePeer } from "./resolve-route.js";
import {
  buildCanonicalConversationLaneKey,
  buildCanonicalConversationSessionKey,
} from "./session-key.js";

export type ConversationRoute = {
  channel: string;
  accountId: string;
  conversationKind: "direct" | "group" | "channel";
  conversationId: string;
  threadId?: string;
  sessionKey: string;
  queueLaneKey: string;
  transcriptOwner: { agentId: string; sessionKey: string };
  currentReplyTarget?: {
    channel: string;
    accountId: string;
    target: string;
    threadId?: string;
    messageId: string;
  };
};

export type ResolveConversationRouteInput = {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
  peer: RoutePeer;
  parentPeer?: RoutePeer | null;
  threadId?: string | null;
  guildId?: string | null;
  teamId?: string | null;
  memberRoleIds?: string[];
  currentReplyTarget?: ConversationRoute["currentReplyTarget"];
};

/** Resolves native channel identity into the route shared by state, scheduling, and delivery. */
export function resolveConversationRoute(input: ResolveConversationRouteInput): ConversationRoute {
  const resolved = resolveAgentRoute(input);
  const conversationId = input.peer.id.trim();
  if (!conversationId) {
    throw new Error("conversation route requires a non-empty conversation id");
  }
  const threadId = input.threadId?.trim() || undefined;
  const conversationKind: ConversationRoute["conversationKind"] =
    input.peer.kind === "direct" ? "direct" : input.peer.kind === "channel" ? "channel" : "group";
  const routeIdentity = {
    channel: resolved.channel,
    accountId: resolved.accountId,
    conversationKind,
    conversationId,
    threadId,
  };
  const queueLaneKey = buildCanonicalConversationLaneKey(routeIdentity);
  const sessionKey = buildCanonicalConversationSessionKey({
    agentId: resolved.agentId,
    ...routeIdentity,
  });
  return {
    channel: resolved.channel,
    accountId: resolved.accountId,
    conversationKind,
    conversationId,
    ...(threadId ? { threadId } : {}),
    sessionKey,
    queueLaneKey,
    transcriptOwner: { agentId: resolved.agentId, sessionKey },
    ...(input.currentReplyTarget ? { currentReplyTarget: input.currentReplyTarget } : {}),
  };
}
