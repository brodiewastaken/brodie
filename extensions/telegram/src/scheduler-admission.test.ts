import { resolveConversationRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it, vi } from "vitest";
import {
  admitTelegramScheduledInbound,
  buildTelegramScheduledEnvelope,
  telegramSchedulerAdmissionTesting,
} from "./scheduler-admission.js";

const { admit } = vi.hoisted(() => ({ admit: vi.fn() }));

vi.mock("openclaw/plugin-sdk/conversation-scheduler", () => ({
  getRuntimeConversationScheduler: () => ({ admit }),
}));

function topicContext() {
  const cfg = {};
  const nativeRoute = resolveConversationRoute({
    cfg,
    channel: "telegram",
    accountId: "work",
    peer: { kind: "group", id: "-1001234:topic:42" },
    parentPeer: { kind: "group", id: "-1001234" },
  });
  return {
    cfg,
    allMedia: [
      {
        path: "/tmp/photo.jpg",
        contentType: "image/jpeg",
        sourceMessageId: "515",
      },
    ],
    context: {
      accountId: "work",
      chatId: -1001234,
      isGroup: true,
      resolvedThreadId: 42,
      threadSpec: { scope: "forum", id: 42 },
      route: { agentId: "main", accountId: "work", sessionKey: nativeRoute.sessionKey },
      primaryCtx: { me: { id: 424242, username: "brodie_bot" } },
      msg: {
        message_id: 515,
        date: 1_720_000_000,
        chat: { id: -1001234, type: "supergroup", title: "Fork Lab" },
      },
      ctxPayload: {
        SessionKey: nativeRoute.sessionKey,
        AccountId: "work",
        MessageSid: "515",
        Timestamp: 1_720_000_000_000,
        ChatType: "group",
        SenderId: "777",
        SenderName: "Abhay",
        SenderUsername: "notabhay",
        RawBody: "hello there",
        BodyForAgent: "hello there",
        CommandBody: "hello there",
        CommandAuthorized: true,
        WasMentioned: true,
        InboundEventKind: "user_request",
        OriginatingTo: "telegram:-1001234:topic:42",
        To: "telegram:-1001234:topic:42",
        ReplyToId: "500",
        ReplyToBody: "earlier message",
        ReplyToSender: "Someone",
        ConversationLabel: "Fork Lab / queue-v2",
        GroupSubject: "Fork Lab",
        TopicName: "queue-v2",
      },
    },
  } as const;
}

describe("telegram scheduler admission", () => {
  it("admits the prepared account/topic route with the existing reply target", async () => {
    admit.mockReset().mockResolvedValue({
      accepted: true,
      receiptId: "receipt-1",
      durableAt: 1_720_000_000_001,
    });
    const params = topicContext();

    const result = await admitTelegramScheduledInbound(params as never);

    expect(result.result).toMatchObject({ accepted: true, receiptId: "receipt-1" });
    expect(result.route).toMatchObject({
      accountId: "work",
      conversationKind: "group",
      conversationId: "-1001234:topic:42",
      currentReplyTarget: {
        channel: "telegram",
        accountId: "work",
        target: "telegram:-1001234:topic:42",
        threadId: "42",
        messageId: "515",
      },
    });
    expect(result.event).toMatchObject({
      id: `${result.route?.queueLaneKey}:515`,
      producerKind: "human_reply",
      media: true,
      payload: {
        channel: "telegram",
        accountId: "work",
        conversationId: "-1001234:topic:42",
        destination: "telegram:-1001234:topic:42",
        sessionKey: result.route?.sessionKey,
        messageId: "515",
        threadId: "42",
        sender: { id: "777", username: "notabhay" },
        quote: { messageId: "500", sender: "Someone", body: "earlier message" },
        media: [
          {
            kind: "image",
            path: "/tmp/photo.jpg",
            mimeType: "image/jpeg",
            sourceMessageId: "515",
            sourceIndex: 0,
          },
        ],
        conversation: {
          nativeChannel: { id: "-1001234", name: "Fork Lab" },
          topic: { id: "42", name: "queue-v2" },
        },
      },
    });
  });

  it("declines ownership when the finalized native session does not match", async () => {
    admit.mockReset();
    const params = topicContext();
    const onError = vi.fn();
    const result = await admitTelegramScheduledInbound({
      ...params,
      context: {
        ...params.context,
        ctxPayload: { ...params.context.ctxPayload, SessionKey: "agent:main:wrong" },
      },
      onError,
    } as never);

    expect(result.result).toEqual({ accepted: false, reason: "invalid" });
    expect(admit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "telegram scheduler route does not match the finalized native session",
      }),
    );
  });

  it("preserves aggregated media source identities in the typed envelope", () => {
    const params = topicContext();
    const route = resolveConversationRoute({
      cfg: params.cfg,
      channel: "telegram",
      accountId: "work",
      peer: { kind: "group", id: "-1001234:topic:42" },
      parentPeer: { kind: "group", id: "-1001234" },
    });
    const envelope = buildTelegramScheduledEnvelope({ ...params, route } as never);

    expect(envelope.media).toEqual([
      expect.objectContaining({
        id: "515:0",
        sourceMessageId: "515",
        sourceIndex: 0,
      }),
    ]);
  });

  it("keeps a direct sender lane separate from the existing native reply destination", async () => {
    admit.mockReset().mockResolvedValue({
      accepted: true,
      receiptId: "receipt-dm",
      durableAt: 1_720_000_000_001,
    });
    const cfg = {};
    const nativeRoute = resolveConversationRoute({
      cfg,
      channel: "telegram",
      accountId: "work",
      peer: { kind: "direct", id: "777" },
    });
    const result = await admitTelegramScheduledInbound({
      cfg,
      allMedia: [],
      context: {
        accountId: "work",
        chatId: 999,
        isGroup: false,
        threadSpec: { scope: "none" },
        route: { agentId: "main", accountId: "work", sessionKey: nativeRoute.sessionKey },
        primaryCtx: {},
        msg: { message_id: 8, date: 1_720_000_000, chat: { id: 999, type: "private" } },
        ctxPayload: {
          SessionKey: nativeRoute.sessionKey,
          MessageSid: "8",
          SenderId: "777",
          OriginatingTo: "telegram:999",
          To: "telegram:999",
          ChatType: "direct",
          RawBody: "hello",
          CommandAuthorized: false,
        },
      },
    } as never);

    expect(result.route).toMatchObject({
      conversationId: "777",
      currentReplyTarget: { target: "telegram:999" },
    });
    expect(result.event?.payload).toMatchObject({
      conversationId: "777",
      destination: "telegram:999",
    });
  });

  it("recursively rejects cyclic payloads before durable ownership", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => telegramSchedulerAdmissionTesting.compactJson(cyclic)).toThrow("cycle");
  });
});
