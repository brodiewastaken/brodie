// Xai tests cover provider policy api plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("xai provider thinking policy", () => {
  it.each([
    ["grok-4.3", "low"],
    ["grok-4.5", "high"],
    ["grok-4.6", "high"],
  ] as const)("exposes every mapped level for %s", (modelId, defaultLevel) => {
    const profile = resolveThinkingProfile({ provider: "xai", modelId });

    expect(profile.defaultLevel).toBe(defaultLevel);
    expect(profile.levels.map((level) => level.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "adaptive",
      "max",
      "ultra",
    ]);
  });

  it.each(["grok-build-0.1", "grok-4.20-beta-latest-reasoning"])(
    "accepts every common level for fixed-reasoning %s",
    (modelId) => {
      const profile = resolveThinkingProfile({ provider: "xai", modelId });

      expect(profile.defaultLevel).toBe("high");
      expect(profile.levels.map((level) => level.id)).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "adaptive",
        "max",
        "ultra",
      ]);
    },
  );

  it("accepts every common level as off for non-reasoning xai models", () => {
    const profile = resolveThinkingProfile({
      provider: "xai",
      modelId: "grok-4-fast-non-reasoning",
      reasoning: false,
    });

    expect(profile.defaultLevel).toBe("off");
    expect(profile.preserveWhenCatalogReasoningFalse).toBe(true);
    expect(profile.levels.map((level) => level.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "adaptive",
      "max",
      "ultra",
    ]);
  });

  it("keeps non-xai routes off-only", () => {
    expect(
      resolveThinkingProfile({
        provider: "openrouter",
        modelId: "x-ai/grok-4.3",
        reasoning: true,
      }),
    ).toEqual({ levels: [{ id: "off" }], defaultLevel: "off" });
  });
});
