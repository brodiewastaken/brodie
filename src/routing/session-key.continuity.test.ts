// Session key continuity tests cover stable route keys across routing changes.
import { describe, it, expect } from "vitest";
import { buildAgentSessionKey } from "./resolve-route.js";
import {
  buildCanonicalConversationSessionKey,
  parseCanonicalConversationSessionKey,
  resolveThreadSessionKeys,
} from "./session-key.js";

describe("Channel Session Key Continuity", () => {
  const agentId = "main";
  const channel = "quietchat";
  const accountId = "default";

  function buildChannelSessionKey(params: {
    peer: { kind: "direct" | "channel"; id: string };
    dmScope?: "main" | "per-peer";
  }) {
    return buildAgentSessionKey({
      agentId,
      channel,
      accountId,
      dmScope: params.dmScope ?? "main",
      peer: params.peer,
    });
  }

  function expectDistinctDmAndChannelKeys(dmScope: "main" | "per-peer") {
    const dmKey = buildChannelSessionKey({
      peer: { kind: "direct", id: "user123" },
      dmScope,
    });

    const groupKey = buildChannelSessionKey({
      peer: { kind: "channel", id: "channel456" },
    });

    expect(dmKey).toBe(
      buildCanonicalConversationSessionKey({
        agentId,
        channel,
        accountId,
        conversationKind: "direct",
        conversationId: "user123",
      }),
    );
    expect(groupKey).toBe(
      buildCanonicalConversationSessionKey({
        agentId,
        channel,
        accountId,
        conversationKind: "channel",
        conversationId: "channel456",
      }),
    );
    expect(dmKey).not.toBe(groupKey);
  }

  function expectUnknownChannelKeyCase(channelId: string) {
    const missingIdKey = buildChannelSessionKey({
      peer: { kind: "channel", id: channelId },
    });

    expect(missingIdKey).toContain("unknown");
    expect(missingIdKey).not.toBe("agent:main:main");
  }

  it.each(["main", "per-peer"] as const)(
    "keeps %s-scoped DMs on the canonical route and distinct from channels",
    (dmScope) => {
      expectDistinctDmAndChannelKeys(dmScope);
    },
  );

  it.each(["", "   "] as const)("handles invalid channel id %j without collision", (channelId) => {
    expectUnknownChannelKeyCase(channelId);
  });

  it("uses the readable positional key and appends a canonical thread", () => {
    const baseSessionKey = buildCanonicalConversationSessionKey({
      agentId,
      channel: "whatsapp",
      accountId: "brodie",
      conversationKind: "group",
      conversationId: "120363406331109499@g.us",
    });

    expect(baseSessionKey).toBe(
      "agent:main:conversation:whatsapp:brodie:group:120363406331109499@g.us",
    );
    expect(resolveThreadSessionKeys({ baseSessionKey, threadId: "Topic: One" })).toEqual({
      sessionKey:
        "agent:main:conversation:whatsapp:brodie:group:120363406331109499@g.us:thread:topic%3A%20one",
      parentSessionKey: undefined,
    });
  });

  it.each([
    "agent:main:conversation-v1:8:whatsapp|6:brodie|6:direct|4:user|-",
    "agent:main:conversation:whatsapp:brodie:direct",
    "agent:main:conversation:whatsapp:brodie:direct:user:extra:value",
    "agent:main:conversation:whatsapp:brodie:direct:user:thread:",
    "agent:main:conversation:whatsapp:brodie:direct:user%2fother",
    "agent:main:conversation:whatsapp::direct:user",
  ])("rejects non-canonical readable key %s", (sessionKey) => {
    expect(parseCanonicalConversationSessionKey(sessionKey)).toBeNull();
  });
});
