import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readSessionMessageChunkBySeqAsync,
  readSessionMessageBySeqAsync,
  readSessionMessagesBeforeSeqAsync,
  readSessionMessagesTailAsync,
} from "./session-utils.fs.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function seedTranscript(texts: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sequence-test-"));
  cleanupPaths.push(dir);
  const file = path.join(dir, "session.jsonl");
  const lines = [JSON.stringify({ type: "session", version: 1, id: "session" })];
  for (const [index, text] of texts.entries()) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `message-${index + 1}`,
        timestamp: new Date(1_700_000_000_000 + index).toISOString(),
        message: { role: "assistant", content: [{ type: "text", text }] },
      }),
    );
  }
  await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

function seqs(messages: unknown[]): number[] {
  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") {
      return [];
    }
    const metadata = (message as Record<string, unknown>)["__openclaw"];
    if (!metadata || typeof metadata !== "object") {
      return [];
    }
    const seq = (metadata as Record<string, unknown>).seq;
    return typeof seq === "number" ? [seq] : [];
  });
}

describe("absolute transcript sequence reads", () => {
  it("uses one sequence namespace for tail, older pages, and multibyte rows", async () => {
    const file = await seedTranscript(["one", "界".repeat(5000), "three", "four", "five"]);

    const tail = await readSessionMessagesTailAsync("session", undefined, file, {
      maxMessages: 2,
    });
    expect(seqs(tail)).toEqual([4, 5]);

    const older = await readSessionMessagesBeforeSeqAsync("session", undefined, file, 4, {
      maxMessages: 2,
    });
    expect(seqs(older)).toEqual([2, 3]);

    const row = await readSessionMessageBySeqAsync("session", undefined, file, 2);
    expect(row).toMatchObject({ found: true, oversized: false, seq: 2 });
    expect(JSON.stringify(row.message)).toContain("界".repeat(100));
  });

  it("keeps an oversized indexed row on its sequence and reads it in bounded chunks", async () => {
    const text = "z".repeat(300 * 1024);
    const file = await seedTranscript(["small", text]);

    const tail = await readSessionMessagesTailAsync("session", undefined, file, {
      maxMessages: 2,
    });
    expect(seqs(tail)).toEqual([1, 2]);
    expect(tail[1]).toMatchObject({
      __openclaw: {
        deferredTranscriptRow: {
          reason: "oversized",
          byteLength: expect.any(Number),
          sha256: expect.any(String),
        },
      },
    });
    expect(JSON.stringify(tail[1])).not.toContain("message too large");

    const row = await readSessionMessageBySeqAsync("session", undefined, file, 2);
    expect(row).toMatchObject({ found: true, oversized: true, seq: 2 });

    const firstChunk = await readSessionMessageChunkBySeqAsync(
      "session",
      undefined,
      file,
      2,
      0,
      64 * 1024,
    );
    expect(firstChunk).toMatchObject({ found: true, seq: 2, offset: 0, done: false });
    expect(firstChunk.bytes?.byteLength).toBe(64 * 1024);
  });

  it("reads a persisted row above 8 MiB without a total-size cap", async () => {
    const text = `${"a".repeat(8 * 1024 * 1024)}界tail`;
    const file = await seedTranscript([text]);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts: string[] = [];
    let offset = 0;
    let calls = 0;
    while (true) {
      const chunk = await readSessionMessageChunkBySeqAsync(
        "session",
        undefined,
        file,
        1,
        offset,
        512 * 1024,
      );
      expect(chunk.found).toBe(true);
      expect(chunk.offset).toBe(offset);
      const bytes = chunk.bytes ?? new Uint8Array();
      expect(bytes.byteLength).toBeLessThanOrEqual(512 * 1024);
      parts.push(decoder.decode(bytes, { stream: true }));
      offset += bytes.byteLength;
      calls += 1;
      if (chunk.done) {
        expect(offset).toBe(chunk.totalBytes);
        break;
      }
    }
    parts.push(decoder.decode());
    const record = JSON.parse(parts.join("")) as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(calls).toBeGreaterThan(16);
    expect(record.message?.content?.[0]?.text).toBe(text);
  });
});
