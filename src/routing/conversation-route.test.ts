import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConversationRoute } from "./conversation-route.js";

describe("resolveConversationRoute", () => {
  const cfg = {} as OpenClawConfig;

  it("keeps bot accounts and threads in the canonical identity", () => {
    const first = resolveConversationRoute({
      cfg,
      channel: "discord",
      accountId: "brodie-main",
      peer: { kind: "channel", id: "room-1" },
      threadId: "thread-9",
    });
    const second = resolveConversationRoute({
      cfg,
      channel: "discord",
      accountId: "brodie-backup",
      peer: { kind: "channel", id: "room-1" },
      threadId: "thread-9",
    });

    expect(first.sessionKey).not.toBe(second.sessionKey);
    expect(first.queueLaneKey).not.toBe(second.queueLaneKey);
    expect(first).toMatchObject({
      conversationKind: "channel",
      conversationId: "room-1",
      threadId: "thread-9",
      transcriptOwner: { agentId: "main", sessionKey: first.sessionKey },
    });
  });

  it("keeps the private lane length-prefixed and makes the session key readable", () => {
    const route = resolveConversationRoute({
      cfg,
      channel: "whatsapp",
      accountId: "brodie",
      peer: { kind: "group", id: "🤙🏽|room" },
    });

    expect(route.queueLaneKey).toContain("13:🤙🏽|room");
    expect(route.sessionKey).toBe(
      "agent:main:conversation:whatsapp:brodie:group:%F0%9F%A4%99%F0%9F%8F%BD%7Croom",
    );
  });

  it("encodes reserved dimensions and reverses an optional thread exactly", async () => {
    const { parseCanonicalConversationSessionKey } = await import("./session-key.js");
    const route = resolveConversationRoute({
      cfg,
      channel: "discord",
      accountId: "brodie:backup",
      peer: { kind: "channel", id: "room/one" },
      threadId: "topic:α",
    });

    expect(route.sessionKey).toBe(
      "agent:main:conversation:discord:brodie-backup:channel:room%2Fone:thread:topic%3A%CE%B1",
    );
    expect(parseCanonicalConversationSessionKey(route.sessionKey)).toEqual({
      agentId: "main",
      channel: "discord",
      accountId: "brodie-backup",
      conversationKind: "channel",
      conversationId: "room/one",
      threadId: "topic:α",
      baseSessionKey: "agent:main:conversation:discord:brodie-backup:channel:room%2Fone",
    });
  });
});
