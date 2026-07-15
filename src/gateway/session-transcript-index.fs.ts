import { createHash } from "node:crypto";
// Filesystem transcript indexer.
// Streams JSONL transcript files into byte-offset indexes for history paging.
import fs from "node:fs";
import {
  parseSessionTranscriptTreeEntry,
  scanSessionTranscriptTree,
} from "../config/sessions/transcript-tree.js";
import {
  extractJsonNullableStringFieldPrefix,
  extractJsonNumberFieldPrefix,
  extractJsonStringFieldPrefix,
  normalizeOptionalString,
} from "./session-transcript-json.js";

const TRANSCRIPT_INDEX_READ_CHUNK_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_INDEX_CACHE_ENTRIES = 256;
const MAX_TRANSCRIPT_INDEX_PARSE_LINE_BYTES = 256 * 1024;
const OVERSIZED_TRANSCRIPT_METADATA_PREFIX_CHARS = 64 * 1024;

type ParsedTranscriptRecord = Record<string, unknown>;

/** Visible transcript entry plus its byte range in the JSONL file. */
export type IndexedTranscriptEntry = {
  seq: number;
  id?: string;
  offset: number;
  byteLength: number;
  record: ParsedTranscriptRecord;
};

type SessionTranscriptIndex = {
  filePath: string;
  mtimeMs: number;
  size: number;
  hasTreeEntries: boolean;
  leafId?: string | null;
  entries: IndexedTranscriptEntry[];
  allEntries: IndexedTranscriptEntry[];
};

type IndexedRawEntry = {
  id?: string;
  parentId?: string | null;
  offset: number;
  byteLength: number;
  record: ParsedTranscriptRecord;
};

type CacheEntry = {
  mtimeMs: number;
  size: number;
  index: SessionTranscriptIndex;
};

type ReadSessionTranscriptIndexOptions = {
  cache?: "reuse" | "skip";
  view?: "active" | "all";
};

const transcriptIndexCache = new Map<string, CacheEntry>();
const transcriptIndexBuilds = new Map<
  string,
  {
    mtimeMs: number;
    size: number;
    promise: Promise<SessionTranscriptIndex>;
  }
>();

