// Discord plugin module implements message handler.preflight history behavior.
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { resolveTimestampMs } from "./format.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";

export function buildDiscordPreflightHistoryEntry(params: {
  isGuildMessage: boolean;
  historyLimit: number;
  message: DiscordMessagePreflightContext["message"];
  messageText: string;
  senderLabel: string;
}): HistoryEntry | undefined {
  const textForHistory = params.messageText;
  return params.isGuildMessage && params.historyLimit > 0 && textForHistory
    ? {
        sender: params.senderLabel,
        body: textForHistory,
        timestamp: resolveTimestampMs(params.message.timestamp),
        messageId: params.message.id,
      }
    : undefined;
}
