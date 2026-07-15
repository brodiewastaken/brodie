// Xai helper module supports tool config shared behavior.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeXaiModelId } from "../model-id.js";

export { isRecord };

export function coerceXaiToolConfig(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return isRecord(config) ? config : {};
}

export function resolveNormalizedXaiToolModel(params: {
  config?: Record<string, unknown>;
  defaultModel: string;
}): string {
  const value = coerceXaiToolConfig(params.config).model;
  return typeof value === "string" && value.trim()
    ? normalizeXaiModelId(value.trim())
    : params.defaultModel;
}

export function resolvePositiveIntegerToolConfig(
  config: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const raw = coerceXaiToolConfig(config)[key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  const normalized = Math.trunc(raw);
  return normalized > 0 ? normalized : undefined;
}

export type XaiToolReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

const XAI_TOOL_REASONING_EFFORTS = new Set<XaiToolReasoningEffort>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export function resolveXaiToolReasoningEffort(
  config: Record<string, unknown> | undefined,
): XaiToolReasoningEffort | undefined {
  const raw = coerceXaiToolConfig(config).reasoningEffort;
  return typeof raw === "string" && XAI_TOOL_REASONING_EFFORTS.has(raw as XaiToolReasoningEffort)
    ? (raw as XaiToolReasoningEffort)
    : undefined;
}
