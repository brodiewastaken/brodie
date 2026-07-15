// Whatsapp tests cover live-photo filtering and batched media plugin behavior.
import "./monitor-inbox.test-harness.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebInboundMessage } from "./inbound/types.js";
import {
  installWebMonitorInboxUnitTestHooks,
  settleInboundWork,
  startInboxMonitor,
  waitForMessageCalls,
  type InboxOnMessage,
} from "./monitor-inbox.test-harness.js";

const mediaDownloadMocks = vi.hoisted(() => ({
  downloadInboundMedia: vi.fn(),
  downloadQuotedInboundMedia: vi.fn(),
}));

vi.mock("./inbound/media.js", async () => {
  const actual = await vi.importActual<typeof import("./inbound/media.js")>("./inbound/media.js");
  return {
    ...actual,
    downloadInboundMedia: mediaDownloadMocks.downloadInboundMedia,
    downloadQuotedInboundMedia: mediaDownloadMocks.downloadQuotedInboundMedia,
  };
});

let messageCounter = 0;
function nextMessageId(label: string): string {
  messageCounter += 1;
  return `${label}-${messageCounter}`;
}

function videoUpsert(id: string, extra?: Record<string, unknown>) {
  return {
    type: "notify",
    messages: [
      {
        key: { id, fromMe: false, remoteJid: "999@s.whatsapp.net" },
        message: { videoMessage: { mimetype: "video/mp4", ...extra } },
        messageTimestamp: 1_700_000_000,
        pushName: "Tester",
      },
    ],
  };
}

function imageUpsert(id: string) {
  return {
    type: "notify",
    messages: [
      {
        key: { id, fromMe: false, remoteJid: "999@s.whatsapp.net" },
        message: { imageMessage: { mimetype: "image/jpeg" } },
        messageTimestamp: 1_700_000_000,
        pushName: "Tester",
      },
    ],
  };
}

