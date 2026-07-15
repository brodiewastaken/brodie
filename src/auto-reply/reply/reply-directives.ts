/** Parses inline reply directives such as media, reply targets, audio, and silence. */
import { splitMediaFromOutput } from "../../media/parse.js";

/** Parsed outbound reply directives and media extracted from model text. */
export type ReplyDirectiveParseResult = {
  text: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  reaction?: {
    emoji: string;
    replyToCurrent?: boolean;
    replyToId?: string;
  };
  replyToId?: string;
  replyToCurrent?: boolean;
  replyToTag: boolean;
  audioAsVoice?: boolean;
  isSilent: boolean;
};

/** Options for extracting reply directives from model text. */
type ReplyDirectiveParseOptions = {
  currentMessageId?: string;
  silentToken?: string;
  extractMarkdownImages?: boolean;
  extractMediaDirectives?: boolean;
};

export function mergeReactionDirectiveChannelData(
  channelData: Record<string, unknown> | undefined,
  reaction: ReplyDirectiveParseResult["reaction"] | undefined,
): Record<string, unknown> | undefined {
  if (!reaction) {
    return channelData;
  }
  const telegramData =
    channelData?.telegram &&
    typeof channelData.telegram === "object" &&
    !Array.isArray(channelData.telegram)
      ? (channelData.telegram as Record<string, unknown>)
      : {};
  if ("reaction" in telegramData) {
    return channelData;
  }
  return {
    ...channelData,
    telegram: { ...telegramData, reaction },
  };
}

/** Parses media, reply-target, audio, and silent directives from reply text. */
export function parseReplyDirectives(
  raw: string,
  options: ReplyDirectiveParseOptions = {},
): ReplyDirectiveParseResult {
  const split = splitMediaFromOutput(raw, {
    extractMarkdownImages: options.extractMarkdownImages,
    extractMediaDirectives: options.extractMediaDirectives,
  });
  const text = split.text ?? "";

  return {
    text,
    mediaUrls: split.mediaUrls,
    mediaUrl: split.mediaUrl,
    reaction: undefined,
    replyToId: undefined,
    replyToCurrent: undefined,
    replyToTag: false,
    audioAsVoice: split.audioAsVoice,
    isSilent: false,
  };
}