async function yieldTranscriptIndexScan(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function touchCachedIndex(filePath: string, entry: CacheEntry): SessionTranscriptIndex {
  transcriptIndexCache.delete(filePath);
  transcriptIndexCache.set(filePath, entry);
  return entry.index;
}

function setCachedIndex(filePath: string, entry: CacheEntry): void {
  transcriptIndexCache.set(filePath, entry);
  while (transcriptIndexCache.size > MAX_TRANSCRIPT_INDEX_CACHE_ENTRIES) {
    const oldestKey = transcriptIndexCache.keys().next().value;
    if (typeof oldestKey !== "string" || !oldestKey) {
      break;
    }
    transcriptIndexCache.delete(oldestKey);
  }
}

function selectTranscriptIndexView(
  index: SessionTranscriptIndex,
  view: ReadSessionTranscriptIndexOptions["view"],
): SessionTranscriptIndex {
  return view === "all" ? { ...index, entries: index.allEntries } : index;
}

/** Clears transcript index caches and in-flight builds between tests. */
export function clearSessionTranscriptIndexCache(): void {
  transcriptIndexCache.clear();
  transcriptIndexBuilds.clear();
}

function isIndexableTranscriptRecord(record: unknown): record is ParsedTranscriptRecord {
  return Boolean(record && typeof record === "object" && !Array.isArray(record));
}

function isVisibleTranscriptRecord(record: ParsedTranscriptRecord): boolean {
  return Boolean(record.message) || record.type === "compaction";
}

function buildOversizedIndexedRawEntry(params: {
  line: string;
  offset: number;
  byteLength: number;
  sha256: string;
}): IndexedRawEntry | null {
  // Oversized lines may contain huge message arrays, so recover only metadata
  // from a bounded prefix and defer the exact row to the chunked reader.
  const prefix = params.line.slice(0, OVERSIZED_TRANSCRIPT_METADATA_PREFIX_CHARS);
  const messageMatch = /"message"\s*:/.exec(prefix);
  const recordPrefix = messageMatch ? prefix.slice(0, messageMatch.index) : prefix;
  const id = extractJsonStringFieldPrefix(prefix, "id");
  const parentId = extractJsonNullableStringFieldPrefix(prefix, "parentId");
  const type = extractJsonStringFieldPrefix(prefix, "type");
  const timestamp =
    extractJsonStringFieldPrefix(recordPrefix, "timestamp") ??
    extractJsonNumberFieldPrefix(recordPrefix, "timestamp");
  const role = extractJsonStringFieldPrefix(prefix, "role") ?? "assistant";
  const record: ParsedTranscriptRecord = {
    ...(type ? { type } : {}),
    ...(id ? { id } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    message: {
      role,
      content: [],
      __openclaw: {
        deferredTranscriptRow: {
          reason: "oversized",
          byteLength: params.byteLength,
          sha256: params.sha256,
        },
      },
    },
  };
  const treeEntry = parseSessionTranscriptTreeEntry(record);
  return {
    ...(id ? { id } : {}),
    ...(treeEntry ? { parentId: treeEntry.parentId } : parentId !== undefined ? { parentId } : {}),
    offset: params.offset,
    byteLength: params.byteLength,
    record,
  };
}

async function visitTranscriptJsonLines(
  filePath: string,
  visit: (line: string, offset: number, byteLength: number, sha256: string) => void,
): Promise<void> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(TRANSCRIPT_INDEX_READ_CHUNK_BYTES);
    const captureLimit = MAX_TRANSCRIPT_INDEX_PARSE_LINE_BYTES + 1;
    let lineOffset = 0;
    let lineByteLength = 0;
    let capturedBytes = 0;
    let capturedParts: Buffer[] = [];
    let lastLineByte: number | undefined;
    let pendingHashByte: number | undefined;
    let lineHash = createHash("sha256");
    let readOffset = 0;

    const appendSegment = (segment: Buffer) => {
      lineByteLength += segment.byteLength;
      if (segment.byteLength > 0) {
        lastLineByte = segment[segment.byteLength - 1];
        if (pendingHashByte !== undefined) {
          lineHash.update(Buffer.from([pendingHashByte]));
        }
        if (segment.byteLength > 1) {
          lineHash.update(segment.subarray(0, segment.byteLength - 1));
        }
        pendingHashByte = segment[segment.byteLength - 1];
      }
      const remainingCapture = captureLimit - capturedBytes;
      if (remainingCapture <= 0 || segment.byteLength === 0) {
        return;
      }
      const captured = Buffer.from(segment.subarray(0, remainingCapture));
      capturedParts.push(captured);
      capturedBytes += captured.byteLength;
    };

    const finishLine = () => {
      const hasCarriageReturn = lastLineByte === 0x0d;
      const byteLength = lineByteLength - (hasCarriageReturn ? 1 : 0);
      const captured = Buffer.concat(capturedParts, capturedBytes);
      const capturedLine =
        hasCarriageReturn && lineByteLength <= captureLimit
          ? captured.subarray(0, Math.max(0, captured.byteLength - 1))
          : captured;
      if (pendingHashByte !== undefined && pendingHashByte !== 0x0d) {
        lineHash.update(Buffer.from([pendingHashByte]));
      }
      visit(capturedLine.toString("utf8"), lineOffset, byteLength, lineHash.digest("hex"));
      lineByteLength = 0;
      capturedBytes = 0;
      capturedParts = [];
      lastLineByte = undefined;
      pendingHashByte = undefined;
      lineHash = createHash("sha256");
    };

    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      let cursor = 0;
      while (cursor < chunk.byteLength) {
        const newline = chunk.indexOf(0x0a, cursor);
        const end = newline === -1 ? chunk.byteLength : newline;
        appendSegment(chunk.subarray(cursor, end));
        if (newline === -1) {
          break;
        }
        finishLine();
        lineOffset = readOffset + newline + 1;
        cursor = newline + 1;
      }
      readOffset += bytesRead;
      // Yield between chunks so a large transcript scan does not monopolize the
      // gateway event loop while chat/session traffic is still flowing.
      await yieldTranscriptIndexScan();
    }

    if (lineByteLength > 0) {
      finishLine();
    }
  } finally {
    await handle.close();
  }
}

function buildActiveTreeEntries(params: {
  byId: Map<string, IndexedRawEntry>;
  leafId?: string | null;
}): IndexedRawEntry[] {
  const out: IndexedRawEntry[] = [];
  const seen = new Set<string>();
  let currentId = params.leafId;
  while (currentId) {
    if (seen.has(currentId)) {
      return [];
    }
    seen.add(currentId);
    const entry = params.byId.get(currentId);
    if (!entry) {
      break;
    }
    out.push(entry);
    currentId = entry.parentId ?? undefined;
  }
  return out.toReversed();
}

