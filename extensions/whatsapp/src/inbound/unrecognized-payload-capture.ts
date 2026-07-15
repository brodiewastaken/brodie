// Private diagnostic capture owner for unrecognized WhatsApp payloads.
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveConfigDir } from "openclaw/plugin-sdk/text-utility-runtime";
import { safeStringify } from "../session-errors.js";
import type { WhatsAppMediaMessageInspection } from "./media.js";

const UNRECOGNIZED_PAYLOAD_DIRNAME = "whatsapp-unrecognized-payloads";
const UNRECOGNIZED_PAYLOAD_CAPTURE_MAX_CHARS = 256 * 1024;
const CAPTURE_FILE_PATTERN =
  /^capture-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[A-Za-z0-9._-]+-[A-Za-z0-9._-]+-[A-Za-z0-9._-]+\.json$/u;

type UnrecognizedInboundPayloadMessage = {
  key?: {
    id?: string | null;
    remoteJid?: string | null;
    participant?: string | null;
    fromMe?: boolean | null;
  };
  messageTimestamp?: unknown;
  pushName?: string | null;
  message?: unknown;
  messageStubParameters?: unknown;
  messageStubType?: unknown;
};

function sanitizePayloadFileSegment(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || fallback;
}

export function resolveWhatsAppUnrecognizedPayloadDir(params: {
  accountId: string;
  configDir?: string;
}): string {
  const captureRoot = path.resolve(
    params.configDir ?? resolveConfigDir(),
    "logs",
    UNRECOGNIZED_PAYLOAD_DIRNAME,
  );
  const accountDir = path.resolve(captureRoot, normalizeAccountId(params.accountId));
  const relative = path.relative(captureRoot, accountDir);
  if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) {
    throw new Error("WhatsApp payload capture directory escaped its owned root");
  }
  return accountDir;
}

async function preparePrivateCaptureDirectory(
  captureDir: string,
  options: { create: boolean },
): Promise<boolean> {
  const captureRoot = path.dirname(captureDir);
  const logsDir = path.dirname(captureRoot);
  const configDir = path.dirname(logsDir);
  const directories = [configDir, logsDir, captureRoot, captureDir];
  for (const [index, directory] of directories.entries()) {
    if (options.create && index > 0) {
      try {
        await fs.mkdir(directory, index >= 2 ? { mode: 0o700 } : undefined);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
    }
    let stats: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stats = await fs.lstat(directory);
    } catch (error) {
      if (!options.create && (error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("WhatsApp payload capture path must contain only real directories");
    }
    if (index >= 2) {
      await fs.chmod(directory, 0o700);
    }
  }
  return true;
}

export async function persistUnrecognizedInboundPayload(params: {
  accountId: string;
  msg: UnrecognizedInboundPayloadMessage;
  mediaProbe: WhatsAppMediaMessageInspection;
  reason: string;
  configDir?: string;
  capturedAt?: Date;
}): Promise<void> {
  const captureDir = resolveWhatsAppUnrecognizedPayloadDir(params);
  const capturedAt = params.capturedAt ?? new Date();
  const messageId = sanitizePayloadFileSegment(params.msg.key?.id, "unknown-message");
  const remoteJid = sanitizePayloadFileSegment(params.msg.key?.remoteJid, "unknown-chat");
  const fileName = `capture-${capturedAt.toISOString().replace(/[:.]/g, "-")}-${remoteJid}-${messageId}-${sanitizePayloadFileSegment(params.reason, "capture")}.json`;
  const payload = {
    capturedAt: capturedAt.toISOString(),
    reason: params.reason,
    accountId: normalizeAccountId(params.accountId),
    messageId: params.msg.key?.id ?? null,
    remoteJid: params.msg.key?.remoteJid ?? null,
    participant: params.msg.key?.participant ?? null,
    fromMe: params.msg.key?.fromMe ?? null,
    messageTimestamp: params.msg.messageTimestamp ?? null,
    pushName: params.msg.pushName ?? null,
    mediaProbe: params.mediaProbe,
    key: params.msg.key,
    message: params.msg.message,
    messageStubParameters: params.msg.messageStubParameters,
    messageStubType: params.msg.messageStubType,
  };
  await preparePrivateCaptureDirectory(captureDir, { create: true });
  await fs.writeFile(
    path.join(captureDir, fileName),
    `${safeStringify(payload, UNRECOGNIZED_PAYLOAD_CAPTURE_MAX_CHARS)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

export async function sweepUnrecognizedPayloadCaptures(params: {
  accountId: string;
  retentionHours: number;
  configDir?: string;
  nowMs?: number;
}): Promise<void> {
  const captureDir = resolveWhatsAppUnrecognizedPayloadDir(params);
  const cutoffMs = (params.nowMs ?? Date.now()) - params.retentionHours * 60 * 60 * 1000;
  let entries: Dirent[];
  try {
    if (!(await preparePrivateCaptureDirectory(captureDir, { create: false }))) {
      return;
    }
    entries = await fs.readdir(captureDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !CAPTURE_FILE_PATTERN.test(entry.name)) {
      continue;
    }
    const filePath = path.join(captureDir, entry.name);
    try {
      if ((await fs.stat(filePath)).mtimeMs < cutoffMs) {
        await fs.rm(filePath, { force: true });
      }
    } catch {
      // Retention is best-effort and must not disturb the WhatsApp monitor.
    }
  }
}
