// Media-understanding attachment facade tests cover automatic-understanding exclusions.
import { describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import { normalizeMediaAttachments } from "./runner.attachments.js";

describe("normalizeMediaAttachments", () => {
  it("skips a cached sticker while preserving supplemental media indexes", () => {
    const ctx: MsgContext = {
      MediaPath: "/tmp/cached-sticker.webp",
      MediaPaths: ["/tmp/cached-sticker.webp", "/tmp/replied-audio.ogg"],
      MediaTypes: ["image/webp", "audio/ogg"],
      StickerMediaIncluded: true,
      SkipStickerMediaUnderstanding: true,
    };

    expect(normalizeMediaAttachments(ctx)).toEqual([
      {
        path: "/tmp/replied-audio.ogg",
        url: undefined,
        mime: "audio/ogg",
        index: 1,
        sourceIndex: 1,
        sourceMessageId: undefined,
        alreadyTranscribed: false,
      },
    ]);
  });

  it("keeps scheduled quote media ahead of current media with exact source identity", () => {
    const ctx: MsgContext = {
      HumanInboundBatch: { version: 1 } as MsgContext["HumanInboundBatch"],
      ReplyToMediaPaths: ["/tmp/quoted.png"],
      ReplyToMediaTypes: ["image/png"],
      ReplyToMediaSourceMessageIds: ["quoted-message"],
      ReplyToMediaSourceIndexes: [2],
      MediaPaths: ["/tmp/current.png"],
      MediaTypes: ["image/png"],
      MediaSourceMessageIds: ["current-message"],
      MediaSourceIndexes: [0],
    };

    expect(normalizeMediaAttachments(ctx)).toEqual([
      expect.objectContaining({
        path: "/tmp/quoted.png",
        index: 0,
        sourceMessageId: "quoted-message",
        sourceIndex: 2,
      }),
      expect.objectContaining({
        path: "/tmp/current.png",
        index: 1,
        sourceMessageId: "current-message",
        sourceIndex: 0,
      }),
    ]);
  });
});
