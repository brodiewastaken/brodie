import { describe, expect, it } from "vitest";
import {
  projectChatDisplayMessages,
  resolveEffectiveChatHistoryMaxChars,
} from "./chat-display-projection.js";

describe("chat display projection configuration", () => {
  it("uses request values before the gateway transcript defaults", () => {
    const cfg = { gateway: { controlUi: { transcript: { maxChars: 4321 } } } };
    expect(resolveEffectiveChatHistoryMaxChars(cfg)).toBe(4321);
    expect(resolveEffectiveChatHistoryMaxChars(cfg, 99)).toBe(99);
  });
});

describe("standard conversational action projection", () => {
  it("shows the authored reset command while preserving model-visible input for raw mode", () => {
    const reset = {
      role: "user",
      content: "[SESSION RESET START]\nexact model-visible reset input",
      openclawSourceMessage: { text: "brodie /new" },
      provenance: { kind: "external_user" },
    };

    expect(projectChatDisplayMessages([reset])).toEqual([
      {
        ...reset,
        content: "brodie /new",
      },
    ]);
  });

  it("shows only externally authored user input and never synthetic queue wrappers", () => {
    const projected = projectChatDisplayMessages([
      {
        role: "user",
        content: "[Queued messages while agent was busy]\n\nQueued #1\nhello brodie",
        openclawSourceMessage: { text: "hello brodie" },
        provenance: { kind: "external_user" },
        __openclaw: { queueBatchIdentity: { version: 1 } },
      },
      {
        role: "user",
        content: "[Queued messages while agent was busy] synthetic only",
        provenance: { kind: "external_user" },
        __openclaw: { queueBatchIdentity: { version: 1 } },
      },
      {
        role: "user",
        content: "internal restart sentinel",
        provenance: { kind: "internal_system" },
      },
      {
        role: "user",
        content: "inter-session handoff",
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      },
      {
        role: "user",
        content: "[OpenClaw session new]",
      },
      {
        role: "user",
        content: "legacy authored message",
      },
    ]);

    expect(projected).toEqual([expect.objectContaining({ role: "user", content: "hello brodie" })]);
    expect(JSON.stringify(projected)).not.toContain("Queued messages");
    expect(JSON.stringify(projected)).not.toContain("restart sentinel");
    expect(JSON.stringify(projected)).not.toContain("inter-session handoff");
  });

  it("expands a typed human inbound batch into one attributed row per native message", () => {
    const projected = projectChatDisplayMessages([
      {
        role: "user",
        content: "[📋 QUEUE ENGINE]: rendered model envelope",
        openclawSourceMessage: { text: "first\nsecond" },
        provenance: { kind: "external_user", sourceChannel: "whatsapp" },
        __openclaw: {
          seq: 41,
          humanInboundBatch: {
            version: 1,
            placement: "idle",
            inbounds: [
              {
                sourceEventId: "message-1",
                messageId: "message-1",
                timestamp: "Thursday, 2026-07-16 12:00:00 PM JST (GMT+9)",
                sender: { id: "sender-1", label: "Abhay" },
                authoredBody: "first",
                bodyForAgent: "first",
                media: [],
              },
              {
                sourceEventId: "message-2",
                messageId: "message-2",
                timestamp: "Thursday, 2026-07-16 12:00:01 PM JST (GMT+9)",
                sender: { id: "sender-2", label: "Rahul" },
                authoredBody: "second",
                bodyForAgent: "second",
                media: [],
              },
            ],
          },
        },
      },
    ]);

    expect(projected).toHaveLength(2);
    expect(projected).toEqual([
      expect.objectContaining({
        role: "user",
        content: "first",
        senderLabel: "Abhay",
        openclawSourceMessage: expect.objectContaining({
          messageId: "message-1",
          senderId: "sender-1",
          text: "first",
        }),
      }),
      expect.objectContaining({
        role: "user",
        content: "second",
        senderLabel: "Rahul",
        openclawSourceMessage: expect.objectContaining({
          messageId: "message-2",
          senderId: "sender-2",
          text: "second",
        }),
      }),
    ]);
    expect(projected.map((row) => row["__openclaw"])).toEqual([
      expect.objectContaining({ seq: 41, sourceIndex: 0 }),
      expect.objectContaining({ seq: 41, sourceIndex: 1 }),
    ]);
  });

  it("keeps an attributed media-only source with native media indicators", () => {
    const projected = projectChatDisplayMessages([
      {
        role: "user",
        content: "[📋 QUEUE ENGINE]: rendered model envelope",
        provenance: { kind: "external_user", sourceChannel: "whatsapp" },
        __openclaw: {
          seq: 42,
          humanInboundBatch: {
            version: 1,
            placement: "idle",
            inbounds: [
              {
                sourceEventId: "message-image-1",
                messageId: "message-image-1",
                timestamp: "Thursday, 2026-07-16 12:00:02 PM JST (GMT+9)",
                sender: { id: "sender-1", label: "Abhay" },
                authoredBody: "",
                bodyForAgent: "",
                media: [
                  {
                    kind: "image",
                    managedLocalPath: "/managed/media/inbound/photo.jpg",
                    mimeType: "image/jpeg",
                  },
                ],
              },
            ],
          },
        },
      },
    ]);

    expect(projected).toEqual([
      expect.objectContaining({
        role: "user",
        content: "",
        senderLabel: "Abhay",
        messageId: "message-image-1",
        MediaPaths: ["/managed/media/inbound/photo.jpg"],
        MediaTypes: ["image/jpeg"],
        openclawSourceMessage: expect.objectContaining({
          messageId: "message-image-1",
          senderId: "sender-1",
          text: "",
          media: [expect.objectContaining({ kind: "image" })],
        }),
      }),
    ]);
  });

  it("groups private thought, authored bubbles, route, and committed receipt", () => {
    const projected = projectChatDisplayMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "provider-native private plan" },
          {
            type: "toolCall",
            id: "call-1",
            name: "message",
            arguments: {
              action: "reply",
              invisibleThinking: "private operator thought",
              visibleMessages: ["first bubble", "second bubble"],
              channel: "whatsapp",
              target: "room-1",
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "message",
        toolCallId: "call-1",
        content: { ok: true, deliveryStatus: "delivered", messageId: "receipt-1" },
      },
      { role: "assistant", content: [{ type: "text", text: "NO_REPLY" }] },
    ]);

    expect(projected).toHaveLength(1);
    expect(projected[0]?.openclawConversationalAction).toEqual({
      action: "reply",
      outcome: "delivered",
      nativeThinking: ["provider-native private plan"],
      invisibleThinking: "private operator thought",
      visibleMessages: ["first bubble", "second bubble"],
      channel: "whatsapp",
      target: "room-1",
      receipt: { ok: true, deliveryStatus: "delivered", messageId: "receipt-1" },
    });
    expect(JSON.stringify(projected)).not.toContain('"type":"toolCall"');
  });

  it("normalizes every historical decision note as legacy private thinking", () => {
    const actionRows = ["first", "second", "third"].flatMap((label, index) => [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: `call-${index}`,
            name: "message",
            arguments: {
              action: "reply",
              decisionNote: `${label} private legacy rationale`,
              visibleMessages: [`${label} reply`],
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "message",
        toolCallId: `call-${index}`,
        content: { status: "sent" },
      },
    ]);

    const projected = projectChatDisplayMessages(actionRows);

    expect(projected).toHaveLength(3);
    expect(projected.map((row) => row.openclawConversationalAction)).toEqual([
      expect.objectContaining({
        invisibleThinking: "legacy action rationale",
        visibleMessages: ["first reply"],
      }),
      expect.objectContaining({
        invisibleThinking: "legacy action rationale",
        visibleMessages: ["second reply"],
      }),
      expect.objectContaining({
        invisibleThinking: "legacy action rationale",
        visibleMessages: ["third reply"],
      }),
    ]);
    expect(JSON.stringify(projected)).not.toContain("private legacy rationale");
    expect(JSON.stringify(projected)).not.toContain("decisionNote");
  });

  it("normalizes an already-projected legacy decision note", () => {
    const projected = projectChatDisplayMessages([
      {
        role: "assistant",
        content: [],
        openclawConversationalAction: {
          action: "reply",
          outcome: "delivered",
          decisionNote: "old share-safe summary",
          visibleMessages: ["visible reply"],
        },
      },
    ]);

    expect(projected[0]?.openclawConversationalAction).toEqual({
      action: "reply",
      outcome: "delivered",
      invisibleThinking: "legacy action rationale",
      visibleMessages: ["visible reply"],
    });
    expect(JSON.stringify(projected)).not.toContain("decisionNote");
    expect(JSON.stringify(projected)).not.toContain("old share-safe summary");
  });

  it("omits indexed but uncommitted assistant prose from sanitized history", () => {
    const messages = [
      { role: "user", content: "morning", provenance: { kind: "external_user" } },
      {
        role: "assistant",
        content: [{ type: "text", text: "morning bro, i'm here" }],
        __openclaw: { id: "legacy-reply", seq: 2 },
      },
    ];
    const projected = projectChatDisplayMessages(messages);

    expect(projected).toEqual([expect.objectContaining({ role: "user", content: "morning" })]);
  });

  it("shows only committed delivery mirrors in sanitized history", () => {
    const delivered = {
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: "morning bro, i'm here" }],
      openclawDeliveryMirror: { kind: "channel-final" },
    };
    const suppressed = {
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: "Channel final suppressed before delivery" }],
      openclawDeliveryMirror: { kind: "channel-final-suppressed" },
    };

    expect(projectChatDisplayMessages([delivered, suppressed])).toEqual([delivered]);
  });

  it("keeps deliberate silence and partial failure actions visible without bookkeeping", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "silence",
            name: "message",
            arguments: { action: "silence", invisibleThinking: "nothing useful" },
          },
          {
            type: "toolCall",
            id: "partial",
            name: "message",
            arguments: {
              action: "send",
              invisibleThinking: "send two",
              visibleMessages: ["one", "two"],
            },
          },
        ],
      },
      { role: "toolResult", toolName: "message", toolCallId: "silence", content: { ok: true } },
      {
        role: "toolResult",
        toolName: "message",
        toolCallId: "partial",
        isError: true,
        content: { ok: false, deliveryStatus: "partial_failed", sentBeforeError: true },
      },
      { role: "assistant", content: "NO_REPLY" },
    ];
    const actions = projectChatDisplayMessages(messages).map(
      (row) => row.openclawConversationalAction,
    );
    expect(actions).toEqual([
      {
        action: "silence",
        outcome: "deliberate_silence",
        invisibleThinking: "nothing useful",
        visibleMessages: [],
        receipt: { ok: true },
      },
      {
        action: "send",
        outcome: "partial_delivery",
        invisibleThinking: "send two",
        visibleMessages: ["one", "two"],
        receipt: { ok: false, deliveryStatus: "partial_failed", sentBeforeError: true },
      },
    ]);
  });

  it("keeps a delivered action when its transcript mirror arrives before the receipt", () => {
    const projected = projectChatDisplayMessages([
      { role: "user", content: "morning", provenance: { kind: "external_user" } },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-live-order",
            name: "message",
            arguments: {
              action: "send",
              invisibleThinking: "reply warmly",
              visibleMessages: ["morning bro, i'm here"],
            },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "morning bro, i'm here" }] },
      {
        role: "toolResult",
        toolName: "message",
        toolCallId: "call-live-order",
        content: { status: "sent", authoredMessages: [{ status: "sent" }] },
      },
    ]);

    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({ role: "user", content: "morning" });
    expect(projected[1]).toMatchObject({
      role: "assistant",
      openclawConversationalAction: {
        invisibleThinking: "reply warmly",
        visibleMessages: ["morning bro, i'm here"],
      },
    });
    expect(JSON.stringify(projected)).not.toContain('"type":"toolCall"');
  });

  it("keeps a partially delivered action visible with its committed receipt", () => {
    const projected = projectChatDisplayMessages([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-partial-status",
            name: "message",
            arguments: {
              action: "send",
              invisibleThinking: "two bubbles",
              visibleMessages: ["one", "two"],
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "message",
        toolCallId: "call-partial-status",
        content: {
          status: "partial_failed",
          authoredMessages: [{ status: "sent" }, { status: "failed" }],
        },
      },
    ]);

    expect(projected[0]?.openclawConversationalAction).toEqual({
      action: "send",
      outcome: "partial_delivery",
      invisibleThinking: "two bubbles",
      visibleMessages: ["one", "two"],
      receipt: {
        status: "partial_failed",
        authoredMessages: [{ status: "sent" }, { status: "failed" }],
      },
    });
  });

  it("projects authored user messages and conversational actions for bounded non-Control clients", () => {
    const projected = projectChatDisplayMessages([
      { role: "user", content: "hello", provenance: { kind: "external_user" } },
      { role: "assistant", content: [{ type: "text", text: "ordinary assistant prose" }] },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-minimal",
            name: "message",
            arguments: {
              action: "send",
              invisibleThinking: "private plan",
              visibleMessages: ["visible reply"],
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "message",
        toolCallId: "call-minimal",
        content: { status: "sent" },
      },
    ]);

    expect(projected).toHaveLength(2);
    expect(projected[0]).toMatchObject({ role: "user", content: "hello" });
    expect(projected[1]).toMatchObject({
      role: "assistant",
      openclawConversationalAction: {
        invisibleThinking: "private plan",
        visibleMessages: ["visible reply"],
      },
    });
    expect(JSON.stringify(projected)).not.toContain("ordinary assistant prose");
  });
});
