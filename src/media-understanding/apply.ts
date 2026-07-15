// Applies media-understanding outputs to inbound message context, including
// attachment normalization, provider execution, non-native media
// externalization (context-engine external files), and transcript echoing.
// Still images stay native (spec memory-media.md B11); everything else —
// video, audio, documents, GIFs — resolves to a ContextEngineExternalFile.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ActiveMediaModel } from "../../packages/media-understanding-common/src/active-model.js";
import {
  extractMediaUserText,
  formatAudioTranscripts,
  formatMediaUnderstandingBody,
} from "../../packages/media-understanding-common/src/format.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import type { ContextEngineExternalFile } from "../context-engine/external-files.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import {
  attachHumanInboundMediaUnderstanding,
  renderHumanInboundBatch,
} from "../scheduler/human-inbound.js";
import { resolveAttachmentKind } from "./attachments.js";
import { runWithConcurrency } from "./concurrency.js";
import { DEFAULT_ECHO_TRANSCRIPT_FORMAT, sendTranscriptEcho } from "./echo-transcript.js";
import type { ExtractedFileImage } from "./extracted-file-images.js";
import { resolveConcurrency } from "./resolve.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  resolveMediaAttachmentLocalRoots,
  runCapability,
} from "./runner.js";
import type {
  MediaUnderstandingCapability,
  MediaUnderstandingDecision,
  MediaUnderstandingOutput,
  MediaUnderstandingProvider,
} from "./types.js";

export type ApplyMediaUnderstandingResult = {
  outputs: MediaUnderstandingOutput[];
  decisions: MediaUnderstandingDecision[];
  /** Retained for callers while non-native files move through context-engine externalization. */
  extractedFileImages: ExtractedFileImage[];
  appliedImage: boolean;
  appliedAudio: boolean;
  appliedVideo: boolean;
  appliedFile: boolean;
};

const CAPABILITY_ORDER: MediaUnderstandingCapability[] = ["image", "audio", "video"];
const EMPTY_VOICE_NOTE_PLACEHOLDER =
  "[Voice note could not be transcribed because the audio attachment was too small]";
export const EXTERNAL_MEDIA_MAX_BYTES = 512 * 1024 * 1024;

// Reject inputs with trailing junk after the type/subtype to defend against
// callers that compare the original string elsewhere; permit the standard
// `;param=value` parameter tail (RFC 9110 §8.3) and discard it.
const MIME_TYPE = String.raw`([a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+)`;
const HTTP_TOKEN = String.raw`[a-z0-9!#$%&'*+.^_\x60|~-]+`;
const HTTP_QUOTED_STRING = String.raw`"(?:[\t !#-\[\]-~]|\\[\t -~])*"`;
const MIME_PARAMETER = String.raw`[ \t]*;[ \t]*${HTTP_TOKEN}=(?:${HTTP_TOKEN}|${HTTP_QUOTED_STRING})`;
const MIME_TYPE_WITH_OPTIONAL_PARAMS = new RegExp(
  String.raw`^${MIME_TYPE}(?:${MIME_PARAMETER})*$`,
  "i",
);
const EXTERNAL_MARKER_CONTROL_CHAR_RE = new RegExp(
  String.raw`[\u0000-\u001f\u007f-\u009f\u2028\u2029]+`,
  "gu",
);

export function sanitizeMimeType(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(MIME_TYPE_WITH_OPTIONAL_PARAMS);
  return match?.[1]?.toLowerCase();
}

function appendExternalFileReferences(
  body: string | undefined,
  externalFiles: ContextEngineExternalFile[],
): string {
  if (!externalFiles || externalFiles.length === 0) {
    return body ?? "";
  }
  const base = typeof body === "string" ? body.trim() : "";
  const suffix = externalFiles
    .map((file) => file.marker)
    .join("\n\n")
    .trim();
  if (!base) {
    return suffix;
  }
  return `${base}\n\n${suffix}`.trim();
}

function buildSyntheticSkippedAudioOutputs(
  decisions: MediaUnderstandingDecision[],
): MediaUnderstandingOutput[] {
  const audioDecision = decisions.find((decision) => decision.capability === "audio");
  if (!audioDecision) {
    return [];
  }
  return audioDecision.attachments.flatMap((attachment) => {
    const hasTooSmallAttempt = attachment.attempts.some((attempt) =>
      attempt.reason?.trim().startsWith("tooSmall"),
    );
    if (!hasTooSmallAttempt) {
      return [];
    }
    return [
      {
        kind: "audio.transcription" as const,
        attachmentIndex: attachment.attachmentIndex,
        text: EMPTY_VOICE_NOTE_PLACEHOLDER,
        provider: "openclaw",
        model: "synthetic-empty-audio",
      },
    ];
  });
}

