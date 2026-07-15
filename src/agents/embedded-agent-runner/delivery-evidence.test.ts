import { describe, expect, it } from "vitest";
import {
  collectDeliveredMediaUrls,
  hasProvisionalMessageToolDeliveryEvidence,
  hasVisibleTerminalOutboundDeliveryEvidence,
  hasVisibleOutboundDeliveryEvidence,
  isAbortedRunTerminalFailure,
} from "./delivery-evidence.js";

describe("visible messaging-tool delivery evidence", () => {
  it("keeps the coarse flag when detailed delivery metadata is unavailable", () => {
    expect(hasVisibleOutboundDeliveryEvidence({ didSendViaMessagingTool: true })).toBe(true);
  });

  it("lets detailed metadata disprove a coarse send flag", () => {
    expect(
      hasVisibleOutboundDeliveryEvidence({
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["  "],
        messagingToolSentMediaUrls: ["\t"],
        messagingToolSentTargets: [{ text: "\n" }],
      }),
    ).toBe(false);
  });

  it("keeps rich delivery evidence when accompanying text is blank", () => {
    expect(
      hasVisibleOutboundDeliveryEvidence({
        didSendViaMessagingTool: true,
        messagingToolSentTexts: [],
        messagingToolSentMediaUrls: [],
        messagingToolSentTargets: [{ text: "  ", hasRichContent: true }],
      }),
    ).toBe(true);
  });
});

describe("terminal messaging-tool delivery evidence", () => {
  it("finds provisional evidence in generic and source-reply envelopes", () => {
    expect(
      hasProvisionalMessageToolDeliveryEvidence({
        messageToolDeliveryState: "provisional",
      }),
    ).toBe(true);
    expect(
      hasProvisionalMessageToolDeliveryEvidence({
        messageToolSourceReplyDeliveryState: "provisional",
      }),
    ).toBe(true);
    expect(
      hasProvisionalMessageToolDeliveryEvidence({
        messageToolDeliveryState: "terminal",
        messageToolSourceReplyDeliveryState: "terminal",
      }),
    ).toBe(false);
  });

  it("does not treat a provisional source acknowledgement as terminal delivery", () => {
    expect(
      hasVisibleTerminalOutboundDeliveryEvidence({
        didSendViaMessagingTool: true,
        didDeliverSourceReplyViaMessageTool: true,
        messageToolSourceReplyDeliveryState: "provisional",
        messagingToolSentTexts: ["one sec"],
        messagingToolSentTargets: [{ text: "one sec" }],
      }),
    ).toBe(false);
  });

  it("does not treat a generic provisional send as terminal delivery", () => {
    expect(
      hasVisibleTerminalOutboundDeliveryEvidence({
        didSendViaMessagingTool: true,
        didDeliverSourceReplyViaMessageTool: true,
        messageToolDeliveryState: "provisional",
        messagingToolSentTexts: ["one sec"],
        messagingToolSentTargets: [{ text: "one sec" }],
      }),
    ).toBe(false);
  });

  it("does not treat target-only provisional metadata as terminal delivery", () => {
    expect(
      hasVisibleTerminalOutboundDeliveryEvidence({
        didSendViaMessagingTool: true,
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "discord",
            to: "channel:brodie-only",
            messageToolDeliveryState: "provisional",
          },
        ],
      }),
    ).toBe(false);
  });

  it("treats terminal and legacy generic sends as terminal delivery", () => {
    expect(
      hasVisibleTerminalOutboundDeliveryEvidence({
        messageToolDeliveryState: "terminal",
      }),
    ).toBe(true);
    expect(
      hasVisibleTerminalOutboundDeliveryEvidence({
        messagingToolSentTexts: ["legacy send"],
      }),
    ).toBe(true);
  });

  it("treats terminal and legacy source replies as terminal delivery", () => {
    expect(
      hasVisibleTerminalOutboundDeliveryEvidence({
        didDeliverSourceReplyViaMessageTool: true,
        messageToolSourceReplyDeliveryState: "terminal",
      }),
    ).toBe(true);
    expect(
      hasVisibleTerminalOutboundDeliveryEvidence({
        didDeliverSourceReplyViaMessageTool: true,
      }),
    ).toBe(true);
  });

  it("preserves generic non-source sends and accepted side effects as terminal", () => {
    expect(
      hasVisibleTerminalOutboundDeliveryEvidence({
        messagingToolSentTexts: ["cross-channel update"],
      }),
    ).toBe(true);
    expect(
      hasVisibleTerminalOutboundDeliveryEvidence({
        didSendViaMessagingTool: true,
        messageToolDeliveryState: "terminal",
        didDeliverSourceReplyViaMessageTool: true,
        messageToolSourceReplyDeliveryState: "provisional",
        messagingToolSourceReplyPayloads: [{ text: "one sec" }],
        messagingToolSentTexts: ["one sec", "cross-channel update"],
        messagingToolSentTargets: [{ text: "one sec" }, { text: "cross-channel update" }],
      }),
    ).toBe(true);
    expect(
      hasVisibleTerminalOutboundDeliveryEvidence({
        didDeliverSourceReplyViaMessageTool: true,
        messageToolSourceReplyDeliveryState: "provisional",
        successfulCronAdds: 1,
      }),
    ).toBe(true);
    expect(
      hasVisibleTerminalOutboundDeliveryEvidence({
        messageToolDeliveryState: "provisional",
        acceptedSessionSpawns: [{ runId: "child", childSessionKey: "agent:main:child" }],
      }),
    ).toBe(true);
  });
});

