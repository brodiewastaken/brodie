// Slack plugin module implements thread behavior.
import type { WebClient as SlackWebClient } from "@slack/web-api";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackFileReferenceList } from "../file-reference.js";
import type { SlackAttachment, SlackFile } from "../types.js";
import { resolveSlackBlocksText } from "./block-text.js";
import { logVerbose } from "./thread.runtime.js";

export type SlackThreadMessage = {
  text: string;
  sourceText?: string;
  userId?: string;
  botId?: string;
  botName?: string;
  ts?: string;
  subtype?: string;
  parentUserId?: string;
  replyCount?: number;
  edited?: {
    userId?: string;
    ts?: string;
  };
  reactions?: Array<{
    name?: string;
    count?: number;
  }>;
  files?: SlackFile[];
};

export type SlackThreadStarter = SlackThreadMessage;

type SlackThreadStarterCacheEntry = {
  value: SlackThreadStarter;
  expiresAt: number;
};

const THREAD_STARTER_CACHE = new Map<string, SlackThreadStarterCacheEntry>();
const THREAD_STARTER_CACHE_TTL_MS = 6 * 60 * 60_000;
const THREAD_STARTER_CACHE_MAX = 2000;

function evictThreadStarterCache(): void {
  const now = asDateTimestampMs(Date.now());
  if (now === undefined) {
    THREAD_STARTER_CACHE.clear();
    return;
  }
  for (const [cacheKey, entry] of THREAD_STARTER_CACHE.entries()) {
    if (asDateTimestampMs(entry.expiresAt) === undefined || entry.expiresAt <= now) {
      THREAD_STARTER_CACHE.delete(cacheKey);
    }
  }
  pruneMapToMaxSize(THREAD_STARTER_CACHE, THREAD_STARTER_CACHE_MAX);
}

function formatSlackFilePlaceholder(files: SlackFile[] | undefined): string {
  return `[attached: ${formatSlackFileReferenceList(files)}]`;
}

function pushUniqueText(parts: string[], value: string | undefined): void {
  const text = normalizeOptionalString(value);
  if (text && !parts.includes(text)) {
    parts.push(text);
  }
}

function resolveSlackBlocksFallbackText(blocks: unknown[] | undefined): string | undefined {
  return resolveSlackBlocksText(blocks)?.text;
}

