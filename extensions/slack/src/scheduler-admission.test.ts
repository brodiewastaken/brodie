import { resolveAgentRoute, resolveConversationRoute } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedSlackMessage } from "./monitor/message-handler/types.js";

const { admit } = vi.hoisted(() => ({ admit: vi.fn() }));

vi.mock("openclaw/plugin-sdk/conversation-scheduler", () => ({
  getRuntimeConversationScheduler: () => ({ admit }),
}));

import { admitSlackScheduledInbound, buildSlackScheduledEnvelope } from "./scheduler-admission.js";

const cfg = {};
const accountId = "work";
const channelId = "C123";
const threadId = "1710000000.000100";
const messageId = "1710000000.000200";
const route = resolveConversationRoute({
  cfg,
  channel: "slack",
  accountId,
  peer: { kind: "channel", id: channelId },
  threadId,
  teamId: "T123",
});

function makePrepared(overrides: Partial<PreparedSlackMessage> = {}): PreparedSlackMessage {
  return {
    ctx: {
      cfg,
      accountId,
      teamId: "T123",
    } as PreparedSlackMessage["ctx"],
    account: { accountId } as PreparedSlackMessage["account"],
    message: {
      type: "message",
      channel: channelId,
      user: "U123",
      username: "Abhay",
      ts: messageId,
      thread_ts: threadId,
      text: "hello",
    },
    route: resolveAgentRoute({
      cfg,
      channel: "slack",
      accountId,
      peer: { kind: "channel", id: channelId },
      teamId: "T123",
    }),
    channelConfig: null,
    replyTarget: `channel:${channelId}`,
    ctxPayload: {
      SessionKey: route.sessionKey,
      ChatType: "channel",
      MessageSid: messageId,
      MessageSids: ["1710000000.000150", messageId],
      Timestamp: 1_710_000_000_200,
      MessageThreadId: threadId,
      RawBody: "hello",
      BodyForAgent: "hello",
      CommandBody: "hello",
      CommandAuthorized: true,
      WasMentioned: true,
      SenderId: "U123",
      SenderName: "Abhay",
      GroupSubject: "project-room",
      GroupChannel: "project-room",
      ReplyToId: "1710000000.000050",
      ReplyToSender: "Teammate",
      ReplyToBody: "earlier",
      ThreadStarterBody: "thread starter",
      ThreadHistoryBody: "older human and bot messages",
      ThreadLabel: "Slack thread #project-room: thread starter",
      MediaPaths: ["/tmp/slack-image.png"],
      MediaTypes: ["image/png"],
    },
    turn: { storePath: "/tmp/sessions.json", record: {} },
    replyToMode: "all",
    requireMention: true,
    isDirectMessage: false,
    isRoomish: true,
    historyKey: channelId,
    preview: "hello",
    ackReactionValue: "eyes",
    ackReactionPromise: null,
    ...overrides,
  };
}

describe("Slack scheduler admission", () => {
  beforeEach(() => {
    admit.mockReset();
    admit.mockResolvedValue({ accepted: true, receiptId: "receipt-1", durableAt: 10 });
  });

  it("preserves canonical route, exact destination, source, thread, and media metadata", async () => {
    const prepared = makePrepared();
    const envelope = buildSlackScheduledEnvelope({ prepared, source: "app_mention", route });

    expect(envelope).toMatchObject({
      version: 1,
      channel: "slack",
      accountId,
      conversationId: channelId,
      nativeChannelId: channelId,
      threadId,
      sessionKey: route.sessionKey,
      destination: `channel:${channelId}`,
      messageId,
      messageIds: ["1710000000.000150", messageId],
      source: "app_mention",
      chatType: "channel",
      sender: { id: "U123", name: "Abhay" },
      quote: {
        messageId: "1710000000.000050",
        sender: "Teammate",
        body: "earlier",
      },
      supplemental: {
        thread: {
          starterBody: "thread starter",
          historyBody: "older human and bot messages",
          label: "Slack thread #project-room: thread starter",
        },
      },
      media: [
        {
          kind: "image",
          path: "/tmp/slack-image.png",
          mimeType: "image/png",
          sourceMessageId: messageId,
          sourceIndex: 0,
        },
      ],
    });

    const result = await admitSlackScheduledInbound({ prepared, source: "app_mention" });

    expect(result.result.accepted).toBe(true);
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `${route.queueLaneKey}:${messageId}`,
        route: expect.objectContaining({
          accountId,
          conversationId: channelId,
          threadId,
          sessionKey: route.sessionKey,
          queueLaneKey: route.queueLaneKey,
        }),
        producerKind: "human_reply",
        human: true,
        media: true,
        payload: expect.objectContaining({
          destination: `channel:${channelId}`,
        }),
      }),
    );
    expect(admit.mock.calls[0]?.[0].route.currentReplyTarget).toEqual({
      channel: "slack",
      accountId,
      target: `channel:${channelId}`,
      threadId,
      messageId,
    });
    expect(JSON.stringify(admit.mock.calls[0]?.[0].payload)).not.toContain("undefined");
  });

  it("keeps a direct message's concrete reply channel instead of its user-scoped route id", async () => {
    const directChannelId = "D123";
    const directRoute = resolveConversationRoute({
      cfg,
      channel: "slack",
      accountId,
      peer: { kind: "direct", id: "U123" },
      teamId: "T123",
    });
    const prepared = makePrepared({
      message: {
        type: "message",
        channel: directChannelId,
        user: "U123",
        ts: messageId,
        text: "hello",
      },
      replyTarget: `channel:${directChannelId}`,
      ctxPayload: {
        SessionKey: directRoute.sessionKey,
        ChatType: "direct",
        MessageSid: messageId,
        Timestamp: 1_710_000_000_200,
        RawBody: "hello",
        BodyForAgent: "hello",
        CommandBody: "hello",
        CommandAuthorized: true,
        SenderId: "U123",
      },
      isDirectMessage: true,
      isRoomish: false,
    });

    const result = await admitSlackScheduledInbound({ prepared, source: "message" });

    expect(result.result.accepted).toBe(true);
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({
          conversationId: "U123",
          currentReplyTarget: expect.objectContaining({
            target: `channel:${directChannelId}`,
          }),
        }),
        payload: expect.objectContaining({
          conversationId: "U123",
          nativeChannelId: directChannelId,
          destination: `channel:${directChannelId}`,
        }),
      }),
    );
  });

  it("declines ownership when the finalized native session differs from the canonical route", async () => {
    const onError = vi.fn();
    const prepared = makePrepared({
      ctxPayload: {
        ...makePrepared().ctxPayload,
        SessionKey: "agent:main:conversation:discord:default:channel:not-slack",
      },
    });

    const result = await admitSlackScheduledInbound({ prepared, source: "message", onError });

    expect(result.result).toEqual({ accepted: false, reason: "invalid" });
    expect(admit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "slack scheduler route does not match the finalized native session",
      }),
    );
  });
});
