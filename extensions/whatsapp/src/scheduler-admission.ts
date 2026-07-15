import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getRuntimeConversationScheduler,
  type AdmissionResult,
  type HumanInboundConversation,
  type HumanInboundEventPayload,
  type HumanInboundMedia,
  type JsonValue,
  type ScheduledEvent,
  type SchedulerDispatchResult,
  type SchedulerProducerKind,
} from "openclaw/plugin-sdk/conversation-scheduler";
import { getMediaDir } from "openclaw/plugin-sdk/media-runtime";
import { resolveConversationRoute, type ConversationRoute } from "openclaw/plugin-sdk/routing";
import { getPrimaryIdentityId } from "./identity.js";
import { requireWhatsAppInboundAdmission } from "./inbound/admission.js";
import type { AdmittedWebInboundMessage } from "./inbound/types.js";

export type WhatsAppScheduledMedia = HumanInboundMedia & {
  id: string;
  uri?: string;
  path?: string;
  url?: string;
};

export type WhatsAppScheduledEnvelope = Omit<
  HumanInboundEventPayload,
  "channel" | "chatType" | "media"
> & {
  channel: "whatsapp";
  chatType: "direct" | "group";
  media: WhatsAppScheduledMedia[];
  rawKind: "text" | "media" | "sticker";
};

export type WhatsAppSchedulerAdmission = {
  result: AdmissionResult;
  route?: ConversationRoute;
  event?: ScheduledEvent;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => readString(entry) ?? "") : [];
}

function normalizeTimestampMs(value: number | undefined, now: number): number {
  if (value === undefined) {
    return now;
  }
  return value > 0 && value < 100_000_000_000 ? value * 1_000 : value;
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

function mediaKind(mimeType: string | undefined, rawBody: string | undefined) {
  if (rawBody === "<media:sticker>") {
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

function buildMedia(params: {
  ctx: Record<string, unknown>;
  messageId: string;
  rawBody?: string;
  prefix?: "ReplyTo";
}): WhatsAppScheduledMedia[] {
  const prefix = params.prefix ?? "";
  const paths = readStringArray(params.ctx[`${prefix}MediaPaths`]);
  const urls = readStringArray(params.ctx[`${prefix}MediaUrls`]);
  const types = readStringArray(params.ctx[`${prefix}MediaTypes`]);
  if (!params.prefix) {
    paths[0] ||= readString(params.ctx.MediaPath) ?? "";
    urls[0] ||= readString(params.ctx.MediaUrl) ?? "";
    types[0] ||= readString(params.ctx.MediaType) ?? "";
  }
  const count = Math.max(paths.length, urls.length, types.length);
  const media: WhatsAppScheduledMedia[] = [];
  for (let index = 0; index < count; index += 1) {
    const mediaPath = paths[index] || undefined;
    const url = urls[index] || undefined;
    const mimeType = types[index] || undefined;
    if (!mediaPath && !url && !mimeType) {
      continue;
    }
    media.push({
      kind: mediaKind(mimeType, params.rawBody),
      id: `${params.messageId}:${index}`,
      ...(mediaPath ? { path: mediaPath } : {}),
      ...(mediaPath ? { managedLocalPath: mediaPath } : {}),
      ...(mediaPath && toInboundMediaUri(mediaPath) ? { uri: toInboundMediaUri(mediaPath) } : {}),
      ...(url ? { url } : {}),
      ...(mimeType ? { mimeType } : {}),
      mediaRef:
        (mediaPath ? toInboundMediaUri(mediaPath) : undefined) ??
        url ??
        `media://staged/${encodeURIComponent(params.messageId)}/${index}`,
      sourceMessageId: params.messageId,
      sourceIndex: index,
      understanding: [],
    });
  }
  return media;
}

function compactJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== undefined).map(compactJson);
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, compactJson(entry)]),
    );
  }
  throw new Error("whatsapp scheduler payload contains an unsupported value");
}

