// Slack tests cover thread-history normalization and accounting.
import type { WebClient } from "@slack/web-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveSlackThreadHistory,
  resolveSlackThreadStarter,
  resetSlackThreadStarterCacheForTest,
} from "./thread.js";
import { logVerbose } from "./thread.runtime.js";

const logVerboseMock = vi.hoisted(() => vi.fn());

vi.mock("./thread.runtime.js", () => ({
  logVerbose: logVerboseMock,
}));

type MockCallReader = { mock: { calls: unknown[][] } };

function requireMockCall(mock: unknown, index: number, label: string): unknown[] {
  const call = (mock as MockCallReader).mock.calls.at(index);
  if (!call) {
    throw new Error(`expected ${label} call ${index}`);
  }
  return call;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectVerboseLogContains(expected: string): void {
  const messages = vi
    .mocked(logVerbose)
    .mock.calls.map((call) => (typeof call[0] === "string" ? call[0] : ""));
  expect(messages.join("\n")).toContain(expected);
}

function createThreadClient(replies: ReturnType<typeof vi.fn>): WebClient {
  return {
    conversations: { replies },
  } as unknown as WebClient;
}

describe("resolveSlackThreadHistory metadata", () => {
  it("reports complete accounting and preserves Slack message metadata", async () => {
    const replies = vi.fn().mockResolvedValueOnce({
      messages: [
        {
          text: "root",
          user: "U1",
          ts: "1.000",
          reply_count: 4,
        },
        {
          text: "old reply",
          bot_id: "B2",
          username: "Beanie",
          ts: "2.000",
          edited: { user: "U2", ts: "2.500" },
          reactions: [{ name: "eyes", count: 2 }],
        },
        { text: "   ", user: "U1", ts: "3.000" },
        { subtype: "message_deleted", user: "U1", ts: "4.000" },
        { text: "current", user: "U1", ts: "5.000" },
      ],
      response_metadata: { next_cursor: "" },
    });

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client: createThreadClient(replies),
      currentMessageTs: "5.000",
      limit: 2,
    });

    expect(result).toMatchObject({
      messagesFetched: 4,
      currentInboundExcluded: true,
      emptyMessagesOmitted: 1,
      messagesOmittedByLimit: 1,
      threadRootFetched: true,
      historyComplete: true,
    });
    expect(result.messages).toEqual([
      expect.objectContaining({
        text: "old reply",
        sourceText: "old reply",
        botId: "B2",
        botName: "Beanie",
        edited: { userId: "U2", ts: "2.500" },
        reactions: [{ name: "eyes", count: 2 }],
      }),
      expect.objectContaining({
        text: "[message was deleted]",
        subtype: "message_deleted",
      }),
    ]);
  });

  it("returns retained messages with an incomplete marker when a later page fails", async () => {
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ text: "root", user: "U1", ts: "1.000" }],
        response_metadata: { next_cursor: "next" },
      })
      .mockRejectedValueOnce(new Error("page failed"));

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client: createThreadClient(replies),
      limit: 20,
    });

    expect(result.historyComplete).toBe(false);
    expect(result.messages.map((message) => message.text)).toEqual(["root"]);
  });
});

