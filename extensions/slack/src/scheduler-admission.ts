import path from "node:path";
import {
  getRuntimeConversationScheduler,
  type AdmissionResult,
  type HumanInboundEventPayload,
  type HumanInboundMedia,
  type JsonValue,
  type ScheduledEvent,
  type SchedulerProducerKind,
} from "openclaw/plugin-sdk/conversation-scheduler";
import { getMediaDir } from "openclaw/plugin-sdk/media-runtime";
import { resolveConversationRoute, type ConversationRoute } from "openclaw/plugin-sdk/routing";
import { resolveSlackTimestampMs } from "./monitor/message-handler/timestamp.js";
import type { PreparedSlackMessage } from "./monitor/message-handler/types.js";
import type { SlackMessageEvent } from "./types.js";

export type SlackScheduledSource = "message" | "app_mention";

export type SlackScheduledMedia = HumanInboundMedia & {
  id: string;
  uri?: string;
  path?: string;
  url?: string;
};

export type SlackScheduledEnvelope = Omit<
  HumanInboundEventPayload,
  "channel" | "chatType" | "media"
> & {
  channel: "slack";
  chatType: "direct" | "group" | "channel";
  media: SlackScheduledMedia[];
  nativeChannelId: string;
  destination: string;
  messageIds: string[];
  source: SlackScheduledSource;
  subtype?: SlackMessageEvent["subtype"];
};

export type SlackSchedulerAdmission = {
  result: AdmissionResult;
  route?: ConversationRoute;
  event?: ScheduledEvent;
};

type ContextRecord = Record<string, unknown>;

function readString(record: ContextRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(record: ContextRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(record: ContextRecord, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
    : [];
}

function readAlignedStringArray(record: ContextRecord, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.map((entry) => (typeof entry === "string" ? entry : "")) : [];
}

function compactJson(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("slack scheduler payload contains a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError("slack scheduler payload contains a cycle");
    }
    seen.add(value);
    const compacted = value
      .filter((entry) => entry !== undefined)
      .map((entry) => compactJson(entry, seen));
    seen.delete(value);
    return compacted;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      throw new TypeError("slack scheduler payload contains a cycle");
    }
    seen.add(value);
    const compacted: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        compacted[key] = compactJson(entry, seen);
      }
    }
    seen.delete(value);
    return compacted;
  }
  throw new TypeError(`slack scheduler payload contains unsupported ${typeof value}`);
}

function toInboundMediaUri(mediaPath: string): string | undefined {
  if (mediaPath.startsWith("media://")) {
    return mediaPath;
  }
  const inboundDir = path.resolve(getMediaDir(), "inbound");
  const resolved = path.resolve(mediaPath);
  if (resolved === inboundDir || resolved.startsWith(`${inboundDir}${path.sep}`)) {
    return `media://inbound/${path.basename(resolved)}`;
  }
  return undefined;
}

function mediaKind(mimeType: string | undefined): SlackScheduledMedia["kind"] {
  const normalized = mimeType?.toLowerCase() ?? "";
  if (normalized.startsWith("image/")) {
    return "image";
  }
  if (normalized.startsWith("video/")) {
    return "video";
  }
  if (normalized.startsWith("audio/")) {
    return "audio";
  }
  return "file";
}

function buildMedia(ctx: ContextRecord, messageId: string): SlackScheduledMedia[] {
  const paths = readAlignedStringArray(ctx, "MediaPaths");
  const urls = readAlignedStringArray(ctx, "MediaUrls");
  const types = readAlignedStringArray(ctx, "MediaTypes");
  paths[0] ||= readString(ctx, "MediaPath") ?? "";
  urls[0] ||= readString(ctx, "MediaUrl") ?? "";
  types[0] ||= readString(ctx, "MediaType") ?? "";
  const media: SlackScheduledMedia[] = [];
  const count = Math.max(paths.length, urls.length, types.length);
  for (let index = 0; index < count; index += 1) {
    const mediaPath = paths[index] || undefined;
    const url = urls[index] || undefined;
    const mimeType = types[index] || undefined;
    if (!mediaPath && !url && !mimeType) {
      continue;
    }
    const uri = mediaPath ? toInboundMediaUri(mediaPath) : undefined;
    media.push({
      kind: mediaKind(mimeType),
      id: `${messageId}:${index}`,
      ...(uri ? { uri } : mediaPath ? { path: mediaPath } : {}),
      ...(mediaPath ? { managedLocalPath: mediaPath } : {}),
      ...(url ? { url } : {}),
      ...(mimeType ? { mimeType } : {}),
      mediaRef: uri ?? url ?? `media://staged/${encodeURIComponent(messageId)}/${index}`,
      sourceMessageId: messageId,
      sourceIndex: index,
      understanding: [],
    });
  }
  return media;
}

