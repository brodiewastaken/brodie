// Tracks image attachments that belong to the current reply turn.
import { createHash } from "node:crypto";
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { ImageContent } from "../../llm/types.js";
import {
  stripExtractedFileImageMetadata,
  type ExtractedFileImage,
} from "../../media-understanding/extracted-file-images.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { MsgContext } from "../templating.js";
import { resolveAgentTurnAttachments } from "./agent-turn-attachments.js";

type CurrentImageAttachment = {
  index: number;
  externalizationIndex?: number;
  sourceMessageId?: string;
  sourceIndex?: number;
  path: string;
  mediaType: string;
};

type OrderedTurnImage = {
  image?: ImageContent;
  imageOrder: PromptImageOrderEntry;
  sourceIndex?: number;
  sequence: number;
};

function isGenericMediaType(mediaType: string | undefined): boolean {
  if (!mediaType) {
    return true;
  }
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase();
  return normalized === "application/octet-stream" || normalized === "binary/octet-stream";
}

/** Resolves image media types from current-turn attachment metadata or filenames. */
function resolveCurrentImageMediaType(pathValue: unknown, mediaType?: unknown): string | undefined {
  const mediaPath = normalizeOptionalString(pathValue);
  if (!mediaPath) {
    return undefined;
  }
  const normalizedMediaType = normalizeOptionalString(mediaType);
  if (normalizedMediaType?.startsWith("image/")) {
    return normalizedMediaType.split(";", 1)[0]?.trim().toLowerCase() === "image/gif"
      ? undefined
      : normalizedMediaType;
  }
  if (!isGenericMediaType(normalizedMediaType)) {
    return undefined;
  }
  const inferredType = mimeTypeFromFilePath(mediaPath);
  return inferredType?.startsWith("image/") && inferredType !== "image/gif"
    ? inferredType
    : undefined;
}

function collectImageAttachments(params: {
  pathsValue?: string[];
  pathValue?: string;
  typesValue?: string[];
  typeValue?: string;
  startIndex: number;
  sourceMessageIds?: string[];
  sourceIndexes?: number[];
  fallbackSourceMessageId?: string;
  current: boolean;
}): CurrentImageAttachment[] {
  const pathsFromArray = Array.isArray(params.pathsValue) ? params.pathsValue : undefined;
  const paths =
    pathsFromArray && pathsFromArray.length > 0
      ? pathsFromArray
      : normalizeOptionalString(params.pathValue)
        ? [params.pathValue]
        : [];
  if (paths.length === 0) {
    return [];
  }
  const types =
    Array.isArray(params.typesValue) && params.typesValue.length === paths.length
      ? params.typesValue
      : undefined;
  const attachments: CurrentImageAttachment[] = [];
  for (const [index, pathValue] of paths.entries()) {
    const mediaPath = normalizeOptionalString(pathValue);
    const mediaType = resolveCurrentImageMediaType(pathValue, types?.[index] ?? params.typeValue);
    if (mediaPath && mediaType) {
      const sourceMessageId = params.sourceMessageIds?.[index] ?? params.fallbackSourceMessageId;
      attachments.push({
        index: params.startIndex + attachments.length,
        ...(params.current ? { externalizationIndex: index } : {}),
        ...(sourceMessageId ? { sourceMessageId } : {}),
        ...(sourceMessageId ? { sourceIndex: params.sourceIndexes?.[index] ?? index } : {}),
        path: mediaPath,
        mediaType,
      });
    }
  }
  return attachments;
}

function collectCurrentImageAttachments(ctx: MsgContext): CurrentImageAttachment[] {
  const quoted = collectImageAttachments({
    pathsValue: ctx.ReplyToMediaPaths,
    pathValue: ctx.ReplyToMediaPath,
    typesValue: ctx.ReplyToMediaTypes,
    typeValue: ctx.ReplyToMediaType,
    startIndex: 0,
    fallbackSourceMessageId: ctx.ReplyToIdFull ?? ctx.ReplyToId,
    current: false,
  });
  const current = collectImageAttachments({
    pathsValue: ctx.MediaPaths,
    pathValue: ctx.MediaPath,
    typesValue: ctx.MediaTypes,
    typeValue: ctx.MediaType,
    startIndex: quoted.length,
    sourceMessageIds: ctx.MediaSourceMessageIds,
    sourceIndexes: ctx.MediaSourceIndexes,
    fallbackSourceMessageId: ctx.MessageSid,
    current: true,
  });
  return [...quoted, ...current];
}

