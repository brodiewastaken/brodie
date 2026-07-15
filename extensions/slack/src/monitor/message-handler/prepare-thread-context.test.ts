// Slack tests cover prepare thread context plugin behavior.
import type { App } from "@slack/bolt";
import { resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import * as mediaModule from "../media.js";
import { resolveSlackThreadContextData } from "./prepare-thread-context.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount,
} from "./prepare.test-helpers.js";

const runMediaUnderstandingFileMock = vi.hoisted(() =>
  vi.fn(async () => ({
    text: undefined as string | undefined,
    provider: undefined as string | undefined,
    model: undefined as string | undefined,
  })),
);

vi.mock("openclaw/plugin-sdk/media-understanding-runtime", () => ({
  runMediaUnderstandingFile: runMediaUnderstandingFileMock,
}));

describe("resolveSlackThreadContextData", () => {
  const storeFixture = createSlackSessionStoreFixture("openclaw-slack-thread-context-");

  beforeAll(() => {
    storeFixture.setup();
  });

  beforeEach(() => {
    runMediaUnderstandingFileMock.mockReset().mockResolvedValue({
      text: undefined,
      provider: undefined,
      model: undefined,
    });
  });

  afterAll(() => {
    storeFixture.cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createThreadContext(params: { replies: unknown }) {
    return createInboundSlackTestContext({
      cfg: {
        channels: { slack: { enabled: true, replyToMode: "all", groupPolicy: "open" } },
      } as OpenClawConfig,
      appClient: { conversations: { replies: params.replies } } as App["client"],
      defaultRequireMention: false,
      replyToMode: "all",
    });
  }

  function createThreadMessage(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
    return {
      channel: "C123",
      channel_type: "channel",
      user: "U1",
      text: "current message",
      ts: "101.000",
      thread_ts: "100.000",
      ...overrides,
    } as SlackMessageEvent;
  }

  async function resolveAllowlistedThreadContext(params: {
    repliesMessages: Array<Record<string, unknown>>;
    threadStarter: {
      text: string;
      userId?: string;
      ts?: string;
      botId?: string;
      files?: NonNullable<SlackMessageEvent["files"]>;
    };
    allowFromLower: string[];
    allowNameMatching: boolean;
    sessionState?: "missing" | "fresh" | "stale";
    replies?: ReturnType<typeof vi.fn>;
  }) {
    const { storePath } = storeFixture.makeTmpStorePath();
    const replies =
      params.replies ??
      vi.fn().mockResolvedValue({
        messages: params.repliesMessages,
        response_metadata: { next_cursor: "" },
      });
    const ctx = createThreadContext({ replies });
    if (params.sessionState) {
      ctx.channelRuntime = {
        ...ctx.channelRuntime!,
        session: {
          resolveEntryResetFreshness: () => ({ state: params.sessionState }),
        },
      };
    }
    ctx.botUserId = "U_BOT";
    ctx.botId = "B1";
    ctx.resolveUserName = async (id: string) => ({
      name: id === "U1" ? "Alice" : id === "U_BOT" ? "Brodie" : "Mallory",
    });

    const result = await resolveSlackThreadContextData({
      ctx,
      account: createSlackTestAccount({ thread: { initialHistoryLimit: 20 } }),
      message: createThreadMessage(),
      isThreadReply: true,
      threadTs: "100.000",
      threadStarter: params.threadStarter,
      roomLabel: "#general",
      storePath,
      sessionKey: "thread-session",
      allowFromLower: params.allowFromLower,
      allowNameMatching: params.allowNameMatching,
      contextVisibilityMode: "allowlist",
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
      effectiveDirectMedia: null,
    });

    return { replies, result };
  }

  const starterFiles = [
    {
      id: "FROOT",
      name: "root.png",
      mimetype: "image/png",
      url_private: "https://files.slack.com/root.png",
    },
  ];
  const starterMedia = [
    {
      path: "/tmp/root.png",
      contentType: "image/png",
      placeholder: "[Slack file: root.png (fileId: FROOT)]",
    },
  ];

  it.each([
    {
      title: "hydrates starter media for a new thread session",
      sessionState: "missing" as const,
      hydrates: true,
    },
    {
      title: "does not hydrate starter media for an existing thread session",
      sessionState: "fresh" as const,
      hydrates: false,
    },
    {
      title: "hydrates starter media after a thread session reset",
      sessionState: "stale" as const,
      hydrates: true,
    },
  ])("$title", async ({ sessionState, hydrates }) => {
    const resolveSlackMedia = vi
      .spyOn(mediaModule, "resolveSlackMedia")
      .mockResolvedValue(starterMedia);
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [],
      threadStarter: { text: "starter with image", userId: "U1", files: starterFiles },
      allowFromLower: ["u1"],
      allowNameMatching: false,
      sessionState,
    });

    expect(result.threadStarterMedia).toEqual(hydrates ? starterMedia : null);
    expect(resolveSlackMedia).toHaveBeenCalledTimes(hydrates ? 1 : 0);
  });

  it("omits non-allowlisted human context while restoring current-bot replies", async () => {
    const { replies, result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "starter secret", user: "U2", ts: "100.000" },
        { text: "assistant reply", bot_id: "B1", ts: "100.500" },
        { text: "blocked follow-up", user: "U2", ts: "100.700" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "starter secret",
        userId: "U2",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadStarterBody).toBeUndefined();
    expect(result.threadLabel).toBe("Slack thread #general");
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).toContain("assistant reply");
    expect(result.threadHistoryBody).not.toContain("starter secret");
    expect(result.threadHistoryBody).not.toContain("blocked follow-up");
    expect(result.threadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(1);
  });

  it("restores prior current-bot replies from user-started channel threads on new sessions", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "starter from Alice", user: "U1", ts: "100.000" },
        { text: "assistant progress update", bot_id: "B1", ts: "100.200" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "starter from Alice",
        userId: "U1",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadStarterBody).toBe("starter from Alice");
    expect(result.threadHistoryBody).toContain("starter from Alice");
    expect(result.threadHistoryBody).toContain("assistant progress update");
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).not.toContain("current message");
  });

  it("passes downloaded historical media understanding into the thread contract", async () => {
    runMediaUnderstandingFileMock.mockResolvedValue({
      text: "derived ```report``` summary",
      provider: "test",
      model: "test-parser",
    });
    const resolveSlackMedia = vi.spyOn(mediaModule, "resolveSlackMedia").mockResolvedValue([
      {
        path: "/private/media/inbound/FREPORT-report.png",
        contentType: "image/png",
        placeholder: "[Slack file: report.png (fileId: FREPORT)]",
      },
    ]);
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        {
          text: "image from Alice",
          user: "U1",
          ts: "100.000",
          files: [
            {
              id: "FREPORT",
              name: "report.png",
              mimetype: "image/png",
              size: 1536,
              url_private: "https://files.slack.com/report.pdf",
            },
          ],
        },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "image from Alice",
        userId: "U1",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    const body = result.threadHistoryBody ?? "";
    expect(resolveSlackMedia).toHaveBeenCalledTimes(1);
    expect(body).toContain('"media_local_path": "/private/media/inbound/FREPORT-report.png"');
    expect(runMediaUnderstandingFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "image",
        filePath: "/private/media/inbound/FREPORT-report.png",
        mime: "image/png",
      }),
    );
    expect(body).toContain("Media Understanding #1 (DERIVED, UNTRUSTED):");
    expect(body).toContain('"trust": "derived_untrusted"');
    expect(body).toContain("Derived Output:\n````text\nderived ```report``` summary\n````");
    expect(body).not.toContain("current message");
  });

  it("renders retained partial history with an explicit incomplete marker", async () => {
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ text: "starter from Alice", user: "U1", ts: "100.000" }],
        response_metadata: { next_cursor: "next" },
      })
      .mockRejectedValueOnce(new Error("later page failed"));
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [],
      replies,
      threadStarter: {
        text: "starter from Alice",
        userId: "U1",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(replies).toHaveBeenCalledTimes(2);
    expect(result.threadHistoryBody).toContain("starter from Alice");
    expect(result.threadHistoryBody).toContain('"history_complete": false');
  });

  it("downloads historical thread files and includes their exact local paths", async () => {
    const resolveSlackMedia = vi.spyOn(mediaModule, "resolveSlackMedia").mockImplementation(
      async ({ files }) =>
        files?.map((file) => ({
          path: `/private/media/inbound/${file.id}-${file.name}`,
          contentType: file.mimetype,
          placeholder: `[Slack file: ${file.name} (fileId: ${file.id})]`,
        })) ?? null,
    );
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        {
          text: "starter from Alice",
          user: "U1",
          ts: "100.000",
        },
        {
          text: "read the report",
          user: "U1",
          ts: "100.400",
          files: [
            {
              id: "FREPORT",
              name: "report.pdf",
              mimetype: "application/pdf",
              url_private: "https://files.slack.com/report.pdf",
            },
          ],
        },
        {
          text: "",
          user: "U1",
          ts: "100.600",
          files: [
            {
              id: "FIMAGE",
              name: "diagram.png",
              mimetype: "image/png",
              url_private: "https://files.slack.com/diagram.png",
            },
          ],
        },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "starter from Alice",
        userId: "U1",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(resolveSlackMedia).toHaveBeenCalledTimes(2);
    expect(result.threadHistoryBody).toContain("read the report");
    expect(result.threadHistoryBody).toContain('"media_reference": "FREPORT"');
    expect(result.threadHistoryBody).toContain(
      '"media_local_path": "/private/media/inbound/FREPORT-report.pdf"',
    );
    expect(result.threadHistoryBody).toContain('"file_name": "diagram.png"');
    expect(result.threadHistoryBody).toContain(
      '"media_local_path": "/private/media/inbound/FIMAGE-diagram.png"',
    );
    expect(result.threadHistoryBody).toContain("Message Body: [EMPTY]");
  });

  it("retains historical Slack file metadata when a download is unavailable", async () => {
    vi.spyOn(mediaModule, "resolveSlackMedia").mockResolvedValue(null);
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        {
          text: "",
          user: "U1",
          ts: "100.600",
          files: [
            {
              id: "FMISSING",
              name: "missing.pdf",
              mimetype: "application/pdf",
              url_private: "https://files.slack.com/missing.pdf",
            },
          ],
        },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "starter from Alice",
        userId: "U1",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadHistoryBody).toContain('"media_reference": "FMISSING"');
    expect(result.threadHistoryBody).toContain('"file_name": "missing.pdf"');
    expect(result.threadHistoryBody).toContain('"download_status": "unavailable"');
    expect(result.threadHistoryBody).not.toContain('"media_local_path"');
  });

  it("downloads every retained historical file without touching filtered senders", async () => {
    const resolveSlackMedia = vi.spyOn(mediaModule, "resolveSlackMedia").mockImplementation(
      async ({ files }) =>
        files?.map((file) => ({
          path: `/private/media/inbound/${file.id}`,
          placeholder: `[Slack file: ${file.name} (fileId: ${file.id})]`,
        })) ?? null,
    );
    const retainedFiles = Array.from({ length: 9 }, (_, index) => ({
      id: `F${index + 1}`,
      name: `part-${index + 1}.txt`,
      mimetype: "text/plain",
      url_private: `https://files.slack.com/part-${index + 1}.txt`,
    }));
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        {
          text: "all nine parts",
          user: "U1",
          ts: "100.500",
          files: retainedFiles,
        },
        {
          text: "blocked attachment",
          user: "U2",
          ts: "100.700",
          files: [
            {
              id: "FBLOCKED",
              name: "blocked.txt",
              mimetype: "text/plain",
              url_private: "https://files.slack.com/blocked.txt",
            },
          ],
        },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "starter from Alice",
        userId: "U1",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(resolveSlackMedia).toHaveBeenCalledTimes(9);
    expect(result.threadHistoryBody).toContain('"media_local_path": "/private/media/inbound/F9"');
    expect(result.threadHistoryBody).not.toContain("blocked attachment");
    expect(result.threadHistoryBody).not.toContain("FBLOCKED");
  });

  it("keeps starter text and history when allowNameMatching authorizes the sender", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "starter from Alice", user: "U1", ts: "100.000" },
        { text: "blocked follow-up", user: "U2", ts: "100.700" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "starter from Alice",
        userId: "U1",
        ts: "100.000",
      },
      allowFromLower: ["alice"],
      allowNameMatching: true,
    });

    expect(result.threadStarterBody).toBe("starter from Alice");
    expect(result.threadLabel).toContain("starter from Alice");
    expect(result.threadHistoryBody).toContain("starter from Alice");
    expect(result.threadHistoryBody).not.toContain("blocked follow-up");
  });

  it("keeps a user-started thread label UTF-16 safe at the snippet limit", async () => {
    const starterText = `${"a".repeat(79)}🐱tail`;
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [],
      threadStarter: {
        text: starterText,
        userId: "U1",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadLabel).toBe(`Slack thread #general: ${"a".repeat(79)}`);
  });

  it("includes bot-authored starter as assistant root context for a new thread session (default)", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "bot starter", bot_id: "B1", ts: "100.000" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "bot starter",
        botId: "B1",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadStarterBody).toBeUndefined();
    expect(result.threadLabel).toBe("Slack thread #general (assistant root): bot starter");
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).toContain("bot starter");
    expect(result.threadHistoryBody).toContain("[ASSISTANT SELF]");
    expect(result.threadHistoryBody).toContain('"sender_type": "assistant_self"');
    expect(result.threadHistoryBody).not.toContain("current message");
  });

  it("injects bot-authored starter when fetched history omits the root", async () => {
    const { storePath } = storeFixture.makeTmpStorePath();
    const replies = vi.fn().mockResolvedValue({
      messages: [
        { text: "assistant reply", bot_id: "B1", ts: "100.500" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      response_metadata: { next_cursor: "" },
    });
    const ctx = createThreadContext({ replies });
    ctx.botUserId = "U_BOT";
    ctx.botId = "B1";
    ctx.resolveUserName = async (id: string) => ({
      name: id === "U1" ? "Alice" : "Mallory",
    });

    const result = await resolveSlackThreadContextData({
      ctx,
      account: createSlackTestAccount({ thread: { initialHistoryLimit: 20 } }),
      message: createThreadMessage(),
      isThreadReply: true,
      threadTs: "100.000",
      threadStarter: {
        text: "bot starter",
        botId: "B1",
        ts: "100.000",
      },
      roomLabel: "#general",
      storePath,
      sessionKey: "thread-session",
      allowFromLower: ["u1"],
      allowNameMatching: false,
      contextVisibilityMode: "allowlist",
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
      effectiveDirectMedia: null,
    });

    expect(result.threadStarterBody).toBeUndefined();
    expect(result.threadLabel).toBe("Slack thread #general (assistant root): bot starter");
    expect(result.threadHistoryBody).toContain("bot starter");
    expect(result.threadHistoryBody).toContain("[ASSISTANT SELF]");
    expect(result.threadHistoryBody).toContain('"thread_root_restored": true');
    expect(result.threadHistoryBody).toContain('"thread_root_fetched": false');
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).toContain("assistant reply");
    expect(result.threadHistoryBody).not.toContain("current message");
  });

  it("injects bot-authored starter when initial history trimming drops the root", async () => {
    const { storePath } = storeFixture.makeTmpStorePath();
    const replies = vi.fn().mockResolvedValue({
      messages: [
        { text: "bot starter", bot_id: "B1", ts: "100.000" },
        { text: "old user follow-up", user: "U1", ts: "100.100" },
        { text: "recent user follow-up", user: "U1", ts: "100.900" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      response_metadata: { next_cursor: "" },
    });
    const ctx = createThreadContext({ replies });
    ctx.botUserId = "U_BOT";
    ctx.botId = "B1";
    ctx.resolveUserName = async () => ({ name: "Alice" });

    const result = await resolveSlackThreadContextData({
      ctx,
      account: createSlackTestAccount({ thread: { initialHistoryLimit: 1 } }),
      message: createThreadMessage(),
      isThreadReply: true,
      threadTs: "100.000",
      threadStarter: {
        text: "bot starter",
        botId: "B1",
        ts: "100.000",
      },
      roomLabel: "#general",
      storePath,
      sessionKey: "thread-session",
      allowFromLower: ["u1"],
      allowNameMatching: false,
      contextVisibilityMode: "allowlist",
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
      effectiveDirectMedia: null,
    });

    expect(result.threadHistoryBody).toContain("bot starter");
    expect(result.threadHistoryBody).toContain('"messages_included": 1');
    expect(result.threadHistoryBody).toContain('"messages_omitted_by_limit": 2');
    expect(result.threadHistoryBody).toContain('"thread_root_restored": true');
    expect(result.threadHistoryBody).toContain('"thread_root_fetched": true');
    expect(result.threadHistoryBody).not.toContain("recent user follow-up");
    expect(result.threadHistoryBody).not.toContain("old user follow-up");
    expect(result.threadHistoryBody).not.toContain("current message");
  });

  it("keeps third-party bot starter text in a new thread session", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "other bot starter", bot_id: "B2", ts: "100.000" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "other bot starter",
        botId: "B2",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadStarterBody).toBe("other bot starter");
    expect(result.threadLabel).toContain("other bot starter");
    expect(result.threadHistoryBody).toContain("other bot starter");
    expect(result.threadHistoryBody).toContain("[Historical Message #1]: [Bot (B2)]");
    expect(result.threadHistoryBody).toContain("[BOT MESSAGE]");
    expect(result.threadHistoryBody).toContain('"sender_type": "bot"');
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).not.toContain("Unknown (user)");
  });

  it("does not coerce malformed thread history timestamps into event times", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "starter from Alice", user: "U1", ts: "100.000" },
        { text: "malformed timestamp follow-up", user: "U1", ts: "0x65" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "starter from Alice",
        userId: "U1",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    const malformedHistoryEntry = result.threadHistoryBody
      ?.split(/\n(?=\[Historical Message #|\[Thread History End\])/u)
      .find((entry) => entry.includes("malformed timestamp follow-up"));
    expect(malformedHistoryEntry).toContain('"message_id": "0x65"');
    expect(malformedHistoryEntry).not.toContain("1970-01-01");
  });

  it("includes self-authored starter (identified by bot user id) for a new thread session (default)", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "self starter", user: "U_BOT", ts: "100.000" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "self starter",
        userId: "U_BOT",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadStarterBody).toBeUndefined();
    expect(result.threadLabel).toBe("Slack thread #general (assistant root): self starter");
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).toContain("self starter");
    expect(result.threadHistoryBody).toContain("[ASSISTANT SELF]");
  });

  it("issue #79338: bot DM confirmation root is included so reply has parent context", async () => {
    const { storePath } = storeFixture.makeTmpStorePath();
    const replies = vi.fn().mockResolvedValue({
      messages: [
        {
          text: "Confirmed Saturday 12:30pm meeting with Alice",
          bot_id: "B1",
          ts: "100.000",
        },
        {
          text: "actually it's Sunday 12:30 pm - apologize and correct",
          user: "U1",
          ts: "101.000",
        },
      ],
      response_metadata: { next_cursor: "" },
    });
    const ctx = createThreadContext({ replies });
    ctx.botUserId = "U_BOT";
    ctx.botId = "B1";
    ctx.resolveUserName = async (id: string) => ({ name: id === "U1" ? "Alice" : "Mallory" });

    const result = await resolveSlackThreadContextData({
      ctx,
      account: createSlackTestAccount({ thread: { initialHistoryLimit: 20 } }),
      message: createThreadMessage({
        channel: "D123",
        channel_type: "im",
        text: "actually it's Sunday 12:30 pm - apologize and correct",
        ts: "101.000",
      }),
      isThreadReply: true,
      threadTs: "100.000",
      threadStarter: {
        text: "Confirmed Saturday 12:30pm meeting with Alice",
        botId: "B1",
        ts: "100.000",
      },
      roomLabel: "DM",
      storePath,
      sessionKey: "thread-session",
      allowFromLower: [],
      allowNameMatching: false,
      contextVisibilityMode: "all",
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
      effectiveDirectMedia: null,
    });

    expect(result.threadHistoryBody).toContain("Confirmed Saturday 12:30pm meeting with Alice");
    expect(result.threadHistoryBody).toContain("[ASSISTANT SELF]");
    expect(result.threadHistoryBody).not.toContain(
      "actually it's Sunday 12:30 pm - apologize and correct",
    );
    expect(result.threadLabel).toContain("Confirmed Saturday 12:30pm");
  });
});
