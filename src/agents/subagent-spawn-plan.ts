/**
 * Subagent spawn planning helpers.
 *
 * Resolves model, thinking, and timeout choices before the sessions_spawn executor launches work.
 */
import { formatThinkingLevels } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
  resolveSubagentSpawnModelSelection,
} from "./model-selection.js";
import { resolveRunPolicyForConfiguredBrain, type RunPolicy } from "./run-policy.js";
import { resolveSubagentThinkingOverride } from "./subagent-spawn-thinking.js";

/** Splits a provider/model ref while preserving model-only refs. */
export function splitModelRef(ref?: string) {
  if (!ref) {
    return { provider: undefined, model: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { provider: undefined, model: undefined };
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    const provider = trimmed.slice(0, slash);
    const model = trimmed.slice(slash + 1);
    return { provider, model };
  }
  const provider = undefined;
  const model = trimmed;
  if (model) {
    return { provider, model };
  }
  return { provider: undefined, model: trimmed };
}

/** Resolves the effective subagent run timeout from per-call override or config default. */
export function resolveConfiguredSubagentRunTimeoutSeconds(params: {
  cfg: OpenClawConfig;
  runTimeoutSeconds?: number;
}) {
  const cfgSubagentTimeout =
    typeof params.cfg?.agents?.defaults?.subagents?.runTimeoutSeconds === "number" &&
    Number.isFinite(params.cfg.agents.defaults.subagents.runTimeoutSeconds)
      ? Math.max(0, Math.floor(params.cfg.agents.defaults.subagents.runTimeoutSeconds))
      : 0;
  return typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
    ? Math.max(0, Math.floor(params.runTimeoutSeconds))
    : cfgSubagentTimeout;
}

/** Resolves the subagent model plus thinking patch to apply to the spawned session. */
export function resolveSubagentModelAndThinkingPlan(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  requesterAgentConfig?: unknown;
  targetAgentConfig?: unknown;
  modelOverride?: string;
  thinkingOverrideRaw?: string;
  fastModeOverride?: boolean;
  callerThinkingRaw?: string;
  callerFastMode?: boolean | "auto";
  callerIsCron?: boolean;
  parentRunPolicy?: RunPolicy;
}) {
  const resolvedModel = resolveSubagentSpawnModelSelection({
    cfg: params.cfg,
    agentId: params.targetAgentId,
    modelOverride: params.modelOverride,
  });

  const thinkingPlan = resolveSubagentThinkingOverride({
    cfg: params.cfg,
    requesterAgentConfig: params.requesterAgentConfig,
    targetAgentConfig: params.targetAgentConfig,
    thinkingOverrideRaw: params.thinkingOverrideRaw,
    callerThinkingRaw: params.callerThinkingRaw,
  });
  if (thinkingPlan.status === "error") {
    const { provider, model } = splitModelRef(resolvedModel);
    // The hint is provider/model-specific because valid thinking levels vary by backend.
    const hint = formatThinkingLevels(provider, model);
    return {
      status: "error" as const,
      resolvedModel,
      error: `Invalid thinking level "${thinkingPlan.thinkingCandidateRaw}". Use one of: ${hint}.`,
    };
  }

  const modelOverrideSource = params.modelOverride?.trim() ? "user" : "auto";
  const requesterSubagentFastMode = (
    params.requesterAgentConfig as { subagents?: { fastMode?: unknown } } | undefined
  )?.subagents?.fastMode;
  const targetSubagentFastMode = (
    params.targetAgentConfig as { subagents?: { fastMode?: unknown } } | undefined
  )?.subagents?.fastMode;
  const configuredFastMode =
    typeof requesterSubagentFastMode === "boolean"
      ? requesterSubagentFastMode
      : typeof targetSubagentFastMode === "boolean"
        ? targetSubagentFastMode
        : params.cfg.agents?.defaults?.subagents?.fastMode;
  const fastMode =
    typeof params.fastModeOverride === "boolean"
      ? params.fastModeOverride
      : params.callerIsCron && typeof params.callerFastMode === "boolean"
        ? params.callerFastMode
        : typeof configuredFastMode === "boolean"
          ? configuredFastMode
          : typeof params.callerFastMode === "boolean"
            ? params.callerFastMode
            : false;
  const resolvedRunPolicy = resolveRunPolicyForConfiguredBrain({
    cfg: params.cfg,
    kind: "subagent",
    parentKind: params.callerIsCron ? "cron" : params.parentRunPolicy ? "subagent" : "main",
    parent: params.parentRunPolicy,
    explicitModel: resolvedModel,
    explicitModelSource: params.modelOverride?.trim() ? "explicit" : "configured",
    ...(thinkingPlan.thinkingOverride
      ? {
          explicitReasoning: thinkingPlan.thinkingOverride,
          explicitReasoningSource: params.thinkingOverrideRaw?.trim()
            ? ("explicit" as const)
            : ("configured" as const),
        }
      : {}),
    ...(typeof params.fastModeOverride === "boolean"
      ? { explicitFastMode: params.fastModeOverride }
      : {}),
    ...(params.callerIsCron && typeof params.callerFastMode === "boolean"
      ? { inheritedCronFastMode: params.callerFastMode }
      : {}),
  });
  const hasConfiguredAutoModel =
    modelOverrideSource === "auto" &&
    Boolean(
      resolveSubagentConfiguredModelSelection({
        cfg: params.cfg,
        agentId: params.targetAgentId,
      }),
    );
  const configuredModelRef = hasConfiguredAutoModel ? splitModelRef(resolvedModel) : undefined;
  const modelOrigin = configuredModelRef?.model
    ? {
        provider:
          configuredModelRef.provider ??
          resolveDefaultModelForAgent({
            cfg: params.cfg,
            agentId: params.targetAgentId,
          }).provider,
        model: configuredModelRef.model,
      }
    : undefined;

  return {
    status: "ok" as const,
    resolvedModel,
    modelApplied: Boolean(resolvedModel),
    thinkingOverride: thinkingPlan.thinkingOverride,
    resolvedRunPolicy,
    initialSessionPatch: {
      ...(resolvedModel
        ? {
            model: resolvedModel,
            modelOverrideSource,
            ...(modelOrigin
              ? {
                  // Config-selected models are session overrides, not legacy fallback residue.
                  // Self-origin metadata keeps cleanup from discarding them before first use.
                  modelOverrideFallbackOriginProvider: modelOrigin.provider,
                  modelOverrideFallbackOriginModel: modelOrigin.model,
                }
              : {}),
          }
        : {}),
      ...thinkingPlan.initialSessionPatch,
      ...(resolvedRunPolicy ? { thinkingLevel: resolvedRunPolicy.reasoning } : {}),
      fastMode: resolvedRunPolicy?.fastMode ?? fastMode,
    },
  };
}
