// Xai plugin module implements runtime model compat behavior.
// Reasoning effort varies by Grok family; encrypted reasoning include/replay is handled
// separately in stream.ts for every reasoning-capable xAI model.
import { applyXaiModelCompat } from "./model-compat.js";

type XaiRuntimeModelCompat = {
  compat?: unknown;
  id?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: XaiThinkingLevelMap;
};
type XaiThinkingLevelMap = Partial<
  Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
>;
export type XaiRequestedThinkingLevel = keyof XaiThinkingLevelMap | "adaptive" | "ultra";

export type XaiThinkingMode = "off" | "fixed" | "grok-4.3" | "grok-4.5" | "grok-4.6";

const XAI_UNSUPPORTED_REASONING_EFFORTS = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
  max: null,
} satisfies NonNullable<XaiRuntimeModelCompat["thinkingLevelMap"]>;

const XAI_FIXED_REASONING_EFFORTS = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
  max: null,
} satisfies NonNullable<XaiRuntimeModelCompat["thinkingLevelMap"]>;

const XAI_GROK_43_REASONING_EFFORTS = {
  off: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
} satisfies NonNullable<XaiRuntimeModelCompat["thinkingLevelMap"]>;

const XAI_GROK_45_REASONING_EFFORTS = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
} satisfies NonNullable<XaiRuntimeModelCompat["thinkingLevelMap"]>;

const XAI_GROK_46_REASONING_EFFORTS = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
} satisfies NonNullable<XaiRuntimeModelCompat["thinkingLevelMap"]>;

function normalizeXaiCompatModelId(id: unknown): string {
  const normalized = typeof id === "string" ? id.trim().toLowerCase() : "";
  return normalized.startsWith("xai/") ? normalized.slice("xai/".length) : normalized;
}

export function resolveXaiThinkingMode(model: XaiRuntimeModelCompat): XaiThinkingMode {
  if (model.reasoning !== true) {
    return "off";
  }
  const id = normalizeXaiCompatModelId(model.id);
  if (id === "grok-4.6" || id.startsWith("grok-4.6-")) {
    return "grok-4.6";
  }
  if (id === "grok-build-latest" || id === "grok-4.5" || id.startsWith("grok-4.5-")) {
    return "grok-4.5";
  }
  if (id === "grok-latest" || id === "grok-4.3" || id.startsWith("grok-4.3-")) {
    return "grok-4.3";
  }
  return "fixed";
}

function resolveXaiReasoningEffortCompat(mode: XaiThinkingMode): Record<string, unknown> {
  switch (mode) {
    case "grok-4.3":
      return {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["none", "low", "medium", "high"],
      };
    case "grok-4.5":
      return {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high"],
      };
    case "grok-4.6":
      return {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
      };
    case "fixed":
    case "off":
      return { supportsReasoningEffort: false };
  }
  return mode satisfies never;
}

function resolveXaiThinkingLevelMap(mode: XaiThinkingMode): XaiThinkingLevelMap {
  switch (mode) {
    case "grok-4.3":
      return XAI_GROK_43_REASONING_EFFORTS;
    case "grok-4.5":
      return XAI_GROK_45_REASONING_EFFORTS;
    case "grok-4.6":
      return XAI_GROK_46_REASONING_EFFORTS;
    case "fixed":
      return XAI_FIXED_REASONING_EFFORTS;
    case "off":
      return XAI_UNSUPPORTED_REASONING_EFFORTS;
  }
  return mode satisfies never;
}

export function resolveXaiReasoningEffort(params: {
  model: XaiRuntimeModelCompat;
  thinkingLevel: XaiRequestedThinkingLevel;
}): string | null {
  const normalizedLevel =
    params.thinkingLevel === "adaptive"
      ? "high"
      : params.thinkingLevel === "ultra"
        ? "max"
        : params.thinkingLevel;
  return resolveXaiThinkingLevelMap(resolveXaiThinkingMode(params.model))[normalizedLevel] ?? null;
}

export function applyXaiRuntimeModelCompat<T extends XaiRuntimeModelCompat>(
  model: T,
): T & { compat: Record<string, unknown>; thinkingLevelMap: XaiThinkingLevelMap } {
  const withCompat = applyXaiModelCompat(model);
  const thinkingMode = resolveXaiThinkingMode(withCompat);
  const existingCompat =
    withCompat.compat && typeof withCompat.compat === "object"
      ? (withCompat.compat as Record<string, unknown>)
      : {};
  return {
    ...withCompat,
    compat: {
      ...existingCompat,
      ...resolveXaiReasoningEffortCompat(thinkingMode),
    },
    thinkingLevelMap: {
      ...withCompat.thinkingLevelMap,
      ...resolveXaiThinkingLevelMap(thinkingMode),
    },
  };
}