function resolveChatType(ctx: ContextRecord): SlackScheduledEnvelope["chatType"] {
  const value = readString(ctx, "ChatType")?.toLowerCase();
  if (value === "direct" || value === "group" || value === "channel") {
    return value;
  }
  throw new Error("slack scheduler envelope requires a finalized ChatType");
}

function resolveMessageId(prepared: PreparedSlackMessage): string {
  const ctx = prepared.ctxPayload as ContextRecord;
  const messageId =
    readString(ctx, "MessageSid") ?? prepared.message.ts ?? prepared.message.event_ts;
  if (!messageId?.trim()) {
    throw new Error("slack scheduler envelope requires a stable message id");
  }
  return messageId;
}

function producerKind(envelope: SlackScheduledEnvelope): SchedulerProducerKind {
  if (envelope.quote) {
    return "human_reply";
  }
  return envelope.media.length > 0 ? "human_media" : "human_message";
}

export function buildSlackScheduledEnvelope(params: {
  prepared: PreparedSlackMessage;
  source: SlackScheduledSource;
  route: ConversationRoute;
}): SlackScheduledEnvelope {
  const { prepared, route } = params;
  const ctx = prepared.ctxPayload as ContextRecord;
  const messageId = resolveMessageId(prepared);
  const messageIds = readStringArray(ctx, "MessageSids");
  if (messageIds.length === 0) {
    messageIds.push(messageId);
  }
  const receivedAt =
    readNumber(ctx, "Timestamp") ??
    resolveSlackTimestampMs(prepared.message.event_ts ?? prepared.message.ts) ??
    Date.now();
  const quoteId = readString(ctx, "ReplyToId");
  const quoteSender = readString(ctx, "ReplyToSender");
  const quoteBody = readString(ctx, "ReplyToBody");
  const threadStarterBody = readString(ctx, "ThreadStarterBody");
  const threadHistoryBody = readString(ctx, "ThreadHistoryBody");
  const threadLabel = readString(ctx, "ThreadLabel");
  const hasThreadContext = Boolean(threadStarterBody || threadHistoryBody || threadLabel);
  const nativeChannelName = readString(ctx, "GroupChannel");
  const conversationLabel = readString(ctx, "GroupSubject") ?? readString(ctx, "ConversationLabel");
  return {
    version: 1,
    channel: "slack",
    accountId: route.accountId,
    conversationId: route.conversationId,
    nativeChannelId: prepared.message.channel,
    ...(route.threadId ? { threadId: route.threadId } : {}),
    sessionKey: route.sessionKey,
    destination: prepared.replyTarget,
    messageId,
    messageIds,
    receivedAt,
    chatType: resolveChatType(ctx),
    source: params.source,
    ...(prepared.message.subtype ? { subtype: prepared.message.subtype } : {}),
    sender: {
      id:
        readString(ctx, "SenderId") ??
        prepared.message.user ??
        prepared.message.bot_id ??
        "unknown",
      ...((readString(ctx, "SenderName") ?? prepared.message.username)
        ? { name: readString(ctx, "SenderName") ?? prepared.message.username }
        : {}),
      bot: Boolean(prepared.message.bot_id),
    },
    ...(readString(ctx, "RawBody") ? { body: readString(ctx, "RawBody") } : {}),
    ...((readString(ctx, "BodyForAgent") ?? readString(ctx, "RawBody"))
      ? { bodyForAgent: readString(ctx, "BodyForAgent") ?? readString(ctx, "RawBody") }
      : {}),
    ...(readString(ctx, "CommandBody") ? { commandBody: readString(ctx, "CommandBody") } : {}),
    commandAuthorized: ctx.CommandAuthorized === true,
    ...(typeof ctx.WasMentioned === "boolean" ? { wasMentioned: ctx.WasMentioned } : {}),
    ...(readString(ctx, "InboundEventKind")
      ? { inboundEventKind: readString(ctx, "InboundEventKind") }
      : {}),
    ...(quoteId || quoteSender || quoteBody
      ? {
          quote: {
            sender: quoteSender ?? "unknown",
            senderId: quoteSender ?? "unknown",
            messageId: quoteId ?? "unknown",
            ...(quoteBody ? { body: quoteBody } : {}),
          },
        }
      : {}),
    ...(hasThreadContext
      ? {
          supplemental: {
            thread: {
              ...(threadStarterBody ? { starterBody: threadStarterBody } : {}),
              ...(threadHistoryBody ? { historyBody: threadHistoryBody } : {}),
              ...(threadLabel ? { label: threadLabel } : {}),
            },
          },
        }
      : {}),
    media: buildMedia(ctx, messageId),
    conversation: {
      channel: "slack",
      conversationType: route.threadId ? "thread" : resolveChatType(ctx),
      ...(nativeChannelName ? { conversationName: nativeChannelName } : {}),
      ...(conversationLabel ? { conversationLabel } : {}),
      sessionKey: route.sessionKey,
      nativeChannel: {
        id: prepared.message.channel,
        ...(nativeChannelName ? { name: nativeChannelName } : {}),
      },
      ...(route.threadId ? { thread: { id: route.threadId } } : {}),
    },
    nativeMetadata: compactJson({
      teamId: prepared.ctx.teamId,
      source: params.source,
      subtype: prepared.message.subtype,
      messageIds,
    }),
  };
}

