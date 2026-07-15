// Converts streaming reply directives into payload delivery decisions.
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import type { ReplyDirectiveParseResult } from "./reply-directives.js";

type ConsumeOptions = {
  final?: boolean;
};

type SplitTrailingDirectiveOptions = {
  final?: boolean;
};

// Holds back incomplete inline directive tails so parseChunk only ever sees
// complete reply/audio tags.
export const splitTrailingDirective = (
  text: string,
  options: SplitTrailingDirectiveOptions = {},
): { text: string; tail: string } => {
  let bufferStart = text.length;
  let trimTextBeforeTail = false;

  // 1. Unclosed `[[…` reply/audio directive tail.
  const openIndex = text.lastIndexOf("[[");
  if (openIndex >= 0 && !text.includes("]]", openIndex + 2)) {
    if (openIndex < bufferStart) {
      bufferStart = openIndex;
      trimTextBeforeTail = true;
    }
  }
  if (text.endsWith("[") && text.length - 1 < bufferStart) {
    bufferStart = text.length - 1;
    trimTextBeforeTail = true;
  }

  if (options.final) {
    if (bufferStart >= text.length) {
      return { text, tail: "" };
    }

    return {
      text: text.slice(0, bufferStart),
      tail: text.slice(bufferStart),
    };
  }

  // Keep a possible final-reply MEDIA directive out of partial streaming
  // payloads. The final message parser still owns legacy MEDIA delivery.
  const lastNewline = text.lastIndexOf("\n");
  const lastLine = lastNewline < 0 ? text : text.slice(lastNewline + 1);
  if (/^\s*MEDIA:/i.test(lastLine)) {
    const mediaLineStart = lastNewline < 0 ? 0 : lastNewline + 1;
    if (mediaLineStart < bufferStart) {
      bufferStart = mediaLineStart;
    }
  }

  const prefixMatch = text.match(/(?:^|\n)(MEDIA|MEDI|MED|ME|M)$/i);
  if (prefixMatch) {
    const prefixStart = text.length - prefixMatch[1].length;
    if (prefixStart < bufferStart) {
      bufferStart = prefixStart;
    }
  }

  if (bufferStart >= text.length) {
    return { text, tail: "" };
  }

  return {
    text: trimTextBeforeTail ? text.slice(0, bufferStart).trimEnd() : text.slice(0, bufferStart),
    tail: text.slice(bufferStart),
  };
};

const parseChunk = (raw: string): ReplyDirectiveParseResult => {
  let text = raw ?? "";

  const replyParsed = parseInlineDirectives(text, {
    stripAudioTag: true,
    stripReplyTags: false,
  });

  if (replyParsed.hasAudioTag) {
    text = replyParsed.text;
  }

  return {
    text,
    replyToId: undefined,
    replyToCurrent: undefined,
    replyToTag: false,
    audioAsVoice: replyParsed.audioAsVoice,
    isSilent: false,
  };
};

const hasRenderableContent = (parsed: ReplyDirectiveParseResult): boolean =>
  hasOutboundReplyContent(parsed) || Boolean(parsed.audioAsVoice);

export function createStreamingDirectiveAccumulator() {
  let pendingTail = "";

  const reset = () => {
    pendingTail = "";
  };

  const consume = (raw: string, options: ConsumeOptions = {}): ReplyDirectiveParseResult | null => {
    let combined = `${pendingTail}${raw ?? ""}`;
    pendingTail = "";

    if (!options.final) {
      const split = splitTrailingDirective(combined);
      combined = split.text;
      pendingTail = split.tail;
    }

    if (!combined) {
      return null;
    }

    const parsed = parseChunk(combined);
    if (!hasRenderableContent(parsed)) {
      return null;
    }
    return parsed;
  };

  return {
    consume,
    reset,
  };
}
