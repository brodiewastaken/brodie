import { resolveConversationRoute } from "openclaw/plugin-sdk/routing";
// Whatsapp tests cover session route plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveWhatsAppOutboundSessionRoute } from "./session-route.js";

describe("resolveWhatsAppOutboundSessionRoute", () => {
  it("routes newsletter JIDs as channel sessions", () => {
    const route = resolveWhatsAppOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "120363401234567890@newsletter",
    });

    const canonical = resolveConversationRoute({
      cfg: {},
      channel: "whatsapp",
      peer: { kind: "channel", id: "120363401234567890@newsletter" },
    });
    expect(route).toEqual({
      sessionKey: canonical.sessionKey,
      baseSessionKey: canonical.sessionKey,
      recipientSessionExact: true,
      peer: {
        kind: "channel",
        id: "120363401234567890@newsletter",
      },
      chatType: "channel",
      from: "120363401234567890@newsletter",
      to: "120363401234567890@newsletter",
    });
  });

  it("keeps direct user targets on direct session semantics", () => {
    const cfg = { session: { dmScope: "per-channel-peer" as const } };
    const route = resolveWhatsAppOutboundSessionRoute({
      cfg,
      agentId: "main",
      target: "+15551234567",
    });

    const canonical = resolveConversationRoute({
      cfg,
      channel: "whatsapp",
      peer: { kind: "direct", id: "+15551234567" },
    });
    expect(route).toEqual({
      sessionKey: canonical.sessionKey,
      baseSessionKey: canonical.sessionKey,
      recipientSessionExact: true,
      peer: {
        kind: "direct",
        id: "+15551234567",
      },
      chatType: "direct",
      from: "+15551234567",
      to: "+15551234567",
    });
  });

  it("uses the canonical account dimension for named-account groups", () => {
    const route = resolveWhatsAppOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "work",
      target: "123@g.us",
    });

    const canonical = resolveConversationRoute({
      cfg: {},
      channel: "whatsapp",
      accountId: "work",
      peer: { kind: "group", id: "123@g.us" },
    });
    expect(route).toMatchObject({
      sessionKey: canonical.sessionKey,
      baseSessionKey: canonical.sessionKey,
      recipientSessionExact: true,
    });
  });
});
