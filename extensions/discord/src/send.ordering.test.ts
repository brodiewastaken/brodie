// Discord tests cover outbound serializer ordering behavior.
import { ChannelType, Routes } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDiscordRest } from "./send.test-harness.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let deliverDiscordReply: typeof import("./monitor/reply-delivery.js").deliverDiscordReply;
let sendMessageDiscord: typeof import("./send.js").sendMessageDiscord;
let sendWebhookMessageDiscord: typeof import("./send.js").sendWebhookMessageDiscord;
let serializerTesting: typeof import("./outbound-serializer.js").outboundSerializerTesting;

const cfg = {
  channels: {
    discord: {
      token: "Bot test-token",
    },
  },
} as OpenClawConfig;

describe("discord outbound ordering", () => {
  beforeAll(async () => {
    ({ deliverDiscordReply } = await import("./monitor/reply-delivery.js"));
    ({ sendMessageDiscord, sendWebhookMessageDiscord } = await import("./send.js"));
    ({ outboundSerializerTesting: serializerTesting } = await import("./outbound-serializer.js"));
  });

  beforeEach(() => {
    serializerTesting.resetDiscordOutboundSerializer();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("serializes visible assistant text before a later message tool send to the same discord thread", async () => {
    const firstText =
      "lmao fair. let me send brocode to investigate what's actually wrong with the Keychain on brozone and figure out the proper fix.";
    const secondText =
      "sent him the full investigation task. he'll diagnose why the Keychain is actually failing.";
    const runtime = {} as RuntimeEnv;
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });

    const firstPostSeen = createDeferred<void>();
    const releaseFirstPost = createDeferred<{ id: string; channel_id: string }>();

    postMock.mockImplementation(async (route: string, init?: { body?: { content?: string } }) => {
      expect(route).toBe(Routes.channelMessages("thread-1"));
      const content = init?.body?.content ?? "";
      if (content === firstText) {
        firstPostSeen.resolve();
        return await releaseFirstPost.promise;
      }
      return { id: "msg-2", channel_id: "thread-1" };
    });

    const streamedReply = deliverDiscordReply({
      replies: [{ text: firstText }],
      target: "channel:thread-1",
      token: "test-token",
      rest,
      runtime,
      cfg,
      textLimit: 2000,
      kind: "final",
    });

    await firstPostSeen.promise;

    const toolSend = sendMessageDiscord("channel:thread-1", secondText, {
      rest,
      token: "test-token",
      cfg,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(postMock).toHaveBeenCalledTimes(1);

    releaseFirstPost.resolve({ id: "msg-1", channel_id: "thread-1" });

    await Promise.all([streamedReply, toolSend]);

    const sentBodies = postMock.mock.calls.map(([, init]) => {
      const body = init?.body as { content?: string } | undefined;
      return body?.content ?? "";
    });
    expect(sentBodies).toEqual([firstText, secondText]);
  });

  it("serializes webhook-path sends before bot sends to the same discord thread", async () => {
    const firstText = "streamed subagent webhook reply";
    const secondText = "follow-up bot send";
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });

    const firstWebhookSeen = createDeferred<void>();
    const releaseFirstWebhook = createDeferred<Response>();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      firstWebhookSeen.resolve();
      return await releaseFirstWebhook.promise;
    });

    postMock.mockResolvedValue({ id: "bot-1", channel_id: "thread-1" });

    const webhookSend = sendWebhookMessageDiscord(firstText, {
      cfg,
      accountId: "default",
      webhookId: "wh_123",
      webhookToken: "tok_123",
      threadId: "thread-1",
      wait: true,
    });

    await firstWebhookSeen.promise;

    const botSend = sendMessageDiscord("channel:thread-1", secondText, {
      rest,
      token: "test-token",
      cfg,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(postMock).not.toHaveBeenCalled();

    releaseFirstWebhook.resolve(
      new Response(JSON.stringify({ id: "wh-msg-1", channel_id: "thread-1" }), {
        status: 200,
      }),
    );

    await Promise.all([webhookSend, botSend]);

    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock).toHaveBeenCalledWith(
      Routes.channelMessages("thread-1"),
      expect.objectContaining({
        body: expect.objectContaining({ content: secondText }),
      }),
    );
  });

  it("delivers [[SPLIT]] fan-out bubbles for the same channel in order through the serializer", async () => {
    // Combined property: the shared outbound fan-out initiates same-channel sends
    // sequentially per payload plan, and the mutex is acquisition-order FIFO — so
    // bubbles land in plan order even with adversarial REST timing, while a send
    // to a different destination is never blocked by the held key.
    const bubbleOne = "first split bubble";
    const bubbleTwo = "second split bubble";
    const otherChannelText = "other-channel send proceeds concurrently";
    const runtime = {} as RuntimeEnv;
    const { rest, postMock, getMock } = makeDiscordRest();
    getMock.mockResolvedValue({ type: ChannelType.GuildText });

    const firstPostSeen = createDeferred<void>();
    const releaseFirstPost = createDeferred<{ id: string; channel_id: string }>();

    postMock.mockImplementation(async (route: string, init?: { body?: { content?: string } }) => {
      const content = init?.body?.content ?? "";
      if (content === bubbleOne) {
        firstPostSeen.resolve();
        return await releaseFirstPost.promise;
      }
      const channelId = route === Routes.channelMessages("chan-b") ? "chan-b" : "chan-a";
      return { id: `msg-${postMock.mock.calls.length}`, channel_id: channelId };
    });

    const fanOut = deliverDiscordReply({
      replies: [{ text: bubbleOne }, { text: bubbleTwo }],
      target: "channel:chan-a",
      token: "test-token",
      rest,
      runtime,
      cfg,
      textLimit: 2000,
      kind: "final",
    });

    await firstPostSeen.promise;
    expect(serializerTesting.getPendingDiscordOutboundKeys()).toContain("discord:default:chan-a");

    // A different destination must not queue behind chan-a's held key.
    await sendMessageDiscord("channel:chan-b", otherChannelText, {
      rest,
      token: "test-token",
      cfg,
    });

    expect(postMock.mock.calls.map(([route]) => route)).toEqual([
      Routes.channelMessages("chan-a"),
      Routes.channelMessages("chan-b"),
    ]);

    releaseFirstPost.resolve({ id: "msg-1", channel_id: "chan-a" });
    await fanOut;

    const chanABodies = postMock.mock.calls
      .filter(([route]) => route === Routes.channelMessages("chan-a"))
      .map(([, init]) => (init?.body as { content?: string } | undefined)?.content ?? "");
    expect(chanABodies).toEqual([bubbleOne, bubbleTwo]);
    expect(serializerTesting.getPendingDiscordOutboundKeys()).toEqual([]);
  });

  it("unblocks queued sends to a channel when an earlier send hangs past the starvation cap", async () => {
    vi.useFakeTimers();
    try {
      const { rest, postMock, getMock } = makeDiscordRest();
      getMock.mockResolvedValue({ type: ChannelType.GuildText });

      // First REST post never settles — a wedged connection, not a rejection.
      postMock
        .mockImplementationOnce(async () => await new Promise<never>(() => {}))
        .mockResolvedValue({ id: "msg-2", channel_id: "chan-hung" });

      const hungSend = sendMessageDiscord("channel:chan-hung", "hung send", {
        rest,
        token: "test-token",
        cfg,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(postMock).toHaveBeenCalledTimes(1);

      const queuedSend = sendMessageDiscord("channel:chan-hung", "queued send", {
        rest,
        token: "test-token",
        cfg,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(postMock).toHaveBeenCalledTimes(1);

      // Default 5-minute cap evicts the hung task from the blocking chain.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await queuedSend;
      expect(postMock).toHaveBeenCalledTimes(2);
      expect(postMock.mock.lastCall?.[1]).toMatchObject({
        body: expect.objectContaining({ content: "queued send" }),
      });

      // The hung caller stays attached to its own (never-settling) task.
      void hungSend;
    } finally {
      vi.useRealTimers();
    }
  });
});
