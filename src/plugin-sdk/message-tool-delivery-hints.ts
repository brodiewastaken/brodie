export const MESSAGE_TOOL_ONLY_DELIVERY_HINT =
  "Delivery: Final assistant text is not automatically delivered in this run. Use message(action=reply) for visible output to the current conversation; normal final text stays private. Do not emit visible progress narration between tool calls.";

const ROOM_EVENT_DELIVERY_HINT =
  "Delivery: No visible reply is delivered automatically in this run, and none is expected by default. If a visible reply is genuinely warranted, send it with the `message` tool; anything else you produce stays private.";

export const LEGACY_MESSAGE_TOOL_DELIVERY_HINTS = [
  "Delivery: to send a message, use the `message` tool.",
  "Delivery: Final assistant text is not automatically delivered in this run. Use the `message` tool to send user-visible output.",
  MESSAGE_TOOL_ONLY_DELIVERY_HINT,
  ROOM_EVENT_DELIVERY_HINT,
] as const;

export const MESSAGE_TOOL_DELIVERY_HINTS = [...LEGACY_MESSAGE_TOOL_DELIVERY_HINTS] as const;