function producerKind(envelope: WhatsAppScheduledEnvelope): SchedulerProducerKind {
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
  if (envelope.location) {
    return "human_location";
  }
  if (envelope.quote) {
    return "human_reply";
  }
  if (envelope.media.length > 0) {
    return "human_media";
  }
  return "human_message";
}

export function buildWhatsAppScheduledEnvelope(params: {
  ctx: Record<string, unknown>;
  msg: AdmittedWebInboundMessage;
}): WhatsAppScheduledEnvelope {
  const admission = requireWhatsAppInboundAdmission(params.msg);
  const sessionKey = readString(params.ctx.SessionKey);
  if (!sessionKey) {
    throw new Error("whatsapp scheduler envelope requires a finalized SessionKey");
  }
  const receivedAt = normalizeTimestampMs(
    readNumber(params.ctx.Timestamp) ?? params.msg.event.timestamp,
    Date.now(),
  );
  const messageId =
    readString(params.ctx.MessageSid) ??
    readString(params.msg.event.id) ??
    `${admission.conversation.id}:${receivedAt}`;
  const nativeBody = params.msg.payload.body;
  const authoredBody = nativeBody.startsWith("<media:") ? undefined : readString(nativeBody);
  const bodyForAgent = readString(params.ctx.BodyForAgent) ?? authoredBody;
  const rawBody = readString(params.ctx.RawBody) ?? authoredBody;
  const media = buildMedia({ ctx: params.ctx, messageId, rawBody });
  const replyId = readString(params.ctx.ReplyToId);
  const replyFullId = readString(params.ctx.ReplyToIdFull);
  const replyBody = readString(params.ctx.ReplyToBody);
  const replySender = readString(params.ctx.ReplyToSender);
  const replyMedia = buildMedia({
    ctx: params.ctx,
    messageId: replyId ?? replyFullId ?? "reply-to",
    prefix: "ReplyTo",
  });
  const quoteSender = params.msg.quote?.context?.sender;
  const quoteSenderId = quoteSender ? (getPrimaryIdentityId(quoteSender) ?? undefined) : undefined;
  const latitude = readNumber(params.ctx.LocationLat);
  const longitude = readNumber(params.ctx.LocationLon);
  const senderE164 = readString(params.ctx.SenderE164);
  const senderName = readString(params.ctx.SenderName);
  const participantCount =
    readNumber(params.ctx.ParticipantCount) ?? params.msg.group?.participants?.length;
  const selfIdentity =
    readString(params.ctx.SelfE164) ??
    readString(params.ctx.SelfJid) ??
    readString(params.ctx.SelfLid);
  const memberLabels =
    readString(params.ctx.GroupMembers)
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ??
    params.msg.group?.participants ??
    [];
  const rawKind =
    nativeBody === "<media:sticker>" || media.some((entry) => entry.kind === "sticker")
      ? "sticker"
      : media.length > 0
        ? "media"
        : "text";
  const conversation: HumanInboundConversation = {
    channel: "whatsapp",
    conversationType: admission.conversation.kind,
    ...((readString(params.ctx.GroupSubject) ?? senderName ?? senderE164)
      ? { conversationName: readString(params.ctx.GroupSubject) ?? senderName ?? senderE164 }
      : {}),
    conversationLabel: readString(params.ctx.ConversationLabel) ?? admission.conversation.id,
    ...(memberLabels.length > 0
      ? {
          conversationMembers: memberLabels.map((label) => {
            const member: { label: string; brodie?: boolean } = { label };
            if (selfIdentity && label.includes(selfIdentity)) {
              member.brodie = true;
            }
            return member;
          }),
        }
      : {}),
    sessionKey,
    chatId: admission.conversation.id,
  };
  return {
    version: 1,
    channel: "whatsapp",
    accountId: readString(params.ctx.AccountId) ?? admission.accountId,
    conversationId: admission.conversation.id,
    sessionKey,
    messageId,
    receivedAt,
    chatType: admission.conversation.kind,
    ...(participantCount !== undefined ? { participantCount } : {}),
    duoRoom: admission.duoRoom,
    sender: {
      id: readString(params.ctx.SenderId) ?? senderE164 ?? admission.sender.id,
      ...(senderName ? { name: senderName } : {}),
      ...(senderE164 ? { e164: senderE164 } : {}),
    },
    ...(rawBody ? { body: rawBody } : {}),
    ...(bodyForAgent ? { bodyForAgent } : {}),
    ...((readString(params.ctx.CommandBody) ?? readString(params.ctx.BodyForCommands))
      ? {
          commandBody: readString(params.ctx.CommandBody) ?? readString(params.ctx.BodyForCommands),
        }
      : {}),
    commandAuthorized: params.ctx.CommandAuthorized === true,
    ...(typeof params.msg.wasMentioned === "boolean"
      ? { wasMentioned: params.msg.wasMentioned }
      : typeof params.ctx.WasMentioned === "boolean"
        ? { wasMentioned: params.ctx.WasMentioned }
        : {}),
    ...(readString(params.ctx.InboundEventKind)
      ? { inboundEventKind: readString(params.ctx.InboundEventKind) }
      : {}),
    eventType: rawKind,
    ...(replyId || replyFullId || replyBody || replySender || replyMedia.length > 0
      ? {
          quote: {
            sender: replySender ?? quoteSenderId ?? "unknown",
            senderId: quoteSenderId ?? replySender ?? "unknown",
            messageId: replyFullId ?? replyId ?? "unknown",
            ...(replyBody ? { body: replyBody } : {}),
            ...(replyMedia.length > 0 ? { media: replyMedia } : {}),
          },
        }
      : {}),
    ...(latitude !== undefined && longitude !== undefined
      ? {
          location: {
            latitude,
            longitude,
            ...(readNumber(params.ctx.LocationAccuracy) !== undefined
              ? { accuracyM: readNumber(params.ctx.LocationAccuracy) }
              : {}),
            ...(readString(params.ctx.LocationName)
              ? { name: readString(params.ctx.LocationName) }
              : {}),
            ...(readString(params.ctx.LocationAddress)
              ? { address: readString(params.ctx.LocationAddress) }
              : {}),
            ...(readString(params.ctx.LocationCaption)
              ? { caption: readString(params.ctx.LocationCaption) }
              : {}),
          },
        }
      : {}),
    media,
    rawKind,
    conversation,
    nativeMetadata: compactJson({
      platformChatJid: params.msg.platform.chatJid,
      recipientJid: params.msg.platform.recipientJid,
      senderJid: params.msg.platform.senderJid,
      trustedGroup: admission.trustedGroup,
      duoRoom: admission.duoRoom,
    }),
  };
}

export async function admitWhatsAppScheduledInbound(params: {
  cfg: OpenClawConfig;
  ctx: Record<string, unknown>;
  msg: AdmittedWebInboundMessage;
  onError?: (error: unknown) => void;
}): Promise<WhatsAppSchedulerAdmission> {
  try {
    const envelope = buildWhatsAppScheduledEnvelope(params);
    const route = resolveConversationRoute({
      cfg: params.cfg,
      channel: "whatsapp",
      accountId: envelope.accountId,
      peer: {
        kind: envelope.chatType === "direct" ? "direct" : "group",
        id: envelope.conversationId,
      },
      currentReplyTarget: {
        channel: "whatsapp",
        accountId: envelope.accountId,
        target: envelope.conversationId,
        messageId: envelope.messageId,
      },
    });
    if (route.sessionKey !== envelope.sessionKey) {
      throw new Error("whatsapp scheduler route does not match the finalized native session");
    }
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

export async function settleWhatsAppScheduledInbound(params: {
  receiptId: string;
  result: Exclude<SchedulerDispatchResult, { outcome: "pending" }>;
}): Promise<boolean> {
  return await getRuntimeConversationScheduler().settle(params.receiptId, params.result);
}