describe("aborted terminal outcome evidence", () => {
  it("preserves a completed media payload without duplicated visible-text metadata", () => {
    expect(
      isAbortedRunTerminalFailure({
        payloads: [{ mediaUrl: "https://example.com/recovered.png" }],
        meta: { aborted: true, stopReason: "stop" },
      }),
    ).toBe(false);
  });

  it("does not promote commentary into a recovered terminal payload", () => {
    expect(
      isAbortedRunTerminalFailure({
        payloads: [{ text: "working", isCommentary: true }],
        meta: { aborted: true, stopReason: "stop" },
      }),
    ).toBe(true);
  });
});

describe("collectDeliveredMediaUrls attachment recursion", () => {
  it("collects media URLs across nested attachments", () => {
    const urls = collectDeliveredMediaUrls({
      payloads: [
        {
          url: "https://example.com/root.png",
          attachments: [
            { mediaUrl: "https://example.com/child.png" },
            { attachments: [{ filePath: "/tmp/grandchild.jpg" }] },
          ],
        },
      ],
    });
    expect(urls.toSorted()).toEqual([
      "/tmp/grandchild.jpg",
      "https://example.com/child.png",
      "https://example.com/root.png",
    ]);
  });

  it("does not overflow the stack on a self-referential attachments cycle", () => {
    // Payloads arrive as in-process `unknown` objects; a malformed self-referential
    // attachments chain previously recursed until the stack overflowed.
    const cyclic: Record<string, unknown> = { url: "https://example.com/loop.png" };
    cyclic.attachments = [cyclic];

    let urls: string[] = [];
    expect(() => {
      urls = collectDeliveredMediaUrls({ payloads: [cyclic] });
    }).not.toThrow();
    expect(urls).toEqual(["https://example.com/loop.png"]);
  });

  it("does not overflow on a mutual attachments cycle", () => {
    const a: Record<string, unknown> = { mediaUrl: "https://example.com/a.png" };
    const b: Record<string, unknown> = { mediaUrl: "https://example.com/b.png" };
    a.attachments = [b];
    b.attachments = [a];

    const urls = collectDeliveredMediaUrls({ payloads: [a] });
    expect(urls.toSorted()).toEqual(["https://example.com/a.png", "https://example.com/b.png"]);
  });
});