describe("resolveSlackThreadHistory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("paginates and returns the latest N messages across pages", async () => {
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        messages: Array.from({ length: 200 }, (_, i) => ({
          text: `msg-${i + 1}`,
          user: "U1",
          ts: `${i + 1}.000`,
        })),
        response_metadata: { next_cursor: "cursor-2" },
      })
      .mockResolvedValueOnce({
        messages: Array.from({ length: 60 }, (_, i) => ({
          text: `msg-${i + 201}`,
          user: "U1",
          ts: `${i + 201}.000`,
        })),
        response_metadata: { next_cursor: "" },
      });
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      currentMessageTs: "260.000",
      limit: 5,
    });

    expect(replies).toHaveBeenCalledTimes(2);
    const firstCall = requireRecord(
      requireMockCall(replies, 0, "conversations.replies")[0],
      "first replies params",
    );
    expect(firstCall.channel).toBe("C1");
    expect(firstCall.ts).toBe("1.000");
    expect(firstCall.limit).toBe(200);
    expect(firstCall.inclusive).toBe(true);
    const secondCall = requireRecord(
      requireMockCall(replies, 1, "conversations.replies")[0],
      "second replies params",
    );
    expect(secondCall.channel).toBe("C1");
    expect(secondCall.ts).toBe("1.000");
    expect(secondCall.limit).toBe(200);
    expect(secondCall.inclusive).toBe(true);
    expect(secondCall.cursor).toBe("cursor-2");
    expect(result.messages.map((entry) => entry.ts)).toEqual([
      "255.000",
      "256.000",
      "257.000",
      "258.000",
      "259.000",
    ]);
  });

  it("walks the complete cursor chain before retaining the latest messages", async () => {
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        messages: Array.from({ length: 200 }, (_, i) => ({
          text: `msg-${i + 1}`,
          user: "U1",
          ts: `${i + 1}.000`,
        })),
        response_metadata: { next_cursor: "cursor-2" },
      })
      .mockResolvedValueOnce({
        messages: Array.from({ length: 200 }, (_, i) => ({
          text: `msg-${i + 201}`,
          user: "U1",
          ts: `${i + 201}.000`,
        })),
        response_metadata: { next_cursor: "cursor-3" },
      })
      .mockResolvedValueOnce({
        messages: Array.from({ length: 200 }, (_, i) => ({
          text: `msg-${i + 401}`,
          user: "U1",
          ts: `${i + 401}.000`,
        })),
        response_metadata: { next_cursor: "cursor-4" },
      })
      .mockResolvedValueOnce({
        messages: Array.from({ length: 5 }, (_, i) => ({
          text: `msg-${i + 601}`,
          user: "U1",
          ts: `${i + 601}.000`,
        })),
        response_metadata: { next_cursor: "" },
      });
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 3,
    });

    expect(replies).toHaveBeenCalledTimes(4);
    expect(requireMockCall(replies, 3, "conversations.replies")[0]).toMatchObject({
      cursor: "cursor-4",
      limit: 200,
    });
    expect(result.messages.map((entry) => entry.ts)).toEqual(["603.000", "604.000", "605.000"]);
  });

  it("returns explicitly incomplete partial history when Slack repeats a pagination cursor", async () => {
    vi.mocked(logVerbose).mockClear();
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ text: "first", user: "U1", ts: "1.000" }],
        response_metadata: { next_cursor: "stuck" },
      })
      .mockResolvedValueOnce({
        messages: [{ text: "second", user: "U1", ts: "2.000" }],
        response_metadata: { next_cursor: "stuck" },
      });
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 3,
    });

    expect(replies).toHaveBeenCalledTimes(2);
    expect(result.historyComplete).toBe(false);
    expect(result.messages.map((message) => message.text)).toEqual(["first", "second"]);
    expectVerboseLogContains("slack thread history fetch failed");
    expectVerboseLogContains("repeated thread-history cursor");
  });

  it("includes file-only messages and drops empty-only entries", async () => {
    const replies = vi.fn().mockResolvedValueOnce({
      messages: [
        { text: "  ", ts: "1.000", files: [{ id: "FSCREEN", name: "screenshot.png" }] },
        { text: "   ", ts: "2.000" },
        { text: "hello", ts: "3.000", user: "U1" },
      ],
      response_metadata: { next_cursor: "" },
    });
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 10,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.text).toBe("[attached: screenshot.png (fileId: FSCREEN)]");
    expect(result.messages[1]?.text).toBe("hello");
  });

  it("extracts thread text from Slack attachment and block surfaces", async () => {
    const replies = vi.fn().mockResolvedValueOnce({
      messages: [
        {
          text: "  ",
          bot_id: "BMONITOR",
          ts: "1.000",
          attachments: [
            {
              title: "Filesystem on /dev/sda1 has only 14.93% available space left.",
              fallback: "Alert: filesystem space is low",
              fields: [{ title: "Host", value: "dc2.ipa.mgt" }],
            },
          ],
        },
        {
          text: "  ",
          bot_id: "BMONITOR",
          ts: "2.000",
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "Pod restart rate is high" } }],
        },
        {
          text: "  ",
          bot_id: "BMONITOR",
          ts: "3.000",
          attachments: [
            {
              blocks: [
                { type: "header", text: { type: "plain_text", text: "Alert firing" } },
                {
                  type: "section",
                  fields: [
                    { type: "mrkdwn", text: "*host:* dc2.ipa.mgt" },
                    { type: "mrkdwn", text: "*device:* /dev/sda1" },
                  ],
                },
                {
                  type: "section",
                  text: { type: "mrkdwn", text: "Free space below threshold" },
                },
              ],
            },
          ],
        },
        {
          text: "  line one\nline two  ",
          ts: "4.000",
        },
      ],
      response_metadata: { next_cursor: "" },
    });
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 10,
    });

    expect(result.messages.map((entry) => entry.text)).toEqual([
      "Filesystem on /dev/sda1 has only 14.93% available space left.\nAlert: filesystem space is low\nHost\ndc2.ipa.mgt",
      "Pod restart rate is high",
      "Alert firing\n*host:* dc2.ipa.mgt\n*device:* /dev/sda1\nFree space below threshold",
      "line one\nline two",
    ]);
    expect(result.messages.map((entry) => entry.botId)).toEqual([
      "BMONITOR",
      "BMONITOR",
      "BMONITOR",
      undefined,
    ]);
    expect(result.messages[3]?.sourceText).toBe("  line one\nline two  ");
  });

  it("returns empty when limit is zero without calling Slack API", async () => {
    const replies = vi.fn();
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 0,
    });

    expect(result.messages).toStrictEqual([]);
    expect(result.historyComplete).toBe(true);
    expect(replies).not.toHaveBeenCalled();
  });

  it("returns empty and surfaces the error via logVerbose when Slack API throws", async () => {
    vi.mocked(logVerbose).mockClear();
    const replies = vi.fn().mockRejectedValueOnce(new Error("slack down"));
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadHistory>[0]["client"];

    const result = await resolveSlackThreadHistory({
      channelId: "C1",
      threadTs: "1.000",
      client,
      limit: 20,
    });

    expect(result.messages).toStrictEqual([]);
    expect(result.historyComplete).toBe(false);
    expectVerboseLogContains("slack thread history fetch failed");
    expectVerboseLogContains("slack down");
    expectVerboseLogContains("channel=C1");
  });
});

