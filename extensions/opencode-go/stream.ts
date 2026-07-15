// Opencode Go plugin module implements stream behavior.
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderRequestHeaders } from "openclaw/plugin-sdk/provider-http";
import {
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  streamWithPayloadPatch,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { isOpencodeGoKimiNoReasoningModelId } from "./provider-catalog.js";
import { resolveOpencodeGoThinkingProfile } from "./provider-policy-api.js";
import { stripOpencodeGoKimiReasoningPayload } from "./reasoning-sanitizer.js";
import {
  createOpencodeGoStalledStreamWrapper,
  OPENCODE_GO_STREAM_FIRST_EVENT_TIMEOUT_MS_DEFAULT,
  OPENCODE_GO_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
} from "./stream-termination.js";

function isOpencodeGoDeepSeekV4ModelId(modelId: unknown): boolean {
  return (
    modelId === "deepseek-flash" ||
    modelId === "deepseek-v4-flash" ||
    modelId === "deepseek-v4-pro" ||
    modelId === "deepseek-v4.1-flash" ||
    modelId === "deepseek-v4-flash-vision-exp"
  );
}

function isOpencodeGoGlm53ModelId(modelId: unknown): boolean {
  // GLM 5.3 Flash rejects `thinking`; its reasoning control is `reasoning_effort`.
  return modelId === "glm-5.3";
}

export function createOpencodeGoAttributionWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  return (model, context, options) => {
    const api = model.api;
    if (model.provider !== "opencode-go" || api !== "anthropic-messages") {
      return baseStreamFn(model, context, options);
    }
    return baseStreamFn(model, context, {
      ...options,
      headers: resolveProviderRequestHeaders({
        provider: model.provider,
        api,
        baseUrl: model.baseUrl,
        capability: "llm",
        transport: "stream",
        callerHeaders: options?.headers,
        precedence: "defaults-win",
      }),
    });
  };
}

function createOpencodeGoDeepSeekV4Wrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  return createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn,
    thinkingLevel,
    shouldPatchModel: (model) =>
      model.provider === "opencode-go" && isOpencodeGoDeepSeekV4ModelId(model.id),
  });
}

function createOpencodeGoGlm53ThinkingWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn || thinkingLevel === undefined) {
    return baseStreamFn;
  }
  const underlying = baseStreamFn;
  return (model, context, options) => {
    if (model.provider !== "opencode-go" || !isOpencodeGoGlm53ModelId(model.id)) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payload) => {
      // GLM 5.3 accepts the native thinking toggle alongside reasoning_effort,
      // but rejects the legacy clear_thinking field.
      delete payload.clear_thinking;
      payload.thinking = { type: thinkingLevel === "off" ? "disabled" : "enabled" };
    });
  };
}

type OpencodeGoStreamModel = Parameters<NonNullable<ProviderWrapStreamFnContext["streamFn"]>>[0];

function resolveOpencodeGoEffortCompat(model: OpencodeGoStreamModel) {
  const compat = model.compat;
  if (!compat) {
    return undefined;
  }
  const supportsReasoningEffort =
    "supportsReasoningEffort" in compat && typeof compat.supportsReasoningEffort === "boolean"
      ? compat.supportsReasoningEffort
      : undefined;
  const supportedReasoningEfforts =
    "supportedReasoningEfforts" in compat && Array.isArray(compat.supportedReasoningEfforts)
      ? compat.supportedReasoningEfforts.filter(
          (effort): effort is string => typeof effort === "string",
        )
      : undefined;
  return supportsReasoningEffort === undefined && supportedReasoningEfforts === undefined
    ? undefined
    : {
        ...(supportsReasoningEffort !== undefined ? { supportsReasoningEffort } : {}),
        ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
      };
}

function resolveOpencodeGoNativeMaximumEffort(
  model: OpencodeGoStreamModel,
): "xhigh" | "max" | undefined {
  if (model.provider !== "opencode-go" || !model.reasoning) {
    return undefined;
  }
  const compat = resolveOpencodeGoEffortCompat(model);
  const profile = resolveOpencodeGoThinkingProfile(model.id, {
    reasoning: model.reasoning,
    compat,
  });
  const highest = profile?.levels.findLast((level) => level.id !== "off")?.id;
  if (highest !== "xhigh" && highest !== "max") {
    return undefined;
  }
  const advertisedEfforts = compat?.supportedReasoningEfforts?.map((effort) =>
    effort.trim().toLowerCase(),
  );
  if (
    advertisedEfforts
      ? !advertisedEfforts.includes(highest)
      : compat?.supportsReasoningEffort !== true
  ) {
    return undefined;
  }
  return highest;
}

