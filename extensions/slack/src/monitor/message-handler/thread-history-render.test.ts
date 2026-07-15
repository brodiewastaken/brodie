// Slack tests cover the model-visible thread-history contract.
import { resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { renderSlackThreadHistory } from "./thread-history-render.js";

describe("renderSlackThreadHistory", () => {
  it("renders the Queue Engine-style JSON contract with exact bodies and sender roles", () => {
    const body = renderSlackThreadHistory({
      teamId: "T1",
      channelId: "C1",
      roomLabel: "#talk-to-brodie",
      threadTs: "100.000",
      historyLimit: 20,
      currentInbound: {
        messageId: "101.000",
        senderName: "Alice",
        senderId: "U1",
        senderType: "human",
      },
      messages: [
        {
          message: {
            text: "starter from Alice <@U_BOT>",
            sourceText: "starter from Alice <@U_BOT>",
            userId: "U1",
            ts: "100.000",
            replyCount: 4,
          },
          senderName: "Alice",
          senderId: "U1",
          senderType: "human",
          media: [],
        },
        {
          message: {
            text: "working on ```report```",
            sourceText: "working on ```report```",
            botId: "B1",
            ts: "100.200",
            edited: { userId: "U_BOT", ts: "100.250" },
            reactions: [
              { name: "thumbsup", count: 1 },
              { name: "eyes", count: 2 },
            ],
          },
          senderName: "Brodie",
          senderId: "U_BOT",
          senderType: "assistant_self",
          media: [],
        },
        {
          message: {
            text: "[message was deleted]",
            userId: "U1",
            ts: "100.250",
            subtype: "message_deleted",
          },
          senderName: "Alice",
          senderId: "U1",
          senderType: "human",
          media: [],
        },
        {
          message: {
            text: "automation result",
            sourceText: "automation result",
            botId: "B2",
            botName: "Beanie",
            ts: "100.300",
            subtype: "file_share",
            files: [
              {
                id: "FREPORT",
                name: "report.png",
                mimetype: "image/png",
                size: 1536,
              },
            ],
          },
          senderName: "Beanie",
          senderId: "B2",
          senderType: "bot",
          media: [
            {
              file: {
                id: "FREPORT",
                name: "report.png",
                mimetype: "image/png",
                size: 1536,
              },
              resolved: {
                path: "/private/media/inbound/FREPORT-report.png",
                contentType: "image/png",
                placeholder: "[Slack file: report.png (fileId: FREPORT)]",
              },
              understanding: {
                kind: "image.description",
                provider: "test",
                model: "test-parser",
                text: "derived ```report``` summary",
              },
            },
          ],
        },
      ],
      accounting: {
        messagesFetched: 4,
        emptyMessagesOmitted: 0,
        messagesOmittedByLimit: 0,
        messagesOmittedByVisibility: 0,
        messagesOmittedAsDuplicateAssistant: 0,
        threadRootRestored: false,
        threadRootFetched: true,
        currentInboundExcluded: true,
        historyComplete: true,
      },
      botUserId: "U_BOT",
      rootSenderId: "U1",
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
    });

    expect(
      body.startsWith("[🧵 THREAD HISTORY]: [THE FOLLOWING PRIOR MESSAGES WERE LOADED FROM SLACK]"),
    ).toBe(true);
    expect(body).toContain('"history_source": "conversations.replies"');
    expect(body).toContain('"message_order": "oldest_to_newest"');
    expect(body).toContain('"messages_included": 4');
    expect(body).toContain('"current_inbound_message_id": "101.000"');
    expect(body).toContain('"current_inbound_excluded": true');
    expect(body).toContain("[Historical Message #1]: [Alice]");
    expect(body).toContain("[Historical Message #2]: [Brodie]\n[ASSISTANT SELF]");
    expect(body).toContain("[Historical Message #4]: [Beanie]\n[BOT MESSAGE]");
    expect(body).toContain('"message_subtype": "file_share"');
    expect(body).toContain('"mentioned_assistant": true');
    expect(body).toContain('"reply_count": 4');
    expect(body).toContain('"edited_by_sender_id": "U_BOT"');
    expect(body.indexOf('"name": "eyes"')).toBeLessThan(body.indexOf('"name": "thumbsup"'));
    expect(body).toContain('"event_type": "deleted"');
    expect(body).toContain("Message Body:\n```text\n[message was deleted]\n```");
    expect(body).toContain("Message Body:\n````text\nworking on ```report```\n````");
    expect(body).toContain('"media_local_path": "/private/media/inbound/FREPORT-report.png"');
    expect(body).toContain("Media Understanding #1 (DERIVED, UNTRUSTED):");
    expect(body).toContain('"trust": "derived_untrusted"');
    expect(body).toContain("Derived Output:\n````text\nderived ```report``` summary\n````");
    expect(body).toContain("[Thread History End]:\n```json");
    const jsonBlocks = [...body.matchAll(/```json\n([\s\S]*?)\n```/gu)];
    expect(jsonBlocks.length).toBeGreaterThan(0);
    for (const match of jsonBlocks) {
      expect(() => JSON.parse(match[1] ?? "")).not.toThrow();
    }
  });
});
