// Message-tool delivery tests cover message_tool_only delivery, where a
// successful source message send records source reply evidence without ending
// the run before the model can observe the tool result.
import type { Agent, AfterToolCallContext } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import {
  installMessageToolOnlyTerminalHook,
  isDeliveredMessageToolOnlySourceReply,
  resolveAttemptMessageToolDeliveryState,
  resolveAttemptMessageToolSourceReplyDeliveryState,
} from "./message-tool-terminal.js";

describe("message-tool-only source replies", () => {
  it("marks successful message-tool-only sends as delivered source replies", () => {
    // Direct send evidence can come from the tool result or hook result; either
    // path means the source reply was delivered and no automatic reply is needed.
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
        }),
      }),
    ).toBe(true);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
          result: createDirectSendResult({ messageId: "discord-message-1" }),
        }),
      }),
    ).toBe(true);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
          result: createSuppressedSendResult(),
        }),
        hookResult: { details: { result: { messageId: "discord-message-2" } } },
      }),
    ).toBe(true);
  });

  it("ignores automatic delivery, non-send actions, explicit routes, or failed sends", () => {
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "automatic",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
        }),
      }),
    ).toBe(false);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "reaction", emoji: "thumbsup" },
        }),
      }),
    ).toBe(false);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", target: "channel:other", message: "cross-channel" },
        }),
      }),
    ).toBe(false);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "sessions_send",
          args: { message: "internal delegation" },
        }),
      }),
    ).toBe(false);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "failed reply" },
          isError: true,
        }),
      }),
    ).toBe(false);
  });

  it("ignores dry-run or non-delivered sends", () => {
    // Dry runs and suppressed sends are observable tool activity, not delivered
    // replies, so they cannot close the turn.
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "preview reply", dryRun: true },
        }),
      }),
    ).toBe(false);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "preview reply" },
          result: {
            content: [{ type: "text", text: '{"ok":true}' }],
            details: {
              payload: {
                deliveryStatus: "dry_run",
                dryRun: true,
              },
            },
          },
        }),
      }),
    ).toBe(false);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "preview reply" },
        }),
        hookResult: { details: { deliveryStatus: "dry_run" } },
      }),
    ).toBe(false);
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "preview reply" },
          result: {
            content: [{ type: "text", text: '{"deliveryStatus":"dry_run","dryRun":true}' }],
            details: { ok: true },
          },
        }),
      }),
    ).toBe(false);
  });

  it("ignores suppressed sends without delivery evidence", () => {
    expect(
      isDeliveredMessageToolOnlySourceReply({
        sourceReplyDeliveryMode: "message_tool_only",
        context: createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "suppressed reply" },
          result: createSuppressedSendResult(),
        }),
      }),
    ).toBe(false);
  });

  it("preserves existing after-tool-call output while recording delivered source replies", async () => {
    const previousAfterToolCall = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "rewritten" }],
      details: { rewritten: true },
    }));
    const agent = { afterToolCall: previousAfterToolCall } as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "visible reply" },
        }),
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "rewritten" }],
      details: { rewritten: true },
    });
    expect(previousAfterToolCall).toHaveBeenCalledTimes(1);
    expect(onDeliveredSourceReply).toHaveBeenCalledWith("terminal");
  });

  it("records provisional delivery evidence for endTurn=false sends", async () => {
    const agent = {} as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "one sec", endTurn: false },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(onDeliveredSourceReply).toHaveBeenCalledWith("provisional");
  });

  it("records provisional source reply evidence for endTurn=false reply actions", async () => {
    const agent = {} as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });

    const context = createAfterToolCallContext({
      toolName: "message",
      args: { action: "reply", message: "one sec", endTurn: false },
    });
    context.args = {
      provider: "whatsapp",
      to: "source-chat",
      text: "one sec",
    };

    await expect(agent.afterToolCall?.(context)).resolves.toBeUndefined();
    expect(onDeliveredSourceReply).toHaveBeenCalledWith("provisional");
  });

  it("records terminal delivery evidence for endTurn=true sends", async () => {
    const agent = {} as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });

    await agent.afterToolCall?.(
      createAfterToolCallContext({
        toolName: "message",
        args: { action: "send", message: "done", endTurn: true },
      }),
    );

    expect(onDeliveredSourceReply).toHaveBeenCalledWith("terminal");
  });

  it("leaves existing after-tool-call output alone when the send failed", async () => {
    const previousAfterToolCall = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "failed" }],
      details: { ok: false },
      isError: true,
    }));
    const agent = { afterToolCall: previousAfterToolCall } as unknown as Agent;
    const onDeliveredSourceReply = vi.fn();
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "message_tool_only",
      onDeliveredSourceReply,
    });

    await expect(
      agent.afterToolCall?.(
        createAfterToolCallContext({
          toolName: "message",
          args: { action: "send", message: "failed reply" },
        }),
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "failed" }],
      details: { ok: false },
      isError: true,
    });
    expect(previousAfterToolCall).toHaveBeenCalledTimes(1);
    expect(onDeliveredSourceReply).not.toHaveBeenCalled();
  });

  it("preserves original endTurn controls when execution args omit them", async () => {
    const previousAfterToolCall = vi.fn(async () => ({
      details: { untouched: true },
    }));
    const agent = { afterToolCall: previousAfterToolCall } as unknown as Agent;
    const onDeliveredMessageTool = vi.fn();
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "automatic",
      onDeliveredMessageTool,
    });

    const context = createAfterToolCallContext({
      toolName: "message",
      args: {
        action: "send",
        channel: "discord",
        target: "channel:brodie-only",
        message: "one sec",
        endTurn: false,
      },
    });
    context.args = {
      provider: "discord",
      to: "channel:brodie-only",
      text: "one sec",
    };
    context.result = {
      content: [{ type: "text", text: '{"ok":true}' }],
      details: { ok: true },
    };

    await agent.afterToolCall?.(context);

    expect(previousAfterToolCall).toHaveBeenCalledTimes(1);
    expect(onDeliveredMessageTool).toHaveBeenCalledWith("provisional");
  });

  it("uses delivery metadata when both authored and execution args omit endTurn", async () => {
    const agent = {} as unknown as Agent;
    const onDeliveredMessageTool = vi.fn();
    installMessageToolOnlyTerminalHook({
      agent,
      sourceReplyDeliveryMode: "automatic",
      onDeliveredMessageTool,
    });

    const context = createAfterToolCallContext({
      toolName: "message",
      args: {
        provider: "discord",
        to: "channel:brodie-only",
        text: "one sec",
      },
      result: {
        content: [{ type: "text", text: '{"status":"sent"}' }],
        details: {
          status: "sent",
          messageToolDeliveryState: "provisional",
        },
      },
    });

    await agent.afterToolCall?.(context);

    expect(onDeliveredMessageTool).toHaveBeenCalledWith("provisional");
  });

  it("recovers a provisional send from the current-attempt tool result", () => {
    expect(
      resolveAttemptMessageToolDeliveryState({
        messages: [
          { role: "toolResult", details: { messageToolDeliveryState: "terminal" } },
          { role: "user", content: "current turn" },
          {
            role: "toolResult",
            details: {
              status: "sent",
              messageToolDeliveryState: "provisional",
            },
          },
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "provider failed after provisional delivery",
            content: [],
          },
        ],
        prePromptMessageCount: 1,
      }),
    ).toBe("provisional");
  });

  it("recovers a provisional send from propagated target evidence", () => {
    expect(
      resolveAttemptMessageToolDeliveryState({
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "discord",
            to: "channel:brodie-only",
            messageToolDeliveryState: "provisional",
          },
        ],
        messages: [],
        prePromptMessageCount: 0,
      }),
    ).toBe("provisional");
  });

  it("recovers a normalized provisional send to the canonical conversation source", () => {
    expect(
      resolveAttemptMessageToolSourceReplyDeliveryState({
        sourceReplyDeliveryMode: "message_tool_only",
        sessionKey: "agent:main:conversation:whatsapp:brodie:group:120363424071859049@g.us",
        messagingToolSentTargets: [
          {
            provider: "whatsapp",
            to: "120363424071859049@g.us",
            messageToolDeliveryState: "provisional",
          },
        ],
      }),
    ).toBe("provisional");
  });

  it("recovers an exact source delivery when automatic delivery owns the turn", () => {
    expect(
      resolveAttemptMessageToolSourceReplyDeliveryState({
        sourceReplyDeliveryMode: "automatic",
        sessionKey: "agent:main:conversation:whatsapp:brodie:group:120363424071859049@g.us",
        messagingToolSentTargets: [
          {
            provider: "whatsapp",
            to: "120363424071859049@g.us",
            messageToolDeliveryState: "provisional",
          },
        ],
      }),
    ).toBe("provisional");
  });

  it("recovers from the inbound route when the attempt session key is not canonical", () => {
    expect(
      resolveAttemptMessageToolSourceReplyDeliveryState({
        messageChannel: "whatsapp",
        messageTo: "120363424071859049@g.us",
        sessionKey: "e17fd21f-48b1-4eab-8127-f7d7602091c0",
        messagingToolSentTargets: [
          {
            provider: "whatsapp",
            to: "120363424071859049@g.us",
            messageToolDeliveryState: "provisional",
          },
        ],
      }),
    ).toBe("provisional");
  });

  it("does not treat a normalized send to another route as a source reply", () => {
    expect(
      resolveAttemptMessageToolSourceReplyDeliveryState({
        sourceReplyDeliveryMode: "message_tool_only",
        sessionKey: "agent:main:conversation:whatsapp:brodie:group:120363424071859049@g.us",
        messagingToolSentTargets: [
          {
            provider: "whatsapp",
            to: "120363424071859050@g.us",
            messageToolDeliveryState: "provisional",
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("recovers a provisional send from the current transcript branch when the context snapshot omits it", () => {
    expect(
      resolveAttemptMessageToolDeliveryState({
        messages: [{ role: "user", content: "assembled prompt only" }],
        prePromptMessageCount: 1,
        transcriptEntries: [
          {
            type: "message",
            message: {
              role: "toolResult",
              details: { messageToolDeliveryState: "terminal" },
            },
          },
          { type: "message", message: { role: "user", content: "current turn" } },
          {
            type: "message",
            message: {
              role: "toolResult",
              details: {
                status: "sent",
                messageToolDeliveryState: "provisional",
              },
            },
          },
          {
            type: "message",
            message: {
              role: "assistant",
              stopReason: "error",
              content: [],
            },
          },
        ],
      }),
    ).toBe("provisional");
  });
});

function createAfterToolCallContext(params: {
  toolName: string;
  args: Record<string, unknown>;
  isError?: boolean;
  result?: AfterToolCallContext["result"];
}): AfterToolCallContext {
  return {
    assistantMessage: createToolCallAssistant(params.toolName, params.args),
    toolCall: {
      type: "toolCall",
      id: "call_message",
      name: params.toolName,
      arguments: params.args,
    },
    args: params.args,
    result: params.result ?? {
      content: [
        {
          type: "text",
          text: '{"status":"ok","deliveryStatus":"sent","sourceReplySink":"internal-ui"}',
        },
      ],
      details: {
        status: "ok",
        deliveryStatus: "sent",
        sourceReplySink: "internal-ui",
        sourceReply: { text: params.args.message },
      },
    },
    isError: params.isError ?? false,
    context: {
      systemPrompt: "",
      messages: [],
      tools: [],
    },
  };
}

function createDirectSendResult(params: { messageId: string }): AfterToolCallContext["result"] {
  // A nested message id is the durable delivery proof used by the terminal
  // decision helper when the channel adapter wraps its result.
  const payload = {
    channel: "discord",
    to: "channel:source",
    via: "direct",
    mediaUrl: null,
    result: {
      channel: "discord",
      messageId: params.messageId,
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}

function createSuppressedSendResult(): AfterToolCallContext["result"] {
  // Same channel shape without message id: useful to prove suppression is not
  // mistaken for delivery.
  const payload = {
    channel: "discord",
    to: "channel:source",
    via: "direct",
    mediaUrl: null,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}

function createToolCallAssistant(
  toolName: string,
  args: Record<string, unknown>,
): AfterToolCallContext["assistantMessage"] {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_message",
        name: toolName,
        arguments: args,
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
}
