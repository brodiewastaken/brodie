/**
 * Installs context guards for oversized tool-result histories.
 */
import type {
  ContextEngine,
  ContextEngineRuntimeContext,
  ContextEngineRuntimeSettings,
} from "../../context-engine/types.js";
import type { HumanInboundBatch } from "../../scheduler/human-inbound.js";
import {
  normalizeQueueBatchIdentity,
  type QueueBatchIdentity,
} from "../../scheduler/queue-batch-identity.js";
import { DEFAULT_MAX_NATIVE_IMAGES } from "../native-image-policy.js";
import type { AgentMessage } from "../runtime/index.js";
import { stableStringify } from "../stable-stringify.js";
import { formatContextLimitTruncationNotice } from "./context-truncation-notice.js";
import { log } from "./logger.js";
import { MidTurnPrecheckSignal, type MidTurnPrecheckRequest } from "./run/midturn-precheck.js";
import {
  estimateRenderedLlmBoundaryTokenPressure,
  shouldPreemptivelyCompactBeforePrompt,
} from "./run/preemptive-compaction.js";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE,
  type MessageCharEstimateCache,
  createMessageCharEstimateCache,
  estimateContextChars,
  estimateMessageCharsCached,
  getToolResultText,
  invalidateMessageCharsCacheEntry,
  isToolResultMessage,
} from "./tool-result-char-estimator.js";

const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5;
const PREEMPTIVE_OVERFLOW_RATIO = 0.9;

export const PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE =
  "Context overflow: estimated context size exceeds safe threshold during tool loop.";
const TOOL_RESULT_ESTIMATE_TO_TEXT_RATIO = 4 / TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE;
const TRANSCRIPT_PROMPT_TEXT_KEY = "__openclawTranscriptPromptText";

type GuardableTransformContext = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

type GuardableAgent = object;

type GuardableAgentRecord = {
  transformContext?: GuardableTransformContext;
};

type MidTurnPrecheckOptions = {
  enabled?: boolean;
  contextTokenBudget: number;
  reserveTokens: () => number;
  toolResultMaxChars?: number;
  getSystemPrompt?: () => string | undefined;
  getPrePromptMessageCount?: () => number;
  getAuthoritativePromptTokens?: () => number | undefined;
  onMidTurnPrecheck?: (request: MidTurnPrecheckRequest) => void;
};

type ImageContentBlock = { type: "image"; data: string; mimeType: string };
type TextContentBlock = { type: "text"; text: string };

const IMAGE_FILE_EXTENSION_PATTERN = "(?:png|jpe?g|gif|webp|bmp|tiff?|heic|heif)";
const IMAGE_FILE_TOKEN_PATTERN = new RegExp(
  `(?:media://inbound/|[A-Za-z]:[\\\\/]|[~./]|/)?([^\\s\\]|()"'\`<>]+\\.${IMAGE_FILE_EXTENSION_PATTERN})`,
  "gi",
);
// lossless-claw externalizes native image blocks into these marker lines; the
// restore pass pairs them back with pre-assembly source images (C17).
const EXTERNALIZED_LCM_IMAGE_PATTERN =
  /\[(?:User|System|Tool|Assistant|Image) image:\s*[^\]]*LCM file:\s*file_[a-f0-9]{16}\]/i;
const EXTERNALIZED_LCM_IMAGE_LINE_PATTERN =
  /^\[(?:User|System|Tool|Assistant|Image) image:\s*[^\]]*LCM file:\s*file_[a-f0-9]{16}\]$/i;
// Both numbered ("[media attached 1/2: ...]") and un-numbered forms count as
// image-reference text — the pattern changed once and silently disabled restore.
const MEDIA_ATTACHED_IMAGE_PATTERN = /\[media attached(?:\s+\d+\/\d+)?:\s*[^\]]+\]/i;
const QUEUE_MEDIA_UNDERSTANDING_PATTERN =
  /^(?:Audio Transcription|Image Description|Video Description)(?: \d+\/\d+)?:$/m;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isImageContentBlock(value: unknown): value is ImageContentBlock {
  return (
    isRecord(value) &&
    value.type === "image" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string" &&
    value.data.length > 0 &&
    value.mimeType.toLowerCase().startsWith("image/")
  );
}

function isTextContentBlock(value: unknown): value is TextContentBlock {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function getMessageContent(message: AgentMessage): unknown {
  return (message as { content?: unknown }).content;
}

function getMessageText(message: AgentMessage): string {
  const content = getMessageContent(message);
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => (isTextContentBlock(block) ? [block.text] : []))
    .filter((text) => text.trim().length > 0)
    .join("\n");
}

function getMessageImages(message: AgentMessage): ImageContentBlock[] {
  const content = getMessageContent(message);
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((block) => (isImageContentBlock(block) ? [block] : []));
}

function getQueueBatchIdentity(message: AgentMessage): QueueBatchIdentity | undefined {
  const metadata = (message as unknown as { __openclaw?: unknown })["__openclaw"];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  return normalizeQueueBatchIdentity(
    (metadata as { queueBatchIdentity?: unknown }).queueBatchIdentity,
  );
}

function getHumanInboundBatch(message: AgentMessage): HumanInboundBatch | undefined {
  const metadata = (message as unknown as { __openclaw?: unknown })["__openclaw"];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const batch = (metadata as { humanInboundBatch?: unknown }).humanInboundBatch;
  return batch && typeof batch === "object" && !Array.isArray(batch)
    ? (batch as HumanInboundBatch)
    : undefined;
}

function queueBatchIdentityKey(identity: QueueBatchIdentity): string {
  return JSON.stringify([identity.version, identity.routeKey, identity.sourceMessageIds]);
}

