// Xai API module exposes the plugin public contract.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveXaiCatalogEntry } from "./model-definitions.js";
import { resolveXaiThinkingMode } from "./runtime-model-compat.js";

const ALL_MAPPED_LEVELS = [
  { id: "off" },
  { id: "minimal" },
  { id: "low" },
  { id: "medium" },
  { id: "high" },
  { id: "xhigh" },
  { id: "adaptive" },
  { id: "max" },
  { id: "ultra" },
] as const;

export function resolveThinkingProfile(
  ctx: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile {
  const reasoning = ctx.reasoning ?? resolveXaiCatalogEntry(ctx.modelId)?.reasoning;
  if (ctx.provider !== "xai") {
    return { levels: [{ id: "off" }], defaultLevel: "off" };
  }
  if (!reasoning) {
    return {
      levels: ALL_MAPPED_LEVELS,
      defaultLevel: "off",
      preserveWhenCatalogReasoningFalse: true,
    };
  }
  const mode = resolveXaiThinkingMode({ id: ctx.modelId, reasoning });
  switch (mode) {
    case "grok-4.3":
      return { levels: ALL_MAPPED_LEVELS, defaultLevel: "low" };
    case "grok-4.5":
    case "grok-4.6":
      return { levels: ALL_MAPPED_LEVELS, defaultLevel: "high" };
    case "fixed":
      return { levels: ALL_MAPPED_LEVELS, defaultLevel: "high" };
    case "off":
      return { levels: [{ id: "off" }], defaultLevel: "off" };
  }
  return mode satisfies never;
}