export async function admitSlackScheduledInbound(params: {
  prepared: PreparedSlackMessage;
  source: SlackScheduledSource;
  onError?: (error: unknown) => void;
}): Promise<SlackSchedulerAdmission> {
  try {
    const ctx = params.prepared.ctxPayload as ContextRecord;
    const chatType = resolveChatType(ctx);
    const conversationId =
      chatType === "direct" ? params.prepared.message.user : params.prepared.message.channel;
    if (!conversationId?.trim()) {
      throw new Error("slack scheduler route requires a native conversation id");
    }
    const threadId = readString(ctx, "MessageThreadId");
    const messageId = resolveMessageId(params.prepared);
    const route = resolveConversationRoute({
      cfg: params.prepared.ctx.cfg,
      channel: "slack",
      accountId: params.prepared.account.accountId,
      peer: {
        kind: chatType === "direct" ? "direct" : chatType === "group" ? "group" : "channel",
        id: conversationId,
      },
      threadId,
      teamId: params.prepared.ctx.teamId,
      currentReplyTarget: {
        channel: "slack",
        accountId: params.prepared.account.accountId,
        target: params.prepared.replyTarget,
        ...(threadId ? { threadId } : {}),
        messageId,
      },
    });
    if (route.sessionKey !== readString(ctx, "SessionKey")) {
      throw new Error("slack scheduler route does not match the finalized native session");
    }
    const envelope = buildSlackScheduledEnvelope({ ...params, route });
    const event: ScheduledEvent = {
      id: `${route.queueLaneKey}:${envelope.messageId}`,
      route,
      producerKind: producerKind(envelope),
      createdAt: envelope.receivedAt,
      human: true,
      media: envelope.media.length > 0,
      payload: compactJson(envelope),
    };
    const result = await getRuntimeConversationScheduler().admit(event);
    return { result, ...(result.accepted ? { route, event } : {}) };
  } catch (error) {
    params.onError?.(error);
    return { result: { accepted: false, reason: "invalid" } };
  }
}

export const slackSchedulerAdmissionTesting = { compactJson };
