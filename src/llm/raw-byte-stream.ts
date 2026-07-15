import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSensitiveHeaders } from "../shared/sensitive-headers.js";

const FILE_PATTERN = /^raw-byte-stream-\d{8}\.jsonl$/;
const DEFAULT_RETENTION_HOURS = 48;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export type RawByteStreamTrace = {
  traceId: string;
  provider: string;
  modelId: string;
  requestId?: string;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  modelCallId?: string;
  diagnosticTraceId?: string;
  diagnosticSpanId?: string;
  diagnosticTraceparent?: string;
};

export type RawByteStreamCapture = {
  appendBytes(params: {
    event: string;
    bytes: string | Uint8Array;
    metadata?: Record<string, unknown>;
  }): void;
  wrapFetch(fetchFn: typeof fetch): typeof fetch;
};

type RawBytePayload = {
  encoding: "base64";
  byteLength: number;
  sha256: string;
  base64: string;
};

let lastPruneAtMs = 0;
let warnedFilePath: string | undefined;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function isRawByteStreamEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:1|true|yes|on)$/i.test(env.OPENCLAW_RAW_BYTE_STREAM?.trim() ?? "");
}

export function resolveRawByteStreamDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.OPENCLAW_RAW_BYTE_STREAM_PATH?.trim() ||
    path.join(os.homedir(), ".openclaw", "logs", "raw-byte-stream")
  );
}

export function resolveRawByteStreamFile(env: NodeJS.ProcessEnv = process.env): string {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return path.join(resolveRawByteStreamDir(env), `raw-byte-stream-${day}.jsonl`);
}

function usableDir(env: NodeJS.ProcessEnv): string | undefined {
  const dir = resolveRawByteStreamDir(env);
  try {
    if (fs.statSync(dir).isDirectory()) {
      return dir;
    }
    if (warnedFilePath !== dir) {
      warnedFilePath = dir;
      console.warn(`[raw-byte-stream] configured path is a file; use a capture directory (${dir})`);
    }
    return undefined;
  } catch {
    return dir;
  }
}

function retentionHours(env: NodeJS.ProcessEnv): number {
  const value = Number.parseInt(env.OPENCLAW_RAW_BYTE_STREAM_RETENTION_HOURS ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RETENTION_HOURS;
}

function prune(dir: string, env: NodeJS.ProcessEnv, now = Date.now()): void {
  const cutoff = now - retentionHours(env) * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!FILE_PATTERN.test(entry)) {
      continue;
    }
    const file = path.join(dir, entry);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.unlinkSync(file);
      }
    } catch {
      // capture cleanup never affects provider traffic
    }
  }
}

export function createRawByteStreamTrace(params: {
  provider: string;
  modelId: string;
  requestId?: string;
  traceContext?: Record<string, unknown>;
}): RawByteStreamTrace {
  const context = params.traceContext ?? {};
  return {
    traceId: randomUUID(),
    provider: params.provider,
    modelId: params.modelId,
    ...(params.requestId ? { requestId: params.requestId } : {}),
    ...(optionalString(context.runId) ? { runId: optionalString(context.runId) } : {}),
    ...(optionalString(context.sessionKey)
      ? { sessionKey: optionalString(context.sessionKey) }
      : {}),
    ...(optionalString(context.sessionId) ? { sessionId: optionalString(context.sessionId) } : {}),
    ...(optionalString(context.callId) ? { modelCallId: optionalString(context.callId) } : {}),
    ...(optionalString(context.traceId)
      ? { diagnosticTraceId: optionalString(context.traceId) }
      : {}),
    ...(optionalString(context.spanId) ? { diagnosticSpanId: optionalString(context.spanId) } : {}),
    ...(optionalString(context.traceparent)
      ? { diagnosticTraceparent: optionalString(context.traceparent) }
      : {}),
  };
}

export function createRawByteStreamCapture(params: {
  provider: string;
  modelId: string;
  requestId?: string;
  traceContext?: Record<string, unknown>;
}): RawByteStreamCapture | undefined {
  if (!isRawByteStreamEnabled()) {
    return undefined;
  }
  const trace = createRawByteStreamTrace(params);
  const capture: RawByteStreamCapture = {
    appendBytes({ event, bytes, metadata }) {
      try {
        if (typeof bytes === "string") {
          appendRawByteStreamUtf8Event({
            event,
            trace,
            text: bytes,
            ...(metadata ? { metadata } : {}),
          });
          return;
        }
        appendRawByteStreamBytesEvent({
          event,
          trace,
          bytes,
          ...(metadata ? { metadata } : {}),
        });
      } catch {
        // Diagnostic capture must never affect provider traffic.
      }
    },
    wrapFetch(fetchFn) {
      return wrapFetchWithRawByteCapture(fetchFn, capture);
    },
  };
  return capture;
}