describe("resolveSlackThreadStarter", () => {
  beforeEach(() => {
    resetSlackThreadStarterCacheForTest();
    vi.mocked(logVerbose).mockClear();
  });

  it("returns the starter message when the Slack API succeeds", async () => {
    const replies = vi.fn().mockResolvedValueOnce({
      messages: [{ text: "hello thread", user: "U1", ts: "1.000" }],
    });
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    const result = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1.000",
      client,
    });

    expect(result).toEqual({
      text: "hello thread",
      sourceText: "hello thread",
      userId: "U1",
      botId: undefined,
      ts: "1.000",
      files: undefined,
    });
    expect(vi.mocked(logVerbose)).not.toHaveBeenCalled();
  });

  it("returns null when the starter message has no text or files", async () => {
    const replies = vi.fn().mockResolvedValueOnce({ messages: [{ text: "   ", user: "U1" }] });
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    const result = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1.000",
      client,
    });

    expect(result).toBeNull();
    expect(vi.mocked(logVerbose)).not.toHaveBeenCalled();
  });

  it("returns the starter text from Slack attachments when bot message text is empty", async () => {
    const replies = vi.fn().mockResolvedValueOnce({
      messages: [
        {
          text: "   ",
          bot_id: "BMONITOR",
          ts: "1.000",
          attachments: [
            {
              pretext: "[FIRING:1] HostFilesystemSpaceLow",
              title: "Filesystem on /dev/sda1 has only 14.93% available space left.",
              fallback: "dc2.ipa.mgt /dev/sda1 low free space",
            },
          ],
        },
      ],
    });
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    const result = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1.000",
      client,
    });

    expect(result).toEqual({
      text: "[FIRING:1] HostFilesystemSpaceLow\nFilesystem on /dev/sda1 has only 14.93% available space left.\ndc2.ipa.mgt /dev/sda1 low free space",
      sourceText:
        "[FIRING:1] HostFilesystemSpaceLow\nFilesystem on /dev/sda1 has only 14.93% available space left.\ndc2.ipa.mgt /dev/sda1 low free space",
      userId: undefined,
      botId: "BMONITOR",
      ts: "1.000",
      files: undefined,
    });
    expect(vi.mocked(logVerbose)).not.toHaveBeenCalled();
  });

  it("returns a placeholder starter when the root message only has files", async () => {
    const replies = vi.fn().mockResolvedValueOnce({
      messages: [
        {
          text: "   ",
          user: "U1",
          ts: "1.000",
          files: [{ id: "FROOT", name: "root.png", mimetype: "image/png" }],
        },
      ],
    });
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    const result = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1.000",
      client,
    });

    expect(result).toEqual({
      text: "[attached: root.png (fileId: FROOT)]",
      userId: "U1",
      botId: undefined,
      ts: "1.000",
      files: [{ id: "FROOT", name: "root.png", mimetype: "image/png" }],
    });
    expect(vi.mocked(logVerbose)).not.toHaveBeenCalled();
  });

  it("returns null and surfaces the error via logVerbose when Slack API throws", async () => {
    const replies = vi.fn().mockRejectedValueOnce(new Error("not_in_channel"));
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    const result = await resolveSlackThreadStarter({
      channelId: "C42",
      threadTs: "9.999",
      client,
    });

    expect(result).toBeNull();
    expectVerboseLogContains("slack thread starter fetch failed");
    expectVerboseLogContains("not_in_channel");
    expectVerboseLogContains("channel=C42");
    expectVerboseLogContains("ts=9.999");
  });

  it("surfaces non-Error thrown values via logVerbose", async () => {
    const replies = vi.fn().mockRejectedValueOnce("rate_limited");
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    const result = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1.000",
      client,
    });

    expect(result).toBeNull();
    expectVerboseLogContains("rate_limited");
  });
});
