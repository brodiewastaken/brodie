/**
 * Shared messaging-tool metadata types captured from embedded-agent runs.
 */
import type { ReplyPayload } from "../auto-reply/reply-payload.js";

export type MessageToolDeliveryState = "provisional" | "terminal";
export type MessageToolSourceReplyDeliveryState = MessageToolDeliveryState;

export function readMessageToolDeliveryState(value: unknown): MessageToolDeliveryState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct = record.messageToolDeliveryState;
  if (direct === "provisional" || direct === "terminal") {
    return direct;
  }
  if (!record.details || typeof record.details !== "object" || Array.isArray(record.details)) {
    return undefined;
  }
  const nested = (record.details as Record<string, unknown>).messageToolDeliveryState;
  return nested === "provisional" || nested === "terminal" ? nested : undefined;
}

export function mergeMessageToolDeliveryState(
  current: MessageToolDeliveryState | undefined,
  next: MessageToolDeliveryState,
): MessageToolDeliveryState {
  return current === "terminal" || next === "terminal" ? "terminal" : "provisional";
}

export function mergeMessageToolSourceReplyDeliveryState(
  current: MessageToolSourceReplyDeliveryState | undefined,
  next: MessageToolSourceReplyDeliveryState,
): MessageToolSourceReplyDeliveryState {
  return mergeMessageToolDeliveryState(current, next);
}

export type MessagingToolSend = {
  tool: string;
  provider: string;
  messageToolDeliveryState?: MessageToolDeliveryState;
  accountId?: string;
  to?: string;
  threadId?: string;
  threadImplicit?: boolean;
  threadSuppressed?: boolean;
  text?: string;
  mediaUrls?: string[];
  hasRichContent?: true;
};

export type MessagingToolSourceReplyPayload = Pick<
  ReplyPayload,
  | "audioAsVoice"
  | "channelData"
  | "interactive"
  | "mediaUrl"
  | "mediaUrls"
  | "presentation"
  | "text"
> & {
  idempotencyKey?: string;
};
