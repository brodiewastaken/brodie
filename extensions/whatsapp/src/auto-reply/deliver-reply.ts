// Whatsapp plugin module implements deliver reply behavior.
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-chunking";
import {
  isReasoningReplyPayload,
  sendMediaWithLeadingCaption,
} from "openclaw/plugin-sdk/reply-payload";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { GifAutoConvertConfig } from "../gif-transcode.js";
import { requireWhatsAppInboundAdmission } from "../inbound/admission.js";
import type { WhatsAppSendResult } from "../inbound/send-result.js";
import { listWhatsAppSendResultMessageIds } from "../inbound/send-result.js";
import type { AdmittedWebInboundMessage } from "../inbound/types.js";
import { loadWebMedia } from "../media.js";
import {
  type DeliverableWhatsAppOutboundPayload,
  normalizeWhatsAppOutboundPayload,
  normalizeWhatsAppPayloadTextPreservingIndentation,
  prepareWhatsAppOutboundMedia,
  sendWhatsAppOutboundWithRetry,
} from "../outbound-media-contract.js";
import {
  buildQuotedMessageOptions,
  cacheInboundMessageMeta,
  lookupInboundMessageMetaForTarget,
} from "../quoted-message.js";
import { newConnectionId } from "../reconnect.js";
import { formatError } from "../session.js";
import { convertMarkdownTables } from "../text-runtime.js";
import { markdownToWhatsApp } from "../text-runtime.js";
import { whatsappOutboundLog } from "./loggers.js";
import { elide, markWhatsAppVisibleDeliveryError } from "./util.js";

const DEFAULT_FAILED_MEDIA_WARNING = "⚠️ Media failed.";

export type WhatsAppPartialMediaFailure = {
  mediaUrl: string;
  caption?: string;
  index: number;
  errorText: string;
  error: unknown;
};

export type WhatsAppReplyDeliveryResult = {
  results: WhatsAppSendResult[];
  receipt: MessageReceipt;
  providerAccepted: boolean;
  /**
   * Media items that failed after other parts were provider-accepted.
   * Surfaces as success-with-warnings in the message-tool result so the model
   * can react in-turn (resend, apologize, or stay silent).
   */
  partialMediaFailures: WhatsAppPartialMediaFailure[];
};

function resolveWhatsAppReceiptKind(
  results: readonly WhatsAppSendResult[],
): Parameters<typeof createMessageReceiptFromOutboundResults>[0]["kind"] {
  if (results.length > 0 && results.every((result) => result.kind === "text")) {
    return "text";
  }
  if (results.length > 0 && results.every((result) => result.kind === "media")) {
    return "media";
  }
  return "unknown";
}

function createWhatsAppReplyDeliveryReceipt(
  results: readonly WhatsAppSendResult[],
): MessageReceipt {
  const receiptResultsById = new Map<string, MessageReceiptSourceResult>();
  for (const result of results) {
    if (result.receipt?.parts.length) {
      for (const part of result.receipt.parts) {
        receiptResultsById.set(part.platformMessageId, {
          ...(part.raw ?? { channel: "whatsapp", messageId: part.platformMessageId }),
          meta: {
            ...part.raw?.meta,
            kind: result.kind,
            providerAccepted: result.providerAccepted,
          },
        });
      }
      continue;
    }
    for (const messageId of listWhatsAppSendResultMessageIds(result)) {
      receiptResultsById.set(messageId, {
        channel: "whatsapp",
        messageId,
        meta: {
          kind: result.kind,
          providerAccepted: result.providerAccepted,
        },
      });
    }
  }
  return createMessageReceiptFromOutboundResults({
    results: [...receiptResultsById.values()],
    kind: resolveWhatsAppReceiptKind(results),
  });
}

