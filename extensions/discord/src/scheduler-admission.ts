import path from "node:path";
import {
  getRuntimeConversationScheduler,
  type AdmissionResult,
  type HumanInboundEventPayload,
  type HumanInboundMedia,
  type JsonValue,
  type ScheduledEvent,
  type SchedulerDispatchResult,
  type SchedulerProducerKind,
} from "openclaw/plugin-sdk/conversation-scheduler";
import { getMediaDir } from "openclaw/plugin-sdk/media-runtime";
import { resolveConversationRoute, type ConversationRoute } from "openclaw/plugin-sdk/routing";
import { resolveTimestampMs } from "./monitor/format.js";
import type { DiscordMessageProcessContext } from "./monitor/message-handler.context.js";
import type { DiscordMessagePreflightContext } from "./monitor/message-handler.preflight.types.js";

type ContextRecord = Record<string, unknown>;

export type DiscordScheduledMedia = HumanInboundMedia & {
  id: string;
  uri?: string;
  path?: string;
};

export type DiscordScheduledEnvelope = Omit<HumanInboundEventPayload, "channel" | "media"> & {
  channel: "discord";
  media: DiscordScheduledMedia[];
  pluralkit?: DiscordMessagePreflightContext["sender"]["pluralkit"];
};

export type DiscordSchedulerAdmission = {
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

function readStringArray(ctx: ContextRecord, key: string): string[] {
  const value = ctx[key];
  return Array.isArray(value) ? value.map((entry) => (typeof entry === "string" ? entry : "")) : [];
}

function readNumberArray(ctx: ContextRecord, key: string): number[] {
  const value = ctx[key];
  return Array.isArray(value)
    ? value.map((entry, index) =>
        typeof entry === "number" && Number.isFinite(entry) ? entry : index,
      )
    : [];
}

function compactJson(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("discord scheduler payload contains a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError("discord scheduler payload contains a cycle");
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
      throw new TypeError("discord scheduler payload contains a cycle");
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
  throw new TypeError(`discord scheduler payload contains unsupported ${typeof value}`);
}

function toInboundMediaUri(mediaPath: string): string | undefined {
  const inboundDir = path.resolve(getMediaDir(), "inbound");
  const resolved = path.resolve(mediaPath);
  if (resolved === inboundDir || resolved.startsWith(`${inboundDir}${path.sep}`)) {
    return `media://inbound/${path.basename(resolved)}`;
  }
  return undefined;
}

function mediaKind(mimeType: string | undefined, placeholder: string | undefined) {
  if (placeholder === "<media:sticker>") {
    return "sticker" as const;
  }
  const normalized = mimeType?.toLowerCase() ?? "";
  if (normalized.startsWith("image/")) {
    return "image" as const;
  }
  if (normalized.startsWith("video/")) {
    return "video" as const;
  }
  if (normalized.startsWith("audio/")) {
    return "audio" as const;
  }
  return "file" as const;
}

function toDiscordScheduledMedia(params: {
  sourceMessageId: string;
  sourceIndex: number;
  mediaPath?: string;
  url?: string;
  mimeType?: string;
  placeholder?: string;
}): DiscordScheduledMedia {
  const remoteUrl = [params.url, params.mediaPath].find((candidate): candidate is string =>
    Boolean(candidate && /^https?:\/\//iu.test(candidate)),
  );
  const mediaPath =
    params.mediaPath && !/^https?:\/\//iu.test(params.mediaPath) ? params.mediaPath : undefined;
  const uri = mediaPath ? toInboundMediaUri(mediaPath) : undefined;
  return {
    kind: mediaKind(params.mimeType, params.placeholder),
    id: `${params.sourceMessageId}:${params.sourceIndex}`,
    ...(uri ? { uri } : mediaPath ? { path: mediaPath } : {}),
    ...(mediaPath ? { managedLocalPath: mediaPath } : {}),
    ...(remoteUrl ? { url: remoteUrl } : {}),
    ...(params.mimeType ? { mimeType: params.mimeType } : {}),
    mediaRef:
      uri ??
      remoteUrl ??
      `media://staged/${encodeURIComponent(params.sourceMessageId)}/${params.sourceIndex}`,
    sourceMessageId: params.sourceMessageId,
    sourceIndex: params.sourceIndex,
    understanding: [],
  };
}

function buildMedia(ctx: DiscordMessagePreflightContext): DiscordScheduledMedia[] {
  return ctx.preparedMedia.map((media, index) =>
    toDiscordScheduledMedia({
      sourceMessageId: ctx.message.id,
      sourceIndex: index,
      mediaPath: media.path,
      mimeType: media.contentType,
      placeholder: media.placeholder,
    }),
  );
}

function buildQuoteMedia(payload: ContextRecord, quoteMessageId: string): DiscordScheduledMedia[] {
  const paths = readStringArray(payload, "ReplyToMediaPaths");
  const urls = readStringArray(payload, "ReplyToMediaUrls");
  const types = readStringArray(payload, "ReplyToMediaTypes");
  const sourceMessageIds = readStringArray(payload, "ReplyToMediaSourceMessageIds");
  const sourceIndexes = readNumberArray(payload, "ReplyToMediaSourceIndexes");
  const count = Math.max(paths.length, urls.length, types.length);
  const media: DiscordScheduledMedia[] = [];
  for (let index = 0; index < count; index += 1) {
    const mediaPath = paths[index] || undefined;
    const url = urls[index] || undefined;
    const mimeType = types[index] || undefined;
    if (!mediaPath && !url && !mimeType) {
      continue;
    }
    const sourceMessageId = sourceMessageIds[index] || quoteMessageId;
    const sourceIndex = sourceIndexes[index] ?? index;
    media.push(toDiscordScheduledMedia({ sourceMessageId, sourceIndex, mediaPath, url, mimeType }));
  }
  return media;
}

function producerKind(envelope: DiscordScheduledEnvelope): SchedulerProducerKind {
  if (envelope.quote?.messageId) {
    return "human_reply";
  }
  return envelope.media.length > 0 ? "human_media" : "human_message";
}

export function buildDiscordScheduledEnvelope(params: {
  ctx: DiscordMessagePreflightContext;
  prepared: DiscordMessageProcessContext;
  route: ConversationRoute;
}): DiscordScheduledEnvelope {
  const { ctx, prepared, route } = params;
  const payload = prepared.ctxPayload as ContextRecord;
  const threadId = route.threadId;
  const quoteId = readString(payload, "ReplyToId");
  const quoteBody = readString(payload, "ReplyToBody");
  const quoteSender = readString(payload, "ReplyToSender");
  const quoteSenderId = readString(payload, "ReplyToSenderId");
  const quoteTimestamp = readNumber(payload, "ReplyToTimestamp");
  const quoteMedia = buildQuoteMedia(payload, quoteId ?? "unknown");
  const body = ctx.baseText?.trim() || readString(payload, "RawBody") || undefined;
  const bodyForAgent = readString(payload, "BodyForAgent") ?? body;
  const commandBody = readString(payload, "CommandBody") ?? readString(payload, "BodyForCommands");
  return {
    version: 1,
    channel: "discord",
    accountId: ctx.accountId,
    conversationId: route.conversationId,
    nativeChannelId: ctx.messageChannelId,
    ...(threadId ? { threadId } : {}),
    sessionKey: prepared.persistedSessionKey,
    messageId: ctx.canonicalMessageId ?? ctx.message.id,
    receivedAt: resolveTimestampMs(ctx.message.timestamp) ?? Date.now(),
    chatType: ctx.isDirectMessage ? "direct" : ctx.isGroupDm ? "group" : "channel",
    sender: {
      id: ctx.sender.id,
      ...(ctx.sender.name ? { name: ctx.sender.name } : {}),
      ...(ctx.author.username ? { username: ctx.author.username } : {}),
      ...(ctx.sender.name ? { displayName: ctx.sender.name } : {}),
      ...(ctx.sender.tag ? { tag: ctx.sender.tag } : {}),
      roles: [...ctx.memberRoleIds],
      bot: Boolean(ctx.author.bot && !ctx.sender.isPluralKit),
      nativeId: ctx.author.id,
    },
    ...(body ? { body } : {}),
    ...(bodyForAgent ? { bodyForAgent } : {}),
    ...(commandBody ? { commandBody } : {}),
    commandAuthorized: ctx.commandAuthorized,
    wasMentioned: ctx.effectiveWasMentioned,
    inboundEventKind: ctx.inboundEventKind,
    conversation: {
      channel: "discord",
      conversationType: ctx.isDirectMessage
        ? "direct"
        : ctx.isGroupDm
          ? "group_dm"
          : threadId
            ? "thread"
            : "guild_channel",
      ...(ctx.channelName ? { conversationName: `#${ctx.channelName}` } : {}),
      conversationLabel: threadId ? `thread:${threadId}` : `channel:${ctx.messageChannelId}`,
      sessionKey: prepared.persistedSessionKey,
      ...(ctx.isGuildMessage
        ? { guild: { id: ctx.guildInfo?.id ?? ctx.guildSlug, name: ctx.guildName } }
        : {}),
      nativeChannel: {
        id: ctx.messageChannelId,
        ...(ctx.channelName ? { name: `#${ctx.channelName}` } : {}),
        ...(ctx.channelInfo?.type !== undefined ? { kind: String(ctx.channelInfo.type) } : {}),
      },
      ...(ctx.threadParentId
        ? { parentChannel: { id: ctx.threadParentId, name: ctx.threadParentName } }
        : {}),
      ...(threadId ? { thread: { id: threadId, name: ctx.threadName ?? ctx.channelName } } : {}),
    },
    ...(quoteId || quoteBody || quoteSender || quoteMedia.length > 0
      ? {
          quote: {
            sender: quoteSender ?? "unknown",
            senderId: quoteSenderId ?? "unknown",
            messageId: quoteId ?? "unknown",
            ...(quoteTimestamp !== undefined
              ? { timestamp: new Date(quoteTimestamp).toISOString() }
              : {}),
            ...(quoteBody ? { body: quoteBody } : {}),
            ...(quoteMedia.length > 0 ? { media: quoteMedia } : {}),
          },
        }
      : {}),
    media: buildMedia(ctx),
    ...(ctx.sender.pluralkit ? { pluralkit: ctx.sender.pluralkit } : {}),
    nativeMetadata: compactJson({
      authorId: ctx.author.id,
      canonicalMessageId: ctx.canonicalMessageId,
      guildSlug: ctx.guildSlug,
      memberRoleIds: ctx.memberRoleIds,
      pluralkit: ctx.sender.pluralkit,
    }),
  };
}

export async function admitDiscordScheduledInbound(params: {
  ctx: DiscordMessagePreflightContext;
  prepared: DiscordMessageProcessContext;
  onError?: (error: unknown) => void;
}): Promise<DiscordSchedulerAdmission> {
  try {
    const nativeConversationId = params.ctx.threadParentId ?? params.ctx.messageChannelId;
    const threadId = params.ctx.threadChannel ? params.ctx.messageChannelId : undefined;
    const resolved = resolveConversationRoute({
      cfg: params.ctx.cfg,
      channel: "discord",
      accountId: params.ctx.accountId,
      peer: {
        kind: params.ctx.isDirectMessage ? "direct" : params.ctx.isGroupDm ? "group" : "channel",
        id: params.ctx.isDirectMessage ? params.ctx.author.id : nativeConversationId,
      },
      parentPeer: params.ctx.threadParentId
        ? { kind: "channel", id: params.ctx.threadParentId }
        : undefined,
      threadId,
      guildId: params.ctx.guildInfo?.id ?? params.ctx.guildSlug,
      memberRoleIds: params.ctx.memberRoleIds,
      currentReplyTarget: {
        channel: "discord",
        accountId: params.ctx.accountId,
        target: params.ctx.messageChannelId,
        ...(threadId ? { threadId } : {}),
        messageId: params.ctx.canonicalMessageId ?? params.ctx.message.id,
      },
    });
    if (resolved.sessionKey !== params.prepared.persistedSessionKey) {
      throw new Error("discord scheduler route does not match the finalized native session");
    }
    const route = resolved;
    const envelope = buildDiscordScheduledEnvelope({ ...params, route });
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

export async function settleDiscordScheduledInbound(params: {
  receiptId: string;
  result: Exclude<SchedulerDispatchResult, { outcome: "pending" }>;
}): Promise<boolean> {
  return await getRuntimeConversationScheduler().settle(params.receiptId, params.result);
}

export const discordSchedulerAdmissionTesting = { compactJson };
