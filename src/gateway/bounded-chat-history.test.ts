import { describe, expect, it } from "vitest";
import {
  enforceBoundedChatHistoryBudget,
  replaceOversizedBoundedChatHistoryMessages,
} from "./bounded-chat-history.js";

describe("bounded chat history", () => {
  it("leaves messages below the non-Control client budget unchanged", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];

    expect(
      replaceOversizedBoundedChatHistoryMessages({
        messages,
        maxSingleMessageBytes: 1024,
      }),
    ).toEqual({ messages, replacedCount: 0 });
  });

  it("preserves row identity when a bounded client cannot carry the full item", () => {
    const result = replaceOversizedBoundedChatHistoryMessages({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "x".repeat(2048) }],
          __openclaw: { id: "message-1", seq: 7, idempotencyKey: "event-1" },
        },
      ],
      maxSingleMessageBytes: 256,
    });

    expect(result.replacedCount).toBe(1);
    expect(result.messages[0]).toMatchObject({
      role: "user",
      __openclaw: {
        id: "message-1",
        seq: 7,
        idempotencyKey: "event-1",
        truncated: true,
        reason: "oversized",
      },
    });
    expect(JSON.stringify(result.messages)).not.toContain(
      "[chat.history omitted: message too large]",
    );
  });

  it("keeps the newest item when it fits the aggregate client budget", () => {
    const newest = { role: "assistant", content: [{ type: "text", text: "newest" }] };

    expect(
      enforceBoundedChatHistoryBudget({
        messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(2048) }] }, newest],
        maxBytes: 512,
      }),
    ).toEqual({ messages: [newest] });
  });
});
