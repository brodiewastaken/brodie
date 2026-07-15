import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
import type { TelegramMediaRef, TelegramMessageContext } from "./bot-message-context.js";
import {
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  resolveTelegramDirectPeerId,
} from "./bot/helpers.js";

type ContextRecord = Record<string, unknown>;

export type TelegramScheduledMedia = HumanInboundMedia & {
  id: string;
  uri?: string;
  path?: string;
};

export type TelegramScheduledEnvelope = Omit<
  HumanInboundEventPayload,
  "channel" | "chatType" | "media"
> & {
  channel: "telegram";
  chatType: "direct" | "group";
  media: TelegramScheduledMedia[];
  destination: string;
  audioTranscription?: string;
};

export type TelegramSchedulerAdmission = {
  result: AdmissionResult;
  route?: ConversationRoute;
  event?: ScheduledEvent;
};

function readString(ctx: ContextRecord, key: string): string | undefined {
  const value = ctx[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(ctx: ContextRecord, key: string): number | undefined {
  const value = ctx[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactJson(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("telegram scheduler payload contains a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError("telegram scheduler payload contains a cycle");
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
      throw new TypeError("telegram scheduler payload contains a cycle");
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
  throw new TypeError(`telegram scheduler payload contains unsupported ${typeof value}`);
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

function mediaKind(media: TelegramMediaRef): TelegramScheduledMedia["kind"] {
  if (media.stickerMetadata) {
    return "sticker";
  }
  const contentType = media.contentType?.toLowerCase() ?? "";
  if (contentType.startsWith("image/")) {
    return "image";
  }
  if (contentType.startsWith("video/")) {
    return "video";
  }
  if (contentType.startsWith("audio/")) {
    return "audio";
  }
  return "file";
}

function buildMedia(params: {
  allMedia: TelegramMediaRef[];
  messageId: string;
}): TelegramScheduledMedia[] {
  return params.allMedia.map((media, index) => {
    const uri = toInboundMediaUri(media.path);
    return {
      kind: mediaKind(media),
      id: `${params.messageId}:${index}`,
      ...(uri ? { uri } : {}),
      path: media.path,
      managedLocalPath: media.path,
      mediaRef: uri ?? `media://staged/${encodeURIComponent(params.messageId)}/${index}`,
      ...(media.contentType ? { mimeType: media.contentType } : {}),
      sourceMessageId: media.sourceMessageId ?? params.messageId,
      sourceIndex: index,
      understanding: [],
    };
  });
}

function producerKind(envelope: TelegramScheduledEnvelope): SchedulerProducerKind {
  const kind = envelope.inboundEventKind?.toLowerCase() ?? "";
  if (kind.includes("reaction")) {
    return "human_reaction";
  }
  if (kind.includes("edit")) {
    return "human_edit";
  }
  if (kind.includes("delet")) {
    return "human_deletion";
  }
  if (kind.includes("forward")) {
    return "human_forward";
  }
  if (envelope.quote) {
    return "human_reply";
  }
  if (envelope.media.length > 0) {
    return "human_media";
  }
  return "human_message";
}

function resolveTelegramScheduledRoute(params: {
  cfg: OpenClawConfig;
  context: TelegramMessageContext;
  destination: string;
  messageId: string;
}): ConversationRoute {
  const { context } = params;
  const senderId = readString(context.ctxPayload as ContextRecord, "SenderId");
  const peerId = context.isGroup
    ? buildTelegramGroupPeerId(context.chatId, context.resolvedThreadId)
    : resolveTelegramDirectPeerId({ chatId: context.chatId, senderId });
  const threadId = context.threadSpec.id == null ? undefined : String(context.threadSpec.id);
  return resolveConversationRoute({
    cfg: params.cfg,
    channel: "telegram",
    accountId: context.accountId,
    peer: { kind: context.isGroup ? "group" : "direct", id: peerId },
    parentPeer: buildTelegramParentPeer({
      isGroup: context.isGroup,
      resolvedThreadId: context.resolvedThreadId,
      chatId: context.chatId,
    }),
    currentReplyTarget: {
      channel: "telegram",
      accountId: context.accountId,
      target: params.destination,
      ...(threadId ? { threadId } : {}),
      messageId: params.messageId,
    },
  });
}

export function buildTelegramScheduledEnvelope(params: {
  context: TelegramMessageContext;
  allMedia: TelegramMediaRef[];
  route: ConversationRoute;
}): TelegramScheduledEnvelope {
  const ctx = params.context.ctxPayload as ContextRecord;
  const messageId = readString(ctx, "MessageSid");
  const destination = readString(ctx, "OriginatingTo") ?? readString(ctx, "To");
  const senderId = readString(ctx, "SenderId");
  if (!messageId || !destination || !senderId) {
    throw new Error("telegram scheduler envelope requires message, destination, and sender ids");
  }
  const media = buildMedia({ allMedia: params.allMedia, messageId });
  const body = readString(ctx, "RawBody") ?? readString(ctx, "Body");
  const bodyForAgent = readString(ctx, "BodyForAgent") ?? body;
  const commandBody = readString(ctx, "CommandBody") ?? readString(ctx, "BodyForCommands");
  const quoteId = readString(ctx, "ReplyToId");
  const quoteSender = readString(ctx, "ReplyToSender");
  const quoteBody = readString(ctx, "ReplyToBody");
  const threadId =
    params.context.threadSpec.id == null ? undefined : String(params.context.threadSpec.id);
  const threadName = readString(ctx, "TopicName");
  const nativeName = params.context.msg.chat.title;
  const conversationName = threadName
    ? nativeName
      ? `${nativeName} / ${threadName}`
      : threadName
    : (nativeName ?? readString(ctx, "SenderName"));
  const timestamp =
    readNumber(ctx, "Timestamp") ??
    (params.context.msg.date ? params.context.msg.date * 1000 : Date.now());
  const audioTranscription = media.some((entry) => entry.kind === "audio")
    ? readString(ctx, "Transcript")
    : undefined;
  return {
    version: 1,
    channel: "telegram",
    accountId: params.route.accountId,
    conversationId: params.route.conversationId,
    destination,
    ...(threadId ? { threadId } : {}),
    sessionKey: params.route.sessionKey,
    messageId,
    receivedAt: timestamp,
    chatType: params.context.isGroup ? "group" : "direct",
    sender: {
      id: senderId,
      ...(readString(ctx, "SenderName") ? { name: readString(ctx, "SenderName") } : {}),
      ...(readString(ctx, "SenderUsername") ? { username: readString(ctx, "SenderUsername") } : {}),
      ...(typeof ctx.SenderIsBot === "boolean" ? { bot: ctx.SenderIsBot } : {}),
    },
    ...(body ? { body } : {}),
    ...(bodyForAgent ? { bodyForAgent } : {}),
    ...(commandBody ? { commandBody } : {}),
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
    media,
    ...(audioTranscription ? { audioTranscription } : {}),
    conversation: {
      channel: "telegram",
      conversationType: params.context.isGroup ? (threadId ? "topic" : "group") : "direct",
      ...(conversationName ? { conversationName } : {}),
      ...(readString(ctx, "ConversationLabel")
        ? { conversationLabel: readString(ctx, "ConversationLabel") }
        : {}),
      sessionKey: params.route.sessionKey,
      nativeChannel: {
        id: String(params.context.chatId),
        ...(nativeName ? { name: nativeName } : {}),
      },
      ...(threadId ? { topic: { id: threadId, ...(threadName ? { name: threadName } : {}) } } : {}),
      chatId: String(params.context.chatId),
    },
    nativeMetadata: compactJson({
      chatId: params.context.chatId,
      threadId,
      senderId,
    }),
  };
}

export async function admitTelegramScheduledInbound(params: {
  cfg: OpenClawConfig;
  context: TelegramMessageContext;
  allMedia: TelegramMediaRef[];
  onError?: (error: unknown) => void;
}): Promise<TelegramSchedulerAdmission> {
  try {
    const ctx = params.context.ctxPayload as ContextRecord;
    const messageId = readString(ctx, "MessageSid");
    const destination = readString(ctx, "OriginatingTo") ?? readString(ctx, "To");
    const finalizedSessionKey = readString(ctx, "SessionKey");
    if (!messageId || !destination || !finalizedSessionKey) {
      throw new Error("telegram scheduler admission requires finalized routing facts");
    }
    const route = resolveTelegramScheduledRoute({
      cfg: params.cfg,
      context: params.context,
      destination,
      messageId,
    });
    if (route.sessionKey !== finalizedSessionKey) {
      throw new Error("telegram scheduler route does not match the finalized native session");
    }
    const envelope = buildTelegramScheduledEnvelope({ ...params, route });
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

export const telegramSchedulerAdmissionTesting = { compactJson };
