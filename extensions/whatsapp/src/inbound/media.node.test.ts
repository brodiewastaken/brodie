// Whatsapp tests cover media plugin behavior.
import { Readable } from "node:stream";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockNormalizeMessageContent } from "../../../../test/mocks/baileys.js";

type MockMessageInput = Parameters<typeof mockNormalizeMessageContent>[0];

const { normalizeMessageContent, downloadMediaMessage, saveMediaStream } = vi.hoisted(() => ({
  normalizeMessageContent: vi.fn((msg: MockMessageInput) => mockNormalizeMessageContent(msg)),
  downloadMediaMessage: vi.fn().mockResolvedValue(Buffer.from("fake-media-data")),
  saveMediaStream: vi.fn(),
}));

vi.mock("baileys", async () => {
  return {
    DisconnectReason: { loggedOut: 401 },
    normalizeMessageContent,
    downloadMediaMessage,
  };
});

vi.mock("openclaw/plugin-sdk/media-store", () => ({
  saveMediaStream,
}));

let downloadInboundMedia: typeof import("./media.js").downloadInboundMedia;
let inspectWhatsAppMediaMessage: typeof import("./media.js").inspectWhatsAppMediaMessage;
let isWhatsAppLivePhotoVideoComponent: typeof import("./media.js").isWhatsAppLivePhotoVideoComponent;
let isWhatsAppVideoMessage: typeof import("./media.js").isWhatsAppVideoMessage;

const mockSock = {
  updateMediaMessage: vi.fn(),
  logger: { child: () => ({}) },
};

async function expectMimetype(message: Record<string, unknown>, expected: string) {
  const result = await downloadInboundMedia({ message } as never, mockSock as never);
  expect(result).toEqual({
    saved: {
      id: "saved-media",
      path: "/tmp/saved-media",
      size: Buffer.byteLength("fake-media-data"),
      contentType: expected,
    },
    mimetype: expected,
    fileName: undefined,
  });
}

describe("downloadInboundMedia", () => {
  beforeAll(async () => {
    ({
      downloadInboundMedia,
      inspectWhatsAppMediaMessage,
      isWhatsAppLivePhotoVideoComponent,
      isWhatsAppVideoMessage,
    } = await import("./media.js"));
  });

  beforeEach(() => {
    normalizeMessageContent.mockClear();
    downloadMediaMessage.mockClear();
    downloadMediaMessage.mockImplementation(() => Readable.from([Buffer.from("fake-media-data")]));
    saveMediaStream.mockClear();
    saveMediaStream.mockImplementation(
      async (
        stream: AsyncIterable<Buffer>,
        contentType: string | undefined,
        _subdir: string,
        maxBytes: number,
      ) => {
        let total = 0;
        for await (const chunk of stream) {
          total += chunk.byteLength;
          if (total > maxBytes) {
            throw new Error("Media exceeds limit");
          }
        }
        return { id: "saved-media", path: "/tmp/saved-media", size: total, contentType };
      },
    );
    mockSock.updateMediaMessage.mockClear();
  });

  it("returns undefined for messages without media", async () => {
    const msg = { message: { conversation: "hello" } } as never;
    const result = await downloadInboundMedia(msg, mockSock as never);
    expect(result).toBeUndefined();
  });

  it("uses explicit mimetype from audioMessage when present", async () => {
    await expectMimetype({ audioMessage: { mimetype: "audio/mp4", ptt: true } }, "audio/mp4");
  });

  it.each([
    { name: "voice messages without explicit MIME", audioMessage: { ptt: true } },
    { name: "audio messages without MIME or ptt flag", audioMessage: {} },
  ])("defaults to audio/ogg for $name", async ({ audioMessage }) => {
    await expectMimetype({ audioMessage }, "audio/ogg; codecs=opus");
  });

  it("uses explicit mimetype from imageMessage when present", async () => {
    await expectMimetype({ imageMessage: { mimetype: "image/png" } }, "image/png");
  });

  it.each([
    { name: "image", message: { imageMessage: {} }, mimetype: "image/jpeg" },
    { name: "video", message: { videoMessage: {} }, mimetype: "video/mp4" },
    { name: "sticker", message: { stickerMessage: {} }, mimetype: "image/webp" },
  ])("defaults MIME for $name messages without explicit MIME", async ({ message, mimetype }) => {
    await expectMimetype(message, mimetype);
  });

  it("preserves fileName from document messages", async () => {
    const msg = {
      message: {
        documentMessage: { mimetype: "application/pdf", fileName: "report.pdf" },
      },
    } as never;
    const result = await downloadInboundMedia(msg, mockSock as never);
    expect(result).toEqual({
      saved: {
        id: "saved-media",
        path: "/tmp/saved-media",
        size: Buffer.byteLength("fake-media-data"),
        contentType: "application/pdf",
      },
      mimetype: "application/pdf",
      fileName: "report.pdf",
    });
  });

  it("downloads in stream mode and rejects over the configured cap", async () => {
    downloadMediaMessage.mockImplementationOnce(() =>
      Readable.from([Buffer.alloc(4), Buffer.alloc(4)]),
    );

    await expect(
      downloadInboundMedia(
        { message: { imageMessage: { mimetype: "image/jpeg" } } } as never,
        mockSock as never,
        7,
      ),
    ).rejects.toThrow(/Media exceeds/i);
    expect(downloadMediaMessage.mock.calls[0]?.[1]).toBe("stream");
  });

  it("propagates transport download failures to the message owner", async () => {
    downloadMediaMessage.mockRejectedValueOnce(new Error("expired media reference"));

    await expect(
      downloadInboundMedia(
        { message: { imageMessage: { mimetype: "image/jpeg" } } } as never,
        mockSock as never,
      ),
    ).rejects.toThrow("expired media reference");
  });

  it("detects explicit WhatsApp Live Photo motion-video markers", () => {
    expect(
      isWhatsAppLivePhotoVideoComponent({
        videoMessage: { mimetype: "video/mp4", motionPhotoPresentationOffsetMs: 42 },
      } as never),
    ).toBe(true);
    expect(
      isWhatsAppLivePhotoVideoComponent({
        videoMessage: { mimetype: "video/mp4", motionPhotoPresentationOffsetMs: 0 },
      } as never),
    ).toBe(false);
    expect(
      isWhatsAppLivePhotoVideoComponent({
        videoMessage: {
          mimetype: "video/mp4",
          _motionPhotoPresentationOffsetMs: "motionPhotoPresentationOffsetMs",
        },
      } as never),
    ).toBe(true);
  });

  it("inspects wrapped media message chains", () => {
    const wrapped = {
      viewOnceMessageV2Extension: {
        message: {
          videoMessage: {
            mimetype: "video/mp4",
            motionPhotoPresentationOffsetMs: { low: 3, high: 0 },
          },
        },
      },
    };

    const inspection = inspectWhatsAppMediaMessage(wrapped as never);
    expect(isWhatsAppVideoMessage(wrapped as never)).toBe(true);
    expect(inspection.hasVideo).toBe(true);
    expect(inspection.livePhotoVideo).toBe(true);
    expect(inspection.finalContentKeys).toContain("videoMessage");
    expect(inspection.chainContentKeys.at(-1)).toContain("videoMessage");
  });
});
