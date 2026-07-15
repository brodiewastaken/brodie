// Attachment path normalization tests cover file URL host checks and Windows
// network path rejection.
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  normalizeAttachmentPath,
  normalizeAttachments,
  resolveAttachmentKind,
} from "./attachments.normalize.js";

describe("normalizeAttachmentPath", () => {
  it("allows localhost file URLs", () => {
    const localPath = path.join(os.tmpdir(), "photo.png");
    const fileUrl = pathToFileURL(localPath);
    fileUrl.hostname = "localhost";

    expect(normalizeAttachmentPath(fileUrl.href)).toBe(localPath);
  });

  it("rejects remote-host file URLs", () => {
    expect(normalizeAttachmentPath("file://attacker/share/photo.png")).toBeUndefined();
  });

  it("rejects Windows network paths", () => {
    withMockedPlatform("win32", () => {
      expect(normalizeAttachmentPath("\\\\attacker\\share\\photo.png")).toBeUndefined();
    });
  });
});

describe("attachment normalization and classification", () => {
  it("retains per-source queue identity and aligned transcription indexes", () => {
    expect(
      normalizeAttachments({
        MediaPaths: ["/tmp/one.ogg", "/tmp/two.ogg", "/tmp/three.ogg"],
        MediaTypes: ["audio/ogg", "audio/ogg", "audio/ogg"],
        MediaSourceMessageIds: ["m1", "m1", "m2"],
        MediaSourceIndexes: [0, 1, 0],
        MediaTranscribedIndexes: [2],
      }),
    ).toMatchObject([
      { index: 0, sourceMessageId: "m1", sourceIndex: 0, alreadyTranscribed: false },
      { index: 1, sourceMessageId: "m1", sourceIndex: 1, alreadyTranscribed: false },
      { index: 2, sourceMessageId: "m2", sourceIndex: 0, alreadyTranscribed: true },
    ]);
  });

  it("classifies GIFs from a URL extension even when the local path is opaque", () => {
    expect(
      resolveAttachmentKind({
        index: 0,
        path: "/tmp/download",
        url: "https://cdn.example.test/reaction.gif?token=redacted",
        mime: "image/*",
      }),
    ).toBe("video");
  });

  it("classifies detected image/gif as video regardless of declared filename", () => {
    expect(resolveAttachmentKind({ index: 0, path: "/tmp/photo.png", mime: "image/gif" })).toBe(
      "video",
    );
  });
});