export function attachQueueBatchIdentity<T extends AgentMessage>(
  message: T,
  identity: QueueBatchIdentity | undefined,
): T {
  if (!identity || getQueueBatchIdentity(message)) {
    return message;
  }
  const metadata = (message as unknown as { __openclaw?: unknown })["__openclaw"];
  const metadataRecord =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : undefined;
  return {
    ...(message as unknown as Record<string, unknown>),
    __openclaw: { ...metadataRecord, queueBatchIdentity: identity },
  } as unknown as T;
}

function attachHumanInboundBatch<T extends AgentMessage>(
  message: T,
  batch: HumanInboundBatch | undefined,
): T {
  if (!batch || getHumanInboundBatch(message)) {
    return message;
  }
  const metadata = (message as unknown as { __openclaw?: unknown })["__openclaw"];
  const metadataRecord =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : undefined;
  return {
    ...(message as unknown as Record<string, unknown>),
    __openclaw: { ...metadataRecord, humanInboundBatch: batch },
  } as unknown as T;
}

function messageHasImageContent(message: AgentMessage): boolean {
  return getMessageImages(message).length > 0;
}

function normalizeImageIdentityToken(value: string): string {
  const parts = value.trim().replace(/\\/g, "/").split("/");
  return parts.findLast((part) => part.length > 0)?.toLowerCase() ?? "";
}

function extractImageIdentityTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  IMAGE_FILE_TOKEN_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(IMAGE_FILE_TOKEN_PATTERN)) {
    const raw = match[1] ?? match[0];
    const normalized = normalizeImageIdentityToken(raw);
    if (normalized) {
      tokens.add(normalized);
    }
  }
  return tokens;
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

function hasImageReferenceText(text: string): boolean {
  return EXTERNALIZED_LCM_IMAGE_PATTERN.test(text) || MEDIA_ATTACHED_IMAGE_PATTERN.test(text);
}

function appendImageContentBlocks(
  message: AgentMessage,
  images: ImageContentBlock[],
  queueBatchIdentity?: QueueBatchIdentity,
): AgentMessage {
  const imageCopies = images.map((image) => ({ ...image }));
  const content = getMessageContent(message);
  if (Array.isArray(content)) {
    return attachQueueBatchIdentity(
      {
        ...(message as unknown as Record<string, unknown>),
        content: [...content, ...imageCopies],
      } as AgentMessage,
      queueBatchIdentity,
    );
  }
  if (typeof content === "string") {
    return attachQueueBatchIdentity(
      {
        ...(message as unknown as Record<string, unknown>),
        content: [{ type: "text", text: content }, ...imageCopies],
      } as AgentMessage,
      queueBatchIdentity,
    );
  }
  return message;
}

type QueueMediaRichness = readonly [
  nativeImageCount: number,
  externalizedImageCount: number,
  mediaUnderstandingCount: number,
];

function countPatternMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replaceAll("g", "")}g`))]
    .length;
}

function queueMediaRichness(message: AgentMessage): QueueMediaRichness {
  const text = getMessageText(message);
  return [
    getMessageImages(message).length,
    countPatternMatches(text, EXTERNALIZED_LCM_IMAGE_PATTERN),
    countPatternMatches(text, QUEUE_MEDIA_UNDERSTANDING_PATTERN),
  ];
}

function hasQueueMediaRichness(richness: QueueMediaRichness): boolean {
  return richness.some((count) => count > 0);
}

function compareQueueMediaRichness(left: QueueMediaRichness, right: QueueMediaRichness): number {
  for (const index of [0, 1, 2] as const) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/**
 * Strips stray externalized-LCM image lines beyond the queue batch's own image
 * descriptor count — leaked lines from other messages that survived inside the
 * envelope text after compaction (spec C18).
 */
function sanitizeQueueLcmImageLines(
  message: AgentMessage,
  maxLcmImages: number,
): {
  message: AgentMessage;
  removedCount: number;
} {
  const content = getMessageContent(message);
  let seenLcmImages = 0;
  let removedCount = 0;

  const keepText = (text: string): string | undefined => {
    if (EXTERNALIZED_LCM_IMAGE_LINE_PATTERN.test(text.trim())) {
      seenLcmImages += 1;
      if (seenLcmImages > maxLcmImages) {
        removedCount += 1;
        return undefined;
      }
      return text;
    }

    if (!EXTERNALIZED_LCM_IMAGE_PATTERN.test(text)) {
      return text;
    }

    const keptLines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (EXTERNALIZED_LCM_IMAGE_LINE_PATTERN.test(line.trim())) {
        seenLcmImages += 1;
        if (seenLcmImages > maxLcmImages) {
          removedCount += 1;
          continue;
        }
      }
      keptLines.push(line);
    }
    return keptLines.join("\n");
  };

  if (typeof content === "string") {
    const text = keepText(content);
    if (removedCount <= 0) {
      return { message, removedCount };
    }
    return {
      message: {
        ...(message as unknown as Record<string, unknown>),
        content: text ?? "",
      } as AgentMessage,
      removedCount,
    };
  }

  if (!Array.isArray(content)) {
    return { message, removedCount: 0 };
  }

  const nextContent: unknown[] = [];
  for (const block of content) {
    if (!isTextContentBlock(block)) {
      nextContent.push(block);
      continue;
    }
    const text = keepText(block.text);
    if (text !== undefined) {
      nextContent.push(text === block.text ? block : { ...block, text });
    }
  }

  if (removedCount <= 0) {
    return { message, removedCount };
  }
  return {
    message: {
      ...(message as unknown as Record<string, unknown>),
      content: nextContent,
    } as AgentMessage,
    removedCount,
  };
}

/**
 * Deduplicates assembled copies of the same queue-v2 batch where at least one
 * copy carries media richness (native image blocks or externalized-LCM
 * markers): structured media counts choose the fuller copy, while equal
 * non-zero richness keeps the first.
 * Without this, LCM-assembled queue media double-counts every queued image
 * (spec memory-media.md B16/C18).
 */
export function dedupeContextEngineQueueMediaMessages(params: { messages: AgentMessage[] }): {
  messages: AgentMessage[];
  removedCount: number;
} {
  let removedCount = 0;
  let changed = false;
  const result: AgentMessage[] = [];
  const queueMessageIndex = new Map<string, number>();

  for (const rawMessage of params.messages) {
    const identity = getQueueBatchIdentity(rawMessage);
    const sanitized = identity
      ? sanitizeQueueLcmImageLines(rawMessage, identity.nativeImageCount)
      : { message: rawMessage, removedCount: 0 };
    const message = sanitized.message;
    if (sanitized.removedCount > 0) {
      changed = true;
      removedCount += sanitized.removedCount;
    }

    const currentIdentity = getQueueBatchIdentity(message);
    const currentKey = currentIdentity ? queueBatchIdentityKey(currentIdentity) : undefined;
    const currentRichness = queueMediaRichness(message);
    const previousIndex = currentKey ? queueMessageIndex.get(currentKey) : undefined;
    const previous = previousIndex === undefined ? undefined : result[previousIndex];
    const previousRichness = previous ? queueMediaRichness(previous) : ([0, 0, 0] as const);

    if (
      currentKey !== undefined &&
      previousIndex !== undefined &&
      (hasQueueMediaRichness(currentRichness) || hasQueueMediaRichness(previousRichness))
    ) {
      changed = true;
      removedCount += 1;
      if (compareQueueMediaRichness(currentRichness, previousRichness) > 0) {
        result[previousIndex] = message;
      }
      continue;
    }

    if (currentKey !== undefined) {
      queueMessageIndex.set(currentKey, result.length);
    }
    result.push(message);
  }

  return {
    messages: changed ? result : params.messages,
    removedCount,
  };
}

function queueCloneFingerprint(message: AgentMessage): string {
  const { __openclaw: _hostMetadata, ...messageWithoutHostMetadata } = message as unknown as Record<
    string,
    unknown
  >;
  return stableStringify(messageWithoutHostMetadata);
}

/**
 * Restores host-owned queue identity onto exact structured message clones that
 * dropped unknown metadata. Fingerprints cover the whole message minus the
 * host metadata itself; no model-facing queue text is parsed. Ambiguous clones
 * that map to different source identities remain untyped rather than guessed.
 */
function reattachContextEngineQueueBatchIdentities(params: {
  sourceMessages: AgentMessage[];
  assembledMessages: AgentMessage[];
}): AgentMessage[] {
  type Candidate = { identity: QueueBatchIdentity; identityKey: string };
  const identityByFingerprint = new Map<string, Candidate | null>();
  for (const source of params.sourceMessages) {
    const identity = getQueueBatchIdentity(source);
    if (!identity) {
      continue;
    }
    const fingerprint = queueCloneFingerprint(source);
    const identityKey = queueBatchIdentityKey(identity);
    const existing = identityByFingerprint.get(fingerprint);
    if (existing === undefined) {
      identityByFingerprint.set(fingerprint, { identity, identityKey });
    } else if (existing && existing.identityKey !== identityKey) {
      identityByFingerprint.set(fingerprint, null);
    }
  }
  if (identityByFingerprint.size === 0) {
    return params.assembledMessages;
  }

  let changed = false;
  const messages = params.assembledMessages.map((message) => {
    if (getQueueBatchIdentity(message)) {
      return message;
    }
    const candidate = identityByFingerprint.get(queueCloneFingerprint(message));
    if (!candidate) {
      return message;
    }
    changed = true;
    return attachQueueBatchIdentity(message, candidate.identity);
  });
  return changed ? messages : params.assembledMessages;
}

/** Restores the typed inbound manifest on exact metadata-dropping context-engine clones. */
function reattachContextEngineHumanInboundBatches(params: {
  sourceMessages: AgentMessage[];
  assembledMessages: AgentMessage[];
}): AgentMessage[] {
  type Candidate = { batch: HumanInboundBatch; batchKey: string };
  const batchByFingerprint = new Map<string, Candidate | null>();
  for (const source of params.sourceMessages) {
    const batch = getHumanInboundBatch(source);
    if (!batch) {
      continue;
    }
    const fingerprint = queueCloneFingerprint(source);
    const batchKey = stableStringify(batch);
    const existing = batchByFingerprint.get(fingerprint);
    if (existing === undefined) {
      batchByFingerprint.set(fingerprint, { batch, batchKey });
    } else if (existing && existing.batchKey !== batchKey) {
      batchByFingerprint.set(fingerprint, null);
    }
  }
  if (batchByFingerprint.size === 0) {
    return params.assembledMessages;
  }

  let changed = false;
  const messages = params.assembledMessages.map((message) => {
    if (getHumanInboundBatch(message)) {
      return message;
    }
    const candidate = batchByFingerprint.get(queueCloneFingerprint(message));
    if (!candidate) {
      return message;
    }
    changed = true;
    return attachHumanInboundBatch(message, candidate.batch);
  });
  return changed ? messages : params.assembledMessages;
}

function cloneContextEngineSnapshotValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing as T;
  }
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const entry of value) {
      clone.push(cloneContextEngineSnapshotValue(entry, seen));
    }
    return clone as unknown as T;
  }
  if (value instanceof Date) {
    return new Date(value) as unknown as T;
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value) as unknown as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, entry] of Object.entries(value)) {
    clone[key] = cloneContextEngineSnapshotValue(entry, seen);
  }
  return clone as unknown as T;
}

/**
 * Deeply snapshots provider messages before an engine that is allowed to
 * mutate its input runs. Separate snapshots serve as immutable postprocess
 * source truth and disposable assemble input/failure isolation.
 */
export function snapshotContextEnginePostprocessSources(messages: AgentMessage[]): AgentMessage[] {
  return cloneContextEngineSnapshotValue(messages);
}

export function postprocessContextEngineMessages(params: {
  sourceMessages: AgentMessage[];
  assembledMessages: AgentMessage[];
  maxImageInputCount?: number;
  sourceMessageLimit?: number;
}): { messages: AgentMessage[]; restoredCount: number; removedCount: number } {
  const identifiedMessages = reattachContextEngineQueueBatchIdentities({
    sourceMessages: params.sourceMessages,
    assembledMessages: params.assembledMessages,
  });
  const typedMessages = reattachContextEngineHumanInboundBatches({
    sourceMessages: params.sourceMessages,
    assembledMessages: identifiedMessages,
  });
  const restored = restoreContextEngineImageBlocks({
    sourceMessages: params.sourceMessages,
    assembledMessages: typedMessages,
    ...(params.maxImageInputCount !== undefined
      ? { maxInputCount: params.maxImageInputCount }
      : {}),
    ...(params.sourceMessageLimit !== undefined
      ? { sourceMessageLimit: params.sourceMessageLimit }
      : {}),
  });
  const deduped = dedupeContextEngineQueueMediaMessages({ messages: restored.messages });
  return {
    messages: deduped.messages,
    restoredCount: restored.restoredCount,
    removedCount: deduped.removedCount,
  };
}

/**
 * Re-hydrates native image blocks the context engine externalized to text
 * markers: each assembled user message with image-reference text but no image
 * content is paired to a pre-assembly source user message by exact typed queue
 * batch identity first, then image-identity token intersection. A
 * single-candidate fallback applies when exactly one compatible unmatched
 * source remains and either side lacks tokens (spec C17). Conflicting typed
 * identities never fall back across batches; two unmatched sources mean no
 * restore — never guess.
 */
export function restoreContextEngineImageBlocks(params: {
  sourceMessages: AgentMessage[];
  assembledMessages: AgentMessage[];
  maxInputCount?: number;
  sourceMessageLimit?: number;
}): { messages: AgentMessage[]; restoredCount: number } {
  const sourceMessageLimit =
    typeof params.sourceMessageLimit === "number" && Number.isFinite(params.sourceMessageLimit)
      ? Math.max(0, Math.min(params.sourceMessages.length, Math.floor(params.sourceMessageLimit)))
      : params.sourceMessages.length;
  const sourceImageMessages = params.sourceMessages
    .slice(0, sourceMessageLimit)
    .flatMap((message) => {
      if ((message as { role?: unknown }).role !== "user") {
        return [];
      }
      const images = getMessageImages(message);
      if (images.length === 0) {
        return [];
      }
      return [
        {
          images,
          tokens: extractImageIdentityTokens(getMessageText(message)),
          queueBatchIdentity: getQueueBatchIdentity(message),
        },
      ];
    });

  if (sourceImageMessages.length === 0) {
    return { messages: params.assembledMessages, restoredCount: 0 };
  }

  const usedSourceIndexes = new Set<number>();
  let remainingNativeImageSlots =
    typeof params.maxInputCount === "number" &&
    Number.isSafeInteger(params.maxInputCount) &&
    params.maxInputCount >= 0
      ? params.maxInputCount
      : DEFAULT_MAX_NATIVE_IMAGES;
  let restoredCount = 0;
  let changed = false;

  const messages = params.assembledMessages.map((message) => {
    if (remainingNativeImageSlots <= 0) {
      return message;
    }
    if ((message as { role?: unknown }).role !== "user" || messageHasImageContent(message)) {
      return message;
    }

    const text = getMessageText(message);
    if (!hasImageReferenceText(text)) {
      return message;
    }

    const assembledTokens = extractImageIdentityTokens(text);
    const assembledQueueBatchIdentity = getQueueBatchIdentity(message);
    const assembledQueueBatchKey = assembledQueueBatchIdentity
      ? queueBatchIdentityKey(assembledQueueBatchIdentity)
      : undefined;
    const isCompatibleTokenFallback = (sourceIndex: number): boolean => {
      if (usedSourceIndexes.has(sourceIndex)) {
        return false;
      }
      const sourceIdentity = sourceImageMessages[sourceIndex].queueBatchIdentity;
      return (
        !assembledQueueBatchKey ||
        !sourceIdentity ||
        queueBatchIdentityKey(sourceIdentity) === assembledQueueBatchKey
      );
    };

    // Queue identity is authoritative and ordered. Filename tokens are only a
    // fallback for legacy/untyped messages; two batches can legitimately use
    // the same attachment filename while carrying different native bytes.
    let sourceIndex = assembledQueueBatchKey
      ? sourceImageMessages.findIndex(
          (source, index) =>
            !usedSourceIndexes.has(index) &&
            source.queueBatchIdentity !== undefined &&
            queueBatchIdentityKey(source.queueBatchIdentity) === assembledQueueBatchKey,
        )
      : -1;
    if (sourceIndex < 0) {
      sourceIndex = sourceImageMessages.findIndex(
        (source, index) =>
          isCompatibleTokenFallback(index) &&
          source.tokens.size > 0 &&
          assembledTokens.size > 0 &&
          intersects(source.tokens, assembledTokens),
      );
    }

    if (sourceIndex < 0 && EXTERNALIZED_LCM_IMAGE_PATTERN.test(text)) {
      let remainingSourceIndex: number | undefined;
      let remainingSourceCount = 0;
      let remainingSourceHasTokens = true;
      for (let index = 0; index < sourceImageMessages.length; index += 1) {
        if (!isCompatibleTokenFallback(index)) {
          continue;
        }
        remainingSourceIndex = index;
        remainingSourceHasTokens = sourceImageMessages[index].tokens.size > 0;
        remainingSourceCount += 1;
        if (remainingSourceCount > 1) {
          break;
        }
      }
      if (
        remainingSourceCount === 1 &&
        remainingSourceIndex !== undefined &&
        (assembledTokens.size === 0 || !remainingSourceHasTokens)
      ) {
        sourceIndex = remainingSourceIndex;
      }
    }

    if (sourceIndex < 0) {
      return message;
    }

    usedSourceIndexes.add(sourceIndex);
    const images = sourceImageMessages[sourceIndex].images.slice(0, remainingNativeImageSlots);
    if (images.length === 0) {
      return message;
    }
    remainingNativeImageSlots -= images.length;
    restoredCount += images.length;
    changed = true;
    return appendImageContentBlocks(
      message,
      images,
      sourceImageMessages[sourceIndex].queueBatchIdentity,
    );
  });

  return {
    messages: changed ? messages : params.assembledMessages,
    restoredCount,
  };
}

export {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  formatContextLimitTruncationNotice,
} from "./context-truncation-notice.js";

export function markTranscriptPromptText(message: AgentMessage, text: string): void {
  Object.defineProperty(message, TRANSCRIPT_PROMPT_TEXT_KEY, {
    configurable: true,
    enumerable: true,
    value: text,
  });
}

function getTranscriptPromptText(message: AgentMessage): string | undefined {
  const value = (message as unknown as Record<string, unknown>)[TRANSCRIPT_PROMPT_TEXT_KEY];
  return typeof value === "string" ? value : undefined;
}

function restoreTranscriptPromptText(
  message: AgentMessage,
  cache: WeakMap<AgentMessage, AgentMessage>,
): AgentMessage {
  const transcriptText = getTranscriptPromptText(message);
  if (transcriptText === undefined || message.role !== "user") {
    return message;
  }
  const cached = cache.get(message);
  if (cached) {
    return cached;
  }
  const content = (message as { content?: unknown }).content;
  const { [TRANSCRIPT_PROMPT_TEXT_KEY]: _transcriptPromptText, ...messageRest } =
    message as unknown as Record<string, unknown>;
  let restoredMessage: AgentMessage = message;
  if (typeof content === "string") {
    restoredMessage = { ...messageRest, content: transcriptText } as unknown as AgentMessage;
  } else if (Array.isArray(content)) {
    let restored = false;
    const nextContent = content.map((block) => {
      if (restored || !block || typeof block !== "object") {
        return block;
      }
      const textBlock = block as { type?: unknown; text?: unknown };
      if (textBlock.type !== "text" || typeof textBlock.text !== "string") {
        return block;
      }
      restored = true;
      return Object.assign({}, block, { text: transcriptText });
    });
    if (restored) {
      restoredMessage = { ...messageRest, content: nextContent } as unknown as AgentMessage;
    }
  }
  cache.set(message, restoredMessage);
  return restoredMessage;
}

function stripTranscriptPromptMarker(message: AgentMessage): AgentMessage {
  if (getTranscriptPromptText(message) === undefined) {
    return message;
  }
  const { [TRANSCRIPT_PROMPT_TEXT_KEY]: _transcriptPromptText, ...messageRest } =
    message as unknown as Record<string, unknown>;
  return messageRest as unknown as AgentMessage;
}

function projectTranscriptPromptMessages(
  messages: AgentMessage[],
  cache: WeakMap<AgentMessage, AgentMessage>,
): AgentMessage[] {
  let changed = false;
  const projected = messages.map((message) => {
    const next = restoreTranscriptPromptText(message, cache);
    changed ||= next !== message;
    return next;
  });
  return changed ? projected : messages;
}

function stripTranscriptPromptMarkers(messages: AgentMessage[]): AgentMessage[] {
  let changed = false;
  const stripped = messages.map((message) => {
    const next = stripTranscriptPromptMarker(message);
    changed ||= next !== message;
    return next;
  });
  return changed ? stripped : messages;
}

function truncateTextToBudget(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  if (maxChars <= 0) {
    return formatContextLimitTruncationNotice(text.length);
  }

  let bodyBudget = maxChars;
  for (let i = 0; i < 4; i += 1) {
    const estimatedSuffix = formatContextLimitTruncationNotice(
      Math.max(1, text.length - bodyBudget),
    );
    bodyBudget = Math.max(0, maxChars - estimatedSuffix.length);
  }

  let cutPoint = bodyBudget;
  const newline = text.lastIndexOf("\n", cutPoint);
  if (newline > bodyBudget * 0.7) {
    cutPoint = newline;
  }

  const omittedChars = text.length - cutPoint;
  return text.slice(0, cutPoint) + formatContextLimitTruncationNotice(omittedChars);
}

function replaceToolResultText(msg: AgentMessage, text: string): AgentMessage {
  const content = (msg as { content?: unknown }).content;
  const replacementContent =
    typeof content === "string" || content === undefined ? text : [{ type: "text", text }];

  const sourceRecord = msg as unknown as Record<string, unknown>;
  const { details: _details, ...rest } = sourceRecord;
  return {
    ...rest,
    content: replacementContent,
  } as AgentMessage;
}

function estimateBudgetToTextBudget(maxChars: number): number {
  return Math.max(0, Math.floor(maxChars / TOOL_RESULT_ESTIMATE_TO_TEXT_RATIO));
}

function truncateToolResultToChars(
  msg: AgentMessage,
  maxChars: number,
  cache: MessageCharEstimateCache,
): AgentMessage {
  if (!isToolResultMessage(msg)) {
    return msg;
  }

  const estimatedChars = estimateMessageCharsCached(msg, cache);
  if (estimatedChars <= maxChars) {
    return msg;
  }

  const rawText = getToolResultText(msg);
  if (!rawText) {
    const omittedChars = Math.max(
      1,
      estimateBudgetToTextBudget(Math.max(estimatedChars - maxChars, 1)),
    );
    return replaceToolResultText(msg, formatContextLimitTruncationNotice(omittedChars));
  }

  const textBudget = estimateBudgetToTextBudget(maxChars);
  if (textBudget <= 0) {
    return replaceToolResultText(msg, formatContextLimitTruncationNotice(rawText.length));
  }

  if (rawText.length <= textBudget) {
    return replaceToolResultText(msg, rawText);
  }

  const truncatedText = truncateTextToBudget(rawText, textBudget);
  return replaceToolResultText(msg, truncatedText);
}

function cloneMessagesForGuard(messages: AgentMessage[]): AgentMessage[] {
  return messages.map(
    (msg) => ({ ...(msg as unknown as Record<string, unknown>) }) as unknown as AgentMessage,
  );
}

function toolResultsNeedTruncation(params: {
  messages: AgentMessage[];
  maxSingleToolResultChars: number;
}): boolean {
  const { messages, maxSingleToolResultChars } = params;
  const estimateCache = createMessageCharEstimateCache();
  for (const message of messages) {
    if (!isToolResultMessage(message)) {
      continue;
    }
    if (estimateMessageCharsCached(message, estimateCache) > maxSingleToolResultChars) {
      return true;
    }
  }
  return false;
}

function exceedsPreemptiveOverflowThreshold(params: {
  messages: AgentMessage[];
  maxContextChars: number;
}): boolean {
  const estimateCache = createMessageCharEstimateCache();
  return estimateContextChars(params.messages, estimateCache) > params.maxContextChars;
}

function applyMessageMutationInPlace(
  target: AgentMessage,
  source: AgentMessage,
  cache?: MessageCharEstimateCache,
): void {
  if (target === source) {
    return;
  }

  const targetRecord = target as unknown as Record<string, unknown>;
  const sourceRecord = source as unknown as Record<string, unknown>;
  for (const key of Object.keys(targetRecord)) {
    if (!(key in sourceRecord)) {
      delete targetRecord[key];
    }
  }
  Object.assign(targetRecord, sourceRecord);
  if (cache) {
    invalidateMessageCharsCacheEntry(cache, target);
  }
}

function enforceToolResultLimitInPlace(params: {
  messages: AgentMessage[];
  maxSingleToolResultChars: number;
}): void {
  const { messages, maxSingleToolResultChars } = params;
  const estimateCache = createMessageCharEstimateCache();

  for (const message of messages) {
    if (!isToolResultMessage(message)) {
      continue;
    }
    const truncated = truncateToolResultToChars(message, maxSingleToolResultChars, estimateCache);
    applyMessageMutationInPlace(message, truncated, estimateCache);
  }
}

function hasNewToolResultAfterFence(params: {
  messages: AgentMessage[];
  prePromptMessageCount: number;
}): boolean {
  for (const message of params.messages.slice(params.prePromptMessageCount)) {
    if (isToolResultMessage(message)) {
      return true;
    }
  }
  return false;
}

function toMidTurnPrecheckRequest(
  result: ReturnType<typeof shouldPreemptivelyCompactBeforePrompt>,
): MidTurnPrecheckRequest | null {
  if (result.route === "fits") {
    return null;
  }
  return {
    route: result.route,
    estimatedPromptTokens: result.estimatedPromptTokens,
    promptBudgetBeforeReserve: result.promptBudgetBeforeReserve,
    overflowTokens: result.overflowTokens,
    toolResultReducibleChars: result.toolResultReducibleChars,
    effectiveReserveTokens: result.effectiveReserveTokens,
  };
}

/**
 * Per-iteration `afterTurn` + `assemble` wrapper for sessions where
 * the context engine owns compaction. Lets the engine compact inside
 * a long tool loop instead of only at end of attempt.
 */
export function installContextEngineLoopHook(params: {
  agent: GuardableAgent;
  contextEngine: ContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  tokenBudget?: number;
  modelId: string;
  /** Native-image restore budget after assemble; 0 disables (text-only models). */
  maxImageInputCount?: number;
  repairAssembledMessages?: (messages: AgentMessage[]) => AgentMessage[];
  getPrePromptMessageCount?: () => number;
  onAfterTurnCheckpoint?: (messageCount: number) => void;
  onAssembledTokenEstimate?: (estimatedTokens: number | undefined) => void;
  getRuntimeContext?: (params: {
    messages: AgentMessage[];
    prePromptMessageCount: number;
  }) => ContextEngineRuntimeContext | undefined;
  runtimeSettings?: ContextEngineRuntimeSettings;
  /** True when this turn belongs to a heartbeat run. */
  isHeartbeat?: boolean;
}): () => void {
  const { contextEngine, sessionId, sessionKey, sessionFile, tokenBudget, modelId } = params;
  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;
  let lastSeenLength: number | null = null;
  let lastAssembledView: AgentMessage[] | null = null;
  let lastSourceMessages: AgentMessage[] | null = null;
  const transcriptProjectionCache = new WeakMap<AgentMessage, AgentMessage>();

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;
    const sourceMessages = Array.isArray(transformed) ? transformed : messages;
    const transcriptMessages = projectTranscriptPromptMessages(
      sourceMessages,
      transcriptProjectionCache,
    );
    const providerMessages = stripTranscriptPromptMarkers(sourceMessages);
    const postprocessSourceMessages = snapshotContextEnginePostprocessSources(providerMessages);
    const checkedPrefixLength =
      lastSeenLength == null ? 0 : Math.min(lastSeenLength, transcriptMessages.length);
    const sourceHistoryChanged =
      lastSeenLength != null &&
      lastSourceMessages != null &&
      (transcriptMessages.length < lastSeenLength ||
        (transcriptMessages.length === lastSeenLength &&
          transcriptMessages
            .slice(0, checkedPrefixLength)
            .some((message, index) => message !== lastSourceMessages?.[index])));
    if (sourceHistoryChanged) {
      lastSeenLength = null;
      lastAssembledView = null;
      params.onAssembledTokenEstimate?.(undefined);
    }

    // Seed the loop fence from the attempt's pre-prompt message count when available.
    // This keeps the first real post-tool-call iteration eligible for compaction even
    // if the hook's first observed call happens after tool results were appended.
    const prePromptMessageCount = Math.max(
      0,
      Math.min(
        transcriptMessages.length,
        lastSeenLength ?? params.getPrePromptMessageCount?.() ?? transcriptMessages.length,
      ),
    );

    const hasNewMessages = transcriptMessages.length > prePromptMessageCount;
    if (!hasNewMessages) {
      lastSeenLength = prePromptMessageCount;
      lastSourceMessages = transcriptMessages;
      return lastAssembledView ?? providerMessages;
    }
    const disposableAssembleMessages = snapshotContextEnginePostprocessSources(providerMessages);
    try {
      // This hook is only installed for assembly-authoritative engines
      // (ownsCompaction), so the engine must ingest the exact provider view.
      // Feeding the transcript projection here lets a DB-backed assemble()
      // resurrect the transcript text on the wire, silently dropping any
      // model-only prompt content (e.g. the session-reset bootstrap).
      const runtimeContext = params.getRuntimeContext?.({
        messages: providerMessages,
        prePromptMessageCount,
      });
      if (typeof contextEngine.afterTurn === "function") {
        await contextEngine.afterTurn({
          sessionId,
          sessionKey,
          sessionFile,
          messages: providerMessages,
          prePromptMessageCount,
          tokenBudget,
          runtimeContext,
          runtimeSettings: params.runtimeSettings,
          isHeartbeat: params.isHeartbeat,
        });
      } else {
        const newMessages = providerMessages.slice(prePromptMessageCount);
        if (newMessages.length > 0) {
          if (typeof contextEngine.ingestBatch === "function") {
            await contextEngine.ingestBatch({
              sessionId,
              sessionKey,
              messages: newMessages,
              isHeartbeat: params.isHeartbeat,
            });
          } else {
            for (const message of newMessages) {
              await contextEngine.ingest({
                sessionId,
                sessionKey,
                message,
                isHeartbeat: params.isHeartbeat,
              });
            }
          }
        }
      }
      lastSeenLength = transcriptMessages.length;
      params.onAfterTurnCheckpoint?.(lastSeenLength);
      lastSourceMessages = transcriptMessages;
      const assembled = await contextEngine.assemble({
        sessionId,
        sessionKey,
        messages: disposableAssembleMessages,
        tokenBudget,
        model: modelId,
        runtimeSettings: params.runtimeSettings,
        runtimeContext,
      });
      if (assembled && Array.isArray(assembled.messages)) {
        params.onAssembledTokenEstimate?.(
          typeof assembled.estimatedTokens === "number" &&
            Number.isFinite(assembled.estimatedTokens) &&
            assembled.estimatedTokens >= 0
            ? Math.floor(assembled.estimatedTokens)
            : undefined,
        );
        const repairedMessages =
          params.repairAssembledMessages?.(assembled.messages) ?? assembled.messages;
        const postprocessed = postprocessContextEngineMessages({
          sourceMessages: postprocessSourceMessages,
          assembledMessages: repairedMessages,
          ...(params.maxImageInputCount !== undefined
            ? { maxImageInputCount: params.maxImageInputCount }
            : {}),
        });
        if (postprocessed.restoredCount > 0) {
          log.info(
            `context engine assemble externalized native image block(s); restored ` +
              `${postprocessed.restoredCount} image block(s) before provider request ` +
              `sessionId=${sessionId} sessionKey=${sessionKey ?? ""}`,
          );
        }
        if (postprocessed.removedCount > 0) {
          log.info(
            `context engine assemble removed ${postprocessed.removedCount} duplicate queue media ` +
              `message(s) before provider request sessionId=${sessionId} ` +
              `sessionKey=${sessionKey ?? ""}`,
          );
        }
        lastAssembledView = postprocessed.messages;
        return postprocessed.messages;
      }
      lastAssembledView = null;
      params.onAssembledTokenEstimate?.(undefined);
    } catch {
      // Best-effort: any engine failure falls through to the raw source
      // messages so the tool loop still makes forward progress.
      lastSeenLength = prePromptMessageCount;
      lastAssembledView = null;
      lastSourceMessages = transcriptMessages;
      params.onAssembledTokenEstimate?.(undefined);
    }

    return providerMessages;
  }) as GuardableTransformContext;

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}

export function installToolResultContextGuard(params: {
  agent: GuardableAgent;
  contextWindowTokens: number;
  /** Context engine assembly owns admission, so local char heuristics are advisory only. */
  contextEngineOwnsAssembly?: boolean;
  midTurnPrecheck?: MidTurnPrecheckOptions;
}): () => void {
  const contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));
  const maxContextChars = Math.max(
    1_024,
    Math.floor(contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * PREEMPTIVE_OVERFLOW_RATIO),
  );
  const maxSingleToolResultChars = Math.max(
    1_024,
    Math.floor(
      contextWindowTokens * TOOL_RESULT_CHARS_PER_TOKEN_ESTIMATE * SINGLE_TOOL_RESULT_CONTEXT_SHARE,
    ),
  );

  // Agent.transformContext is private in session runtime, so access it via a
  // narrow runtime view to keep callsites type-safe while preserving behavior.
  const mutableAgent = params.agent as GuardableAgentRecord;
  const originalTransformContext = mutableAgent.transformContext;
  let lastSeenLength: number | null = null;

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;

    const sourceMessages = Array.isArray(transformed) ? transformed : messages;
    const contextMessages = toolResultsNeedTruncation({
      messages: sourceMessages,
      maxSingleToolResultChars,
    })
      ? cloneMessagesForGuard(sourceMessages)
      : sourceMessages;
    if (contextMessages !== sourceMessages) {
      enforceToolResultLimitInPlace({
        messages: contextMessages,
        maxSingleToolResultChars,
      });
    }
    if (params.midTurnPrecheck?.enabled) {
      const prePromptMessageCount = Math.max(
        0,
        Math.min(
          contextMessages.length,
          lastSeenLength ??
            params.midTurnPrecheck.getPrePromptMessageCount?.() ??
            contextMessages.length,
        ),
      );
      lastSeenLength = prePromptMessageCount;
      if (
        hasNewToolResultAfterFence({
          messages: contextMessages,
          prePromptMessageCount,
        })
      ) {
        // Use the same post-truncation view the runtime will send to the next model call.
        // Recovery re-applies truncation to the persisted session manager, so
        // this precheck is only a routing signal, not the source of truth.
        const heuristicPrecheck = shouldPreemptivelyCompactBeforePrompt({
          messages: contextMessages,
          systemPrompt: params.midTurnPrecheck.getSystemPrompt?.(),
          // During a tool loop, the active user prompt is already part of messages.
          prompt: "",
          contextTokenBudget: params.midTurnPrecheck.contextTokenBudget,
          reserveTokens: params.midTurnPrecheck.reserveTokens(),
          toolResultMaxChars: params.midTurnPrecheck.toolResultMaxChars,
        });
        const authoritativePromptTokens =
          params.contextEngineOwnsAssembly === true
            ? params.midTurnPrecheck.getAuthoritativePromptTokens?.()
            : undefined;
        const hasAuthoritativePromptTokens =
          typeof authoritativePromptTokens === "number" &&
          Number.isFinite(authoritativePromptTokens) &&
          authoritativePromptTokens >= 0;
        const renderedPromptTokens = hasAuthoritativePromptTokens
          ? estimateRenderedLlmBoundaryTokenPressure({
              systemPrompt: params.midTurnPrecheck.getSystemPrompt?.(),
              // During a tool loop, the active user prompt is already part of the assembled context.
              prompt: "",
            })
          : 0;
        const engineDerivedPromptTokens = hasAuthoritativePromptTokens
          ? authoritativePromptTokens + renderedPromptTokens
          : undefined;
        const precheck = hasAuthoritativePromptTokens
          ? shouldPreemptivelyCompactBeforePrompt({
              messages: contextMessages,
              prompt: "",
              contextTokenBudget: params.midTurnPrecheck.contextTokenBudget,
              reserveTokens: params.midTurnPrecheck.reserveTokens(),
              toolResultMaxChars: params.midTurnPrecheck.toolResultMaxChars,
              llmBoundaryTokenPressure: {
                estimatedPromptTokens: engineDerivedPromptTokens as number,
                source: "context_engine_assembled_plus_rendered_prompt",
              },
            })
          : heuristicPrecheck;
        const request = toMidTurnPrecheckRequest(precheck);
        const pressureLogLine =
          `[context-overflow-midturn-precheck] tool-result-guard check route=${precheck.route} ` +
          `pressureSource=${precheck.pressureSource} heuristicRoute=${heuristicPrecheck.route} ` +
          `heuristicEstimatedPromptTokens=${heuristicPrecheck.estimatedPromptTokens} ` +
          `authoritativePromptTokens=${hasAuthoritativePromptTokens ? authoritativePromptTokens : "unavailable"} ` +
          `renderedPromptTokens=${renderedPromptTokens} ` +
          `messages=${contextMessages.length} prePromptMessageCount=${prePromptMessageCount} ` +
          `estimatedPromptTokens=${precheck.estimatedPromptTokens} ` +
          `promptBudgetBeforeReserve=${precheck.promptBudgetBeforeReserve} ` +
          `overflowTokens=${precheck.overflowTokens}`;
        if (params.contextEngineOwnsAssembly === true && heuristicPrecheck.route !== "fits") {
          log.warn(pressureLogLine);
        } else {
          log.debug(pressureLogLine);
        }
        if (
          request &&
          (params.contextEngineOwnsAssembly !== true || hasAuthoritativePromptTokens)
        ) {
          params.midTurnPrecheck.onMidTurnPrecheck?.(request);
          throw new MidTurnPrecheckSignal(request);
        }
      }
      lastSeenLength = contextMessages.length;
    }
    const exceedsHeuristicHighWater = exceedsPreemptiveOverflowThreshold({
      messages: contextMessages,
      maxContextChars,
    });
    if (exceedsHeuristicHighWater) {
      if (params.contextEngineOwnsAssembly === true) {
        log.warn(
          `[context-overflow-midturn-precheck] char high-water exceeded but context engine owns ` +
            `assembly; heuristic cannot terminate the turn`,
        );
      } else {
        throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
      }
    }

    return contextMessages;
  }) as GuardableTransformContext;

  return () => {
    mutableAgent.transformContext = originalTransformContext;
  };
}