function collectExternalizedAttachmentIndexes(ctx: MsgContext): Set<number> {
  return new Set(
    ctx.ExternalFiles?.flatMap((file) =>
      Number.isSafeInteger(file.attachmentIndex) && file.attachmentIndex >= 0
        ? [file.attachmentIndex]
        : [],
    ) ?? [],
  );
}

function createNativeImageContext(
  ctx: MsgContext,
  undescribedAttachments: CurrentImageAttachment[],
): MsgContext {
  const first = undescribedAttachments[0];
  return {
    ...ctx,
    MediaPath: first?.path,
    MediaType: first?.mediaType,
    MediaPaths: undescribedAttachments.map((attachment) => attachment.path),
    MediaTypes: undescribedAttachments.map((attachment) => attachment.mediaType),
  };
}

function appendOrderedImages(params: {
  entries: OrderedTurnImage[];
  images: ImageContent[] | undefined;
  imageOrder?: PromptImageOrderEntry[];
  sourceIndex?: number;
}) {
  const images = params.images ?? [];
  if (!params.imageOrder || params.imageOrder.length === 0) {
    for (const image of images) {
      params.entries.push({
        image,
        imageOrder: "inline",
        sourceIndex: params.sourceIndex,
        sequence: params.entries.length,
      });
    }
    return;
  }

  let inlineIndex = 0;
  for (const imageOrder of params.imageOrder) {
    params.entries.push({
      image: imageOrder === "inline" ? images[inlineIndex++] : undefined,
      imageOrder,
      sourceIndex: params.sourceIndex,
      sequence: params.entries.length,
    });
  }
  while (inlineIndex < images.length) {
    params.entries.push({
      image: images[inlineIndex++],
      imageOrder: "inline",
      sourceIndex: params.sourceIndex,
      sequence: params.entries.length,
    });
  }
}

function resolveMergedTurnImages(entries: OrderedTurnImage[]): {
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
} {
  if (entries.length === 0) {
    return {};
  }
  const merged = entries.toSorted((left, right) => {
    if (left.sourceIndex !== undefined && right.sourceIndex !== undefined) {
      return left.sourceIndex - right.sourceIndex || left.sequence - right.sequence;
    }
    if (left.sourceIndex !== undefined || right.sourceIndex !== undefined) {
      return left.sequence - right.sequence;
    }
    return left.sequence - right.sequence;
  });
  const images = merged.flatMap((entry) => (entry.image ? [entry.image] : []));
  return {
    ...(images.length > 0 ? { images } : {}),
    imageOrder: merged.map((entry) => entry.imageOrder),
  };
}

