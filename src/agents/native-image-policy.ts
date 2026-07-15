import type { OpenClawConfig } from "../config/types.openclaw.js";

export const DEFAULT_MAX_NATIVE_IMAGES = 42;

export type NativeImagePolicySource = "model" | "global" | "default";
export type NativeImagePolicy = { maxNativeImages: number; source: NativeImagePolicySource };

function isValidMaxNativeImages(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function resolveNativeImagePolicy(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): NativeImagePolicy {
  const modelValue =
    params.cfg.agents?.defaults?.models?.[`${params.provider}/${params.model}`]?.maxNativeImages;
  if (isValidMaxNativeImages(modelValue)) {
    return { maxNativeImages: modelValue, source: "model" };
  }
  const globalValue = params.cfg.agents?.defaults?.maxNativeImages;
  if (isValidMaxNativeImages(globalValue)) {
    return { maxNativeImages: globalValue, source: "global" };
  }
  return { maxNativeImages: DEFAULT_MAX_NATIVE_IMAGES, source: "default" };
}

export function resolveMaxNativeImages(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): number {
  return resolveNativeImagePolicy(params).maxNativeImages;
}
