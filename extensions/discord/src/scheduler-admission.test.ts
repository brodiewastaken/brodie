import type { ConversationRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it, vi } from "vitest";
import {
  admitDiscordScheduledInbound,
  buildDiscordScheduledEnvelope,
  discordSchedulerAdmissionTesting,
} from "./scheduler-admission.js";

const { admit } = vi.hoisted(() => ({ admit: vi.fn() }));

vi.mock("openclaw/plugin-sdk/conversation-scheduler", () => ({
  getRuntimeConversationScheduler: () => ({ admit }),
}));

describe("discord scheduler admission", () => {
  it("rejects scheduler ownership when the finalized native session differs from the canonical route", async () => {
    admit.mockClear();
    const onError = vi.fn();
    const result = await admitDiscordScheduledInbound({
      ctx: {
        cfg: {},
        accountId: "work",
        messageChannelId: "dm-1",
        message: { id: "message-1", timestamp: "2026-07-15T00:00:00.000Z" },
        author: { id: "user-1", username: "abhay", bot: false },
        sender: { id: "user-1", name: "Abhay", isPluralKit: false },
        memberRoleIds: [],
        commandAuthorized: true,
        effectiveWasMentioned: false,
        inboundEventKind: "message",
        isDirectMessage: true,
        isGroupDm: false,
        isGuildMessage: false,
        guildInfo: null,
        guildSlug: "",
        channelName: "dm",
        channelInfo: null,
        threadChannel: null,
        preparedMedia: [],
        route: { agentId: "main" },
      } as never,
      prepared: {
        persistedSessionKey: "agent:main:conversation:slack:default:channel:not-discord",
        ctxPayload: { RawBody: "hello" },
      } as never,
      onError,
    });

    expect(result.result).toEqual({ accepted: false, reason: "invalid" });
    expect(admit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "discord scheduler route does not match the finalized native session",
      }),
    );
  });

  it("recursively compacts optional payload values", () => {
    expect(
      discordSchedulerAdmissionTesting.compactJson({
        text: "hello",
        absent: undefined,
        nested: { keep: true, absent: undefined },
        list: ["first", undefined, { keep: 2, absent: undefined }],
      }),
    ).toEqual({
      text: "hello",
      nested: { keep: true },
      list: ["first", { keep: 2 }],
    });
  });

  it("rejects cyclic payloads before scheduler ownership", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => discordSchedulerAdmissionTesting.compactJson(cyclic)).toThrow("cycle");
  });

  it("preserves native Discord and PluralKit facts in one typed envelope", () => {
    const route: ConversationRoute = {
      channel: "discord",
      accountId: "work",
      conversationKind: "channel",
      conversationId: "parent-1",
      threadId: "thread-1",
      sessionKey: "agent:main:conversation:discord:default:channel:discord",
      queueLaneKey: "discord-lane",
      transcriptOwner: {
        agentId: "main",
        sessionKey: "agent:main:conversation:discord:default:channel:discord",
      },
    };
    const ctx = {
      accountId: "work",
      messageChannelId: "thread-1",
      canonicalMessageId: "pk-message-1",
      message: { id: "message-1", timestamp: "2026-07-15T00:00:00.000Z" },
      author: { id: "webhook-1", username: "proxy", bot: true },
      sender: {
        id: "member-1",
        name: "alex",
        tag: "alex-system",
        isPluralKit: true,
        pluralkit: { memberId: "member-1", systemId: "system-1" },
      },
      memberRoleIds: ["role-1"],
      commandAuthorized: true,
      effectiveWasMentioned: true,
      inboundEventKind: "message",
      isDirectMessage: false,
      isGroupDm: false,
      isGuildMessage: true,
      guildInfo: { id: "guild-1" },
      guildSlug: "guild",
      guildName: "Guild",
      channelName: "thread",
      channelInfo: { type: 11 },
      threadParentId: "parent-1",
      threadParentName: "forum",
      threadParentType: 15,
      threadName: "thread",
      preparedMedia: [
        { path: "/tmp/attachment.png", contentType: "image/png", placeholder: "<media:image>" },
      ],
    } as never;
    const prepared = {
      persistedSessionKey: route.sessionKey,
      ctxPayload: {
        RawBody: "hello",
        BodyForAgent: "hello",
        CommandBody: "hello",
        ReplyToId: "quoted-1",
        ReplyToSender: "sender-2",
        ReplyToSenderId: "sender-native-2",
        ReplyToTimestamp: Date.parse("2026-07-14T23:59:00.000Z"),
        ReplyToBody: "quoted",
        ReplyToMediaPaths: ["/tmp/quoted.png", "https://cdn.discord.test/quoted-fallback.png"],
        ReplyToMediaUrls: ["/tmp/quoted.png", "https://cdn.discord.test/quoted-fallback.png"],
        ReplyToMediaTypes: ["image/png", "image/png"],
        ReplyToMediaSourceMessageIds: ["quoted-1", "quoted-1"],
        ReplyToMediaSourceIndexes: [0, 1],
      },
    } as never;

    const envelope = buildDiscordScheduledEnvelope({ ctx, prepared, route });
    expect(envelope).toMatchObject({
      accountId: "work",
      conversationId: "parent-1",
      nativeChannelId: "thread-1",
      threadId: "thread-1",
      messageId: "pk-message-1",
      sender: {
        id: "member-1",
        roles: ["role-1"],
      },
      pluralkit: { systemId: "system-1" },
      conversation: {
        guild: { id: "guild-1", name: "Guild" },
        parentChannel: { id: "parent-1", name: "forum" },
      },
      quote: {
        messageId: "quoted-1",
        sender: "sender-2",
        senderId: "sender-native-2",
        timestamp: "2026-07-14T23:59:00.000Z",
        body: "quoted",
        media: [
          expect.objectContaining({
            sourceMessageId: "quoted-1",
            sourceIndex: 0,
            managedLocalPath: "/tmp/quoted.png",
          }),
          expect.objectContaining({
            sourceMessageId: "quoted-1",
            sourceIndex: 1,
            url: "https://cdn.discord.test/quoted-fallback.png",
          }),
        ],
      },
      media: [{ kind: "image", sourceMessageId: "message-1" }],
    });
    expect(envelope.quote?.media?.[0]).not.toHaveProperty("url");
    expect(envelope.quote?.media?.[1]).not.toHaveProperty("managedLocalPath");
  });

  it("preserves canonical native tag text through scheduler admission", () => {
    const canonicalBody =
      "ask @tagged_user [111222333444555666] in #botpostin [<#1477428282428358798>]";
    const route: ConversationRoute = {
      channel: "discord",
      accountId: "work",
      conversationKind: "channel",
      conversationId: "channel-1",
      sessionKey: "agent:main:conversation:discord:default:channel:channel-1",
      queueLaneKey: "discord-lane",
      transcriptOwner: {
        agentId: "main",
        sessionKey: "agent:main:conversation:discord:default:channel:channel-1",
      },
    };
    const envelope = buildDiscordScheduledEnvelope({
      route,
      ctx: {
        accountId: "work",
        messageChannelId: "channel-1",
        message: { id: "message-1", timestamp: "2026-07-20T00:00:00.000Z" },
        author: { id: "sender-1", username: "sender", bot: false },
        sender: { id: "sender-1", name: "Sender", isPluralKit: false },
        memberRoleIds: [],
        commandAuthorized: false,
        effectiveWasMentioned: false,
        inboundEventKind: "message",
        isDirectMessage: false,
        isGroupDm: false,
        isGuildMessage: true,
        guildInfo: { id: "guild-1" },
        guildSlug: "guild",
        channelName: "channel-1",
        channelInfo: { type: 0 },
        threadChannel: null,
        preparedMedia: [],
        baseText: canonicalBody,
      } as never,
      prepared: {
        persistedSessionKey: route.sessionKey,
        ctxPayload: { RawBody: canonicalBody, BodyForAgent: canonicalBody },
      } as never,
    });

    expect(envelope).toMatchObject({ body: canonicalBody, bodyForAgent: canonicalBody });
  });
});
