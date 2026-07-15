import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordTypingListener } from "./listeners.js";

const { noteTyping, resolveDiscordChannelInfo } = vi.hoisted(() => ({
  noteTyping: vi.fn(async (_route: { queueLaneKey: string }) => true),
  resolveDiscordChannelInfo: vi.fn(async () => null as { parentId?: string } | null),
}));

vi.mock("openclaw/plugin-sdk/conversation-scheduler", () => ({
  getRuntimeConversationScheduler: () => ({ noteTyping }),
}));

vi.mock("openclaw/plugin-sdk/routing", () => ({
  resolveConversationRoute: (input: { peer: { kind: string; id: string }; threadId?: string }) => ({
    queueLaneKey: [input.peer.kind, input.peer.id, input.threadId].filter(Boolean).join(":"),
  }),
}));

vi.mock("./message-utils.js", () => ({
  resolveDiscordChannelInfo,
}));

const cfg = {} as ConstructorParameters<typeof DiscordTypingListener>[0]["cfg"];
const client = {} as Parameters<DiscordTypingListener["handle"]>[1];

describe("DiscordTypingListener", () => {
  beforeEach(() => {
    noteTyping.mockClear();
    resolveDiscordChannelInfo.mockReset().mockResolvedValue(null);
  });

  it("resets the matching guild channel lane", async () => {
    const listener = new DiscordTypingListener({ cfg, accountId: "acc", botUserId: "42" });
    await listener.handle({ channel_id: "111", user_id: "777", guild_id: "g1" }, client);

    expect(noteTyping).toHaveBeenCalledTimes(1);
    expect(noteTyping).toHaveBeenCalledWith(
      expect.objectContaining({ queueLaneKey: "channel:111" }),
    );
  });

  it("resolves a thread parent before resetting its lane", async () => {
    resolveDiscordChannelInfo.mockResolvedValue({ parentId: "100" });
    const listener = new DiscordTypingListener({ cfg, accountId: "acc" });
    await listener.handle({ channel_id: "111", user_id: "777", guild_id: "g1" }, client);

    expect(noteTyping).toHaveBeenCalledWith(
      expect.objectContaining({ queueLaneKey: "channel:100:111" }),
    );
  });

  it("signals direct and group-DM shapes when Discord omits guild metadata", async () => {
    const listener = new DiscordTypingListener({ cfg, accountId: "acc" });
    await listener.handle({ channel_id: "111", user_id: "777" }, client);

    expect(noteTyping.mock.calls.map(([route]) => route.queueLaneKey)).toEqual([
      "direct:777",
      "group:111",
    ]);
  });

  it("ignores bot typing and malformed payloads", async () => {
    const listener = new DiscordTypingListener({ cfg, accountId: "acc", botUserId: "42" });
    await listener.handle({ channel_id: "111", user_id: "42" }, client);
    await listener.handle({ channel_id: "", user_id: "777" }, client);
    await listener.handle(undefined as never, client);

    expect(noteTyping).not.toHaveBeenCalled();
  });

  it("fails open when route inspection fails", async () => {
    resolveDiscordChannelInfo.mockRejectedValue(new Error("boom"));
    noteTyping.mockRejectedValueOnce(new Error("storage"));
    const listener = new DiscordTypingListener({ cfg, accountId: "acc" });

    await expect(
      listener.handle({ channel_id: "111", user_id: "777", guild_id: "g1" }, client),
    ).resolves.toBeUndefined();
  });
});