/** Resolves current-turn still images that were not externalized as non-native media. */
export async function resolveCurrentTurnImages(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  extractedFileImages?: ExtractedFileImage[];
  maxNativeImages?: number;
  nativeImageOmissionReason?: "policy_ceiling" | "model_not_image_capable";
}): Promise<{
  images?: ImageContent[];
  imageOrder?: PromptImageOrderEntry[];
  nativeImageInputs?: Array<{
    attachmentIndex: number;
    sourceMessageId?: string;
    sourceIndex?: number;
    contentHash: string;
  }>;
  nativeImageOmissions?: Array<{
    attachmentIndex: number;
    sourceMessageId?: string;
    sourceIndex?: number;
    reason: "policy_ceiling" | "model_not_image_capable";
  }>;
}> {
  const entries: OrderedTurnImage[] = [];
  appendOrderedImages({
    entries,
    images: params.images,
    imageOrder: params.imageOrder,
  });
  for (const image of params.extractedFileImages ?? []) {
    appendOrderedImages({
      entries,
      images: [stripExtractedFileImageMetadata(image)],
      sourceIndex: image.attachmentIndex,
    });
  }

  const currentImageAttachments = collectCurrentImageAttachments(params.ctx);
  if (currentImageAttachments.length === 0) {
    return resolveMergedTurnImages(entries);
  }
  const externalizedAttachmentIndexes = collectExternalizedAttachmentIndexes(params.ctx);
  const nativeImageAttachments = currentImageAttachments.filter(
    (attachment) =>
      attachment.externalizationIndex === undefined ||
      !externalizedAttachmentIndexes.has(attachment.externalizationIndex),
  );
  if (nativeImageAttachments.length === 0) {
    return resolveMergedTurnImages(entries);
  }
  const maxNativeImages = Math.max(
    0,
    Math.min(
      Math.floor(params.maxNativeImages ?? nativeImageAttachments.length),
      nativeImageAttachments.length,
    ),
  );
  const retainedNativeImageAttachments = nativeImageAttachments.slice(0, maxNativeImages);
  const nativeImageOmissions = nativeImageAttachments.slice(maxNativeImages).map((attachment) => {
    const omission: {
      attachmentIndex: number;
      sourceMessageId?: string;
      sourceIndex?: number;
      reason: "policy_ceiling" | "model_not_image_capable";
    } = {
      attachmentIndex: attachment.index,
      reason: params.nativeImageOmissionReason ?? "policy_ceiling",
    };
    if (attachment.sourceMessageId) {
      omission.sourceMessageId = attachment.sourceMessageId;
    }
    if (attachment.sourceIndex !== undefined) {
      omission.sourceIndex = attachment.sourceIndex;
    }
    return omission;
  });
  if (retainedNativeImageAttachments.length === 0) {
    return {
      ...resolveMergedTurnImages(entries),
      ...(nativeImageOmissions.length > 0 ? { nativeImageOmissions } : {}),
    };
  }

  try {
    // Still images remain native even when media understanding also supplied a
    // description. Externalized GIF/video/document indexes are the only ones
    // removed from the native lane.
    const resolved = await resolveAgentTurnAttachments({
      ctx: createNativeImageContext(params.ctx, retainedNativeImageAttachments),
      cfg: params.cfg,
      includeRecentHistoryImages: false,
    });
    const images = resolved.attachments.map(
      (attachment): ImageContent => ({
        type: "image",
        data: attachment.data,
        mimeType: attachment.mediaType,
      }),
    );
    if (images.length < retainedNativeImageAttachments.length) {
      logVerbose(
        `agent-runner: native OpenClaw media resolution produced ${images.length}/${retainedNativeImageAttachments.length} current image attachment(s); falling back to prompt image refs`,
      );
      return resolveMergedTurnImages(entries);
    }
    for (const [index, image] of images.entries()) {
      appendOrderedImages({
        entries,
        images: [image],
        sourceIndex: retainedNativeImageAttachments[index]?.index,
      });
    }
    return {
      ...resolveMergedTurnImages(entries),
      nativeImageInputs: images.map((image, index) => {
        const attachment = retainedNativeImageAttachments[index]!;
        const input: {
          attachmentIndex: number;
          sourceMessageId?: string;
          sourceIndex?: number;
          contentHash: string;
        } = {
          attachmentIndex: attachment.index,
          contentHash: `sha256:${createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex")}`,
        };
        if (attachment.sourceMessageId) {
          input.sourceMessageId = attachment.sourceMessageId;
        }
        if (attachment.sourceIndex !== undefined) {
          input.sourceIndex = attachment.sourceIndex;
        }
        return input;
      }),
      ...(nativeImageOmissions.length > 0 ? { nativeImageOmissions } : {}),
    };
  } catch (error) {
    logVerbose(
      `agent-runner: media attachment image resolution failed, proceeding without native images: ${formatErrorMessage(error)}`,
    );
    return resolveMergedTurnImages(entries);
  }
}
