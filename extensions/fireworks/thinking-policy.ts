// Fireworks plugin module implements thinking policy behavior.
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import { resolveFireworksThinkingProfile as resolveProfile } from "./reasoning-contract.js";

export function resolveFireworksThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  return resolveProfile(modelId);
}
