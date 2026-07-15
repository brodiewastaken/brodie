import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveConfiguredFallbackThinking,
  BRODIE_BRAIN_CATALOG,
  buildBrodieBrainAliasIndex,
  resolveBrodieBrainRef,
  resolveRunPolicy,
  resolveRunPolicyCandidateFastMode,
  resolveRunPolicyForConfiguredBrain,
} from "./run-policy.js";

function config(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.6-sol", fallbacks: ["anthropic/claude-opus-5"] },
        models: {
          "anthropic/claude-opus-5": {
            alias: "opus",
            aliases: ["opus5"],
            params: { fastMode: false },
            startupJournals: "inline",
          },
          "openai/gpt-5.6-sol": {
            alias: " Sol ",
            aliases: ["SOL56"],
            params: { fastMode: false },
            startupJournals: "paths",
          },
          "anthropic/claude-opus-4-8": { alias: "opus48", startupJournals: "inline" },
        },
        thinkingDefault: "low",
        subagents: {
          model: { primary: "openai/gpt-5.6-sol", fallbacks: ["anthropic/claude-opus-5"] },
          thinking: "low",
          fastMode: false,
        },
      },
    },
  };
}

describe("brodie brain catalog", () => {
  it("contains exactly the fourteen locked brains", () => {
    expect(Object.keys(BRODIE_BRAIN_CATALOG)).toHaveLength(14);
  });

  it("routes astra to GPT-6 Astra and sol to the retained Sol brain", () => {
    expect(resolveBrodieBrainRef(config(), "astra")).toBe("openai/gpt-6-astra");
    expect(resolveBrodieBrainRef(config(), "sol")).toBe("openai/gpt-5.6-sol");
  });

  it("routes fable to Fable 5.1 and fable5 to the retained Fable 5 brain", () => {
    expect(resolveBrodieBrainRef(config(), "fable")).toBe("anthropic/claude-fable-5-1");
    expect(resolveBrodieBrainRef(config(), "fable51")).toBe("anthropic/claude-fable-5-1");
    expect(resolveBrodieBrainRef(config(), "fable5")).toBe("anthropic/claude-fable-5");
  });

  it("merges singular and plural aliases case-insensitively", () => {
    expect(resolveBrodieBrainRef(config(), "sol56")).toBe("openai/gpt-5.6-sol");
    expect(resolveBrodieBrainRef(config(), " SOL ")).toBe("openai/gpt-5.6-sol");
  });

  it("routes opus to Opus 5 and opus48 to the pinned Opus 4.8 brain", () => {
    expect(resolveBrodieBrainRef(config(), "opus")).toBe("anthropic/claude-opus-5");
    expect(resolveBrodieBrainRef(config(), "opus48")).toBe("anthropic/claude-opus-4-8");
  });

  it("rejects normalized alias collisions", () => {
    const cfg = config();
    cfg.agents!.defaults!.models!["anthropic/claude-opus-4-8"]!.aliases = ["sol"];
    expect(() => buildBrodieBrainAliasIndex(cfg)).toThrow("alias collision");
  });
});

