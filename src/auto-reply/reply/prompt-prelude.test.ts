// Tests prompt prelude construction for sender, routing, and context metadata.
import { describe, expect, it } from "vitest";
import { MESSAGE_TOOL_ONLY_DELIVERY_HINT } from "../../plugin-sdk/message-tool-delivery-hints.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { buildReplyPromptEnvelope } from "./prompt-prelude.js";

function countOccurrences(text: string | undefined, needle: string): number {
  return (text?.split(needle).length ?? 1) - 1;
}

describe("buildReplyPromptEnvelope", () => {
  it("keeps the authored reset command separate from the exact model-visible reset input", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "/reset",
      BodyStripped: "",
      RawBody: "/reset",
      CommandBody: "/reset",
      Provider: "telegram",
      ChatType: "direct",
      SenderId: "telegram-user-1",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "A new session was started via /new or /reset.",
      hasUserBody: true,
      inboundUserContext: "Conversation info (untrusted metadata):\nsender_id=telegram-user-1",
      isBareSessionReset: true,
      startupAction: "reset",
      startupContextPrelude: "Startup context",
    });

    expect(envelope.prefixedCommandBody).toContain("sender_id=telegram-user-1");
    expect(envelope.prefixedCommandBody).toContain("Startup context");
    expect(envelope.effectiveBaseBody).toBe(
      [
        "Conversation info (untrusted metadata):\nsender_id=telegram-user-1",
        "Startup context",
        "A new session was started via /new or /reset.",
      ].join("\n\n"),
    );
    expect(envelope.transcriptCommandBody).toBe("/reset");
    expect(envelope.transcriptCommandBody).not.toContain("[OpenClaw session");
    expect(envelope.currentInboundContext).toBeUndefined();
  });

  it("keeps ordinary inbound context runtime-only while preserving transcript text", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "what changed?",
      BodyStripped: "what changed?",
      Provider: "slack",
      ChatType: "group",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "what changed?",
      prefixedBody: "what changed?",
      hasUserBody: true,
      inboundUserContext: "Current message:\nchat_id=C123",
      inboundUserContextPromptJoiner: " ",
      isBareSessionReset: false,
      startupAction: "new",
    });

    expect(envelope.prefixedCommandBody).toBe("what changed?");
    expect(envelope.transcriptCommandBody).toBe("what changed?");
    expect(envelope.currentInboundContext).toEqual({
      text: "Current message:\nchat_id=C123",
      promptJoiner: " ",
    });
  });

  it("adds one message-tool delivery hint to user-request runtime context only", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "@bot what changed?",
      BodyStripped: "what changed?",
      Provider: "telegram",
      ChatType: "group",
      InboundEventKind: "user_request",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "what changed?",
      prefixedBody: "what changed?",
      hasUserBody: true,
      inboundUserContext: "Current message:\nchat_id=-100123",
      isBareSessionReset: false,
      startupAction: "new",
      inboundEventKind: "user_request",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(
      countOccurrences(envelope.currentInboundContext?.text, MESSAGE_TOOL_ONLY_DELIVERY_HINT),
    ).toBe(1);
    expect(envelope.prefixedCommandBody).toBe("what changed?");
    expect(envelope.transcriptCommandBody).toBe("what changed?");
    expect(envelope.transcriptCommandBody).not.toContain(MESSAGE_TOOL_ONLY_DELIVERY_HINT);
  });

  it.each([undefined, "automatic"] as const)(
    "omits user-request delivery hints for %s delivery",
    (sourceReplyDeliveryMode) => {
      const sessionCtx = finalizeInboundContext({
        Body: "@bot what changed?",
        BodyStripped: "what changed?",
        Provider: "telegram",
        ChatType: "group",
        InboundEventKind: "user_request",
      });

      const envelope = buildReplyPromptEnvelope({
        ctx: sessionCtx,
        sessionCtx,
        baseBody: "what changed?",
        prefixedBody: "what changed?",
        hasUserBody: true,
        inboundUserContext: "Current message:\nchat_id=-100123",
        isBareSessionReset: false,
        startupAction: "new",
        inboundEventKind: "user_request",
        sourceReplyDeliveryMode,
      });

      expect(envelope.currentInboundContext?.text).not.toContain(MESSAGE_TOOL_ONLY_DELIVERY_HINT);
    },
  );

  it("projects room events as context instead of user requests", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "No wtf",
      BodyStripped: "No wtf",
      Provider: "telegram",
      ChatType: "group",
      InboundEventKind: "room_event",
      MessageSid: "35676",
      SenderName: "Keśava",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "No wtf",
      hasUserBody: true,
      inboundUserContext: [
        "Conversation info (untrusted metadata):",
        "```json",
        JSON.stringify({ message_id: "35676", inbound_event_kind: "room_event" }, null, 2),
        "```",
        "",
        "Conversation context (untrusted, chronological, selected for current message):",
        "#35674 Other: I wish I could enjoy 5.5",
        "#35675 User ->#35674: Are you fr fr",
      ].join("\n"),
      isBareSessionReset: false,
      startupAction: "new",
      inboundEventKind: "room_event",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(envelope.prefixedCommandBody).toBe("[OpenClaw room event]");
    expect(envelope.queuedBody).toBe("[OpenClaw room event]");
    expect(envelope.transcriptCommandBody).toBe("#35676 Keśava: No wtf");
    expect(envelope.currentInboundContext?.text).toBe(
      [
        "[OpenClaw room event]",
        "inbound_event_kind: room_event",
        [
          "Room context:",
          "Conversation info (untrusted metadata):",
          "```json",
          JSON.stringify({ message_id: "35676", inbound_event_kind: "room_event" }, null, 2),
          "```",
          "",
          "Conversation context (untrusted, chronological, selected for current message):",
          "#35674 Other: I wish I could enjoy 5.5",
          "#35675 User ->#35674: Are you fr fr",
        ].join("\n"),
        "Current event:\n#35676 Keśava: No wtf",
        "Treat this as observed room activity. Default: no response; most room events need nothing from you. Reply via message(action=reply) only when directly addressed or you have concrete value to add; your final text stays private either way.",
      ].join("\n\n"),
    );
    expect(envelope.currentInboundContext?.resumableText).toBe(
      [
        "[OpenClaw room event]",
        "inbound_event_kind: room_event",
        [
          "Room context:",
          "Conversation info (untrusted metadata):",
          "```json",
          JSON.stringify({ message_id: "35676", inbound_event_kind: "room_event" }, null, 2),
          "```",
        ].join("\n"),
        "Current event:\n#35676 Keśava: No wtf",
        "Treat this as observed room activity. Default: no response; most room events need nothing from you. Reply via message(action=reply) only when directly addressed or you have concrete value to add; your final text stays private either way.",
      ].join("\n\n"),
    );
    expect(envelope.currentInboundContext?.resumableText).not.toContain(
      "Conversation context (untrusted, chronological, selected for current message):",
    );
  });

  it("uses attributed coalesced room-event lines for current event and transcript", () => {
    const ambientTranscriptBody = ["#35676 Keśava: No wtf", "#35677 Ayaan: fr"].join("\n");
    const sessionCtx = finalizeInboundContext({
      Body: "No wtf\nfr",
      BodyStripped: "No wtf\nfr",
      Provider: "telegram",
      ChatType: "group",
      InboundEventKind: "room_event",
      MessageSid: "35677",
      SenderName: "Ayaan",
      AmbientTranscriptBody: ambientTranscriptBody,
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "No wtf\nfr",
      hasUserBody: true,
      inboundUserContext: "Conversation context:",
      isBareSessionReset: false,
      startupAction: "new",
      inboundEventKind: "room_event",
    });

    expect(envelope.transcriptCommandBody).toBe(ambientTranscriptBody);
    expect(envelope.currentInboundContext?.text).toContain(
      `Current event:\n${ambientTranscriptBody}`,
    );
  });

  it("uses the raw current body for room-event current event text", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "[Chat history]\nAlice: old context\n\nBob: current note",
      BodyStripped: "[Chat history]\nAlice: old context\n\nBob: current note",
      RawBody: "current note",
      CommandBody: "current note",
      Provider: "telegram",
      ChatType: "group",
      InboundEventKind: "room_event",
      MessageSid: "2002",
      SenderName: "Bob",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: sessionCtx.Body ?? "",
      hasUserBody: true,
      inboundUserContext: "Chat history since last reply:\nAlice: old context",
      isBareSessionReset: false,
      startupAction: "new",
      inboundEventKind: "room_event",
    });

    expect(envelope.currentInboundContext?.text).toContain("Room context:");
    expect(envelope.currentInboundContext?.text).toContain("Alice: old context");
    expect(envelope.currentInboundContext?.text).toContain(
      "Current event:\n#2002 Bob: current note",
    );
    expect(envelope.currentInboundContext?.text).toContain(
      "Treat this as observed room activity. Default: no reply; most room events need no response from you. Reply only when you are directly addressed or have concrete value to add.",
    );
    expect(envelope.currentInboundContext?.text).not.toContain("message(action=send)");
    expect(envelope.currentInboundContext?.text).not.toContain(
      "your final text here stays private",
    );
    expect(envelope.currentInboundContext?.text).not.toContain(
      "Current event:\n#2002 Bob: [Chat history]",
    );
  });

  it("keeps media-only notes in ordinary user request transcripts", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "",
      BodyStripped: "",
      Provider: "telegram",
      ChatType: "group",
      MediaPaths: ["/tmp/openclaw-photo.jpg"],
      MediaUrls: ["https://example.com/photo.jpg"],
      InboundHistory: [{ sender: "Alice", timestamp: 1_700_000_000_000, body: "context" }],
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "",
      hasUserBody: true,
      inboundUserContext: "Current message:\nchat_id=G1",
      isBareSessionReset: false,
      startupAction: "new",
    });

    expect(envelope.transcriptCommandBody).toContain("[media attached");
    expect(envelope.transcriptCommandBody).toContain("https://example.com/photo.jpg");
  });

  it("keeps scheduler envelopes first and suppresses duplicate legacy media text", () => {
    const queueEnvelope = [
      "[📋 QUEUE ENGINE]: [THE FOLLOWING MESSAGE ARRIVED WHILE YOU WERE IDLE]",
      "",
      "[Conversation Metadata]:",
      '```json\n{"channel":"discord"}\n```',
      "Message Media:",
      '```json\n[{"media_reference":"media://inbound/image.png"}]\n```',
    ].join("\n");
    const humanInboundBatch = {
      version: 1,
      placement: "idle",
      inbounds: [{}],
    } as NonNullable<Parameters<typeof buildReplyPromptEnvelope>[0]["ctx"]["HumanInboundBatch"]>;
    const sessionCtx = finalizeInboundContext({
      Body: queueEnvelope,
      BodyStripped: queueEnvelope,
      Provider: "discord",
      ChatType: "group",
      HumanInboundBatch: humanInboundBatch,
      MediaPaths: ["/tmp/openclaw-staged-image.png"],
      MediaTypes: ["image/png"],
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: queueEnvelope,
      prefixedBody: `Note: previous run was aborted.\n\n${queueEnvelope}`,
      hasUserBody: true,
      inboundUserContext: "Active goal: finish the current rollout.",
      isBareSessionReset: false,
      startupAction: "new",
      threadContextNote: "[Thread history - for context]\nprior thread message",
      systemEventBlocks: ["System: [t] Model switched."],
      inboundEventKind: "user_request",
      sourceReplyDeliveryMode: "message_tool_only",
    });

    expect(envelope.prefixedCommandBody.startsWith("[📋 QUEUE ENGINE]:")).toBe(true);
    expect(envelope.queuedBody.startsWith("[📋 QUEUE ENGINE]:")).toBe(true);
    expect(envelope.prefixedCommandBody).not.toContain("[media attached:");
    expect(envelope.queuedBody).not.toContain("[media attached:");
    expect(envelope.mediaNote).toBeUndefined();
    expect(envelope.currentInboundContext).toMatchObject({
      text: "Active goal: finish the current rollout.",
      placement: "tail",
    });
  });

  it("persists the complete authored soft reset without leaking startup context", () => {
    const sessionCtx = finalizeInboundContext({
      Body: "/reset soft re-read persona files",
      BodyStripped: "",
      RawBody: "/reset soft re-read persona files",
      CommandBody: "/reset soft re-read persona files",
      Provider: "slack",
      ChatType: "direct",
    });

    const envelope = buildReplyPromptEnvelope({
      ctx: sessionCtx,
      sessionCtx,
      baseBody: "",
      hasUserBody: true,
      inboundUserContext: 'Conversation info (untrusted metadata):\n{"sender":{"id":"U123"}}',
      isBareSessionReset: true,
      startupAction: "reset",
      startupContextPrelude: "Startup context",
      softResetTail: "re-read persona files",
    });

    expect(envelope.prefixedCommandBody).toContain("Conversation info (untrusted metadata):");
    expect(envelope.prefixedCommandBody).toContain("Startup context");
    expect(envelope.prefixedCommandBody).toContain("re-read persona files");
    expect(envelope.transcriptCommandBody).toBe("/reset soft re-read persona files");
    expect(envelope.transcriptCommandBody).not.toContain("Startup context");
  });
});
