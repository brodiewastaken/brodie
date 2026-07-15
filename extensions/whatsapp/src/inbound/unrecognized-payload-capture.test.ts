import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  persistUnrecognizedInboundPayload,
  resolveWhatsAppUnrecognizedPayloadDir,
  sweepUnrecognizedPayloadCaptures,
} from "./unrecognized-payload-capture.js";

const CAPTURED_AT = new Date("2026-07-13T01:02:03.456Z");
const MEDIA_PROBE = {
  rawKeys: [],
  normalizedKeys: [],
  chainContentKeys: [],
  finalContentKeys: [],
  hasVideo: false,
  hasImage: false,
  livePhotoVideo: false,
  motionPhotoOffsetPresent: false,
};

let configDir: string;

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-capture-"));
});

afterEach(async () => {
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("WhatsApp unrecognized payload capture", () => {
  it("normalizes account ids inside the owned capture directory", () => {
    expect(
      resolveWhatsAppUnrecognizedPayloadDir({
        configDir,
        accountId: "../../agents/main/agent",
      }),
    ).toBe(path.join(configDir, "logs", "whatsapp-unrecognized-payloads", "agents-main-agent"));
  });

  it("writes private captures into a private account directory", async () => {
    await persistUnrecognizedInboundPayload({
      configDir,
      accountId: "Team A",
      capturedAt: CAPTURED_AT,
      reason: "unrecognized-message-shape",
      mediaProbe: MEDIA_PROBE,
      msg: {
        key: { id: "message-1", remoteJid: "chat@g.us", fromMe: false },
        message: { conversation: "private fixture" },
      },
    });

    const captureDir = path.join(configDir, "logs", "whatsapp-unrecognized-payloads", "team-a");
    const files = await fs.readdir(captureDir);
    expect(files).toEqual([
      "capture-2026-07-13T01-02-03-456Z-chat_g.us-message-1-unrecognized-message-shape.json",
    ]);
    expect((await fs.stat(captureDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(captureDir, files[0]))).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlinked account capture directory", async () => {
    const captureRoot = path.join(configDir, "logs", "whatsapp-unrecognized-payloads");
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-capture-outside-"));
    await fs.mkdir(captureRoot, { recursive: true });
    await fs.symlink(outsideDir, path.join(captureRoot, "default"), "dir");
    try {
      await expect(
        persistUnrecognizedInboundPayload({
          configDir,
          accountId: "default",
          capturedAt: CAPTURED_AT,
          reason: "unrecognized-message-shape",
          mediaProbe: MEDIA_PROBE,
          msg: { key: { id: "message-1", remoteJid: "chat@g.us" } },
        }),
      ).rejects.toThrow("must contain only real directories");
      await expect(fs.readdir(outsideDir)).resolves.toEqual([]);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("does not follow a symlinked logs directory for capture or retention", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-capture-outside-"));
    const outsideCaptureDir = path.join(outsideDir, "whatsapp-unrecognized-payloads", "default");
    const outsideCapture = path.join(
      outsideCaptureDir,
      "capture-2026-07-10T01-00-00-000Z-chat-message-reason.json",
    );
    await fs.mkdir(outsideCaptureDir, { recursive: true });
    await fs.writeFile(outsideCapture, "{}\n");
    await fs.symlink(outsideDir, path.join(configDir, "logs"), "dir");
    try {
      await expect(
        persistUnrecognizedInboundPayload({
          configDir,
          accountId: "default",
          capturedAt: CAPTURED_AT,
          reason: "unrecognized-message-shape",
          mediaProbe: MEDIA_PROBE,
          msg: { key: { id: "message-1", remoteJid: "chat@g.us" } },
        }),
      ).rejects.toThrow("must contain only real directories");

      await sweepUnrecognizedPayloadCaptures({
        configDir,
        accountId: "default",
        retentionHours: 48,
        nowMs: CAPTURED_AT.getTime(),
      });
      await expect(fs.stat(outsideCapture)).resolves.toBeDefined();
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("prunes only expired capture files", async () => {
    const captureDir = resolveWhatsAppUnrecognizedPayloadDir({ configDir, accountId: "default" });
    await fs.mkdir(captureDir, { recursive: true });
    const staleCapture = path.join(
      captureDir,
      "capture-2026-07-10T01-00-00-000Z-chat-message-reason.json",
    );
    const freshCapture = path.join(
      captureDir,
      "capture-2026-07-12T13-00-00-000Z-chat-message-reason.json",
    );
    const foreignFile = path.join(captureDir, "notes.txt");
    await Promise.all([
      fs.writeFile(staleCapture, "{}\n"),
      fs.writeFile(freshCapture, "{}\n"),
      fs.writeFile(foreignFile, "keep\n"),
    ]);
    const staleAt = new Date("2026-07-10T01:00:00.000Z");
    const freshAt = new Date("2026-07-12T13:00:00.000Z");
    await Promise.all([
      fs.utimes(staleCapture, staleAt, staleAt),
      fs.utimes(freshCapture, freshAt, freshAt),
      fs.utimes(foreignFile, staleAt, staleAt),
    ]);

    await sweepUnrecognizedPayloadCaptures({
      configDir,
      accountId: "default",
      retentionHours: 48,
      nowMs: CAPTURED_AT.getTime(),
    });

    await expect(fs.stat(staleCapture)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(freshCapture)).resolves.toBeDefined();
    await expect(fs.stat(foreignFile)).resolves.toBeDefined();
  });
});
