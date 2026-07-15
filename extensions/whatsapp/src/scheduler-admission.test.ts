import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConversationRoute } from "openclaw/plugin-sdk/routing";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "./inbound/test-message.test-helper.js";

const { admit, settle, mediaDirRef } = vi.hoisted(() => ({
  admit: vi.fn(),
  settle: vi.fn(),
  mediaDirRef: { current: "/tmp/whatsapp-scheduler-media" },
}));

vi.mock("openclaw/plugin-sdk/conversation-scheduler", () => ({
  getRuntimeConversationScheduler: () => ({ admit, settle }),
}));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return { ...actual, getMediaDir: () => mediaDirRef.current };
});

import {
  admitWhatsAppScheduledInbound,
  buildWhatsAppScheduledEnvelope,
  settleWhatsAppScheduledInbound,
} from "./scheduler-admission.js";

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "whatsapp-scheduler-admission-"));
mediaDirRef.current = path.join(tempRoot, "media");
const inboundMediaDir = path.join(mediaDirRef.current, "inbound");
mkdirSync(inboundMediaDir, { recursive: true });

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

const cfg = {};
const conversationId = "trusted-group@g.us";
const accountId = "work";
const route = resolveConversationRoute({
  cfg,
  channel: "whatsapp",
  accountId,
  peer: { kind: "group", id: conversationId },
});

function makeMessage(payload: { body: string; commandBody?: string } = { body: "hello" }) {
  return createTestWebInboundMessage({
    event: { id: "source-1", timestamp: 1_710_000_000 },
    payload,
    platform: {
      chatJid: conversationId,
      recipientJid: "bot@s.whatsapp.net",
      senderJid: "person@s.whatsapp.net",
      senderE164: "+10000000001",
      senderName: "Person",
    },
    admission: {
      accountId,
      conversation: { kind: "group", id: conversationId },
      sender: { id: "+10000000001" },
      trustedGroup: true,
      duoRoom: true,
    },
    group: { subject: "Trusted Group", participants: ["person", "bot"] },
  });
}

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    SessionKey: route.sessionKey,
    AccountId: accountId,
    MessageSid: "source-1",
    Timestamp: 1_710_000_000,
    RawBody: "hello",
    BodyForAgent: "hello",
    CommandBody: "hello",
    SenderId: "+10000000001",
    SenderName: "Person",
    SenderE164: "+10000000001",
    GroupSubject: "Trusted Group",
    GroupMembers: "Person, brodie (you)",
    ParticipantCount: 2,
    ...overrides,
  };
}

describe("WhatsApp scheduler admission", () => {
  beforeEach(() => {
    admit.mockReset();
    settle.mockReset();
    admit.mockResolvedValue({ accepted: true, receiptId: "receipt-1", durableAt: 10 });
    settle.mockResolvedValue(true);
  });

  it("materializes one typed account-aware event with managed media references", async () => {
    const imagePath = path.join(inboundMediaDir, "source-1.jpg");
    const quotedImagePath = path.join(inboundMediaDir, "quoted-1.jpg");
    writeFileSync(imagePath, "image");
    writeFileSync(quotedImagePath, "quoted image");
    const ctx = makeContext({
      MediaPaths: [imagePath],
      MediaTypes: ["image/jpeg"],
      ReplyToId: "quoted-1",
      ReplyToBody: "earlier",
      ReplyToMediaPaths: [quotedImagePath],
      ReplyToMediaTypes: ["image/jpeg"],
      LocationLat: 35.6,
      LocationLon: 139.7,
    });

    const envelope = buildWhatsAppScheduledEnvelope({ ctx, msg: makeMessage() });
    expect(envelope).toMatchObject({
      version: 1,
      accountId,
      conversationId,
      sessionKey: route.sessionKey,
      messageId: "source-1",
      duoRoom: true,
      rawKind: "media",
      quote: {
        messageId: "quoted-1",
        body: "earlier",
        media: [
          expect.objectContaining({
            mediaRef: "media://inbound/quoted-1.jpg",
            sourceMessageId: "quoted-1",
            sourceIndex: 0,
          }),
        ],
      },
      location: { latitude: 35.6, longitude: 139.7 },
    });
    expect(envelope.media).toEqual([
      expect.objectContaining({
        id: "source-1:0",
        uri: "media://inbound/source-1.jpg",
        sourceMessageId: "source-1",
      }),
    ]);

    const result = await admitWhatsAppScheduledInbound({ cfg, ctx, msg: makeMessage() });
    expect(result.result.accepted).toBe(true);
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `${route.queueLaneKey}:source-1`,
        route: expect.objectContaining({
          queueLaneKey: route.queueLaneKey,
          sessionKey: route.sessionKey,
        }),
        producerKind: "human_location",
        human: true,
        media: true,
      }),
    );
    expect(JSON.stringify(admit.mock.calls[0]?.[0].payload)).not.toContain("undefined");
  });

  it("keeps authored, agent, and command bodies separate for native mentions", () => {
    const authoredBody = "@277038292303944 check";
    const bodyForAgent = "@Ada [+15551234567][277038292303944@lid] check";
    const commandBody = "check";
    const envelope = buildWhatsAppScheduledEnvelope({
      ctx: makeContext({
        RawBody: authoredBody,
        BodyForAgent: bodyForAgent,
        CommandBody: commandBody,
      }),
      msg: makeMessage({ body: authoredBody, commandBody }),
    });

    expect(envelope).toMatchObject({
      body: authoredBody,
      bodyForAgent,
      commandBody,
    });
  });

  it("declines ownership and preserves native fallback when preparation is invalid", async () => {
    const onError = vi.fn();
    const result = await admitWhatsAppScheduledInbound({
      cfg,
      ctx: makeContext({ SessionKey: undefined }),
      msg: makeMessage(),
      onError,
    });
    expect(result.result).toEqual({ accepted: false, reason: "invalid" });
    expect(admit).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("settles the durable receipt through the shared scheduler", async () => {
    const result = { outcome: "implicit_silence", transcriptEvidence: "session:key" } as const;
    await expect(settleWhatsAppScheduledInbound({ receiptId: "receipt-1", result })).resolves.toBe(
      true,
    );
    expect(settle).toHaveBeenCalledWith("receipt-1", result);
  });
});
