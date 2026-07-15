import type { ResponseInput } from "openai/resources/responses/responses.js";

const HUMAN_INBOUND_QUEUE_HEADER = "[📋 QUEUE ENGINE]:";

type ResponseInputUserMessage = {
  type?: "message";
  role: "user";
  content: Array<{ type: string; text?: string }>;
};

function asResponseInputUserMessage(
  item: ResponseInput[number] | undefined,
): ResponseInputUserMessage | undefined {
  if (
    !item ||
    !("role" in item) ||
    item.role !== "user" ||
    !("content" in item) ||
    !Array.isArray(item.content)
  ) {
    return undefined;
  }
  return item as ResponseInputUserMessage;
}

function responseInputTextParts(message: ResponseInputUserMessage): string[] {
  return message.content.flatMap((part) =>
    part.type === "input_text" && typeof part.text === "string" ? [part.text] : [],
  );
}

function normalizeResponseInputSidecarText(text: string): string {
  return text.replace(/[0-9a-f]{16,}/gi, "<media-id>");
}

/**
 * AgentSession can serialize a persisted image-bearing queue turn and its
 * ephemeral text-only prompt copy as adjacent final input messages. Collapse
 * only that exact shape at the final provider request-body boundary.
 */
export function collapseDuplicateHumanInboundResponseInput(messages: ResponseInput): ResponseInput {
  if (messages.length < 2) {
    return messages;
  }
  const canonical = asResponseInputUserMessage(messages.at(-2));
  const duplicate = asResponseInputUserMessage(messages.at(-1));
  if (
    !canonical ||
    !duplicate ||
    !canonical.content.some((part) => part.type === "input_image") ||
    duplicate.content.length === 0 ||
    !duplicate.content.every((part) => part.type === "input_text")
  ) {
    return messages;
  }
  const canonicalTextParts = responseInputTextParts(canonical);
  const duplicateTextParts = responseInputTextParts(duplicate);
  if (
    canonicalTextParts.length === 0 ||
    canonicalTextParts.length !== duplicateTextParts.length ||
    !canonicalTextParts[0]?.startsWith(HUMAN_INBOUND_QUEUE_HEADER) ||
    canonicalTextParts[0] !== duplicateTextParts[0] ||
    !canonicalTextParts
      .slice(1)
      .every(
        (text, index) =>
          normalizeResponseInputSidecarText(text) ===
          normalizeResponseInputSidecarText(duplicateTextParts[index + 1] ?? ""),
      )
  ) {
    return messages;
  }
  return messages.slice(0, -1);
}