describe("web monitor inbox live-photo filtering", () => {
  installWebMonitorInboxUnitTestHooks();

  beforeEach(() => {
    mediaDownloadMocks.downloadInboundMedia.mockReset().mockResolvedValue(undefined);
    mediaDownloadMocks.downloadQuotedInboundMedia.mockReset().mockResolvedValue(undefined);
  });

  it("drops explicit WhatsApp Live Photo motion-video components", async () => {
    const onMessage = vi.fn(async (_msg: WebInboundMessage) => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    const messageId = nextMessageId("live-photo-marker");

    sock.ev.emit(
      "messages.upsert",
      videoUpsert(messageId, { motionPhotoPresentationOffsetMs: 42 }),
    );

    await settleInboundWork();
    expect(onMessage).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(sock.readMessages).toHaveBeenCalledWith([
        {
          remoteJid: "999@s.whatsapp.net",
          id: messageId,
          participant: undefined,
          fromMe: false,
        },
      ]);
    });

    await listener.close();
  });

  it("passes zero-offset videos (regular video from a Live-Photo-capable device)", async () => {
    const onMessage = vi.fn(async (_msg: WebInboundMessage) => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);
    mediaDownloadMocks.downloadInboundMedia.mockResolvedValue({
      saved: { path: "/tmp/video.mp4" },
      mimetype: "video/mp4",
    });

    sock.ev.emit(
      "messages.upsert",
      videoUpsert(nextMessageId("zero-offset"), { motionPhotoPresentationOffsetMs: 0 }),
    );

    await waitForMessageCalls(onMessage, 1);
    expect(onMessage.mock.calls[0]?.[0]?.payload.body).toBe("<media:video>");
    expect(onMessage.mock.calls[0]?.[0]?.payload.media?.[0]?.path).toBe("/tmp/video.mp4");

    await listener.close();
  });

  it("delivers bare non-motion videos immediately (failed download is not a live photo)", async () => {
    const onMessage = vi.fn(async (_msg: WebInboundMessage) => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);

    sock.ev.emit("messages.upsert", videoUpsert(nextMessageId("bare-video-plain")));

    await waitForMessageCalls(onMessage, 1);
    expect(onMessage.mock.calls[0]?.[0]?.payload.body).toBe("<media:video>");

    await listener.close();
  });

  it("holds bare video placeholders and releases them when no image pairs", async () => {
    const onMessage = vi.fn(async (_msg: WebInboundMessage) => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);

    sock.ev.emit(
      "messages.upsert",
      videoUpsert(nextMessageId("bare-video-release"), { motionPhotoPresentationOffsetMs: 0 }),
    );

    await settleInboundWork();
    expect(onMessage).not.toHaveBeenCalled();
    await waitForMessageCalls(onMessage, 1);
    expect(onMessage.mock.calls[0]?.[0]?.payload.body).toBe("<media:video>");

    await listener.close();
  }, 10_000);

  it("drops held bare videos when a downloaded image from the same sender arrives", async () => {
    const onMessage = vi.fn(async (_msg: WebInboundMessage) => undefined);
    // The download mock answers per message kind: the video stays bare, the
    // still downloads (that is what makes the pair a Live Photo).
    mediaDownloadMocks.downloadInboundMedia.mockImplementation(async (msg: unknown) =>
      (msg as { message?: { imageMessage?: unknown } }).message?.imageMessage
        ? { saved: { path: "/tmp/still.jpg" }, mimetype: "image/jpeg" }
        : undefined,
    );
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);

    sock.ev.emit(
      "messages.upsert",
      videoUpsert(nextMessageId("bare-video-paired"), { motionPhotoPresentationOffsetMs: 0 }),
    );
    // Let the bare video reach its hold (well inside the 3s pair window).
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
    expect(onMessage).not.toHaveBeenCalled();

    sock.ev.emit("messages.upsert", imageUpsert(nextMessageId("paired-still")));

    await waitForMessageCalls(onMessage, 1);
    // Give the (now cancelled) pair window a chance to misfire.
    await new Promise((resolve) => {
      setTimeout(resolve, 3_200);
    });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]?.payload.body).toBe("<media:image>");

    await listener.close();
  }, 10_000);

  it("releases held bare videos through the drain path on close", async () => {
    const onMessage = vi.fn(async (_msg: WebInboundMessage) => undefined);
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage);

    sock.ev.emit(
      "messages.upsert",
      videoUpsert(nextMessageId("bare-video-drain"), { motionPhotoPresentationOffsetMs: 0 }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
    expect(onMessage).not.toHaveBeenCalled();

    await listener.close();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]?.payload.body).toBe("<media:video>");
  });
});

describe("web monitor inbox batched media", () => {
  installWebMonitorInboxUnitTestHooks();

  beforeEach(() => {
    mediaDownloadMocks.downloadInboundMedia.mockReset().mockResolvedValue(undefined);
    mediaDownloadMocks.downloadQuotedInboundMedia.mockReset().mockResolvedValue(undefined);
  });

  it("keeps every entry's media when the debouncer coalesces an album", async () => {
    const onMessage = vi.fn(async (_msg: WebInboundMessage) => undefined);
    mediaDownloadMocks.downloadInboundMedia
      .mockResolvedValueOnce({ saved: { path: "/tmp/photo-1.jpg" }, mimetype: "image/jpeg" })
      .mockResolvedValueOnce({ saved: { path: "/tmp/photo-2.jpg" }, mimetype: "image/jpeg" });
    const { listener, sock } = await startInboxMonitor(onMessage as InboxOnMessage, {
      debounceMs: 150,
    });

    sock.ev.emit("messages.upsert", imageUpsert(nextMessageId("album-1")));
    await settleInboundWork();
    sock.ev.emit("messages.upsert", imageUpsert(nextMessageId("album-2")));

    await waitForMessageCalls(onMessage, 1);
    const combined = onMessage.mock.calls[0]?.[0];
    expect(combined?.event.isBatched).toBe(true);
    expect(combined?.payload.media).toEqual([
      { path: "/tmp/photo-1.jpg", type: "image/jpeg", fileName: undefined },
      { path: "/tmp/photo-2.jpg", type: "image/jpeg", fileName: undefined },
    ]);
    // Deprecated scalar aliases view the first item.
    expect(combined?.mediaPath).toBe("/tmp/photo-1.jpg");

    await listener.close();
  });
});
