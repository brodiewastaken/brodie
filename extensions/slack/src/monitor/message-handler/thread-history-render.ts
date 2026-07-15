// Slack plugin module renders initial thread history for the model.
import {
  formatEnvelopeTimestamp,
  type EnvelopeFormatOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import type { SlackFile } from "../../types.js";
import type { SlackMediaResult } from "../media-types.js";
import type { SlackThreadMessage } from "../thread.js";
import { resolveSlackTimestampMs } from "./timestamp.js";

type SlackThreadHistorySenderType = "human" | "assistant_self" | "bot";

type SlackThreadHistoryRenderMessage = {
  message: SlackThreadMessage;
  senderName: string;
  senderId?: string;
  senderType: SlackThreadHistorySenderType;
  media: Array<{
    file: SlackFile;
    resolved: SlackMediaResult | null;
    understanding?: {
      kind: "image.description" | "audio.transcription" | "video.description";
      provider?: string;
      model?: string;
      text: string;
    };
  }>;
};

type SlackThreadHistoryAccounting = {
  messagesFetched: number;
  emptyMessagesOmitted: number;
  messagesOmittedByLimit: number;
  messagesOmittedByVisibility: number;
  messagesOmittedAsDuplicateAssistant: number;
  threadRootRestored: boolean;
  threadRootFetched: boolean;
  currentInboundExcluded: boolean;
  historyComplete: boolean;
};

type SlackThreadHistoryCurrentInbound = {
  messageId?: string;
  senderName: string;
  senderId?: string;
  senderType: SlackThreadHistorySenderType;
};

function cleanRecord(entries: Array<[string, unknown]>): Record<string, unknown> {
  return Object.fromEntries(
    entries.filter(([, value]) => {
      if (value === undefined || value === null || value === "") {
        return false;
      }
      return !Array.isArray(value) || value.length > 0;
    }),
  );
}

function renderJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function renderTextFence(value: string): string {
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${value}\n${fence}`;
}

function sanitizeSectionLabel(value: string): string {
  return (
    value
      .replace(/\r\n|\r|\n/gu, " ")
      .replaceAll("[", "(")
      .replaceAll("]", ")")
      .replace(/\s+/gu, " ")
      .trim() || "Unknown"
  );
}

function formatSlackThreadTimestamp(
  slackTimestamp: string | undefined,
  options: EnvelopeFormatOptions,
): string | undefined {
  const timestampMs = resolveSlackTimestampMs(slackTimestamp);
  return timestampMs === undefined ? undefined : formatEnvelopeTimestamp(timestampMs, options);
}

function humanSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return undefined;
  }
  if (bytes < 1_000) {
    return `${Math.floor(bytes)}B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = "B";
  for (const candidate of units) {
    value /= 1_000;
    unit = candidate;
    if (value < 1_000) {
      break;
    }
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}${unit}`;
}

function resolveMediaKind(contentType: string | undefined): "image" | "audio" | "video" | "file" {
  if (contentType?.startsWith("image/")) {
    return "image";
  }
  if (contentType?.startsWith("audio/")) {
    return "audio";
  }
  if (contentType?.startsWith("video/")) {
    return "video";
  }
  return "file";
}

function renderMediaMetadata(params: {
  sourceMessageId?: string;
  media: SlackThreadHistoryRenderMessage["media"];
}): Array<Record<string, unknown>> {
  return params.media.map(({ file, resolved }, index) =>
    cleanRecord([
      ["kind", resolveMediaKind(resolved?.contentType ?? file.mimetype)],
      ["type", resolved?.contentType ?? file.mimetype],
      ["size", humanSize(file.size)],
      ["source_message_id", params.sourceMessageId],
      ["source_index", index],
      ["media_reference", file.id],
      ["media_local_path", resolved?.path],
      ["media_path_source", resolved ? "openclaw_inbound_media" : undefined],
      ["media_path_verified", resolved ? true : undefined],
      ["file_name", file.name],
      ["download_status", resolved ? "available" : "unavailable"],
    ]),
  );
}

function senderMetadata(params: {
  senderName: string;
  senderId?: string;
  senderType: SlackThreadHistorySenderType;
}): Record<string, unknown> {
  return cleanRecord([
    ["sender", params.senderName],
    ["sender_id", params.senderId],
    ["sender_type", params.senderType],
  ]);
}

export function renderSlackThreadHistory(params: {
  teamId?: string;
  channelId: string;
  roomLabel: string;
  threadTs: string;
  historyLimit: number;
  currentInbound: SlackThreadHistoryCurrentInbound;
  messages: SlackThreadHistoryRenderMessage[];
  accounting: SlackThreadHistoryAccounting;
  botUserId: string;
  rootSenderId?: string;
  envelopeOptions: EnvelopeFormatOptions;
}): string {
  const media = params.messages.flatMap((entry) => entry.media);
  const availableMediaCount = media.filter((entry) => entry.resolved !== null).length;
  const participants = Array.from(
    new Map(
      params.messages.map((entry) => {
        const metadata = senderMetadata(entry);
        return [`${entry.senderType}:${entry.senderId ?? entry.senderName}`, metadata] as const;
      }),
    ).values(),
  );
  const messagesOmitted =
    params.accounting.emptyMessagesOmitted +
    params.accounting.messagesOmittedByLimit +
    params.accounting.messagesOmittedByVisibility +
    params.accounting.messagesOmittedAsDuplicateAssistant;
  const firstMessage = params.messages[0]?.message;
  const lastMessage = params.messages.at(-1)?.message;
  const lines = [
    "[🧵 THREAD HISTORY]: [THE FOLLOWING PRIOR MESSAGES WERE LOADED FROM SLACK]",
    "",
    "[Thread Metadata]:",
    renderJson(
      cleanRecord([
        ["channel", "slack"],
        ["conversation_type", "thread"],
        ["conversation_label", params.roomLabel],
        ["workspace_id", params.teamId],
        ["channel_id", params.channelId],
        ["thread_id", params.threadTs],
        ["history_source", "conversations.replies"],
        ["message_order", "oldest_to_newest"],
        ["messages_fetched", params.accounting.messagesFetched],
        ["messages_included", params.messages.length],
        ["messages_omitted", messagesOmitted],
        ["messages_omitted_empty", params.accounting.emptyMessagesOmitted],
        ["messages_omitted_by_limit", params.accounting.messagesOmittedByLimit],
        ["messages_omitted_by_visibility", params.accounting.messagesOmittedByVisibility],
        [
          "messages_omitted_as_duplicate_assistant",
          params.accounting.messagesOmittedAsDuplicateAssistant,
        ],
        ["history_complete", params.accounting.historyComplete],
        ["history_limit", params.historyLimit],
        ["thread_root_restored", params.accounting.threadRootRestored],
        ["thread_root_fetched", params.accounting.threadRootFetched],
        ["current_inbound_message_id", params.currentInbound.messageId],
        ["current_inbound_excluded", params.accounting.currentInboundExcluded],
        ["current_inbound_sender", senderMetadata(params.currentInbound)],
        ["oldest_included_message_id", firstMessage?.ts],
        ["newest_included_message_id", lastMessage?.ts],
        ["participants", participants],
        [
          "media",
          {
            files: media.length,
            available_locally: availableMediaCount,
            unavailable_locally: media.length - availableMediaCount,
          },
        ],
      ]),
    ),
  ];
  let understandingIndex = 0;

  for (const [index, entry] of params.messages.entries()) {
    const { message } = entry;
    const isRoot = message.ts === params.threadTs;
    const reactions = (message.reactions ?? [])
      .toSorted((left, right) => {
        const nameOrder = (left.name ?? "").localeCompare(right.name ?? "");
        return nameOrder !== 0 ? nameOrder : (left.count ?? 0) - (right.count ?? 0);
      })
      .map((reaction) =>
        cleanRecord([
          ["name", reaction.name],
          ["count", reaction.count],
        ]),
      )
      .filter((reaction) => Object.keys(reaction).length > 0);
    lines.push(
      "",
      `[Historical Message #${index + 1}]: [${sanitizeSectionLabel(entry.senderName)}]`,
    );
    if (entry.senderType === "assistant_self") {
      lines.push("[ASSISTANT SELF]");
    } else if (entry.senderType === "bot") {
      lines.push("[BOT MESSAGE]");
    }
    lines.push(
      "",
      "Message Metadata:",
      renderJson(
        cleanRecord([
          ["sender", entry.senderName],
          ["sender_id", entry.senderId],
          ["sender_type", entry.senderType],
          ["bot_id", message.botId],
          ["message_id", message.ts],
          ["timestamp", formatSlackThreadTimestamp(message.ts, params.envelopeOptions)],
          ["position", index + 1],
          ["is_thread_root", isRoot || undefined],
          ["thread_root_id", isRoot ? undefined : params.threadTs],
          ["parent_sender_id", isRoot ? undefined : (message.parentUserId ?? params.rootSenderId)],
          ["message_subtype", message.subtype],
          [
            "mentioned_assistant",
            message.sourceText?.includes(`<@${params.botUserId}>`) || undefined,
          ],
          ["reply_count", message.replyCount],
          ["edited_at", formatSlackThreadTimestamp(message.edited?.ts, params.envelopeOptions)],
          ["edited_by_sender_id", message.edited?.userId],
          ["event_type", message.subtype === "message_deleted" ? "deleted" : undefined],
          ["reactions", reactions],
          ["has_media", entry.media.length > 0 || undefined],
        ]),
      ),
    );
    if (!message.sourceText && message.files?.length && message.subtype !== "message_deleted") {
      lines.push("Message Body: [EMPTY]");
    } else {
      lines.push(
        "Message Body:",
        renderTextFence(
          message.subtype === "message_deleted"
            ? "[message was deleted]"
            : (message.sourceText ?? message.text),
        ),
      );
    }
    if (entry.media.length > 0) {
      lines.push(
        "Message Media:",
        renderJson(
          renderMediaMetadata({
            sourceMessageId: message.ts,
            media: entry.media,
          }),
        ),
      );
      for (const [mediaIndex, mediaEntry] of entry.media.entries()) {
        const understanding = mediaEntry.understanding;
        if (!understanding) {
          continue;
        }
        understandingIndex += 1;
        lines.push(
          `Media Understanding #${understandingIndex} (DERIVED, UNTRUSTED):`,
          renderJson(
            cleanRecord([
              ["kind", understanding.kind],
              ["source_message_id", message.ts],
              ["source_index", mediaIndex],
              ["provider", understanding.provider],
              ["model", understanding.model],
              ["trust", "derived_untrusted"],
            ]),
          ),
          "Derived Output:",
          renderTextFence(understanding.text),
        );
      }
    }
  }

  lines.push(
    "",
    "[Thread History End]:",
    renderJson(
      cleanRecord([
        ["last_included_message_id", lastMessage?.ts],
        ["current_inbound_message_id", params.currentInbound.messageId],
        ["current_inbound_follows", true],
      ]),
    ),
  );
  return lines.join("\n");
}
