import { describe, expect, it } from "vitest";
import { resolveOpencodeGoThinkingProfile, resolveThinkingProfile } from "./provider-policy-api.js";

function levelIds(profile: ReturnType<typeof resolveOpencodeGoThinkingProfile>) {
  return profile?.levels.map((level) => level.id);
}

describe("OpenCode Go thinking policy", () => {
  it("exposes the native ceiling for each routed Brodie model", () => {
    expect(levelIds(resolveOpencodeGoThinkingProfile("muse-spark-1.3-contributor"))).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(levelIds(resolveOpencodeGoThinkingProfile("deepseek-v4.1-flash"))).toEqual([
      "off",
      "low",
      "high",
      "max",
    ]);
    expect(levelIds(resolveOpencodeGoThinkingProfile("glm-5.3-flash"))).toEqual([
      "off",
      "low",
      "high",
      "max",
    ]);
  });

  it("uses live supported-effort metadata for other adjustable Go models", () => {
    expect(
      levelIds(
        resolveOpencodeGoThinkingProfile("future-model", {
          reasoning: true,
          compat: { supportedReasoningEfforts: ["low", "high", "max"] },
        }),
      ),
    ).toEqual(["off", "low", "high", "max"]);
    expect(
      levelIds(
        resolveOpencodeGoThinkingProfile("future-model", {
          reasoning: true,
          compat: { supportedReasoningEfforts: ["max", "low", "high"] },
        }),
      ),
    ).toEqual(["off", "low", "high", "max"]);
  });

  it("does not invent an adjustable level for fixed Go models", () => {
    expect(levelIds(resolveOpencodeGoThinkingProfile("kimi-k2.6"))).toEqual(["off"]);
    expect(levelIds(resolveOpencodeGoThinkingProfile("minimax-m2.7"))).toEqual(["high"]);
  });

  it("keeps catalog-declared non-reasoning models off despite stale effort metadata", () => {
    expect(
      levelIds(
        resolveOpencodeGoThinkingProfile("future-model", {
          reasoning: false,
          compat: { supportedReasoningEfforts: ["low", "high", "max"] },
        }),
      ),
    ).toEqual(["off"]);
  });

  it("does not apply the policy to another provider", () => {
    expect(
      resolveThinkingProfile({
        provider: "deepseek",
        modelId: "deepseek-v4.1-flash",
        reasoning: true,
      }),
    ).toBeUndefined();
  });
});
