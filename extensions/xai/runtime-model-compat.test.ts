// Xai tests cover runtime model compat plugin behavior.
import { describe, expect, it } from "vitest";
import { applyXaiRuntimeModelCompat } from "./runtime-model-compat.js";

describe("xai runtime model compat", () => {
  it.each([
    {
      id: "grok-4.3",
      efforts: ["none", "low", "medium", "high"],
      map: {
        off: "none",
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "high",
        max: "high",
      },
    },
    {
      id: "grok-4.5",
      efforts: ["low", "medium", "high"],
      map: {
        off: "low",
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "high",
        max: "high",
      },
    },
    {
      id: "grok-4.6",
      efforts: ["low", "medium", "high", "xhigh"],
      map: {
        off: "low",
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "xhigh",
      },
    },
  ])("maps $id levels onto its native xAI efforts", ({ id, efforts, map }) => {
    const model = applyXaiRuntimeModelCompat({ id, provider: "xai", reasoning: true });

    expect(model.compat).toMatchObject({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: efforts,
    });
    expect(model.thinkingLevelMap).toEqual(map);
  });

  it("suppresses reasoning efforts for non-reasoning models", () => {
    const model = applyXaiRuntimeModelCompat({
      id: "grok-4-fast-non-reasoning",
      provider: "xai",
      reasoning: false,
    });

    expect(model.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    });
  });

  it.each([
    ["grok-latest", "none", "high"],
    ["grok-4.3-latest", "none", "high"],
    ["grok-build-latest", "low", "high"],
    ["grok-4.5-latest", "low", "high"],
    ["grok-4.6-latest", "low", "xhigh"],
  ])("maps the %s alias to its native reasoning family", (id, off, max) => {
    const model = applyXaiRuntimeModelCompat({ id, provider: "xai", reasoning: true });

    expect(model.thinkingLevelMap).toMatchObject({ off, max });
  });

  it.each(["grok-build-0.1", "grok-4.20-beta-latest-reasoning"])(
    "maps every common level for fixed-reasoning %s to its intrinsic mode",
    (id) => {
      const model = applyXaiRuntimeModelCompat({ id, provider: "xai", reasoning: true });

      expect(model.compat).toMatchObject({ supportsReasoningEffort: false });
      expect(model.thinkingLevelMap).toEqual({
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      });
    },
  );
});