function resolveSlackAttachmentFallbackText(
  attachments: SlackAttachment[] | undefined,
): string | undefined {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  for (const attachment of attachments) {
    pushUniqueText(parts, attachment.pretext);
    pushUniqueText(parts, attachment.title);
    pushUniqueText(parts, attachment.text);
    pushUniqueText(parts, attachment.fallback);
    for (const field of attachment.fields ?? []) {
      pushUniqueText(parts, field.title);
      pushUniqueText(parts, field.value);
    }
    pushUniqueText(parts, resolveSlackBlocksFallbackText(attachment.blocks));
    pushUniqueText(parts, resolveSlackBlocksFallbackText(attachment.message_blocks));
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function resolveSlackMessageSourceText(message: {
  text?: string;
  blocks?: unknown[];
  attachments?: SlackAttachment[];
}): string | undefined {
  if (typeof message.text === "string" && message.text.trim().length > 0) {
    return message.text;
  }
  return (
    resolveSlackAttachmentFallbackText(message.attachments) ??
    resolveSlackBlocksFallbackText(message.blocks)
  );
}

function resolveSlackMessageText(message: {
  text?: string;
  blocks?: unknown[];
  attachments?: SlackAttachment[];
}): string | undefined {
  return normalizeOptionalString(resolveSlackMessageSourceText(message));
}

export async function resolveSlackThreadStarter(params: {
  channelId: string;
  threadTs: string;
  client: SlackWebClient;
}): Promise<SlackThreadStarter | null> {
  evictThreadStarterCache();
  const cacheKey = `${params.channelId}:${params.threadTs}`;
  const cached = THREAD_STARTER_CACHE.get(cacheKey);
  if (cached) {
    const now = asDateTimestampMs(Date.now());
    if (now !== undefined && cached.expiresAt > now) {
      return cached.value;
    }
    THREAD_STARTER_CACHE.delete(cacheKey);
  }
  try {
    const response = (await params.client.conversations.replies({
      channel: params.channelId,
      ts: params.threadTs,
      limit: 1,
      inclusive: true,
    })) as SlackRepliesPage;
    const message = response?.messages?.[0];
    const starter = message ? normalizeSlackThreadMessage(message) : null;
    if (!starter) {
      return null;
    }
    const expiresAt = resolveExpiresAtMsFromDurationMs(THREAD_STARTER_CACHE_TTL_MS);
    if (expiresAt !== undefined) {
      if (THREAD_STARTER_CACHE.has(cacheKey)) {
        THREAD_STARTER_CACHE.delete(cacheKey);
      }
      THREAD_STARTER_CACHE.set(cacheKey, {
        value: starter,
        expiresAt,
      });
      evictThreadStarterCache();
    }
    return starter;
  } catch (err) {
    logVerbose(
      `slack thread starter fetch failed channel=${params.channelId} ts=${params.threadTs}: ${formatErrorMessage(err)}`,
    );
    return null;
  }
}

export function resetSlackThreadStarterCacheForTest(): void {
  THREAD_STARTER_CACHE.clear();
}

type SlackRepliesPageMessage = {
  text?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  ts?: string;
  subtype?: string;
  parent_user_id?: string;
  reply_count?: number;
  edited?: { user?: string; ts?: string };
  reactions?: Array<{ name?: string; count?: number }>;
  files?: SlackFile[];
  blocks?: unknown[];
  attachments?: SlackAttachment[];
};

type SlackRepliesPage = {
  messages?: SlackRepliesPageMessage[];
  response_metadata?: { next_cursor?: string };
};

function normalizeSlackThreadMessage(message: SlackRepliesPageMessage): SlackThreadMessage | null {
  const text = resolveSlackMessageText(message);
  const sourceText = resolveSlackMessageSourceText(message);
  const files = message.files?.length ? message.files : undefined;
  if (!text && !files && message.subtype !== "message_deleted") {
    return null;
  }
  const botName = normalizeOptionalString(message.username) ?? message.bot_profile?.name;
  return {
    text:
      text ??
      (message.subtype === "message_deleted"
        ? "[message was deleted]"
        : formatSlackFilePlaceholder(files)),
    ...(sourceText ? { sourceText } : {}),
    ...(message.user ? { userId: message.user } : {}),
    ...(message.bot_id ? { botId: message.bot_id } : {}),
    ...(botName ? { botName } : {}),
    ...(message.ts ? { ts: message.ts } : {}),
    ...(message.subtype ? { subtype: message.subtype } : {}),
    ...(message.parent_user_id ? { parentUserId: message.parent_user_id } : {}),
    ...(message.reply_count !== undefined ? { replyCount: message.reply_count } : {}),
    ...(message.edited
      ? {
          edited: {
            ...(message.edited.user ? { userId: message.edited.user } : {}),
            ...(message.edited.ts ? { ts: message.edited.ts } : {}),
          },
        }
      : {}),
    ...(message.reactions?.length ? { reactions: message.reactions } : {}),
    ...(files ? { files } : {}),
  };
}

export type SlackThreadHistoryResult = {
  messages: SlackThreadMessage[];
  messagesFetched: number;
  currentInboundExcluded: boolean;
  emptyMessagesOmitted: number;
  messagesOmittedByLimit: number;
  threadRootFetched: boolean;
  historyComplete: boolean;
};

/**
 * Fetches the most recent messages in a Slack thread (excluding the current message).
 * Used to populate thread context when a new thread session starts.
 *
 * Uses cursor pagination across the complete thread and keeps only the latest N
 * retained messages. Slack returns replies oldest-first, so reaching the end of
 * the cursor chain is required to know which messages are actually newest.
 */
export async function resolveSlackThreadHistory(params: {
  channelId: string;
  threadTs: string;
  client: SlackWebClient;
  currentMessageTs?: string;
  limit?: number;
}): Promise<SlackThreadHistoryResult> {
  const maxMessages = params.limit ?? 20;
  if (!Number.isFinite(maxMessages) || maxMessages <= 0) {
    return {
      messages: [],
      messagesFetched: 0,
      currentInboundExcluded: Boolean(params.currentMessageTs),
      emptyMessagesOmitted: 0,
      messagesOmittedByLimit: 0,
      threadRootFetched: false,
      historyComplete: true,
    };
  }

  // Slack recommends no more than 200 per page.
  const fetchLimit = 200;
  const retained: SlackRepliesPageMessage[] = [];
  let messagesFetched = 0;
  let eligibleMessages = 0;
  let emptyMessagesOmitted = 0;
  let threadRootFetched = false;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const buildResult = (historyComplete: boolean): SlackThreadHistoryResult => ({
    messages: retained
      .map((message) => normalizeSlackThreadMessage(message))
      .filter((message): message is SlackThreadMessage => message !== null),
    messagesFetched,
    currentInboundExcluded: Boolean(params.currentMessageTs),
    emptyMessagesOmitted,
    messagesOmittedByLimit: Math.max(0, eligibleMessages - retained.length),
    threadRootFetched,
    historyComplete,
  });

  try {
    do {
      const response = (await params.client.conversations.replies({
        channel: params.channelId,
        ts: params.threadTs,
        limit: fetchLimit,
        inclusive: true,
        ...(cursor ? { cursor } : {}),
      })) as SlackRepliesPage;

      for (const msg of response.messages ?? []) {
        const text = resolveSlackMessageText(msg);
        if (params.currentMessageTs && msg.ts === params.currentMessageTs) {
          continue;
        }
        messagesFetched += 1;
        if (msg.ts === params.threadTs) {
          threadRootFetched = true;
        }
        // Keep messages with text, Slack attachment/block fallback text, or file attachments.
        if (!text && !msg.files?.length && msg.subtype !== "message_deleted") {
          emptyMessagesOmitted += 1;
          continue;
        }
        eligibleMessages += 1;
        retained.push(msg);
      }
      if (retained.length > maxMessages) {
        retained.splice(0, retained.length - maxMessages);
      }

      const next = response.response_metadata?.next_cursor;
      cursor = typeof next === "string" && next.trim().length > 0 ? next.trim() : undefined;
      if (cursor && seenCursors.has(cursor)) {
        throw new Error(`Slack returned a repeated thread-history cursor: ${cursor}`);
      }
      if (cursor) {
        seenCursors.add(cursor);
      }
    } while (cursor);

    return buildResult(true);
  } catch (err) {
    logVerbose(
      `slack thread history fetch failed channel=${params.channelId} ts=${params.threadTs}: ${formatErrorMessage(err)}`,
    );
    // Keep successfully fetched pages but mark them incomplete. Returning no
    // history here would hide valid Slack evidence just because a later cursor
    // failed, while claiming completeness would make the partial set misleading.
    return buildResult(false);
  }
}
