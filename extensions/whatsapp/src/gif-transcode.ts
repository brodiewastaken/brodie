// Whatsapp plugin module implements GIF to MP4 auto-convert behavior.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveFfmpegBin,
  runFfmpeg,
  type MediaExecOptions,
} from "openclaw/plugin-sdk/media-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

// Single owner of the gifAutoConvert defaults; the config schema deliberately
// carries no defaults so parsing and runtime cannot drift.
export const DEFAULT_GIF_AUTOCONVERT_TIMEOUT_MS = 8_000;
export const DEFAULT_GIF_AUTOCONVERT_MAX_OUTPUT_BYTES = 12_000_000;

export type GifAutoConvertConfig = {
  enabled?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

export type ResolvedGifAutoConvertConfig = {
  enabled: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
};

type GifTranscodeDeps = {
  resolveFfmpegBin: () => string;
  runFfmpeg: (args: string[], options?: MediaExecOptions) => Promise<string>;
  mkdir: typeof fs.mkdir;
  writeFile: typeof fs.writeFile;
  stat: typeof fs.stat;
  readFile: typeof fs.readFile;
  rm: typeof fs.rm;
  randomUUID: () => string;
  resolveTmpDir: () => string;
};

const defaultDeps: GifTranscodeDeps = {
  resolveFfmpegBin,
  runFfmpeg,
  mkdir: fs.mkdir,
  writeFile: fs.writeFile,
  stat: fs.stat,
  readFile: fs.readFile,
  rm: fs.rm,
  randomUUID: () => crypto.randomUUID(),
  resolveTmpDir: () => resolvePreferredOpenClawTmpDir(),
};

function isGifMedia(opts: { contentType?: string | null; fileName?: string | null }): boolean {
  if (opts.contentType?.toLowerCase() === "image/gif") {
    return true;
  }
  return path.extname(opts.fileName ?? "").toLowerCase() === ".gif";
}

function resolvePositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function resolveGifAutoConvertConfig(
  config?: GifAutoConvertConfig,
): ResolvedGifAutoConvertConfig {
  return {
    enabled: config?.enabled ?? true,
    timeoutMs: resolvePositiveInt(config?.timeoutMs, DEFAULT_GIF_AUTOCONVERT_TIMEOUT_MS),
    maxOutputBytes: resolvePositiveInt(
      config?.maxOutputBytes,
      DEFAULT_GIF_AUTOCONVERT_MAX_OUTPUT_BYTES,
    ),
  };
}

export type GifTranscodeErrorCode =
  | "ffmpeg_missing"
  | "timeout"
  | "conversion_failed"
  | "output_too_large"
  | "empty_output";

export class GifTranscodeError extends Error {
  code: GifTranscodeErrorCode;

  constructor(code: GifTranscodeErrorCode, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "GifTranscodeError";
    this.code = code;
  }
}

type MaybeExecError = Error & {
  code?: string;
  signal?: string;
  killed?: boolean;
};

function isTimeoutError(err: unknown): boolean {
  const typed = err as MaybeExecError;
  if (typed?.code === "ETIMEDOUT" || typed?.killed === true || typed?.signal === "SIGTERM") {
    return true;
  }
  const message = typed?.message ? typed.message : String(err);
  return /timed?\s*out/i.test(message);
}

export async function transcodeGifToMp4(params: {
  gifBuffer: Buffer;
  config?: GifAutoConvertConfig;
  sourceLabel?: string;
  deps?: Partial<GifTranscodeDeps>;
}): Promise<Buffer> {
  const cfg = resolveGifAutoConvertConfig(params.config);
  const deps: GifTranscodeDeps = {
    ...defaultDeps,
    ...params.deps,
  };
  const sourceLabel = params.sourceLabel?.trim() || "media";
  // Trusted-path binary resolution happens up front so a missing ffmpeg fails
  // before any temp state is created.
  try {
    deps.resolveFfmpegBin();
  } catch (err) {
    throw new GifTranscodeError(
      "ffmpeg_missing",
      `GIF auto-convert requires ffmpeg but it was not found. Install ffmpeg or set channels.whatsapp.gifAutoConvert.enabled=false. (${err instanceof Error ? err.message : String(err)})`,
      err,
    );
  }
  const workDir = path.join(deps.resolveTmpDir(), `gif-transcode-${deps.randomUUID()}`);
  const inputPath = path.join(workDir, "input.gif");
  const outputPath = path.join(workDir, "output.mp4");

  await deps.mkdir(workDir, { recursive: true, mode: 0o700 });
  try {
    await deps.writeFile(inputPath, params.gifBuffer);
    try {
      await deps.runFfmpeg(
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          inputPath,
          "-movflags",
          "+faststart",
          "-pix_fmt",
          "yuv420p",
          "-vf",
          "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos",
          "-an",
          outputPath,
        ],
        { timeoutMs: cfg.timeoutMs },
      );
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new GifTranscodeError(
          "timeout",
          `GIF auto-convert timed out after ${cfg.timeoutMs}ms for ${sourceLabel}.`,
          err,
        );
      }
      throw new GifTranscodeError(
        "conversion_failed",
        `GIF auto-convert failed for ${sourceLabel}.`,
        err,
      );
    }

    // Bound memory, not just the send: check the output size before reading it.
    let outputSize: number;
    try {
      outputSize = (await deps.stat(outputPath)).size;
    } catch (err) {
      throw new GifTranscodeError(
        "conversion_failed",
        `GIF auto-convert produced no output for ${sourceLabel}.`,
        err,
      );
    }
    if (outputSize === 0) {
      throw new GifTranscodeError(
        "empty_output",
        `GIF auto-convert produced empty output for ${sourceLabel}.`,
      );
    }
    if (outputSize > cfg.maxOutputBytes) {
      throw new GifTranscodeError(
        "output_too_large",
        `Converted GIF exceeds max output size (${cfg.maxOutputBytes} bytes) for ${sourceLabel}.`,
      );
    }
    return await deps.readFile(outputPath);
  } finally {
    await deps.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function maybeTranscodeGifToMp4(params: {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  sourceLabel?: string;
  config?: GifAutoConvertConfig;
  deps?: Partial<GifTranscodeDeps>;
}): Promise<{ buffer: Buffer; converted: boolean }> {
  const cfg = resolveGifAutoConvertConfig(params.config);
  if (!cfg.enabled || !isGifMedia({ contentType: params.contentType, fileName: params.fileName })) {
    return { buffer: params.buffer, converted: false };
  }
  return {
    buffer: await transcodeGifToMp4({
      gifBuffer: params.buffer,
      config: cfg,
      sourceLabel: params.sourceLabel,
      deps: params.deps,
    }),
    converted: true,
  };
}
