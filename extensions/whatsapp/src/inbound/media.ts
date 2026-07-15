// Whatsapp plugin module implements media behavior.
import type { proto, WAMessage } from "baileys";
import { saveMediaStream, type SavedMedia } from "openclaw/plugin-sdk/media-store";
import type { createWaSocket } from "../session.js";
import { extractContextInfo } from "./extract.js";
import { resolveInboundMediaMimetype } from "./media-mimetype.js";
import { downloadMediaMessage, normalizeMessageContent } from "./runtime-api.js";

class WhatsAppInboundMediaLimitExceededError extends Error {
  constructor(maxBytes: number) {
    super(`Media exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
    this.name = "WhatsAppInboundMediaLimitExceededError";
  }
}

const MESSAGE_WRAPPER_KEYS = [
  "botInvokeMessage",
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "groupMentionedMessage",
] as const;

const MESSAGE_CONTENT_KEYS = [
  "conversation",
  "extendedTextMessage",
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
  "locationMessage",
  "liveLocationMessage",
  "contactMessage",
  "contactsArrayMessage",
] as const;
// protobufjs synthesizes a `_motionPhotoPresentationOffsetMs` oneof marker for
// the proto3-optional offset field; the typed value can be erased to null on
// normalization while the marker survives, so presence checks need both.
const MOTION_PHOTO_PRESENTATION_OFFSET_MARKER = "_motionPhotoPresentationOffsetMs";

function unwrapMessage(message: proto.IMessage | undefined): proto.IMessage | undefined {
  return buildMessageChain(message).at(-1);
}

function ownKeysWithValues(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry != null)
    .map(([key]) => key);
}

function hasMotionPhotoPresenceMarker(videoRecord: Record<string, unknown>): boolean {
  return videoRecord[MOTION_PHOTO_PRESENTATION_OFFSET_MARKER] === "motionPhotoPresentationOffsetMs";
}

// Zero offset = a regular video from a Live-Photo-capable device, NOT a live
// photo; nonzero/unparseable values mark the motion component.
function hasMeaningfulMotionPhotoOffset(value: unknown): boolean {
  if (value == null) {
    return false;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "bigint") {
    return value !== 0n;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return false;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed !== 0 : true;
  }
  if (typeof value === "object") {
    if ("low" in value && "high" in value) {
      const low = (value as { low?: unknown }).low;
      const high = (value as { high?: unknown }).high;
      return (typeof low === "number" && low !== 0) || (typeof high === "number" && high !== 0);
    }
    if ("toNumber" in value && typeof (value as { toNumber?: unknown }).toNumber === "function") {
      try {
        return hasMeaningfulMotionPhotoOffset((value as { toNumber: () => unknown }).toNumber());
      } catch {
        return true;
      }
    }
    if ("valueOf" in value && typeof (value as { valueOf?: unknown }).valueOf === "function") {
      const primitive = (value as { valueOf: () => unknown }).valueOf();
      if (primitive !== value) {
        return hasMeaningfulMotionPhotoOffset(primitive);
      }
    }
  }
  return true;
}

function getKnownContentKeys(message: proto.IMessage | undefined): string[] {
  if (!message || typeof message !== "object") {
    return [];
  }
  return MESSAGE_CONTENT_KEYS.filter((key) => (message as Record<string, unknown>)[key] != null);
}

function getWrappedInnerMessage(message: proto.IMessage): proto.IMessage | undefined {
  const record = message as Record<string, unknown>;
  for (const key of MESSAGE_WRAPPER_KEYS) {
    const candidate = record[key];
    if (
      candidate &&
      typeof candidate === "object" &&
      "message" in candidate &&
      (candidate as { message?: unknown }).message &&
      typeof (candidate as { message?: unknown }).message === "object"
    ) {
      return normalizeMessageContent((candidate as { message: proto.IMessage }).message);
    }
  }

  for (const candidate of Object.values(record)) {
    if (
      candidate &&
      typeof candidate === "object" &&
      "message" in candidate &&
      (candidate as { message?: unknown }).message &&
      typeof (candidate as { message?: unknown }).message === "object"
    ) {
      const inner = normalizeMessageContent((candidate as { message: proto.IMessage }).message);
      if (inner) {
        return inner;
      }
    }
  }
  return undefined;
}

// Wrapper chains (ephemeral, view-once, document-with-caption, generic
// `{message}` holders) unwrap to depth 8 with a cycle guard.
function buildMessageChain(message: proto.IMessage | undefined): proto.IMessage[] {
  const chain: proto.IMessage[] = [];
  let current = normalizeMessageContent(message);
  const seen = new Set<proto.IMessage>();
  while (current && chain.length < 8 && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    if (getKnownContentKeys(current).length > 0) {
      break;
    }
    current = getWrappedInnerMessage(current);
  }
  return chain;
}

function isLivePhotoMotionVideo(rawMessage: proto.IMessage | undefined): {
  present: boolean;
  livePhoto: boolean;
  offsetValue: unknown;
} {
  const message = unwrapMessage(rawMessage);
  const video = message?.videoMessage;
  if (!video) {
    return { present: false, livePhoto: false, offsetValue: undefined };
  }
  const videoRecord = video as Record<string, unknown>;
  const offsetValue = video.motionPhotoPresentationOffsetMs;
  const markerPresent = hasMotionPhotoPresenceMarker(videoRecord);
  const present = offsetValue != null || markerPresent;
  const livePhoto =
    hasMeaningfulMotionPhotoOffset(offsetValue) || (offsetValue == null && markerPresent);
  return { present, livePhoto, offsetValue };
}

export function isWhatsAppLivePhotoVideoComponent(rawMessage: proto.IMessage | undefined): boolean {
  return isLivePhotoMotionVideo(rawMessage).livePhoto;
}

export function isWhatsAppVideoMessage(rawMessage: proto.IMessage | undefined): boolean {
  const message = unwrapMessage(rawMessage);
  return Boolean(message?.videoMessage);
}

export type WhatsAppMediaMessageInspection = {
  rawKeys: string[];
  normalizedKeys: string[];
  chainContentKeys: string[][];
  finalContentKeys: string[];
  hasVideo: boolean;
  hasImage: boolean;
  livePhotoVideo: boolean;
  motionPhotoOffsetPresent: boolean;
  motionPhotoOffsetMs?: unknown;
  videoMimetype?: string | null;
  imageMimetype?: string | null;
};

export function inspectWhatsAppMediaMessage(
  rawMessage: proto.IMessage | undefined,
): WhatsAppMediaMessageInspection {
  const normalized = normalizeMessageContent(rawMessage);
  const chain = buildMessageChain(rawMessage);
  const message = chain.at(-1);
  const video = message?.videoMessage;
  const image = message?.imageMessage;
  const motionPhoto = isLivePhotoMotionVideo(rawMessage);
  return {
    rawKeys: ownKeysWithValues(rawMessage),
    normalizedKeys: ownKeysWithValues(normalized),
    chainContentKeys: chain.map(getKnownContentKeys),
    finalContentKeys: getKnownContentKeys(message),
    hasVideo: Boolean(video),
    hasImage: Boolean(image),
    livePhotoVideo: motionPhoto.livePhoto,
    motionPhotoOffsetPresent: motionPhoto.present,
    motionPhotoOffsetMs: motionPhoto.offsetValue,
    videoMimetype: video?.mimetype ?? null,
    imageMimetype: image?.mimetype ?? null,
  };
}

export async function downloadInboundMedia(
  msg: proto.IWebMessageInfo,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
  maxBytes = 50 * 1024 * 1024,
): Promise<{ saved: SavedMedia; mimetype?: string; fileName?: string } | undefined> {
  const message = unwrapMessage(msg.message as proto.IMessage | undefined);
  if (!message) {
    return undefined;
  }
  const mimetype = resolveInboundMediaMimetype(message);
  const fileName = message.documentMessage?.fileName ?? undefined;
  if (
    !message.imageMessage &&
    !message.videoMessage &&
    !message.documentMessage &&
    !message.audioMessage &&
    !message.stickerMessage
  ) {
    return undefined;
  }
  const stream = await downloadMediaMessage(
    msg as WAMessage,
    "stream",
    {},
    {
      reuploadRequest: sock.updateMediaMessage,
      logger: sock.logger,
    },
  );
  const saved = await saveMediaStream(
    stream as AsyncIterable<unknown>,
    mimetype,
    "inbound",
    maxBytes,
    fileName,
  ).catch((err: unknown) => {
    if (err instanceof Error && /Media exceeds/i.test(err.message)) {
      throw new WhatsAppInboundMediaLimitExceededError(maxBytes);
    }
    throw err;
  });
  return { saved, mimetype, fileName };
}

export async function downloadQuotedInboundMedia(
  msg: proto.IWebMessageInfo,
  sock: Awaited<ReturnType<typeof createWaSocket>>,
  maxBytes = 50 * 1024 * 1024,
): Promise<{ saved: SavedMedia; mimetype?: string; fileName?: string } | undefined> {
  const message = unwrapMessage(msg.message as proto.IMessage | undefined);
  const contextInfo = extractContextInfo(message);
  if (!contextInfo?.quotedMessage) {
    return undefined;
  }
  const quotedMessage = contextInfo.quotedMessage;
  return downloadInboundMedia(
    {
      key: {
        id: contextInfo?.stanzaId || undefined,
        remoteJid: contextInfo.remoteJid ?? msg.key?.remoteJid ?? undefined,
        participant: contextInfo?.participant ?? undefined,
        fromMe: false,
      },
      message: quotedMessage,
      messageTimestamp: msg.messageTimestamp,
    },
    sock,
    maxBytes,
  );
}
