import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
  createConversationalAction,
  resolveConversationalOutcome,
  type ConversationalActionContext,
  type ConversationalDispatchResult,
} from "./conversational-action.js";

const messageFields = new Set(["media", "presentation"]);

function context(
  dispatch: ConversationalActionContext["dispatch"] = async (input) => ({
    ok: true,
    bubbles: [
      {
        channel: String(input.params.channel),
        target: String(input.params.target),
        messageId: `message-${input.authoredIndex}`,
      },
    ],
  }),
): ConversationalActionContext {
  return {
    currentReplyTarget: {
      channel: "discord",
      target: "channel:room",
      messageId: "inbound",
      accountId: "primary",
    },
    allowedMessageFields: messageFields,
    allowedReactionFields: new Set(["participant"]),
    hasMessageContent: (params) => Boolean(params.media || params.presentation),
    validateQuote: async () => {},
    dispatch,
  };
}

describe("ConversationalAction", () => {
  it("builds four strict discriminated core schemas with only valid branch fields", () => {
    const schemas = createConversationalAction().buildSchemas({
      actions: new Set(["reply", "send", "react", "silence"]),
      sendFields: {
        message: Type.Optional(Type.String()),
        replyTo: Type.Optional(Type.String()),
        threadId: Type.Optional(Type.String()),
        media: Type.Optional(Type.String()),
      },
      reactionFields: { participant: Type.Optional(Type.String()) },
      channelTargetSchema: Type.String(),
    }) as Array<{
      additionalProperties?: boolean;
      properties: Record<string, unknown>;
    }>;
    expect(schemas).toHaveLength(4);
    expect(schemas.every((schema) => schema.additionalProperties === false)).toBe(true);
    const [reply, send, react, silence] = schemas;
    expect(Object.keys(reply?.properties ?? {})).toEqual([
      "action",
      "invisibleThinking",
      "visibleMessages",
      "endTurn",
      "quoteReply",
      "media",
    ]);
    expect(Object.keys(send?.properties ?? {})).toEqual([
      "action",
      "channel",
      "target",
      "accountId",
      "invisibleThinking",
      "visibleMessages",
      "endTurn",
      "quoteReply",
      "media",
    ]);
    expect(Object.keys(react?.properties ?? {})).not.toContain("quoteReply");
    expect(Object.keys(react?.properties ?? {})).toContain("participant");
    expect(Object.keys(silence?.properties ?? {})).toEqual(["action", "invisibleThinking"]);
  });

  it("requires private invisible thinking on every core action", async () => {
    await expect(
      createConversationalAction().execute(
        { action: "reply", visibleMessages: ["hello"], endTurn: true },
        context(),
      ),
    ).rejects.toThrow("invisibleThinking");
  });

  it("rejects invalid union fields and every legacy quote field", async () => {
    const action = createConversationalAction();
    await expect(
      action.execute(
        {
          action: "reply",
          invisibleThinking: "private",
          visibleMessages: ["hello"],
          endTurn: true,
          channel: "discord",
        },
        context(),
      ),
    ).rejects.toThrow("reply does not accept channel");
    await expect(
      action.execute(
        {
          action: "send",
          invisibleThinking: "private",
          visibleMessages: ["hello"],
          endTurn: true,
          channel: "discord",
          target: "channel:room",
          replyTo: "legacy",
        },
        context(),
      ),
    ).rejects.toThrow("replyTo is retired");
  });

  it("requires authoritative reply context and complete reaction routing", async () => {
    const action = createConversationalAction();
    await expect(
      action.execute(
        {
          action: "reply",
          invisibleThinking: "private",
          visibleMessages: ["hello"],
          endTurn: true,
        },
        { ...context(), currentReplyTarget: undefined },
      ),
    ).rejects.toThrow("authoritative inbound context");
    await expect(
      action.execute(
        {
          action: "react",
          invisibleThinking: "private",
          visibleReaction: "👍",
          endTurn: true,
          channel: "discord",
        },
        context(),
      ),
    ).rejects.toThrow("react target");
  });

  it("replies through the bound route without a current inbound message id", async () => {
    const dispatch = vi.fn<ConversationalActionContext["dispatch"]>(async () => ({
      ok: true,
      bubbles: [{ channel: "discord", target: "channel:room", messageId: "sent" }],
    }));

    await createConversationalAction().execute(
      {
        action: "reply",
        invisibleThinking: "announce the completed work",
        visibleMessages: ["the audits are done"],
        endTurn: true,
      },
      {
        ...context(dispatch),
        currentReplyTarget: {
          channel: "discord",
          target: "channel:room",
          accountId: "primary",
        },
      },
    );

    expect(dispatch).toHaveBeenCalledWith({
      action: "send",
      authoredIndex: 0,
      params: {
        action: "send",
        channel: "discord",
        target: "channel:room",
        accountId: "primary",
        message: "the audits are done",
      },
    });
  });

  it("rejects inbound-anchored actions when the bound route has no message id", async () => {
    const dispatch = vi.fn<ConversationalActionContext["dispatch"]>();
    const routeOnlyContext: ConversationalActionContext = {
      ...context(dispatch),
      currentReplyTarget: {
        channel: "whatsapp",
        target: "1234567890@g.us",
        accountId: "primary",
      },
    };

    await expect(
      createConversationalAction().execute(
        {
          action: "reply",
          invisibleThinking: "quote the inbound",
          visibleMessages: ["quoted reply"],
          quoteReply: "inbound",
          endTurn: true,
        },
        routeOnlyContext,
      ),
    ).rejects.toThrow("reply quoteReply requires a current inbound message id");

    await expect(
      createConversationalAction().execute(
        {
          action: "react",
          invisibleThinking: "react to the inbound",
          visibleReaction: "👍",
          participant: "123@lid",
          endTurn: true,
        },
        routeOnlyContext,
      ),
    ).rejects.toThrow("react requires a current inbound message id or an explicit messageId");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reacts to an older message in the current conversation without restating its route", async () => {
    const dispatch = vi.fn<ConversationalActionContext["dispatch"]>(async () => ({
      ok: true,
      bubbles: [],
    }));

    await createConversationalAction().execute(
      {
        action: "react",
        invisibleThinking: "older message",
        visibleReaction: "👍",
        endTurn: true,
        messageId: "older-message",
        participant: "123@lid",
      },
      context(dispatch),
    );

    expect(dispatch).toHaveBeenCalledWith({
      action: "react",
      authoredIndex: 0,
      params: {
        action: "react",
        channel: "discord",
        target: "channel:room",
        messageId: "older-message",
        accountId: "primary",
        emoji: "👍",
        participant: "123@lid",
      },
    });
  });

  it("leaves current-message identity implicit for native participant inference", async () => {
    const dispatch = vi.fn<ConversationalActionContext["dispatch"]>(async () => ({
      ok: true,
      bubbles: [],
    }));

    const result = await createConversationalAction().execute(
      {
        action: "react",
        invisibleThinking: "current message",
        visibleReaction: "👍",
        endTurn: true,
      },
      context(dispatch),
    );

    expect(dispatch.mock.calls[0]?.[0].params).not.toHaveProperty("messageId");
    expect(result.payload).toMatchObject({ messageId: "inbound" });
  });

  it("rejects blank and oversized authored arrays but permits media-only creation", async () => {
    const action = createConversationalAction();
    await expect(
      action.execute(
        {
          action: "send",
          invisibleThinking: "private",
          visibleMessages: ["   "],
          endTurn: true,
          channel: "discord",
          target: "channel:room",
        },
        context(),
      ),
    ).rejects.toThrow("must be non-blank");
    await expect(
      action.execute(
        {
          action: "send",
          invisibleThinking: "private",
          visibleMessages: Array.from({ length: 10 }, () => "bubble"),
          endTurn: true,
          channel: "discord",
          target: "channel:room",
        },
        context(),
      ),
    ).rejects.toThrow("at most 9");
    await expect(
      action.execute(
        {
          action: "send",
          invisibleThinking: "private",
          endTurn: true,
          channel: "discord",
          target: "channel:room",
          media: "file:///asset.png",
        },
        context(),
      ),
    ).resolves.toMatchObject({ payload: { status: "sent" }, outcome: "sent" });
  });

  it("delivers authored messages in order and quotes only the first platform bubble", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const result = await createConversationalAction().execute(
      {
        action: "reply",
        invisibleThinking: "private",
        visibleMessages: ["first", "second"],
        quoteReply: "quoted-message",
        endTurn: true,
        media: "file:///first.png",
      },
      context(async (input) => {
        seen.push(input.params);
        return {
          ok: true,
          bubbles: [
            { channel: "discord", target: "channel:room", messageId: `${input.authoredIndex}-a` },
            { channel: "discord", target: "channel:room", messageId: `${input.authoredIndex}-b` },
          ],
        };
      }),
    );
    expect(seen).toEqual([
      expect.objectContaining({
        message: "first",
        media: "file:///first.png",
        replyTo: "quoted-message",
      }),
      expect.objectContaining({ message: "second" }),
    ]);
    expect(seen[1]).not.toHaveProperty("media");
    expect(seen[1]).not.toHaveProperty("replyTo");
    expect(result).toMatchObject({
      terminate: true,
      payload: {
        status: "sent",
        authoredMessages: [
          { bubbles: [{ quoted: true }, { quoted: false }] },
          { bubbles: [{ quoted: false }, { quoted: false }] },
        ],
      },
    });
  });

  it("refuses to send a quote when authoritative quote validation is unavailable", async () => {
    const dispatch = vi.fn<ConversationalActionContext["dispatch"]>();

    await expect(
      createConversationalAction().execute(
        {
          action: "reply",
          invisibleThinking: "private",
          visibleMessages: ["quoted reply"],
          quoteReply: "quoted-message",
          endTurn: true,
        },
        { ...context(dispatch), validateQuote: undefined },
      ),
    ).rejects.toThrow("quote validation is unavailable");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("stops on first failure and preserves successful and partial receipts", async () => {
    const dispatch = vi.fn<ConversationalActionContext["dispatch"]>(async (input) => {
      if (input.authoredIndex === 0) {
        return {
          ok: true,
          bubbles: [{ channel: "discord", target: "room", messageId: "first" }],
        };
      }
      return {
        ok: false,
        bubbles: [{ channel: "discord", target: "room", messageId: "partial" }],
        error: "provider failed",
      };
    });
    const result = await createConversationalAction().execute(
      {
        action: "send",
        invisibleThinking: "private",
        visibleMessages: ["first", "second", "never"],
        channel: "discord",
        target: "room",
        endTurn: true,
      },
      context(dispatch),
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      terminate: false,
      payload: {
        status: "partial_failed",
        failure: { authoredIndex: 1, bubbleIndex: 1, message: "provider failed" },
      },
    });
  });

  it("records deliberate silence and successful terminal outcomes only", async () => {
    const recordOutcome = vi.fn();
    const silence = await createConversationalAction().execute(
      { action: "silence", invisibleThinking: "nothing useful to add" },
      { ...context(), recordOutcome },
    );
    expect(silence).toMatchObject({ terminate: true, outcome: "deliberate_silence" });
    expect(recordOutcome).toHaveBeenCalledWith("deliberate_silence");

    recordOutcome.mockClear();
    const provisional = await createConversationalAction().execute(
      {
        action: "send",
        invisibleThinking: "private",
        visibleMessages: ["one sec"],
        channel: "discord",
        target: "room",
        endTurn: false,
      },
      { ...context(), recordOutcome },
    );
    expect(provisional).toMatchObject({ terminate: false, outcome: "sent" });
    expect(recordOutcome).not.toHaveBeenCalled();

    const failed: ConversationalDispatchResult = { ok: false, bubbles: [], error: "nope" };
    const send = await createConversationalAction().execute(
      {
        action: "send",
        invisibleThinking: "private",
        visibleMessages: ["hello"],
        channel: "discord",
        target: "room",
        endTurn: true,
      },
      { ...context(async () => failed), recordOutcome },
    );
    expect(send.terminate).toBe(false);
    expect(recordOutcome).not.toHaveBeenCalled();
  });

  it("returns output-safety suppression before sending any bubble", async () => {
    const dispatch = vi.fn<ConversationalActionContext["dispatch"]>();
    const result = await createConversationalAction().execute(
      {
        action: "reply",
        invisibleThinking: "private",
        visibleMessages: ["unsafe"],
        endTurn: true,
      },
      {
        ...context(dispatch),
        sanitizeVisibleMessage: () => ({
          text: "",
          suppression: { reason: "internal_runtime_context_echo", message: "suppressed" },
        }),
      },
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toEqual({
      payload: {
        status: "suppressed",
        reason: "internal_runtime_context_echo",
        message: "suppressed",
      },
      terminate: false,
    });
  });

  it.each(["—", "–", "―", "⸺", "⸻"])(
    "rejects em dash family character %s before message or reaction delivery",
    async (dash) => {
      const dispatch = vi.fn<ConversationalActionContext["dispatch"]>();
      const action = createConversationalAction();
      const error =
        "visible message text contains an em dash family character (—). rewrite the sentence without it; do not substitute a spaced hyphen. this ban is physics, not style.";

      await expect(
        action.execute(
          {
            action: "reply",
            invisibleThinking: "private",
            visibleMessages: [`left${dash}right`],
            endTurn: true,
          },
          context(dispatch),
        ),
      ).rejects.toThrow(error);
      await expect(
        action.execute(
          {
            action: "react",
            invisibleThinking: "private",
            visibleReaction: `👍${dash}`,
            endTurn: true,
          },
          context(dispatch),
        ),
      ).rejects.toThrow(error);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("allows ordinary hyphens and keeps private thinking exempt from the dash filter", async () => {
    const dispatch = vi.fn<ConversationalActionContext["dispatch"]>(async () => ({
      ok: true,
      bubbles: [{ channel: "discord", target: "channel:room", messageId: "sent" }],
    }));

    await expect(
      createConversationalAction().execute(
        {
          action: "reply",
          invisibleThinking: "private — this never reaches chat",
          visibleMessages: ["plain - hyphenated-word"],
          endTurn: true,
        },
        context(dispatch),
      ),
    ).resolves.toMatchObject({ outcome: "sent" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("records implicit silence only for an otherwise unclassified natural provider stop", () => {
    expect(
      resolveConversationalOutcome({
        stopReason: "stop",
        aborted: false,
        timedOut: false,
        promptError: undefined,
      }),
    ).toBe("implicit_silence");
    expect(
      resolveConversationalOutcome({
        recorded: "sent",
        stopReason: "stop",
        aborted: false,
        timedOut: false,
        promptError: undefined,
      }),
    ).toBe("sent");
    for (const terminal of [
      { stopReason: "toolUse", aborted: false, timedOut: false, promptError: undefined },
      { stopReason: "stop", aborted: true, timedOut: false, promptError: undefined },
      { stopReason: "stop", aborted: false, timedOut: true, promptError: undefined },
      { stopReason: "stop", aborted: false, timedOut: false, promptError: new Error("failed") },
    ]) {
      expect(resolveConversationalOutcome(terminal)).toBeUndefined();
    }
  });
});
