import { normalizeThinkLevel, type ThinkLevel } from "../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveFastModeState } from "./fast-mode.js";
import { resolveNativeImagePolicy } from "./native-image-policy.js";

export type ModelRef = { provider: string; model: string };
export type RunPolicyFallback = Readonly<ModelRef & { fastMode: boolean }>;
export type PolicySource = "explicit" | "configured" | "parent" | "model" | "default";
export type RunPolicy = {
  primary: ModelRef;
  fallbacks: readonly RunPolicyFallback[];
  reasoning: ThinkLevel;
  fastMode: boolean;
  textVerbosity: "low";
  authProfileId?: string;
  startupJournals: "inline" | "paths";
  maxNativeImages: number;
  source: {
    model: PolicySource;
    reasoning: PolicySource;
    fastMode: PolicySource;
    textVerbosity: PolicySource;
    auth: PolicySource;
    startupJournals: PolicySource;
    maxNativeImages: PolicySource;
  };
};

export const BRODIE_BRAIN_CATALOG = Object.freeze({
  "anthropic/claude-opus-5": ["opus", "opus5"],
  "anthropic/claude-opus-4-8": ["opus48"],
  "anthropic/claude-opus-4-7": ["opus47"],
  "anthropic/claude-opus-4-6": ["opus46"],
  "anthropic/claude-sonnet-5": ["sonnet", "sonnet5"],
  "anthropic/claude-fable-5-1": ["fable", "fable51"],
  "anthropic/claude-fable-5": ["fable5"],
  "openai/gpt-6-astra": ["astra"],
  "openai/gpt-5.6-sol": ["sol"],
  "openai/gpt-5.6-terra": ["terra"],
  "openai/gpt-5.6-luna": ["luna"],
} satisfies Record<string, readonly string[]>);

export function isBrodieBrainRef(value: string): boolean {
  return Object.hasOwn(BRODIE_BRAIN_CATALOG, value.trim());
}

function parseModelRef(ref: string): ModelRef {
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator === ref.length - 1) {
    throw new Error(`run policy model must be provider-qualified: ${ref}`);
  }
  return { provider: ref.slice(0, separator), model: ref.slice(separator + 1) };
}

function configuredModel(value: string | { primary?: string; fallbacks?: string[] } | undefined): {
  primary?: string;
  fallbacks: string[];
} {
  if (typeof value === "string") {
    return { primary: value, fallbacks: [] };
  }
  return { primary: value?.primary, fallbacks: value?.fallbacks ?? [] };
}

export function buildBrodieBrainAliasIndex(cfg: OpenClawConfig): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const [ref, defaults] of Object.entries(BRODIE_BRAIN_CATALOG)) {
    const entry = cfg.agents?.defaults?.models?.[ref];
    const aliases = [entry?.alias, ...(entry?.aliases ?? []), ...defaults]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    for (const alias of aliases) {
      const normalized = alias.toLowerCase();
      const existing = index.get(normalized);
      if (existing && existing !== ref) {
        throw new Error(`run policy alias collision: ${alias}`);
      }
      index.set(normalized, ref);
    }
  }
  return index;
}

export function resolveBrodieBrainRef(cfg: OpenClawConfig, input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("/")) {
    if (!Object.hasOwn(BRODIE_BRAIN_CATALOG, trimmed)) {
      throw new Error(`model is not an allowed brodie brain: ${trimmed}`);
    }
    return trimmed;
  }
  const resolved = buildBrodieBrainAliasIndex(cfg).get(trimmed.toLowerCase());
  if (!resolved) {
    throw new Error(`unknown brodie brain alias: ${input}`);
  }
  return resolved;
}

