import { jsonUtf8Bytes } from "../infra/json-utf8-bytes.js";

export const BOUNDED_CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES = 128 * 1024;

const BOUNDED_HISTORY_OVERSIZED_PLACEHOLDER = "[history item omitted: payload too large]";
const BOUNDED_HISTORY_UNAVAILABLE_SENTINEL =
  "[history unavailable: payload exceeds this client's transport budget]";

function buildBoundedHistoryPlaceholder(message?: unknown): Record<string, unknown> {
  const record =
    message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>)
      : undefined;
  const metadataRecord =
    record?.["__openclaw"] &&
    typeof record["__openclaw"] === "object" &&
    !Array.isArray(record["__openclaw"])
      ? (record["__openclaw"] as Record<string, unknown>)
      : undefined;
  return {
    role: typeof record?.role === "string" ? record.role : "assistant",
    timestamp: typeof record?.timestamp === "number" ? record.timestamp : Date.now(),
    content: [{ type: "text", text: BOUNDED_HISTORY_OVERSIZED_PLACEHOLDER }],
    __openclaw: {
      ...(typeof metadataRecord?.id === "string" ? { id: metadataRecord.id } : {}),
      ...(typeof metadataRecord?.seq === "number" ? { seq: metadataRecord.seq } : {}),
      ...(typeof metadataRecord?.idempotencyKey === "string"
        ? { idempotencyKey: metadataRecord.idempotencyKey }
        : {}),
      truncated: true,
      reason: "oversized",
    },
  };
}

function buildBoundedHistoryUnavailableSentinel(): Record<string, unknown> {
  return {
    role: "assistant",
    timestamp: Date.now(),
    content: [{ type: "text", text: BOUNDED_HISTORY_UNAVAILABLE_SENTINEL }],
  };
}

/** Applies per-item limits for non-Control clients with bounded RPC payloads. */
export function replaceOversizedBoundedChatHistoryMessages(params: {
  messages: unknown[];
  maxSingleMessageBytes: number;
}): { messages: unknown[]; replacedCount: number } {
  let replacedCount = 0;
  const messages = params.messages.map((message) => {
    if (jsonUtf8Bytes(message) <= params.maxSingleMessageBytes) {
      return message;
    }
    replacedCount += 1;
    return buildBoundedHistoryPlaceholder(message);
  });
  return { messages: replacedCount > 0 ? messages : params.messages, replacedCount };
}

/** Enforces an aggregate transport budget for non-Control history clients. */
export function enforceBoundedChatHistoryBudget(params: {
  messages: unknown[];
  maxBytes: number;
}): { messages: unknown[] } {
  if (params.messages.length === 0 || jsonUtf8Bytes(params.messages) <= params.maxBytes) {
    return { messages: params.messages };
  }
  const last = params.messages.at(-1);
  if (last && jsonUtf8Bytes([last]) <= params.maxBytes) {
    return { messages: [last] };
  }
  const placeholder = buildBoundedHistoryPlaceholder(last);
  if (jsonUtf8Bytes([placeholder]) <= params.maxBytes) {
    return { messages: [placeholder] };
  }
  return { messages: [buildBoundedHistoryUnavailableSentinel()] };
}
