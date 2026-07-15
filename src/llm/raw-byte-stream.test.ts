import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendRawByteStreamBytesEvent,
  appendRawByteStreamJsonEvent,
  createRawByteStreamCapture,
  createRawByteStreamTrace,
  redactRawByteStreamHeaders,
  resolveRawByteStreamFile,
  testing,
  wrapFetchWithRawByteCapture,
} from "./raw-byte-stream.js";

function captureDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-raw-byte-stream-"));
}

function rows(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("raw byte stream", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    testing.resetRetentionThrottleForTest();
    testing.resetLegacyPathWarningForTest();
  });

  it("writes correlated daily rows only when enabled", () => {
    const dir = captureDir();
    vi.stubEnv("OPENCLAW_RAW_BYTE_STREAM", "1");
    vi.stubEnv("OPENCLAW_RAW_BYTE_STREAM_PATH", dir);
    const trace = createRawByteStreamTrace({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      requestId: "request",
      traceContext: { runId: "run", callId: "call" },
    });
    appendRawByteStreamJsonEvent({ event: "request.body", trace, value: { ok: true } });
    const file = resolveRawByteStreamFile();
    expect(path.basename(file)).toMatch(/^raw-byte-stream-\d{8}\.jsonl$/);
    expect(rows(file)[0]).toMatchObject({
      traceSchema: "openclaw-raw-byte-stream",
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      requestId: "request",
      runId: "run",
      modelCallId: "call",
    });
  });

  it("preserves arbitrary response bytes and hashes them", () => {
    const dir = captureDir();
    vi.stubEnv("OPENCLAW_RAW_BYTE_STREAM", "1");
    vi.stubEnv("OPENCLAW_RAW_BYTE_STREAM_PATH", dir);
    const bytes = new Uint8Array([0, 255, 10, 65]);
    appendRawByteStreamBytesEvent({
      event: "response.sse_chunk",
      trace: createRawByteStreamTrace({ provider: "openai", modelId: "gpt-5.6-sol" }),
      bytes,
    });
    const payload = rows(resolveRawByteStreamFile())[0]?.bytes as Record<string, unknown>;
    expect(payload.byteLength).toBe(bytes.byteLength);
    expect(payload.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.from(String(payload.base64), "base64")).toEqual(Buffer.from(bytes));
  });

  it("captures exact request and streamed response bytes without persisting headers", async () => {
    const dir = captureDir();
    vi.stubEnv("OPENCLAW_RAW_BYTE_STREAM", "1");
    vi.stubEnv("OPENCLAW_RAW_BYTE_STREAM_PATH", dir);
    const responseChunks = [
      new TextEncoder().encode('data: {"type":"response.created"}\n\n'),
      new TextEncoder().encode("data: [DONE]\n\n"),
    ];
    const fetchFn = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of responseChunks) {
            controller.enqueue(chunk);
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream", authorization: "secret" },
      });
    });
    const capture = createRawByteStreamCapture({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      traceContext: { runId: "run", callId: "call" },
    });
    if (!capture) {
      throw new Error("expected raw byte capture");
    }
    const requestBody = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]);
    const response = await capture.wrapFetch(fetchFn as typeof fetch)(
      "https://chatgpt.test/backend-api/codex/responses",
      {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-encoding": "zstd" },
        body: requestBody,
      },
    );
    await response.text();

    const capturedRows = rows(resolveRawByteStreamFile());
    expect(capturedRows.map((row) => row.event)).toEqual([
      "openai.request.body",
      "openai.response.sse_chunk",
      "openai.response.sse_chunk",
    ]);
    const decode = (row: Record<string, unknown>) =>
      Buffer.from(String((row.bytes as Record<string, unknown>).base64), "base64");
    expect(decode(capturedRows[0] ?? {})).toEqual(Buffer.from(requestBody));
    expect(Buffer.concat(capturedRows.slice(1).map(decode))).toEqual(
      Buffer.concat(responseChunks.map((chunk) => Buffer.from(chunk))),
    );
    expect(capturedRows[0]).toMatchObject({
      runId: "run",
      modelCallId: "call",
      metadata: { requestIndex: 0, contentEncoding: "zstd" },
    });
    expect(capturedRows[2]).toMatchObject({
      metadata: { requestIndex: 0, chunkIndex: 1, byteOffset: responseChunks[0]?.byteLength },
    });
  });

  it("keeps fetch and response streaming working when capture throws", async () => {
    const response = new Response("data: ok\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fetchFn = vi.fn(async () => response);
    const capture = {
      appendBytes() {
        throw new Error("capture unavailable");
      },
      wrapFetch(fetchImpl: typeof fetch) {
        return wrapFetchWithRawByteCapture(fetchImpl, capture);
      },
    };

    const wrappedResponse = await capture.wrapFetch(fetchFn as typeof fetch)(
      "https://example.com",
      {
        method: "POST",
        body: "request",
      },
    );

    await expect(wrappedResponse.text()).resolves.toBe("data: ok\n\n");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("redacts credential-shaped headers", () => {
    expect(
      redactRawByteStreamHeaders({ authorization: "secret", "x-api-key": "secret", safe: "ok" }),
    ).toEqual({ authorization: "[REDACTED]", "x-api-key": "[REDACTED]", safe: "ok" });
  });

  it("prunes daily files older than the bounded 48-hour default", () => {
    const dir = captureDir();
    vi.stubEnv("OPENCLAW_RAW_BYTE_STREAM", "1");
    vi.stubEnv("OPENCLAW_RAW_BYTE_STREAM_PATH", dir);
    const stale = path.join(dir, "raw-byte-stream-20200101.jsonl");
    const foreign = path.join(dir, "notes.txt");
    fs.writeFileSync(stale, "{}\n");
    fs.writeFileSync(foreign, "keep\n");
    const old = new Date(Date.now() - 72 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    appendRawByteStreamJsonEvent({
      event: "request.body",
      trace: createRawByteStreamTrace({ provider: "anthropic", modelId: "claude-sonnet-5" }),
      value: {},
    });
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it("rejects a legacy single-file capture path without affecting it", () => {
    const dir = captureDir();
    const file = path.join(dir, "raw-byte-stream.jsonl");
    fs.writeFileSync(file, "legacy\n");
    vi.stubEnv("OPENCLAW_RAW_BYTE_STREAM", "1");
    vi.stubEnv("OPENCLAW_RAW_BYTE_STREAM_PATH", file);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    appendRawByteStreamJsonEvent({
      event: "request.body",
      trace: createRawByteStreamTrace({ provider: "anthropic", modelId: "claude-sonnet-5" }),
      value: {},
    });
    expect(fs.readFileSync(file, "utf8")).toBe("legacy\n");
    expect(warn).toHaveBeenCalledOnce();
  });
});