export function resolveRunPolicy(params: {
  cfg: OpenClawConfig;
  kind?: "main" | "subagent" | "cron";
  parentKind?: "main" | "subagent" | "cron";
  parent?: RunPolicy;
  explicitModel?: string;
  explicitFallbacks?: string[];
  explicitReasoning?: ThinkLevel;
  explicitReasoningSource?: PolicySource;
  explicitFastMode?: boolean;
  inheritedCronFastMode?: boolean;
  explicitModelSource?: PolicySource;
  authProfileId?: string;
}): RunPolicy {
  const kind = params.kind ?? "main";
  const defaults = configuredModel(params.cfg.agents?.defaults?.model);
  const subagent = configuredModel(params.cfg.agents?.defaults?.subagents?.model);
  const configured = kind === "subagent" ? subagent : defaults;
  const primaryInput =
    (params.explicitModel ?? configured.primary ?? params.parent?.primary)
      ? (params.explicitModel ??
        configured.primary ??
        (params.parent
          ? `${params.parent.primary.provider}/${params.parent.primary.model}`
          : undefined))
      : undefined;
  if (!primaryInput) {
    throw new Error("run policy requires a configured primary model");
  }
  const primaryRef = resolveBrodieBrainRef(params.cfg, primaryInput);
  const primary = Object.freeze(parseModelRef(primaryRef));
  const fallbackInputs =
    params.explicitFallbacks ??
    (configured.fallbacks.length > 0
      ? configured.fallbacks
      : (params.parent?.fallbacks.map((ref) => `${ref.provider}/${ref.model}`) ?? []));
  const fallbacks = fallbackInputs.map((ref) => {
    const fallback = parseModelRef(resolveBrodieBrainRef(params.cfg, ref));
    return Object.freeze({
      ...fallback,
      fastMode: resolveFastModeState({
        cfg: params.cfg,
        provider: fallback.provider,
        model: fallback.model,
      }).enabled,
    });
  });
  const configuredFast = params.cfg.agents?.defaults?.subagents?.fastMode;
  const parentFastWins = kind === "subagent" && params.parentKind === "cron";
  const modelFast = resolveFastModeState({
    cfg: params.cfg,
    provider: primary.provider,
    model: primary.model,
  }).enabled;
  const fastMode =
    params.explicitFastMode ??
    (parentFastWins ? (params.parent?.fastMode ?? params.inheritedCronFastMode) : undefined) ??
    (kind === "subagent" ? configuredFast : undefined) ??
    params.parent?.fastMode ??
    modelFast;
  const entry = params.cfg.agents?.defaults?.models?.[primaryRef];
  const startupJournals = entry?.startupJournals ?? "paths";
  const nativeImages = resolveNativeImagePolicy({
    cfg: params.cfg,
    provider: primary.provider,
    model: primary.model,
  });
  const modelSource: PolicySource = params.explicitModel
    ? (params.explicitModelSource ?? "explicit")
    : configured.primary
      ? "configured"
      : "parent";
  const configuredReasoning = normalizeThinkLevel(
    kind === "subagent"
      ? params.cfg.agents?.defaults?.subagents?.thinking
      : params.cfg.agents?.defaults?.thinkingDefault,
  );
  const reasoning =
    params.explicitReasoning ?? configuredReasoning ?? params.parent?.reasoning ?? "high";
  const policy: RunPolicy = {
    primary,
    fallbacks: Object.freeze(fallbacks),
    reasoning,
    fastMode,
    textVerbosity: "low",
    ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
    startupJournals,
    maxNativeImages: nativeImages.maxNativeImages,
    source: Object.freeze({
      model: modelSource,
      reasoning: params.explicitReasoning
        ? (params.explicitReasoningSource ?? "explicit")
        : configuredReasoning
          ? "configured"
          : params.parent
            ? "parent"
            : "default",
      fastMode:
        params.explicitFastMode !== undefined
          ? "explicit"
          : parentFastWins &&
              (params.parent !== undefined || params.inheritedCronFastMode !== undefined)
            ? "parent"
            : kind === "subagent" && configuredFast !== undefined
              ? "configured"
              : params.parent
                ? "parent"
                : "model",
      textVerbosity: "default",
      auth: params.authProfileId ? "explicit" : "default",
      startupJournals: entry?.startupJournals ? "model" : "default",
      maxNativeImages:
        nativeImages.source === "default"
          ? "default"
          : nativeImages.source === "global"
            ? "configured"
            : "model",
    }),
  };
  return Object.freeze(policy);
}

/** Resolve the candidate-specific Fast mode recorded in one immutable run policy. */
export function resolveRunPolicyCandidateFastMode(
  policy: RunPolicy,
  provider: string,
  model: string,
): boolean | undefined {
  if (policy.primary.provider === provider && policy.primary.model === model) {
    return policy.fastMode;
  }
  const candidate = policy.fallbacks.find(
    (fallback) => fallback.provider === provider && fallback.model === model,
  );
  return candidate?.fastMode;
}

/** Applies brodie's strict catalog only when the selected primary is one of its brains. */
export function resolveRunPolicyForConfiguredBrain(
  params: Parameters<typeof resolveRunPolicy>[0],
): RunPolicy | undefined {
  const configured = configuredModel(
    params.kind === "subagent"
      ? params.cfg.agents?.defaults?.subagents?.model
      : params.cfg.agents?.defaults?.model,
  );
  const primaryInput = params.explicitModel ?? configured.primary;
  if (!primaryInput) {
    return undefined;
  }
  const canonical = primaryInput.includes("/")
    ? primaryInput.trim()
    : buildBrodieBrainAliasIndex(params.cfg).get(primaryInput.trim().toLowerCase());
  if (!canonical || !isBrodieBrainRef(canonical)) {
    return undefined;
  }
  return resolveRunPolicy(params);
}