function toIndexedEntries(rawEntries: IndexedRawEntry[]): IndexedTranscriptEntry[] {
  const entries: IndexedTranscriptEntry[] = [];
  let seq = 0;
  for (const entry of rawEntries) {
    if (!isVisibleTranscriptRecord(entry.record)) {
      continue;
    }
    seq += 1;
    entries.push({
      seq,
      ...(entry.id ? { id: entry.id } : {}),
      offset: entry.offset,
      byteLength: entry.byteLength,
      record: entry.record,
    });
  }
  return entries;
}

async function buildSessionTranscriptIndex(
  filePath: string,
  stat: fs.Stats,
): Promise<SessionTranscriptIndex> {
  const rawEntries: IndexedRawEntry[] = [];

  await visitTranscriptJsonLines(filePath, (line, offset, byteLength, sha256) => {
    if (!line.trim()) {
      return;
    }
    if (byteLength > MAX_TRANSCRIPT_INDEX_PARSE_LINE_BYTES) {
      const rawEntry = buildOversizedIndexedRawEntry({ line, offset, byteLength, sha256 });
      if (!rawEntry) {
        return;
      }
      rawEntries.push(rawEntry);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isIndexableTranscriptRecord(parsed)) {
      return;
    }
    const id = normalizeOptionalString(parsed.id);
    const parentId =
      parsed.parentId === null ? null : (normalizeOptionalString(parsed.parentId) ?? undefined);
    const treeEntry = parseSessionTranscriptTreeEntry(parsed);
    const rawEntry: IndexedRawEntry = {
      ...(id ? { id } : {}),
      ...(treeEntry
        ? { parentId: treeEntry.parentId }
        : parentId !== undefined
          ? { parentId }
          : {}),
      offset,
      byteLength,
      record: parsed,
    };
    rawEntries.push(rawEntry);
  });

  const tree = scanSessionTranscriptTree(rawEntries.map((entry) => entry.record));
  const rawByRecord = new Map(rawEntries.map((entry) => [entry.record, entry]));
  const byId = new Map<string, IndexedRawEntry>();
  for (const node of tree.nodes) {
    const rawEntry = rawByRecord.get(node.entry);
    if (rawEntry) {
      rawEntry.parentId = node.parentId;
      byId.set(node.id, rawEntry);
    }
  }
  const activeRawEntries = tree.hasExplicitLeafUpdate
    ? buildActiveTreeEntries({ byId, leafId: tree.leafId })
    : rawEntries;
  return {
    filePath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hasTreeEntries: tree.hasExplicitLeafUpdate,
    ...(tree.hasExplicitLeafUpdate ? { leafId: tree.leafId } : {}),
    entries: toIndexedEntries(activeRawEntries),
    allEntries: toIndexedEntries(rawEntries),
  };
}

/** Reads or builds the visible transcript index for a JSONL session file. */
export async function readSessionTranscriptIndex(
  filePath: string,
  opts: ReadSessionTranscriptIndexOptions = {},
): Promise<SessionTranscriptIndex | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    transcriptIndexCache.delete(filePath);
    return null;
  }
  if (!stat.isFile()) {
    transcriptIndexCache.delete(filePath);
    return null;
  }
  if (opts.cache === "skip") {
    return selectTranscriptIndexView(await buildSessionTranscriptIndex(filePath, stat), opts.view);
  }
  const cached = transcriptIndexCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return selectTranscriptIndexView(touchCachedIndex(filePath, cached), opts.view);
  }
  const inFlight = transcriptIndexBuilds.get(filePath);
  if (inFlight && inFlight.mtimeMs === stat.mtimeMs && inFlight.size === stat.size) {
    return selectTranscriptIndexView(await inFlight.promise, opts.view);
  }
  const promise = buildSessionTranscriptIndex(filePath, stat);
  transcriptIndexBuilds.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    promise,
  });
  const index = await promise.finally(() => {
    const current = transcriptIndexBuilds.get(filePath);
    if (current?.promise === promise) {
      transcriptIndexBuilds.delete(filePath);
    }
  });
  setCachedIndex(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    index,
  });
  return selectTranscriptIndexView(index, opts.view);
}