function safeAppendCapturedBytes(
  capture: RawByteStreamCapture,
  params: Parameters<RawByteStreamCapture["appendBytes"]>[0],
): void {
  try {
    capture.appendBytes(params);
  } catch {
    // Diagnostic capture must never affect provider traffic.
  }
}

function tapCapturedResponse(
  response: Response,
  capture: RawByteStreamCapture,
  requestIndex: number,
): Response {
  if (!response.body) {
    return response;
  }
  const reader = response.body.getReader();
  const isSse = (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .includes("text/event-stream");
  let chunkIndex = 0;
  let byteOffset = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        safeAppendCapturedBytes(capture, {
          event: isSse ? "openai.response.sse_chunk" : "openai.response.body_chunk",
          bytes: chunk.value,
          metadata: { requestIndex, chunkIndex, byteOffset },
        });
        chunkIndex += 1;
        byteOffset += chunk.value.byteLength;
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  const wrapped = new Response(body, response);
  for (const key of ["url", "redirected", "type"] as const) {
    Object.defineProperty(wrapped, key, { value: response[key] });
  }
  return wrapped;
}

export function wrapFetchWithRawByteCapture(
  fetchFn: typeof fetch,
  capture: RawByteStreamCapture,
): typeof fetch {
  let requestCount = 0;
  return async (input, init) => {
    const requestIndex = requestCount++;
    const request = input instanceof Request ? new Request(input, init) : undefined;
    const body = init?.body ?? request?.body;
    const contentEncoding = new Headers(init?.headers ?? request?.headers ?? {}).get(
      "content-encoding",
    );
    const metadata = {
      requestIndex,
      ...(contentEncoding ? { contentEncoding } : {}),
    };
    if (typeof body === "string" || body instanceof Uint8Array) {
      safeAppendCapturedBytes(capture, { event: "openai.request.body", bytes: body, metadata });
    } else if (request?.body) {
      try {
        const bytes = new Uint8Array(await request.clone().arrayBuffer());
        safeAppendCapturedBytes(capture, { event: "openai.request.body", bytes, metadata });
      } catch {
        // Diagnostic capture must never affect provider traffic.
      }
    }
    const response = await fetchFn(input, init);
    return tapCapturedResponse(response, capture, requestIndex);
  };
}

export function buildRawBytePayload(value: string | Uint8Array): RawBytePayload {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  return {
    encoding: "base64",
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    base64: bytes.toString("base64"),
  };
}

export const redactRawByteStreamHeaders = redactSensitiveHeaders;

export function appendRawByteStreamEvent(
  params: {
    event: string;
    trace: RawByteStreamTrace;
    bytes?: RawBytePayload;
    metadata?: Record<string, unknown>;
  },
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    if (!isRawByteStreamEnabled(env)) {
      return;
    }
    const dir = usableDir(env);
    if (!dir) {
      return;
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      resolveRawByteStreamFile(env),
      `${JSON.stringify({
        traceSchema: "openclaw-raw-byte-stream",
        schemaVersion: 1,
        ts: new Date().toISOString(),
        event: params.event,
        ...params.trace,
        ...(params.bytes ? { bytes: params.bytes } : {}),
        ...(params.metadata ? { metadata: params.metadata } : {}),
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const now = Date.now();
    if (now - lastPruneAtMs >= PRUNE_INTERVAL_MS) {
      lastPruneAtMs = now;
      prune(dir, env, now);
    }
  } catch {
    // diagnostic capture is fail-open by contract
  }
}

export function appendRawByteStreamUtf8Event(params: {
  event: string;
  trace: RawByteStreamTrace;
  text: string;
  metadata?: Record<string, unknown>;
}): void {
  appendRawByteStreamEvent({ ...params, bytes: buildRawBytePayload(params.text) });
}

export function appendRawByteStreamBytesEvent(params: {
  event: string;
  trace: RawByteStreamTrace;
  bytes: Uint8Array;
  metadata?: Record<string, unknown>;
}): void {
  appendRawByteStreamEvent({ ...params, bytes: buildRawBytePayload(params.bytes) });
}

export function appendRawByteStreamJsonEvent(params: {
  event: string;
  trace: RawByteStreamTrace;
  value: unknown;
  metadata?: Record<string, unknown>;
}): void {
  appendRawByteStreamUtf8Event({
    event: params.event,
    trace: params.trace,
    text: JSON.stringify(params.value),
    ...(params.metadata ? { metadata: params.metadata } : {}),
  });
}

export const testing = {
  resetRetentionThrottleForTest(): void {
    lastPruneAtMs = 0;
  },
  resetLegacyPathWarningForTest(): void {
    warnedFilePath = undefined;
  },
  pruneNowForTest(env: NodeJS.ProcessEnv = process.env): void {
    prune(resolveRawByteStreamDir(env), env);
  },
};
