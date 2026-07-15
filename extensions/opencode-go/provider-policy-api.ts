// OpenCode Go policy exposes model-specific thinking controls before runtime registration.
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";

const KIMI_K2_MODEL_IDS = new Set(["kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code"]);
const FIXED_ANTHROPIC_REASONING_MODEL_IDS = new Set(["minimax-m2.5", "minimax-m2.7"]);

const KIMI_K2_THINKING_PROFILE = {
  levels: [{ id: "off" }],
  defaultLevel: "off",
} as const satisfies ProviderThinkingProfile;
const BINARY_REASONING_PROFILE = {
  levels: [{ id: "off" }, { id: "high", label: "on" }],
  defaultLevel: "high",
} as const satisfies ProviderThinkingProfile;
const FIXED_ANTHROPIC_REASONING_PROFILE = {
  levels: [{ id: "high", label: "always on" }],
  defaultLevel: "high",
} as const satisfies ProviderThinkingProfile;
const MAX_REASONING_PROFILE = {
  levels: [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }],
  defaultLevel: "high",
} as const satisfies ProviderThinkingProfile;
const XHIGH_REASONING_PROFILE = {
  levels: [
    { id: "off" },
    { id: "minimal" },
    { id: "low" },
    { id: "medium" },
    { id: "high" },
    { id: "xhigh" },
  ],
  defaultLevel: "medium",
} as const satisfies ProviderThinkingProfile;
const THINKING_LEVEL_IDS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function resolveEffortThinkingProfile(
  efforts: readonly string[] | null | undefined,
): ProviderThinkingProfile | undefined {
  if (!efforts || efforts.length === 0) {
    return undefined;
  }
  const normalizedEfforts = new Set(
    efforts.map((effort) =>
      effort.trim().toLowerCase() === "none" ? "off" : effort.trim().toLowerCase(),
    ),
  );
  normalizedEfforts.add("off");
  const acceptedLevelIds = THINKING_LEVEL_IDS.filter((id) => normalizedEfforts.has(id));
  const levels = acceptedLevelIds.map((id) => ({ id }));
  const levelIds = new Set(acceptedLevelIds);
  const defaultLevel = levelIds.has("medium")
    ? "medium"
    : levelIds.has("high")
      ? "high"
      : levelIds.has("low")
        ? "low"
        : "off";
  return { levels, defaultLevel };
}

export function resolveOpencodeGoThinkingProfile(
  modelId: string,
  context?: Pick<ProviderDefaultThinkingPolicyContext, "reasoning" | "compat">,
): ProviderThinkingProfile | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (context?.reasoning === false) {
    return KIMI_K2_THINKING_PROFILE;
  }
  if (normalized === "muse-spark-1.3-contributor") {
    return XHIGH_REASONING_PROFILE;
  }
  if (normalized === "deepseek-v4.1-flash" || normalized === "glm-5.3-flash") {
    return MAX_REASONING_PROFILE;
  }
  if (KIMI_K2_MODEL_IDS.has(normalized)) {
    return KIMI_K2_THINKING_PROFILE;
  }
  if (normalized === "minimax-m3") {
    return BINARY_REASONING_PROFILE;
  }
  if (FIXED_ANTHROPIC_REASONING_MODEL_IDS.has(normalized)) {
    return FIXED_ANTHROPIC_REASONING_PROFILE;
  }
  return resolveEffortThinkingProfile(context?.compat?.supportedReasoningEfforts);
}

export function resolveThinkingProfile(
  context: ProviderDefaultThinkingPolicyContext,
): ProviderThinkingProfile | undefined {
  return context.provider.trim().toLowerCase() === "opencode-go"
    ? resolveOpencodeGoThinkingProfile(context.modelId, context)
    : undefined;
}