describe("resolveRunPolicy", () => {
  it("resolves and freezes the main policy once", () => {
    const policy = resolveRunPolicy({ cfg: config() });
    expect(policy).toMatchObject({
      primary: { provider: "openai", model: "gpt-5.6-sol" },
      fallbacks: [{ provider: "anthropic", model: "claude-opus-5", fastMode: false }],
      reasoning: "low",
      fastMode: false,
      textVerbosity: "low",
      startupJournals: "paths",
      maxNativeImages: 42,
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.primary)).toBe(true);
    expect(Object.isFrozen(policy.fallbacks[0])).toBe(true);
    expect(Object.isFrozen(policy.source)).toBe(true);
  });

  it("activates strict policy only for configured brodie brains", () => {
    expect(
      resolveRunPolicyForConfiguredBrain({ cfg: config(), explicitModel: "sol" })?.primary,
    ).toEqual({ provider: "openai", model: "gpt-5.6-sol" });
    expect(
      resolveRunPolicyForConfiguredBrain({
        cfg: config(),
        explicitModel: "google/gemini-2.5-flash",
      }),
    ).toBeUndefined();
  });

  it("admits the ordered OpenCode Go fallback chain for every brodie run kind", () => {
    const cfg = config();
    cfg.agents!.defaults!.model = {
      primary: "openai/gpt-6-astra",
      fallbacks: [
        "opencode-go/muse-spark-1.3-contributor",
        "opencode-go/deepseek-v4.1-flash",
        "opencode-go/glm-5.3-flash",
      ],
    };
    cfg.agents!.defaults!.subagents!.model = {
      primary: "openai/gpt-6-astra",
      fallbacks: [
        "opencode-go/muse-spark-1.3-contributor",
        "opencode-go/deepseek-v4.1-flash",
        "opencode-go/glm-5.3-flash",
      ],
    };
    cfg.agents!.defaults!.models!["openai/gpt-6-astra"] = { params: { fastMode: false } };

    for (const kind of ["main", "cron", "subagent"] as const) {
      expect(resolveRunPolicy({ cfg, kind }).fallbacks).toEqual([
        { provider: "opencode-go", model: "muse-spark-1.3-contributor", fastMode: false },
        { provider: "opencode-go", model: "deepseek-v4.1-flash", fastMode: false },
        { provider: "opencode-go", model: "glm-5.3-flash", fastMode: false },
      ]);
    }
    expect(
      resolveRunPolicyForConfiguredBrain({
        cfg,
        explicitModel: "opencode-go/muse-spark-1.3-contributor",
      })?.primary,
    ).toEqual({ provider: "opencode-go", model: "muse-spark-1.3-contributor" });
    expect(() => resolveBrodieBrainRef(cfg, "xai/grok-4.6")).toThrow(
      "model is not an allowed brodie brain",
    );
  });

  it("forces each OpenCode Go primary to its highest native level", () => {
    const cfg = config();
    for (const [model, reasoning] of [
      ["muse-spark-1.3-contributor", "xhigh"],
      ["deepseek-v4.1-flash", "max"],
      ["glm-5.3-flash", "max"],
    ] as const) {
      const policy = resolveRunPolicy({
        cfg,
        explicitModel: `opencode-go/${model}`,
        explicitReasoning: "off",
      });
      expect(policy).toMatchObject({
        reasoning,
        fallbackReasoning: "off",
        source: { reasoning: "model" },
      });
    }

    expect(resolveRunPolicy({ cfg, explicitReasoning: "off" })).toMatchObject({
      reasoning: "off",
      source: { reasoning: "explicit" },
    });
  });

  it("attributes a global image ceiling to configured policy", () => {
    const cfg = config();
    cfg.agents!.defaults!.maxNativeImages = 9;
    expect(resolveRunPolicy({ cfg }).source.maxNativeImages).toBe("configured");
  });

  it("takes the main fast capability from configured model params instead of provider identity", () => {
    const cfg = config();
    cfg.agents!.defaults!.models!["openai/gpt-5.6-sol"]!.params = { fastMode: true };

    expect(resolveRunPolicy({ cfg }).fastMode).toBe(true);
  });

  it("keeps Fast off for both Sol and the Opus fallback", () => {
    const policy = resolveRunPolicy({ cfg: config() });

    expect(resolveRunPolicyCandidateFastMode(policy, "openai", "gpt-5.6-sol")).toBe(false);
    expect(resolveRunPolicyCandidateFastMode(policy, "anthropic", "claude-opus-5")).toBe(false);
  });

  it("lets an explicit child reasoning override win over the configured Low default", () => {
    expect(
      resolveRunPolicy({
        cfg: config(),
        kind: "subagent",
        explicitReasoning: "high",
        explicitReasoningSource: "explicit",
      }),
    ).toMatchObject({
      reasoning: "high",
      source: { reasoning: "explicit" },
    });
  });

  it("lets an explicit child override win", () => {
    const parent = resolveRunPolicy({ cfg: config(), kind: "cron", explicitFastMode: false });
    expect(
      resolveRunPolicy({ cfg: config(), kind: "subagent", parentKind: "cron", parent }).fastMode,
    ).toBe(false);
    expect(
      resolveRunPolicy({
        cfg: config(),
        kind: "subagent",
        parentKind: "cron",
        parent,
        explicitFastMode: true,
      }).fastMode,
    ).toBe(true);
  });

  it("enforces Fast OFF for explicit primary, fallback, and cron-child requests", () => {
    const cfg = config();
    cfg.agents!.defaults!.fastModeEnforcedOff = true;
    cfg.agents!.defaults!.models!["openai/gpt-5.6-sol"]!.params = { fastMode: true };
    cfg.agents!.defaults!.models!["anthropic/claude-opus-5"]!.params = { fastMode: true };

    const policy = resolveRunPolicy({ cfg, kind: "cron", explicitFastMode: true });
    expect(policy.fastMode).toBe(false);
    expect(resolveRunPolicyCandidateFastMode(policy, "anthropic", "claude-opus-5")).toBe(false);
    expect(
      resolveRunPolicy({
        cfg,
        kind: "subagent",
        parentKind: "cron",
        parent: policy,
        explicitFastMode: true,
      }).fastMode,
    ).toBe(false);
  });
});

describe("resolveConfiguredFallbackThinking", () => {
  it("returns a fallback model's own configured thinking and nothing when unset", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-5": { params: { thinking: "low" } },
            "openai/gpt-6-astra": { params: { thinking: "high" } },
          },
        },
      },
    } as OpenClawConfig;
    expect(resolveConfiguredFallbackThinking(cfg, "anthropic", "claude-sonnet-5")).toBe("low");
    expect(resolveConfiguredFallbackThinking(cfg, "openai", "gpt-6-astra")).toBe("high");
    expect(resolveConfiguredFallbackThinking(cfg, "opencode-go", "glm-5.3-flash")).toBeUndefined();
  });
});
