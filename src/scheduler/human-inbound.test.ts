import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ConversationRoute } from "../routing/conversation-route.js";
import {
  DERIVED_MEDIA_TRUST_LABEL,
  attachHumanInboundMediaUnderstanding,
  attachHumanInboundNativeImageInputs,
  interleaveHumanInboundProviderContent,
  materializeHumanInboundBatch,
  renderHumanInboundBatch,
  type HumanInboundEventPayload,
} from "./human-inbound.js";

const route: ConversationRoute = {
  channel: "whatsapp",
  accountId: "brodie",
  conversationKind: "group",
  conversationId: "1234567890@g.us",
  sessionKey: "agent:main:conversation:whatsapp:brodie:group:1234567890@g.us",
  queueLaneKey: "whatsapp:brodie:group:1234567890@g.us",
  transcriptOwner: {
    agentId: "main",
    sessionKey: "agent:main:conversation:whatsapp:brodie:group:1234567890@g.us",
  },
};

function payload(overrides: Partial<HumanInboundEventPayload> = {}): HumanInboundEventPayload {
  return {
    version: 1,
    channel: "whatsapp",
    accountId: "brodie",
    conversationId: route.conversationId,
    sessionKey: route.sessionKey,
    messageId: "message-image-1",
    receivedAt: Date.parse("2026-07-16T01:00:00.000Z"),
    chatType: "group",
    sender: { id: "resolved-owner-id", name: "Abhay" },
    body: "what do you notice here?",
    bodyForAgent: "what do you notice here?",
    commandBody: "what do you notice here?",
    commandAuthorized: false,
    wasMentioned: true,
    inboundEventKind: "user_request",
    media: [
      {
        kind: "image",
        mediaRef: "media://inbound/photo.jpg",
        managedLocalPath: "/managed/media/inbound/photo.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 2_400_000,
        sourceMessageId: "message-image-1",
        sourceIndex: 0,
        nativeImageCandidate: { contentHash: "sha256:example-image-hash" },
        understanding: [
          {
            kind: "image.description",
            text: "The image appears to show a handwritten diagram.",
            provider: "google",
            model: "configured-gemini-media-model",
            trust: "derived_untrusted",
          },
        ],
      },
    ],
    conversation: {
      channel: "whatsapp",
      conversationType: "group",
      conversationName: "example group",
      conversationMembers: [
        { label: "Abhay", id: "resolved-owner-id" },
        { label: "brodie", brodie: true },
      ],
      sessionKey: route.sessionKey,
    },
    nativeMetadata: {},
    ...overrides,
  };
}

