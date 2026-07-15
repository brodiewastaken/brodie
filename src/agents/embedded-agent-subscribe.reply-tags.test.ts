// Reply-tag tests cover literal legacy reply_to markers across block replies
// and partial reply chunks.
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  createStubSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";

describe("subscribeEmbeddedAgentSession reply tags", () => {
  type ReplyPayload = { text?: string; replyToCurrent?: boolean; replyToTag?: boolean };

  function replyPayloadAt(mock: ReturnType<typeof vi.fn>, index: number): ReplyPayload {
    const call = mock.mock.calls[index];
    if (!call) {
      throw new Error(`expected reply payload at index ${index}`);
    }
    return call[0] as ReplyPayload;
  }

  function replyTexts(mock: ReturnType<typeof vi.fn>): string[] {
    return mock.mock.calls.map(([payload]) => (payload as ReplyPayload).text ?? "");
  }

  function lastReplyPayload(mock: ReturnType<typeof vi.fn>): ReplyPayload {
    return replyPayloadAt(mock, mock.mock.calls.length - 1);
  }

  function createBlockReplyHarness() {
    // Small chunk sizes force legacy directive text through the block reply path.
    const { session, emit } = createStubSessionHarness();
    const onBlockReply = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      onBlockReply,
      blockReplyBreak: "text_end",
      blockReplyChunking: {
        minChars: 1,
        maxChars: 50,
        breakPreference: "newline",
      },
    });

    return { emit, onBlockReply };
  }

  it("keeps reply_to_current literal across tag-only block chunks", () => {
    const { emit, onBlockReply } = createBlockReplyHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "[[reply_to_current]]\nHello" });
    emitAssistantTextEnd({ emit });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "[[reply_to_current]]\nHello" }],
    } as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(replyTexts(onBlockReply)).toEqual(["[[reply_to_current]]", "Hello"]);
    for (const [payload] of onBlockReply.mock.calls) {
      expect(payload.replyToCurrent).toBeUndefined();
      expect(payload.replyToTag).toBe(false);
    }
  });

  it("flushes trailing directive tails on stream end", () => {
    const { emit, onBlockReply } = createBlockReplyHarness();

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "Hello [[" });
    emitAssistantTextEnd({ emit });

    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello [[" }],
    } as AssistantMessage;
    emit({ type: "message_end", message: assistantMessage });

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(replyTexts(onBlockReply)).toEqual(["Hello", "[["]);
  });

  it("streams split legacy reply_to tags as literal text once complete", () => {
    // Split tags are buffered until complete, then emitted as ordinary text.
    const { session, emit } = createStubSessionHarness();

    const onPartialReply = vi.fn();

    subscribeEmbeddedAgentSession({
      session,
      runId: "run",
      onPartialReply,
    });

    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: "[[reply_to:1897" });
    emitAssistantTextDelta({ emit, delta: "]] Hello" });
    emitAssistantTextDelta({ emit, delta: " world" });
    emitAssistantTextEnd({ emit });

    expect(lastReplyPayload(onPartialReply).text).toBe("[[reply_to:1897]] Hello world");
  });
});
