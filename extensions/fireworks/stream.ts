// Fireworks plugin module implements stream behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveFireworksReasoningDispatch } from "./reasoning-contract.js";

function isFireworksProviderId(providerId: string): boolean {
  const normalized = normalizeProviderId(providerId);
  return normalized === "fireworks" || normalized === "fireworks-ai";
}

function patchAfterCaller(params: {
  payload: Record<string, unknown>;
  patchPayload: (payload: Record<string, unknown>) => void;
  result: unknown;
}): unknown {
  const patchResult = (result: unknown): unknown => {
    if (result && typeof result === "object") {
      params.patchPayload(result as Record<string, unknown>);
    } else {
      params.patchPayload(params.payload);
    }
    return result;
  };
  if (params.result && typeof (params.result as Promise<unknown>).then === "function") {
    return Promise.resolve(params.result).then(patchResult);
  }
  return patchResult(params.result);
}

export function wrapFireworksProviderStream(
  ctx: ProviderWrapStreamFnContext,
): StreamFn | undefined {
  if (!isFireworksProviderId(ctx.provider) || ctx.model?.api !== "openai-completions") {
    return undefined;
  }
  const dispatch = resolveFireworksReasoningDispatch({
    modelId: ctx.modelId,
    thinkingLevel: ctx.thinkingLevel,
  });
  if (!dispatch) {
    return undefined;
  }

  const underlying = ctx.streamFn ?? streamSimple;
  return (model, context, options) => {
    const runtimeModel =
      model.reasoning === dispatch.reasoning
        ? model
        : {
            ...model,
            reasoning: dispatch.reasoning,
          };
    const originalOnPayload = options?.onPayload;
    return underlying(runtimeModel, context, {
      ...options,
      onPayload: (payload, payloadModel) => {
        if (!payload || typeof payload !== "object") {
          return originalOnPayload?.(payload, payloadModel);
        }
        const payloadObject = payload as Record<string, unknown>;
        dispatch.patchPayload(payloadObject);
        const result = originalOnPayload?.(payload, payloadModel);
        return patchAfterCaller({
          payload: payloadObject,
          patchPayload: dispatch.patchPayload,
          result,
        });
      },
    });
  };
}
