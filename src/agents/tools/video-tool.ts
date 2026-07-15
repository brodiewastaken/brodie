/** Explicit multi-video understanding, separate from video generation. */
import { Type } from "typebox";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MediaUnderstandingConfig } from "../../config/types.tools.js";
import {
  buildProviderRegistry,
  createMediaAttachmentCache,
  normalizeMediaAttachments,
  resolveMediaAttachmentLocalRoots,
  runCapability,
} from "../../media-understanding/runner.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
} from "../../media/media-reference.js";
import type { AnyAgentTool } from "./tool-runtime.helpers.js";

const DEFAULT_VIDEO_PROMPT = "Describe the video accurately.";

type ExplicitVideoConfig = MediaUnderstandingConfig & {
  _requestPromptOverride?: string;
};

function collectVideoInputs(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const candidates = [
    ...(typeof record.video === "string" ? [record.video] : []),
    ...(Array.isArray(record.videos)
      ? record.videos.filter((entry): entry is string => typeof entry === "string")
      : []),
  ];
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const normalized = normalizeMediaReferenceSource(candidate);
    if (!normalized || seen.has(normalized)) {
      return [];
    }
    seen.add(normalized);
    return [normalized];
  });
}

export function createVideoTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
}): AnyAgentTool | null {
  const cfg = options?.config ?? {};
  const configured = cfg.tools?.media?.video;
  if (configured?.enabled === false) {
    return null;
  }
  return {
    label: "Video",
    name: "video",
    description:
      "Analyze one or more existing videos. Use video for one managed reference/path/URL or videos for several. This is understanding, not video_generate.",
    parameters: Type.Object({
      prompt: Type.Optional(Type.String({ description: "Optional focus for the analysis." })),
      video: Type.Optional(Type.String({ description: "One video reference, path, or URL." })),
      videos: Type.Optional(
        Type.Array(Type.String(), { description: "Video references, paths, or URLs." }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const inputs = collectVideoInputs(args);
      if (inputs.length === 0) {
        throw new Error("video or videos required");
      }
      const record = args as Record<string, unknown>;
      const focus = typeof record.prompt === "string" ? record.prompt.trim() : "";
      const basePrompt = configured?.prompt?.trim() || DEFAULT_VIDEO_PROMPT;
      const requestPrompt = focus
        ? `${basePrompt}\n\n[AGENT-REQUESTED FOCUS]\n${focus}`
        : basePrompt;
      const paths: string[] = [];
      const urls: string[] = [];
      for (const input of inputs) {
        const source = classifyMediaReferenceSource(input);
        paths.push(source.isHttpUrl ? "" : input);
        urls.push(source.isHttpUrl ? input : "");
      }
      const ctx = {
        MediaPaths: paths,
        MediaUrls: urls,
        MediaSourceIndexes: inputs.map((_, index) => index),
      } as MsgContext;
      const media = normalizeMediaAttachments(ctx);
      const cache = createMediaAttachmentCache(media, {
        localPathRoots: resolveMediaAttachmentLocalRoots({
          cfg,
          ctx,
          workspaceDir: options?.workspaceDir,
        }),
        ssrfPolicy: cfg.tools?.web?.fetch?.ssrfPolicy,
        workspaceDir: options?.workspaceDir,
      });
      const config: ExplicitVideoConfig = {
        ...configured,
        enabled: true,
        attachments: { mode: "all", maxAttachments: inputs.length },
        _requestPromptOverride: requestPrompt,
      };
      try {
        const result = await runCapability({
          capability: "video",
          cfg,
          ctx,
          attachments: cache,
          media,
          agentDir: options?.agentDir,
          workspaceDir: options?.workspaceDir,
          providerRegistry: buildProviderRegistry(undefined, cfg),
          config,
        });
        const byIndex = new Map(result.outputs.map((output) => [output.attachmentIndex, output]));
        const videos = inputs.map((input, attachmentIndex) => {
          const output = byIndex.get(attachmentIndex);
          const decision = result.decision.attachments.find(
            (candidate) => candidate.attachmentIndex === attachmentIndex,
          );
          return output
            ? {
                input,
                attachmentIndex,
                status: "described",
                text: output.text,
                provider: output.provider,
                model: output.model,
              }
            : {
                input,
                attachmentIndex,
                status: "failed",
                attempts: decision?.attempts ?? [],
              };
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ videos }, null, 2) }],
          details: { capability: "video-understanding", videos },
        };
      } finally {
        await cache.cleanup();
      }
    },
  };
}