function resolveOpencodeGoPolicyModel(
  runtimeModel: OpencodeGoStreamModel,
  preparedModel?: ProviderWrapStreamFnContext["model"],
): OpencodeGoStreamModel {
  if (preparedModel?.provider !== runtimeModel.provider || preparedModel.id !== runtimeModel.id) {
    return runtimeModel;
  }
  // Simple completion aliases the API after provider normalization. Keep the
  // final model metadata while restoring the provider-facing API for payload shape.
  return { ...runtimeModel, api: preparedModel.api };
}

function createOpencodeGoMaximumThinkingWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  preparedModel?: ProviderWrapStreamFnContext["model"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  const underlying = baseStreamFn;
  return (model, context, options) => {
    const policyModel = resolveOpencodeGoPolicyModel(model, preparedModel);
    const effort = resolveOpencodeGoNativeMaximumEffort(policyModel);
    if (!effort) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, (payload) => {
      if (policyModel.api === "openai-responses") {
        const currentReasoning = payload.reasoning;
        payload.reasoning = {
          ...(currentReasoning &&
          typeof currentReasoning === "object" &&
          !Array.isArray(currentReasoning)
            ? currentReasoning
            : {}),
          effort,
        };
        return;
      }
      if (policyModel.api !== "openai-completions") {
        return;
      }
      payload.reasoning_effort = effort;
      if (
        isOpencodeGoDeepSeekV4ModelId(policyModel.id) ||
        isOpencodeGoGlm53ModelId(policyModel.id)
      ) {
        delete payload.clear_thinking;
        payload.thinking = { type: "enabled" };
      }
    });
  };
}

function stripReasoningParams(payloadObj: Record<string, unknown>): void {
  stripOpencodeGoKimiReasoningPayload(payloadObj);
}

function createOpencodeGoKimiNoReasoningWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  const underlying = baseStreamFn;
  return (model, context, options) => {
    if (model.provider !== "opencode-go" || !isOpencodeGoKimiNoReasoningModelId(model.id)) {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(underlying, model, context, options, stripReasoningParams);
  };
}

export function createOpencodeGoWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel: ProviderWrapStreamFnContext["thinkingLevel"],
  preparedModel?: ProviderWrapStreamFnContext["model"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  const kimiWrapped = createOpencodeGoKimiNoReasoningWrapper(baseStreamFn) ?? baseStreamFn;
  const deepSeekWrapped =
    createOpencodeGoDeepSeekV4Wrapper(kimiWrapped, thinkingLevel) ?? kimiWrapped;
  const glm53Wrapped =
    createOpencodeGoGlm53ThinkingWrapper(deepSeekWrapped, thinkingLevel) ?? deepSeekWrapped;
  const maximumWrapped =
    createOpencodeGoMaximumThinkingWrapper(glm53Wrapped, preparedModel) ?? glm53Wrapped;
  const attributed = createOpencodeGoAttributionWrapper(maximumWrapped) ?? maximumWrapped;
  // Outermost layer: provider-owned stalled SSE termination so the underlying
  // OpenAI SDK request is aborted at the raw opencode-go boundary instead of
  // waiting for the shared runtime stuck-session recovery.
  return createOpencodeGoStalledStreamWrapper(attributed, {
    provider: "opencode-go",
    idleTimeoutMs: OPENCODE_GO_STREAM_IDLE_TIMEOUT_MS_DEFAULT,
    firstEventTimeoutMs: OPENCODE_GO_STREAM_FIRST_EVENT_TIMEOUT_MS_DEFAULT,
  });
}

export function createOpencodeGoSimpleCompletionWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  preparedModel?: ProviderWrapStreamFnContext["model"],
): ProviderWrapStreamFnContext["streamFn"] {
  if (!baseStreamFn) {
    return undefined;
  }
  const kimiWrapped = createOpencodeGoKimiNoReasoningWrapper(baseStreamFn) ?? baseStreamFn;
  const simpleThinkingLevel =
    preparedModel?.reasoning === false
      ? "off"
      : preparedModel
        ? resolveOpencodeGoNativeMaximumEffort(preparedModel)
        : undefined;
  const deepSeekWrapped =
    createOpencodeGoDeepSeekV4Wrapper(kimiWrapped, simpleThinkingLevel) ?? kimiWrapped;
  const maximumWrapped =
    createOpencodeGoMaximumThinkingWrapper(deepSeekWrapped, preparedModel) ?? deepSeekWrapped;
  return createOpencodeGoAttributionWrapper(maximumWrapped) ?? maximumWrapped;
}