export async function deliverWebReply(params: {
  replyResult: ReplyPayload;
  normalizedReplyResult?: DeliverableWhatsAppOutboundPayload<ReplyPayload>;
  msg: AdmittedWebInboundMessage;
  mediaLocalRoots?: readonly string[];
  gifAutoConvert?: GifAutoConvertConfig;
  failedMediaWarning?: string;
  maxMediaBytes: number;
  textLimit: number;
  chunkMode?: ChunkMode;
  replyLogger: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
  };
  connectionId?: string;
  skipLog?: boolean;
  tableMode?: MarkdownTableMode;
}): Promise<WhatsAppReplyDeliveryResult> {
  const { replyResult, msg, maxMediaBytes, textLimit, replyLogger, connectionId, skipLog } = params;
  const admission = requireWhatsAppInboundAdmission(msg);
  const conversationId = admission.conversation.id;
  const isGroupConversation = admission.conversation.kind === "group";
  const replyStarted = Date.now();
  const sendResults: WhatsAppSendResult[] = [];
  const partialMediaFailures: WhatsAppPartialMediaFailure[] = [];
  // Self-quote participant is LID-first: phone-JID participants render
  // "unknown sender" quotes in LID groups.
  const selfParticipant =
    msg.platform.selfLid ??
    msg.platform.self?.lid ??
    msg.platform.selfJid ??
    msg.platform.self?.jid ??
    undefined;
  const rememberSendResult = (result: WhatsAppSendResult | undefined, messageText?: string) => {
    if (!result) {
      return;
    }
    sendResults.push(result);
    // Record every outbound send into the quoted-message meta cache with the
    // self participant so later replies targeting our own message ids render
    // correct fromMe quotes in groups and cross-conversation lookups.
    const normalizedText = messageText?.trim();
    const keyEntries =
      result.keys.length > 0
        ? result.keys
        : listWhatsAppSendResultMessageIds(result).map((id) => ({
            id,
            remoteJid: msg.platform.chatJid,
            fromMe: true,
            participant: selfParticipant,
          }));
    for (const key of keyEntries) {
      if (!key.id) {
        continue;
      }
      cacheInboundMessageMeta(admission.accountId, key.remoteJid ?? msg.platform.chatJid, key.id, {
        participant: key.participant ?? (key.fromMe ? selfParticipant : undefined),
        participantE164:
          admission.conversation.kind === "direct"
            ? key.fromMe
              ? (msg.platform.selfE164 ?? undefined)
              : (msg.platform.senderE164 ?? undefined)
            : undefined,
        body: normalizedText,
        fromMe: key.fromMe ?? true,
      });
    }
  };
  const finishDelivery = (): WhatsAppReplyDeliveryResult => {
    const receipt = createWhatsAppReplyDeliveryReceipt(sendResults);
    return {
      results: sendResults,
      receipt,
      providerAccepted: sendResults.some((result) => result.providerAccepted),
      partialMediaFailures,
    };
  };
  if (isReasoningReplyPayload(replyResult)) {
    whatsappOutboundLog.debug(`Suppressed reasoning payload to ${conversationId}`);
    return finishDelivery();
  }
  const tableMode = params.tableMode ?? "code";
  const chunkMode = params.chunkMode ?? "length";
  const normalizedReply =
    params.normalizedReplyResult ??
    normalizeWhatsAppOutboundPayload(replyResult, {
      normalizeText: normalizeWhatsAppPayloadTextPreservingIndentation,
    });
  const convertedText = markdownToWhatsApp(
    convertMarkdownTables(normalizedReply.text ?? "", tableMode),
  );
  const textChunks = chunkMarkdownTextWithMode(convertedText, textLimit, chunkMode);
  const mediaList = normalizedReply.mediaUrls ?? [];

  // At most one quote per delivery: the first outbound part consumes it and
  // subsequent parts send unquoted.
  let replyQuoteUsed = false;
  let replyQuote: ReturnType<typeof buildQuotedMessageOptions> | undefined;
  const getQuote = () => {
    if (replyQuoteUsed || !replyResult.replyToId) {
      return undefined;
    }
    // Use replyToId (not msg.event.id) so batched payloads quote the correct
    // per-message target; the cross-conversation lookup matches quoted ids
    // from other chats (never across group boundaries).
    replyQuote ??= (() => {
      const cached = lookupInboundMessageMetaForTarget(
        admission.accountId,
        msg.platform.chatJid,
        replyResult.replyToId,
      );
      return buildQuotedMessageOptions({
        messageId: replyResult.replyToId,
        remoteJid: cached?.remoteJid ?? msg.platform.chatJid,
        fromMe: cached?.fromMe ?? false,
        participant:
          cached?.participant ??
          (cached?.fromMe
            ? selfParticipant
            : isGroupConversation
              ? msg.platform.senderJid
              : undefined),
        messageText: cached?.body ?? "",
      });
    })();
    if (replyQuote) {
      replyQuoteUsed = true;
    }
    return replyQuote;
  };

  const sendWithRetry = async <T>(fn: () => Promise<T>, label: string, maxAttempts = 3) => {
    try {
      return await sendWhatsAppOutboundWithRetry({
        send: fn,
        maxAttempts,
        onRetry: ({ attempt, maxAttempts: retryMaxAttempts, backoffMs, errorText }) => {
          logVerbose(
            `Retrying ${label} to ${conversationId} after failure (${attempt}/${retryMaxAttempts - 1}) in ${backoffMs}ms: ${errorText}`,
          );
        },
      });
    } catch (error: unknown) {
      // A throw after any provider-accepted send must carry the accepted
      // receipts so callers do not re-send already-delivered parts.
      if (sendResults.some((result) => result.providerAccepted)) {
        throw markWhatsAppVisibleDeliveryError(error);
      }
      throw error;
    }
  };

  // Text-only replies
  if (mediaList.length === 0 && textChunks.length) {
    const totalChunks = textChunks.length;
    for (const [index, chunk] of textChunks.entries()) {
      const chunkStarted = Date.now();
      const quote = getQuote();
      rememberSendResult(
        await sendWithRetry(() => msg.platform.reply(chunk, quote), "text"),
        chunk,
      );
      if (!skipLog) {
        const durationMs = Date.now() - chunkStarted;
        whatsappOutboundLog.debug(
          `Sent chunk ${index + 1}/${totalChunks} to ${conversationId} (${durationMs.toFixed(0)}ms)`,
        );
      }
    }
    const delivery = finishDelivery();
    const logPayload = {
      correlationId: msg.event.id ?? newConnectionId(),
      connectionId: connectionId ?? null,
      to: conversationId,
      from: msg.platform.recipientJid,
      text: elide(replyResult.text, 240),
      mediaUrl: null,
      mediaSizeBytes: null,
      mediaKind: null,
      durationMs: Date.now() - replyStarted,
    };
    if (delivery.providerAccepted) {
      replyLogger.info(logPayload, "auto-reply sent (text)");
    } else {
      replyLogger.warn(logPayload, "auto-reply text was not accepted by WhatsApp provider");
    }
    return delivery;
  }

  const remainingText = [...textChunks];

  // Media (with optional caption on first item)
  const leadingCaption = remainingText.shift() || "";
  await sendMediaWithLeadingCaption({
    mediaUrls: mediaList,
    caption: leadingCaption,
    send: async ({ mediaUrl, caption }) => {
      const media = await prepareWhatsAppOutboundMedia(
        await loadWebMedia(mediaUrl, {
          maxBytes: maxMediaBytes,
          localRoots: params.mediaLocalRoots,
        }),
        mediaUrl,
        { gifAutoConvert: params.gifAutoConvert },
      );
      if (shouldLogVerbose()) {
        logVerbose(
          `Web auto-reply media size: ${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB`,
        );
        logVerbose(`Web auto-reply media source: ${mediaUrl} (kind ${media.kind})`);
      }
      if (media.kind === "image") {
        const quote = getQuote();
        rememberSendResult(
          await sendWithRetry(
            () =>
              msg.platform.sendMedia(
                {
                  image: media.buffer,
                  caption,
                  mimetype: media.mimetype,
                },
                quote,
              ),
            "media:image",
          ),
          caption,
        );
      } else if (media.kind === "audio") {
        const quote = getQuote();
        rememberSendResult(
          await sendWithRetry(
            () =>
              msg.platform.sendMedia(
                {
                  audio: media.buffer,
                  ptt: true,
                  mimetype: media.mimetype,
                },
                quote,
              ),
            "media:audio",
          ),
        );
        if (caption) {
          const captionQuote = getQuote();
          rememberSendResult(
            await sendWithRetry(
              () => msg.platform.reply(caption, captionQuote),
              "media:audio-text",
            ),
            caption,
          );
        }
      } else if (media.kind === "video") {
        const quote = getQuote();
        rememberSendResult(
          await sendWithRetry(
            () =>
              msg.platform.sendMedia(
                {
                  video: media.buffer,
                  caption,
                  mimetype: media.mimetype,
                  ...(media.gifPlayback ? { gifPlayback: true } : {}),
                },
                quote,
              ),
            "media:video",
          ),
          caption,
        );
      } else {
        const quote = getQuote();
        rememberSendResult(
          await sendWithRetry(
            () =>
              msg.platform.sendMedia(
                {
                  document: media.buffer,
                  fileName: media.fileName,
                  caption,
                  mimetype: media.mimetype,
                },
                quote,
              ),
            "media:document",
          ),
          caption,
        );
      }
      whatsappOutboundLog.info(
        `Sent media reply to ${conversationId} (${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB)`,
      );
      replyLogger.info(
        {
          correlationId: msg.event.id ?? newConnectionId(),
          connectionId: connectionId ?? null,
          to: conversationId,
          from: msg.platform.recipientJid,
          text: caption ?? null,
          mediaUrl,
          mediaSizeBytes: media.buffer.length,
          mediaKind: media.kind,
          durationMs: Date.now() - replyStarted,
        },
        "auto-reply sent (media)",
      );
    },
    onError: async ({ error, mediaUrl, caption, index, isFirst }) => {
      whatsappOutboundLog.error(
        `Failed sending web media to ${conversationId}: ${formatError(error)}`,
      );
      replyLogger.warn({ err: error, mediaUrl }, "failed to send web media reply");
      partialMediaFailures.push({
        mediaUrl,
        ...(caption ? { caption } : {}),
        index,
        errorText: formatError(error),
        error,
      });
      const warning = params.failedMediaWarning?.trim() || DEFAULT_FAILED_MEDIA_WARNING;
      if (!isFirst) {
        // Interim surfacing until the feature-03 message-tool executor renders
        // partialMediaFailures as success-with-warnings (Round 2 Q4): a
        // trailing attachment must not vanish without any user-visible signal.
        whatsappOutboundLog.warn(`Trailing media failed; sent warning to ${conversationId}`);
        rememberSendResult(
          await sendWithRetry(
            () => msg.platform.reply(warning, getQuote()),
            "media:fallback-unavailable",
          ),
        );
        return;
      }
      // First-media failure: the caption chunk rode the failed media and was
      // never delivered, so the fallback re-sends it with the warning; the
      // remaining chunks still go out through the trailing loop.
      const fallbackTextParts = [caption ?? "", warning].filter(Boolean);
      const fallbackText = fallbackTextParts.join("\n");
      if (!fallbackText) {
        return;
      }
      whatsappOutboundLog.warn(`Media skipped; sent text-only to ${conversationId}`);
      rememberSendResult(
        await sendWithRetry(
          () => msg.platform.reply(fallbackText, getQuote()),
          "media:fallback-text",
        ),
      );
    },
  });

  // Remaining text chunks after media
  for (const chunk of remainingText) {
    const quote = getQuote();
    rememberSendResult(
      await sendWithRetry(() => msg.platform.reply(chunk, quote), "media:text"),
      chunk,
    );
  }
  // Round 2 Q4: partial media failure is success-with-warnings, not an error —
  // the delivery result lists exactly which media failed alongside the
  // accepted receipts; the agent decides whether to resend.
  if (partialMediaFailures.length > 0 && sendResults.some((result) => result.providerAccepted)) {
    const receipt = createWhatsAppReplyDeliveryReceipt(sendResults);
    replyLogger.warn(
      {
        correlationId: msg.event.id ?? newConnectionId(),
        connectionId: connectionId ?? null,
        to: conversationId,
        from: msg.platform.recipientJid,
        failedMediaCount: partialMediaFailures.length,
        mediaUrls: partialMediaFailures.map((failure) => failure.mediaUrl),
        receiptIds: receipt.platformMessageIds,
      },
      "auto-reply partially failed after WhatsApp accepted messages",
    );
  }
  return finishDelivery();
}