describe("canonical human inbound", () => {
  it("renders a native image and separately labeled untrusted Gemini evidence", () => {
    const batch = materializeHumanInboundBatch({
      route,
      placement: "idle",
      payloads: [payload()],
    });
    const rendered = renderHumanInboundBatch(batch);

    expect(rendered).toContain(
      "[📋 QUEUE ENGINE]: [THE FOLLOWING MESSAGE ARRIVED WHILE YOU WERE IDLE]",
    );
    expect(rendered).toContain(
      '"session_key": "agent:main:conversation:whatsapp:brodie:group:1234567890@g.us"',
    );
    expect(rendered).toContain(
      "```\n[📨 DELIVERY-REMINDER]: the room only sees what you pass in 'visibleMessages' via the message tool, so don't yap in there\n\n[Inbound #1]: [Abhay]",
    );
    expect(rendered).toContain("[Inbound #1]: [Abhay]");
    expect(rendered).toContain('"native_image_input": "provider_image_block"');
    expect(rendered).toContain('"content_hash": "sha256:example-image-hash"');
    expect(rendered).toContain(`Media Understanding #1 (${DERIVED_MEDIA_TRUST_LABEL}):`);
    expect(rendered).toContain('"trust": "derived_untrusted"');
    expect(rendered).toContain("what do you notice here?");
    expect(rendered.match(/The image appears to show a handwritten diagram\./gu)).toHaveLength(1);
    expect(batch.inbounds[0]?.authoredBody).toBe("what do you notice here?");
    expect(batch.inbounds[0]?.bodyForAgent).toBe("what do you notice here?");
  });

  it("labels timestamps with the timezone that produced the wall clock", () => {
    const rendered = renderHumanInboundBatch(
      materializeHumanInboundBatch({
        route,
        placement: "idle",
        payloads: [payload({ media: [] })],
        timeZone: "America/New_York",
      }),
    );

    expect(rendered).toContain("America/New_York (GMT-4)");
    expect(rendered).not.toContain("JST (GMT+9)");
  });

  it("labels failed-run recovery instead of presenting it as a new idle arrival", () => {
    const rendered = renderHumanInboundBatch({
      ...materializeHumanInboundBatch({
        route,
        placement: "failed_run_recovery",
        payloads: [payload()],
      }),
      recovery: { failedOutcome: "retryable", committedReceiptIds: ["receipt-1"] },
    });

    expect(rendered).toMatch(/^\[📋 QUEUE ENGINE\]: \[THE FOLLOWING MESSAGE IS BEING RETRIED/u);
    expect(rendered).toContain('"committed_receipt_ids": [');
    expect(rendered).not.toContain("ARRIVED WHILE YOU WERE IDLE");
  });

  it("renders quoted media metadata once", () => {
    const quotedMedia = {
      kind: "image" as const,
      mediaRef: "media://inbound/quoted.jpg",
      mimeType: "image/jpeg",
      sourceMessageId: "quoted-message",
      sourceIndex: 0,
      understanding: [],
    };
    const rendered = renderHumanInboundBatch(
      materializeHumanInboundBatch({
        route,
        placement: "idle",
        payloads: [
          payload({
            media: [],
            quote: {
              sender: "friend",
              senderId: "friend-1",
              messageId: "quoted-message",
              media: [quotedMedia],
            },
          }),
        ],
      }),
    );

    expect(rendered.match(/media:\/\/inbound\/quoted\.jpg/gu)).toHaveLength(1);
    expect(rendered.match(/Quoted Message Media:/gu)).toHaveLength(1);
  });

  it("keeps every source attributed and every derived output outside authored bodies", () => {
    const batch = materializeHumanInboundBatch({
      route,
      placement: "idle",
      payloads: [
        payload({
          messageId: "audio-1",
          sender: { id: "owner", name: "Abhay" },
          body: undefined,
          bodyForAgent: undefined,
          media: [
            {
              kind: "audio",
              mediaRef: "media://inbound/voice.ogg",
              sourceMessageId: "audio-1",
              sourceIndex: 0,
              understanding: [
                {
                  kind: "audio.transcription",
                  text: "compare this with the next file",
                  provider: "google",
                  model: "gemini-audio",
                  trust: "derived_untrusted",
                },
              ],
            },
          ],
        }),
        payload({
          messageId: "file-1",
          sender: { id: "friend", name: "friend" },
          body: "use this as reference ``` inside",
          bodyForAgent: "use this as reference ``` inside",
          media: [
            {
              kind: "file",
              mediaRef: "media://inbound/reference.pdf",
              managedLocalPath: "/managed/media/inbound/reference.pdf",
              fileName: "reference.pdf",
              sourceMessageId: "file-1",
              sourceIndex: 0,
              understanding: [
                {
                  kind: "file.extraction",
                  text: "complete extracted document text",
                  provider: "openclaw",
                  model: "document-extractor",
                  trust: "derived_untrusted",
                },
              ],
            },
          ],
        }),
      ],
    });
    const rendered = renderHumanInboundBatch(batch);

    expect(rendered).toContain("[Inbound #1]: [Abhay]");
    expect(rendered).toContain("[Inbound #2]: [friend]");
    expect(rendered).toContain("Message Body: [EMPTY]");
    expect(rendered).toContain("````text\nuse this as reference ``` inside\n````");
    expect(batch.inbounds[0]?.authoredBody).toBeUndefined();
    expect(batch.inbounds[0]?.bodyForAgent).toBeUndefined();
    expect(batch.inbounds[1]?.authoredBody).toBe("use this as reference ``` inside");
    expect(rendered.match(new RegExp(DERIVED_MEDIA_TRUST_LABEL, "gu"))).toHaveLength(2);
  });

  it("attaches media understanding and managed file facts by source without mutating authored text", () => {
    const source = payload({
      body: "read this",
      bodyForAgent: "read this",
      media: [
        {
          kind: "file",
          mediaRef: "media://staged/message-image-1/0",
          sourceMessageId: "message-image-1",
          sourceIndex: 0,
          understanding: [],
        },
      ],
    });
    const batch = materializeHumanInboundBatch({ route, placement: "idle", payloads: [source] });
    const enriched = attachHumanInboundMediaUnderstanding({
      batch,
      outputs: [
        {
          kind: "file.extraction",
          attachmentIndex: 0,
          text: "derived document text",
          provider: "openclaw",
          model: "extractor",
        },
      ],
      externalFiles: [
        {
          attachmentIndex: 0,
          mediaRef: "media://inbound/reference.pdf",
          originalPath: "/managed/reference.pdf",
          fileName: "reference.pdf",
          mimeType: "application/pdf",
          byteSize: 42,
          sourceMessageId: "message-image-1",
          sourceIndex: 0,
        },
      ],
    });

    expect(enriched.inbounds[0]).toMatchObject({
      authoredBody: "read this",
      bodyForAgent: "read this",
      media: [
        {
          mediaRef: "media://inbound/reference.pdf",
          managedLocalPath: "/managed/reference.pdf",
          understanding: [
            {
              kind: "file.extraction",
              text: "derived document text",
              provider: "openclaw",
              model: "extractor",
              trust: "derived_untrusted",
            },
          ],
        },
      ],
    });
  });

  it("renders room markers, snake-case context, stable media numbering, and event literals", () => {
    const rendered = renderHumanInboundBatch(
      materializeHumanInboundBatch({
        route,
        placement: "idle",
        payloads: [
          payload({
            inboundEventKind: "room_event",
            wasMentioned: false,
            eventType: "sticker",
            body: undefined,
            bodyForAgent: undefined,
            quotePosition: 2,
            reaction: { emoji: "👀" },
            quote: {
              sender: "friend",
              senderId: "friend-id",
              messageId: "quoted-1",
              quoteText: "earlier",
            },
            forward: {
              forwardedFrom: "example room",
              forwardedFromId: "room-1",
              forwardedFromUsername: "example",
              forwardedAt: "Thursday, 2026-07-16 9:00:00 AM JST (GMT+9)",
            },
            location: {
              latitude: 35.6586,
              longitude: 139.7454,
              accuracyM: 10,
            },
            media: [
              {
                kind: "image",
                mediaRef: "media://inbound/one.jpg",
                sourceMessageId: "message-image-1",
                sourceIndex: 0,
                understanding: [
                  {
                    kind: "image.description",
                    text: "first description",
                    provider: "google",
                    trust: "derived_untrusted",
                  },
                ],
              },
              {
                kind: "file",
                mediaRef: "media://inbound/two.pdf",
                sourceMessageId: "message-image-1",
                sourceIndex: 1,
                understanding: [
                  {
                    kind: "file.extraction",
                    text: "second description",
                    provider: "openclaw",
                    trust: "derived_untrusted",
                  },
                ],
              },
            ],
          }),
        ],
      }),
    );

    expect(rendered).toContain("[ROOM EVENT]\n[NOT MENTIONED]\nMessage Metadata:");
    expect(rendered).toContain('"event_type": "sticker"');
    expect(rendered).toContain('"quote_position": 2');
    expect(rendered).toContain('"quote_text": "earlier"');
    expect(rendered).toContain('"forwarded_from_id": "room-1"');
    expect(rendered).toContain('"accuracy_m": 10');
    expect(rendered).not.toContain("forwardedFromId");
    expect(rendered).not.toContain("accuracyM");
    expect(rendered).toContain(`Media Understanding #1 (${DERIVED_MEDIA_TRUST_LABEL}):`);
    expect(rendered).toContain(`Media Understanding #2 (${DERIVED_MEDIA_TRUST_LABEL}):`);
    expect(rendered).toContain("```text\n[sent a sticker]\n```");
  });

  it("attaches native evidence to quoted media by exact source identity", () => {
    const batch = materializeHumanInboundBatch({
      route,
      placement: "idle",
      payloads: [
        payload({
          quote: {
            sender: "friend",
            senderId: "friend-id",
            messageId: "quoted-message",
            media: [
              {
                kind: "image",
                mediaRef: "media://inbound/quoted.png",
                sourceMessageId: "quoted-message",
                sourceIndex: 0,
                understanding: [],
              },
            ],
          },
        }),
      ],
    });
    const enriched = attachHumanInboundNativeImageInputs({
      batch,
      inputs: [
        {
          attachmentIndex: 0,
          sourceMessageId: "quoted-message",
          sourceIndex: 0,
          contentHash: "sha256:quoted",
        },
      ],
    });

    expect(enriched.inbounds[0]?.quote?.media?.[0]?.nativeImageCandidate).toEqual({
      contentHash: "sha256:quoted",
    });
    expect(renderHumanInboundBatch(enriched)).toContain('"content_hash": "sha256:quoted"');
  });

  it("attaches derived understanding to quoted media without mutating current media", () => {
    const batch = materializeHumanInboundBatch({
      route,
      placement: "idle",
      payloads: [
        payload({
          quote: {
            sender: "friend",
            senderId: "friend-id",
            messageId: "quoted-message",
            media: [
              {
                kind: "image",
                mediaRef: "media://inbound/quoted.png",
                sourceMessageId: "quoted-message",
                sourceIndex: 0,
                understanding: [],
              },
            ],
          },
          media: [
            {
              kind: "image",
              mediaRef: "media://inbound/current.png",
              sourceMessageId: "message-image-1",
              sourceIndex: 0,
              understanding: [],
            },
          ],
        }),
      ],
    });
    const enriched = attachHumanInboundMediaUnderstanding({
      batch,
      outputs: [
        {
          attachmentIndex: 0,
          kind: "image.description",
          text: "quoted description",
          provider: "google",
          model: "gemini",
        },
      ],
    });

    expect(enriched.inbounds[0]?.quote?.media?.[0]?.understanding).toMatchObject([
      { text: "quoted description", trust: "derived_untrusted" },
    ]);
    expect(enriched.inbounds[0]?.media[0]?.understanding).toEqual([]);
  });

  it("places each provider image after its source inbound instead of after the batch", () => {
    const firstBytes = Buffer.from("first-image").toString("base64");
    const secondBytes = Buffer.from("second-image").toString("base64");
    const firstHash = `sha256:${createHash("sha256").update(Buffer.from(firstBytes, "base64")).digest("hex")}`;
    const secondHash = `sha256:${createHash("sha256").update(Buffer.from(secondBytes, "base64")).digest("hex")}`;
    const batch = attachHumanInboundNativeImageInputs({
      batch: materializeHumanInboundBatch({
        route,
        placement: "idle",
        payloads: [
          payload({
            messageId: "first",
            body: "first body",
            bodyForAgent: "first body",
            media: [
              {
                kind: "image",
                mediaRef: "media://first.png",
                sourceMessageId: "first",
                sourceIndex: 0,
                understanding: [],
              },
            ],
          }),
          payload({
            messageId: "second",
            body: "second body",
            bodyForAgent: "second body",
            media: [
              {
                kind: "image",
                mediaRef: "media://second.png",
                sourceMessageId: "second",
                sourceIndex: 0,
                understanding: [],
              },
            ],
          }),
        ],
      }),
      inputs: [
        { attachmentIndex: 0, sourceMessageId: "first", sourceIndex: 0, contentHash: firstHash },
        { attachmentIndex: 1, sourceMessageId: "second", sourceIndex: 0, contentHash: secondHash },
      ],
    });
    const content = interleaveHumanInboundProviderContent({
      batch,
      content: [
        { type: "text", text: renderHumanInboundBatch(batch) },
        { type: "image", data: firstBytes, mimeType: "image/png" },
        { type: "image", data: secondBytes, mimeType: "image/png" },
      ],
    });

    expect(content.map((block) => block.type)).toEqual(["text", "text", "image", "text", "image"]);
    expect(content[1]?.text).toContain("[Inbound #1]");
    expect(content[3]?.text).toContain("[Inbound #2]");
    expect(content[2]?.data).toBe(firstBytes);
    expect(content[4]?.data).toBe(secondBytes);
  });
});