/**
 * A URL-backed attachment can be declared as a still image while its fetched
 * bytes are a GIF/video. Probe it only under the normal native-image byte cap:
 * native candidates must never enter the 512 MiB external-file copy lane just
 * to discover their MIME type. The cache reuses the bounded bytes if the probe
 * reveals a non-native attachment that must be externalized.
 */
async function resolveAttachmentKindForExternalization(params: {
  attachment: ReturnType<typeof normalizeMediaAttachments>[number];
  cache: ReturnType<typeof createMediaAttachmentCache>;
}): Promise<ReturnType<typeof resolveAttachmentKind>> {
  const hintedKind = resolveAttachmentKind(params.attachment);
  if (hintedKind !== "image" || !params.attachment.url) {
    return hintedKind;
  }
  try {
    const probe = await params.cache.getBuffer({
      attachmentIndex: params.attachment.index,
      maxBytes: MAX_IMAGE_BYTES,
      timeoutMs: 120_000,
    });
    return resolveAttachmentKind({
      ...params.attachment,
      path: probe.fileName || params.attachment.path,
      mime: probe.mime ?? params.attachment.mime,
    });
  } catch {
    // The native loader uses the same cap and will independently report an
    // unreadable/oversized image. Do not escalate it into the 512 MiB lane.
    return "image";
  }
}

function basenameFromAttachmentSource(source?: string): string | undefined {
  const value = normalizeOptionalString(source);
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    return path.basename(parsed.pathname) || undefined;
  } catch {
    return path.basename(value) || undefined;
  }
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function resolveSourceMessageId(ctx: MsgContext): string | undefined {
  return (
    normalizeOptionalString(ctx.MessageSidFull) ??
    normalizeOptionalString(ctx.MessageSid) ??
    normalizeOptionalString(ctx.MessageSidFirst) ??
    normalizeOptionalString(ctx.MessageSidLast)
  );
}

