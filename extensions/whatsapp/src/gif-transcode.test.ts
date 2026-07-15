// Whatsapp tests cover GIF auto-convert plugin behavior.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GifTranscodeError,
  maybeTranscodeGifToMp4,
  resolveGifAutoConvertConfig,
  transcodeGifToMp4,
} from "./gif-transcode.js";

type TranscodeDeps = NonNullable<Parameters<typeof transcodeGifToMp4>[0]["deps"]>;

function createDeps(overrides?: {
  ffmpegMissing?: boolean;
  runError?: unknown;
  outputBuffer?: Buffer;
  missingOutput?: boolean;
}) {
  const output = overrides?.outputBuffer ?? Buffer.from("mp4");
  const resolveFfmpegBin = vi.fn(() => {
    if (overrides?.ffmpegMissing) {
      throw new Error("ffmpeg not found in trusted system directories.");
    }
    return "/usr/bin/ffmpeg";
  });
  const runFfmpeg = vi.fn(async () => {
    if (overrides?.runError) {
      throw overrides.runError as Error;
    }
    return "";
  });
  const mkdir = vi.fn(async () => undefined);
  const writeFile = vi.fn(async () => undefined);
  const stat = vi.fn(async () => {
    if (overrides?.missingOutput) {
      throw new Error("missing");
    }
    return { size: output.length };
  });
  const readFile = vi.fn(async () => output);
  const rm = vi.fn(async () => undefined);
  return {
    resolveFfmpegBin,
    runFfmpeg,
    mkdir,
    writeFile,
    stat,
    readFile,
    rm,
    randomUUID: () => "test-id",
    resolveTmpDir: () => "/tmp/openclaw-tests",
  } as unknown as TranscodeDeps & {
    resolveFfmpegBin: typeof resolveFfmpegBin;
    runFfmpeg: typeof runFfmpeg;
    mkdir: typeof mkdir;
    writeFile: typeof writeFile;
    stat: typeof stat;
    readFile: typeof readFile;
    rm: typeof rm;
  };
}

describe("gif-transcode", () => {
  it("resolves defaults", () => {
    expect(resolveGifAutoConvertConfig(undefined)).toEqual({
      enabled: true,
      timeoutMs: 8000,
      maxOutputBytes: 12000000,
    });
  });

  it("returns original buffer when not gif", async () => {
    const input = Buffer.from("jpeg");
    const out = await maybeTranscodeGifToMp4({
      buffer: input,
      contentType: "image/jpeg",
      fileName: "a.jpg",
    });
    expect(out).toEqual({ buffer: input, converted: false });
  });

  it("transcodes gif using ffmpeg and returns output", async () => {
    const deps = createDeps({ outputBuffer: Buffer.from("video") });
    const out = await transcodeGifToMp4({
      gifBuffer: Buffer.from("gif"),
      sourceLabel: "anim.gif",
      deps,
    });

    expect(out).toEqual(Buffer.from("video"));
    expect(deps.runFfmpeg).toHaveBeenCalledWith(
      expect.arrayContaining([
        "-i",
        path.join("/tmp/openclaw-tests", "gif-transcode-test-id", "input.gif"),
        "-pix_fmt",
        "yuv420p",
        "-an",
      ]),
      { timeoutMs: 8000 },
    );
    expect(deps.rm).toHaveBeenCalled();
  });

  it("throws ffmpeg_missing with an actionable hint when ffmpeg is unavailable", async () => {
    const deps = createDeps({ ffmpegMissing: true });
    const promise = transcodeGifToMp4({
      gifBuffer: Buffer.from("gif"),
      sourceLabel: "anim.gif",
      deps,
    });
    await expect(promise).rejects.toMatchObject({
      code: "ffmpeg_missing",
    } satisfies Partial<GifTranscodeError>);
    await expect(promise).rejects.toThrow(/Install ffmpeg|gifAutoConvert\.enabled=false/);
    // Missing binary fails before any temp state is created.
    expect(deps.mkdir).not.toHaveBeenCalled();
  });

  it("throws timeout when ffmpeg exceeds timeout", async () => {
    const deps = createDeps({
      runError: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    });
    await expect(
      transcodeGifToMp4({
        gifBuffer: Buffer.from("gif"),
        sourceLabel: "anim.gif",
        deps,
      }),
    ).rejects.toMatchObject({ code: "timeout" } satisfies Partial<GifTranscodeError>);
  });

  it("throws conversion_failed when ffmpeg fails or output is missing", async () => {
    await expect(
      transcodeGifToMp4({
        gifBuffer: Buffer.from("gif"),
        deps: createDeps({ runError: new Error("boom") }),
      }),
    ).rejects.toMatchObject({ code: "conversion_failed" } satisfies Partial<GifTranscodeError>);
    await expect(
      transcodeGifToMp4({
        gifBuffer: Buffer.from("gif"),
        deps: createDeps({ missingOutput: true }),
      }),
    ).rejects.toMatchObject({ code: "conversion_failed" } satisfies Partial<GifTranscodeError>);
  });

  it("throws output_too_large from the stat check without reading the file", async () => {
    const deps = createDeps({ outputBuffer: Buffer.alloc(6) });
    await expect(
      transcodeGifToMp4({
        gifBuffer: Buffer.from("gif"),
        sourceLabel: "anim.gif",
        config: { maxOutputBytes: 5 },
        deps,
      }),
    ).rejects.toMatchObject({ code: "output_too_large" } satisfies Partial<GifTranscodeError>);
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it("throws empty_output for zero-byte conversions", async () => {
    const deps = createDeps({ outputBuffer: Buffer.alloc(0) });
    await expect(
      transcodeGifToMp4({
        gifBuffer: Buffer.from("gif"),
        deps,
      }),
    ).rejects.toMatchObject({ code: "empty_output" } satisfies Partial<GifTranscodeError>);
  });
});