function normalizeExternalMarkerValue(value: string | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .normalize("NFC")
    .replace(EXTERNAL_MARKER_CONTROL_CHAR_RE, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (normalized || fallback)
    .replaceAll("%", "%25")
    .replaceAll("[", "%5B")
    .replaceAll("]", "%5D")
    .replaceAll("|", "%7C");
}

function renderExternalFileMarker(input: {
  markerId: string;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  mediaRef?: string;
  originalPath?: string;
}): string {
  const markerId = normalizeExternalMarkerValue(input.markerId, "unknown");
  const name = normalizeExternalMarkerValue(input.fileName, "unknown");
  const mime = normalizeExternalMarkerValue(input.mimeType, "unknown");
  const bytes =
    typeof input.byteSize === "number" && Number.isFinite(input.byteSize)
      ? `${Math.max(0, Math.floor(input.byteSize)).toLocaleString("en-US")} bytes`
      : "unknown bytes";
  const fields = [markerId, name, mime, bytes];
  if (input.mediaRef) {
    fields.push(`Media ref: ${normalizeExternalMarkerValue(input.mediaRef, "unknown")}`);
  }
  if (input.originalPath) {
    fields.push(`Original path: ${normalizeExternalMarkerValue(input.originalPath, "unknown")}`);
  }
  fields.push("Lossless-claw will replace this with an %5BLCM File%5D reference when available.");
  return `[OpenClaw External File: ${fields.join(" | ")}]`;
}

async function hashManagedExternalFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function resolveAttachmentExternalFile(params: {
  attachment: ReturnType<typeof normalizeMediaAttachments>[number];
  cache: ReturnType<typeof createMediaAttachmentCache>;
}): Promise<{
  mediaRef?: string;
  originalPath?: string;
  sourcePath?: string;
  url?: string;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
}> {
  const { attachment, cache } = params;
  const saved = await cache.persistToInboundStore({
    attachmentIndex: attachment.index,
    maxBytes: EXTERNAL_MEDIA_MAX_BYTES,
    timeoutMs: 120_000,
  });
  return {
    mediaRef: `media://inbound/${saved.id}`,
    originalPath: saved.path,
    sourcePath: saved.sourcePath,
    url: saved.sourceUrl ?? attachment.url,
    fileName:
      saved.fileName ??
      basenameFromAttachmentSource(attachment.path) ??
      basenameFromAttachmentSource(attachment.url) ??
      basenameFromAttachmentSource(saved.path),
    mimeType: sanitizeMimeType(saved.contentType ?? attachment.mime),
    byteSize: saved.size,
  };
}

async function collectExternalFiles(params: {
  attachments: ReturnType<typeof normalizeMediaAttachments>;
  cache: ReturnType<typeof createMediaAttachmentCache>;
  ctx: MsgContext;
  outputs: MediaUnderstandingOutput[];
}): Promise<ContextEngineExternalFile[]> {
  const { attachments, cache, ctx, outputs } = params;
  if (!attachments || attachments.length === 0) {
    return [];
  }
  const fallbackSourceMessageId = resolveSourceMessageId(ctx);
  const outputsByAttachment = new Map<number, MediaUnderstandingOutput[]>();
  for (const output of outputs) {
    const existing = outputsByAttachment.get(output.attachmentIndex) ?? [];
    existing.push(output);
    outputsByAttachment.set(output.attachmentIndex, existing);
  }
  const files: ContextEngineExternalFile[] = [];
  for (const attachment of attachments) {
    if (!attachment) {
      continue;
    }
    const preflightKind = await resolveAttachmentKindForExternalization({ attachment, cache });
    if (preflightKind === "image") {
      continue;
    }
    let resolved: Awaited<ReturnType<typeof resolveAttachmentExternalFile>>;
    try {
      resolved = await resolveAttachmentExternalFile({
        attachment,
        cache,
      });
    } catch (err) {
      // B15: resolution failure skips this file; the turn (and any
      // media-understanding text) proceeds — externalization must never kill
      // a message path.
      if (shouldLogVerbose()) {
        logVerbose(`media: external file skipped index=${attachment.index}: ${String(err)}`);
      }
      continue;
    }
    const kind = resolveAttachmentKind({
      ...attachment,
      path: resolved.fileName ?? attachment.path,
      mime: resolved.mimeType ?? attachment.mime,
    });
    if (kind === "image") {
      // An attachment with no useful hint can resolve to a still image only
      // after MIME sniffing. Still images stay native; discard the transient
      // managed copy created for bounded detection.
      if (resolved.originalPath) {
        await fs.unlink(resolved.originalPath).catch(() => {});
      }
      continue;
    }
    const fileName =
      resolved.fileName ??
      basenameFromAttachmentSource(attachment.path) ??
      basenameFromAttachmentSource(attachment.url) ??
      `attachment-${attachment.index + 1}`;
    const mimeType = resolved.mimeType ?? sanitizeMimeType(attachment.mime);
    const sourceMessageId = attachment.sourceMessageId ?? fallbackSourceMessageId;
    const sourceIndex = attachment.sourceIndex ?? attachment.index;
    const sourceMediaRef = attachment.path?.startsWith("media://") ? attachment.path : undefined;
    // Hash only source-stable facts. Generated managed-store ids/paths are
    // deliberately excluded: saveMedia{Buffer,Stream} assigns a fresh UUID on
    // every safe copy, while reprocessing the same source must dedupe in LCM.
    const identity = JSON.stringify({
      sourceMessageId,
      attachmentIndex: sourceIndex,
      mediaRef: sourceMediaRef,
      sourcePath: resolved.sourcePath ?? attachment.path,
      url: attachment.url,
      fileName,
      mimeType,
      byteSize: resolved.byteSize,
    });
    const idempotencyKey = `external_file_${stableHash(identity)}`;
    const mediaUnderstanding = (outputsByAttachment.get(attachment.index) ?? []).map((output) => {
      const descriptor: {
        kind: MediaUnderstandingOutput["kind"];
        text: string;
        provider: string;
        model?: string;
        trust: "derived_untrusted";
      } = {
        kind: output.kind,
        text: output.text,
        provider: output.provider,
        trust: "derived_untrusted",
      };
      if (output.model) {
        descriptor.model = output.model;
      }
      return descriptor;
    });
    let contentHash: string | undefined;
    if (resolved.originalPath) {
      try {
        contentHash = await hashManagedExternalFile(resolved.originalPath);
      } catch (err) {
        if (shouldLogVerbose()) {
          logVerbose(`media: external file hash skipped index=${attachment.index}: ${String(err)}`);
        }
        continue;
      }
    }
    files.push({
      marker: renderExternalFileMarker({
        markerId: idempotencyKey,
        fileName,
        mimeType,
        byteSize: resolved.byteSize,
        mediaRef: resolved.mediaRef,
        originalPath: resolved.originalPath,
      }),
      idempotencyKey,
      attachmentIndex: attachment.index,
      ...(resolved.mediaRef ? { mediaRef: resolved.mediaRef } : {}),
      ...(resolved.originalPath ? { originalPath: resolved.originalPath } : {}),
      ...(resolved.originalPath ? { managedLocalPath: resolved.originalPath } : {}),
      ...(resolved.url ? { url: resolved.url } : {}),
      fileName,
      ...(mimeType ? { mimeType } : {}),
      ...(typeof resolved.byteSize === "number" ? { byteSize: resolved.byteSize } : {}),
      kind,
      ...(sourceMessageId ? { sourceMessageId } : {}),
      sourceIndex,
      ...(contentHash ? { contentHash } : {}),
      ...(mediaUnderstanding.length > 0
        ? { understanding: mediaUnderstanding, mediaUnderstanding }
        : {}),
    });
  }
  return files;
}

export async function applyMediaUnderstanding(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  providers?: Record<string, MediaUnderstandingProvider>;
  activeModel?: ActiveMediaModel;
}): Promise<ApplyMediaUnderstandingResult> {
  const { ctx, cfg } = params;
  const mediaWorkspaceDir = ctx.MediaWorkspaceDir ?? params.workspaceDir;
  const commandCandidates = [ctx.CommandBody, ctx.RawBody, ctx.Body];
  const originalUserText =
    commandCandidates
      .map((value) => extractMediaUserText(value))
      .find((value) => value && value.trim()) ?? undefined;

  const attachments = normalizeMediaAttachments(ctx);
  const providerRegistry = buildProviderRegistry(params.providers, cfg);
  const cache = createMediaAttachmentCache(attachments, {
    localPathRoots: resolveMediaAttachmentLocalRoots({
      cfg,
      ctx,
      workspaceDir: params.workspaceDir,
    }),
    ssrfPolicy: cfg.tools?.web?.fetch?.ssrfPolicy,
    workspaceDir: mediaWorkspaceDir,
  });

  try {
    const tasks = CAPABILITY_ORDER.map((capability) => async () => {
      const config = cfg.tools?.media?.[capability];
      return await runCapability({
        capability,
        cfg,
        ctx,
        attachments: cache,
        media: attachments,
        agentId: params.agentId,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        providerRegistry,
        config,
        activeModel: params.activeModel,
      });
    });

    const results = await runWithConcurrency(tasks, resolveConcurrency(cfg));
    const outputs: MediaUnderstandingOutput[] = [];
    const decisions: MediaUnderstandingDecision[] = [];
    for (const entry of results) {
      if (!entry) {
        continue;
      }
      for (const output of entry.outputs) {
        outputs.push(output);
      }
      decisions.push(entry.decision);
    }

    const audioOutputAttachmentIndexes = new Set(
      outputs
        .filter((output) => output.kind === "audio.transcription")
        .map((output) => output.attachmentIndex),
    );
    const syntheticSkippedAudioOutputs = buildSyntheticSkippedAudioOutputs(decisions).filter(
      (output) => !audioOutputAttachmentIndexes.has(output.attachmentIndex),
    );

    // Merge synthetic placeholders into the audio slice while preserving the
    // selected audio attachment order from `runCapability()` / `attachments.prefer`.
    // When audio produced no real outputs, insert the synthetic slice at the
    // audio capability slot (before video) instead of appending at the end.
    if (syntheticSkippedAudioOutputs.length > 0) {
      const audioDecision = decisions.find((decision) => decision.capability === "audio");
      const audioAttachmentOrder =
        audioDecision?.attachments.map((attachment) => attachment.attachmentIndex) ?? [];
      const audioOutputsByAttachmentIndex = new Map<number, MediaUnderstandingOutput>();
      for (const output of outputs) {
        if (output.kind === "audio.transcription") {
          audioOutputsByAttachmentIndex.set(output.attachmentIndex, output);
        }
      }
      for (const output of syntheticSkippedAudioOutputs) {
        audioOutputsByAttachmentIndex.set(output.attachmentIndex, output);
      }
      const mergedAudio = audioAttachmentOrder
        .map((attachmentIndex) => audioOutputsByAttachmentIndex.get(attachmentIndex))
        .filter((output): output is MediaUnderstandingOutput => Boolean(output));

      const firstAudioIdx = outputs.findIndex((o) => o.kind === "audio.transcription");
      if (firstAudioIdx >= 0) {
        const before = outputs.slice(0, firstAudioIdx);
        const afterLastAudio = outputs.slice(
          outputs.reduce(
            (last, o, i) => (o.kind === "audio.transcription" ? i : last),
            firstAudioIdx,
          ) + 1,
        );
        outputs.length = 0;
        outputs.push(...before, ...mergedAudio, ...afterLastAudio);
      } else {
        const firstVideoIdx = outputs.findIndex((o) => o.kind === "video.description");
        const audioInsertIdx = firstVideoIdx >= 0 ? firstVideoIdx : outputs.length;
        outputs.splice(audioInsertIdx, 0, ...mergedAudio);
      }
    }

    if (decisions.length > 0) {
      ctx.MediaUnderstandingDecisions = [...(ctx.MediaUnderstandingDecisions ?? []), ...decisions];
    }

    const humanInboundBatch = ctx.HumanInboundBatch;
    if (outputs.length > 0) {
      if (!humanInboundBatch) {
        ctx.Body = formatMediaUnderstandingBody({ body: ctx.Body, outputs });
      }
      const audioOutputs = outputs.filter((output) => output.kind === "audio.transcription");
      if (audioOutputs.length > 0) {
        const transcript = formatAudioTranscripts(audioOutputs);
        ctx.Transcript = transcript;
        if (!humanInboundBatch) {
          if (originalUserText) {
            ctx.CommandBody = originalUserText;
            ctx.RawBody = originalUserText;
          } else {
            ctx.CommandBody = transcript;
            ctx.RawBody = transcript;
          }
        }
        // Echo transcript back to chat before agent processing, if configured.
        const audioCfg = cfg.tools?.media?.audio;
        if (audioCfg?.echoTranscript && transcript) {
          await sendTranscriptEcho({
            ctx,
            cfg,
            transcript,
            format: audioCfg.echoFormat ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT,
          });
        }
      } else if (!humanInboundBatch && originalUserText) {
        ctx.CommandBody = originalUserText;
        ctx.RawBody = originalUserText;
      }
      ctx.MediaUnderstanding = [...(ctx.MediaUnderstanding ?? []), ...outputs];
    }
    const externalFiles = await collectExternalFiles({
      attachments,
      cache,
      ctx,
      outputs,
    });
    if (externalFiles.length > 0) {
      ctx.ExternalFiles = [...(ctx.ExternalFiles ?? []), ...externalFiles];
      // LCM rewrites literal markers in messages; typed queue descriptors alone
      // are not a replacement anchor. Queue refs remain excluded from native
      // prompt-image scanning, so this marker does not double-load images.
      if (!humanInboundBatch) {
        ctx.Body = appendExternalFileReferences(ctx.Body, externalFiles);
      }
    }
    if (humanInboundBatch && (outputs.length > 0 || externalFiles.length > 0)) {
      ctx.HumanInboundBatch = attachHumanInboundMediaUnderstanding({
        batch: humanInboundBatch,
        outputs,
        externalFiles,
      });
      ctx.Body = renderHumanInboundBatch(ctx.HumanInboundBatch);
      ctx.BodyForAgent = ctx.Body;
    } else if (outputs.length > 0 || externalFiles.length > 0) {
      finalizeInboundContext(ctx, {
        forceBodyForAgent: true,
        forceBodyForCommands: outputs.length > 0 || externalFiles.length > 0,
      });
    }

    return {
      outputs,
      decisions,
      extractedFileImages: [],
      appliedImage: outputs.some((output) => output.kind === "image.description"),
      appliedAudio: outputs.some((output) => output.kind === "audio.transcription"),
      appliedVideo: outputs.some((output) => output.kind === "video.description"),
      appliedFile: externalFiles.length > 0,
    };
  } finally {
    await cache.cleanup();
  }
}
