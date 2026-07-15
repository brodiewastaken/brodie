// Fireworks tests cover index plugin behavior.
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import {
  createProviderDynamicModelContext,
  runSingleProviderCatalog,
} from "../test-support/provider-model-test-helpers.js";
import fireworksPlugin from "./index.js";
import { applyFireworksConfig } from "./onboard.js";
import {
  FIREWORKS_BASE_URL,
  FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  FIREWORKS_DEFAULT_MAX_TOKENS,
  FIREWORKS_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";
import { resolveThinkingProfile } from "./provider-policy-api.js";

const FIREWORKS_KIMI_K2_6_MODEL_ID = "accounts/fireworks/models/kimi-k2p6";
const FIREWORKS_KIMI_K3_MODEL_ID = "accounts/fireworks/models/kimi-k3";

const FIREWORKS_CHAT_MODEL_IDS = [
  "accounts/fireworks/models/deepseek-v4-flash",
  "accounts/fireworks/models/deepseek-v4-pro",
  "accounts/fireworks/models/glm-5p1",
  "accounts/fireworks/models/glm-5p2",
  "accounts/fireworks/models/gpt-oss-120b",
  "accounts/fireworks/models/gpt-oss-20b",
  "accounts/fireworks/models/inkling",
  FIREWORKS_KIMI_K2_6_MODEL_ID,
  "accounts/fireworks/models/kimi-k2p7-code",
  FIREWORKS_KIMI_K3_MODEL_ID,
  "accounts/fireworks/models/minimax-m2p7",
  "accounts/fireworks/models/minimax-m3",
  "accounts/fireworks/models/nemotron-3-ultra-nvfp4",
  "accounts/fireworks/models/qwen3p7-plus",
  "accounts/fireworks/routers/glm-5p2-fast",
  "accounts/fireworks/routers/kimi-k2p6-fast",
  "accounts/fireworks/routers/kimi-k2p6-turbo",
  "accounts/fireworks/routers/kimi-k2p7-code-fast",
  "accounts/fireworks/routers/kimi-k3-fast",
  "accounts/fireworks/routers/kimi-k3-us",
] as const;

function createFireworksDefaultRuntimeModel(params: { reasoning: boolean }): ProviderRuntimeModel {
  return {
    id: FIREWORKS_DEFAULT_MODEL_ID,
    name: FIREWORKS_DEFAULT_MODEL_ID,
    provider: "fireworks",
    api: "openai-completions",
    baseUrl: FIREWORKS_BASE_URL,
    reasoning: params.reasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
    maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
  };
}

describe("fireworks provider plugin", () => {
  it("registers Fireworks with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "fireworks-api-key",
    });

    expect(provider.id).toBe("fireworks");
    expect(provider.label).toBe("Fireworks");
    expect(provider.aliases).toEqual(["fireworks-ai"]);
    expect(provider.envVars).toEqual(["FIREWORKS_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    if (!resolved) {
      throw new Error("expected Fireworks api-key auth choice");
    }
    expect(resolved.provider.id).toBe("fireworks");
    expect(resolved.method.id).toBe("api-key");
  });

  it("builds the Fireworks catalog", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe(FIREWORKS_BASE_URL);
    const models = catalogProvider.models;
    if (!models) {
      throw new Error("expected Fireworks catalog models");
    }
    expect(FIREWORKS_DEFAULT_MODEL_ID).toBe(FIREWORKS_KIMI_K3_MODEL_ID);
    expect(models.map((model) => model.id)).toEqual(FIREWORKS_CHAT_MODEL_IDS);
    expect(models).not.toContainEqual(
      expect.objectContaining({ id: "accounts/fireworks/routers/kimi-k2p5-turbo" }),
    );
    expect(models.find((model) => model.id === FIREWORKS_KIMI_K2_6_MODEL_ID)).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 262144,
    });
    expect(models.find((model) => model.id === "accounts/fireworks/models/inkling")).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
      maxTokens: 262144,
    });
    expect(models.find((model) => model.id === FIREWORKS_KIMI_K3_MODEL_ID)).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
      maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
    });
  });

  it("augments an existing Fireworks config without replacing its primary model", () => {
    const next = applyFireworksConfig({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: {},
        },
      },
      models: {
        providers: {
          fireworks: {
            baseUrl: FIREWORKS_BASE_URL,
            api: "openai-completions",
            models: [
              {
                id: FIREWORKS_KIMI_K3_MODEL_ID,
                name: "Kimi K3",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
                maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
              },
            ],
          },
        },
      },
    });

    expect(next.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.6-sol" });
    expect(next.models?.providers?.fireworks?.models?.map((model) => model.id)).toEqual([
      FIREWORKS_KIMI_K3_MODEL_ID,
      ...FIREWORKS_CHAT_MODEL_IDS.filter((modelId) => modelId !== FIREWORKS_KIMI_K3_MODEL_ID),
    ]);
    expect(Object.keys(next.agents?.defaults?.models ?? {})).toEqual(
      FIREWORKS_CHAT_MODEL_IDS.map((modelId) => `fireworks/${modelId}`),
    );
    expect(next.agents?.defaults?.models?.[`fireworks/${FIREWORKS_KIMI_K3_MODEL_ID}`]).toEqual({
      alias: "Kimi K3",
    });
  });

  it("preserves existing model selection during non-interactive API key setup", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const apiKey = provider.auth.find((method) => method.id === "api-key");
    if (!apiKey?.runNonInteractive) {
      throw new Error("expected Fireworks API key non-interactive auth");
    }
    const primaryModel = "openai/gpt-5.6-sol";
    const fallbackModel = "anthropic/claude-opus-5";

    const next = await apiKey.runNonInteractive({
      config: {
        agents: {
          defaults: {
            model: { primary: primaryModel, fallbacks: [fallbackModel] },
            models: {
              [primaryModel]: { alias: "Sol" },
              [fallbackModel]: { alias: "Opus" },
            },
          },
        },
      },
      opts: {},
      env: {},
      runtime: {},
      resolveApiKey: async () => ({ key: "fw-test", source: "profile" }),
      toApiKeyCredential: () => null,
    } as never);

    expect(next?.agents?.defaults?.model).toEqual({
      primary: primaryModel,
      fallbacks: [fallbackModel],
    });
    expect(next?.models?.providers?.fireworks?.models?.map((model) => model.id)).toEqual(
      FIREWORKS_CHAT_MODEL_IDS,
    );
    expect(
      Object.keys(next?.agents?.defaults?.models ?? {}).filter((modelRef) =>
        modelRef.startsWith("fireworks/"),
      ),
    ).toEqual(FIREWORKS_CHAT_MODEL_IDS.map((modelId) => `fireworks/${modelId}`));
    expect(next?.agents?.defaults?.models).toMatchObject({
      [primaryModel]: { alias: "Sol" },
      [fallbackModel]: { alias: "Opus" },
    });
  });

  it("resolves forward-compat Fireworks model ids from the default template", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/qwen3.6-plus",
        models: [createFireworksDefaultRuntimeModel({ reasoning: true })],
      }),
    );

    expect(resolved?.provider).toBe("fireworks");
    expect(resolved?.id).toBe("accounts/fireworks/models/qwen3.6-plus");
    expect(resolved?.api).toBe("openai-completions");
    expect(resolved?.baseUrl).toBe(FIREWORKS_BASE_URL);
    expect(resolved?.reasoning).toBe(true);
    expect(resolved?.input).toEqual(["text", "image"]);
  });

  it("enables reasoning metadata for Fireworks Kimi models with a reasoning contract", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/kimi-k2.6-turbo",
        models: [createFireworksDefaultRuntimeModel({ reasoning: false })],
      }),
    );

    expect(resolved?.provider).toBe("fireworks");
    expect(resolved?.id).toBe("accounts/fireworks/models/kimi-k2.6-turbo");
    expect(resolved?.reasoning).toBe(true);
    expect(resolved?.input).toEqual(["text", "image"]);
  });

  it("keeps Fireworks GLM dynamic models text-only", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    const resolved = provider.resolveDynamicModel?.(
      createProviderDynamicModelContext({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/glm-5p3-preview",
        models: [createFireworksDefaultRuntimeModel({ reasoning: false })],
      }),
    );

    expect(resolved?.provider).toBe("fireworks");
    expect(resolved?.id).toBe("accounts/fireworks/models/glm-5p3-preview");
    expect(resolved?.input).toEqual(["text"]);
  });

  it("defers manifest catalog models to core static-catalog resolution", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    for (const modelId of FIREWORKS_CHAT_MODEL_IDS) {
      const resolved = provider.resolveDynamicModel?.(
        createProviderDynamicModelContext({
          provider: "fireworks",
          modelId,
          models: [createFireworksDefaultRuntimeModel({ reasoning: false })],
        }),
      );

      expect(resolved).toBeUndefined();
    }
  });

  it("exposes canonical thinking levels with effective Fireworks labels", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: FIREWORKS_KIMI_K2_6_MODEL_ID,
      }),
    ).toEqual({
      levels: [
        { id: "off" },
        { id: "low", label: "low → on" },
        { id: "medium", label: "medium → on" },
        { id: "high", label: "high → on" },
        { id: "xhigh", label: "xhigh → on" },
        { id: "max", label: "max → on" },
      ],
      defaultLevel: "off",
      preserveWhenCatalogReasoningFalse: true,
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/kimi-k3",
      }),
    ).toEqual({
      levels: [
        { id: "low" },
        { id: "medium", label: "medium → high" },
        { id: "high" },
        { id: "xhigh", label: "xhigh → max" },
        { id: "max" },
      ],
      defaultLevel: "max",
      preserveWhenCatalogReasoningFalse: true,
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/inkling",
      }),
    ).toEqual({
      levels: [
        { id: "off" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "xhigh" },
        { id: "max" },
      ],
      defaultLevel: "high",
      preserveWhenCatalogReasoningFalse: true,
    });
    expect(resolveThinkingProfile({ modelId: FIREWORKS_KIMI_K2_6_MODEL_ID })).toEqual({
      levels: [
        { id: "off" },
        { id: "low", label: "low → on" },
        { id: "medium", label: "medium → on" },
        { id: "high", label: "high → on" },
        { id: "xhigh", label: "xhigh → on" },
        { id: "max", label: "max → on" },
      ],
      defaultLevel: "off",
      preserveWhenCatalogReasoningFalse: true,
    });
    expect(
      resolveThinkingProfile({
        modelId: "accounts/fireworks/models/unknown-model",
      }),
    ).toBeUndefined();
  });

  it("publishes a thinking profile for every configured Fireworks chat model", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);
    for (const modelId of FIREWORKS_CHAT_MODEL_IDS) {
      expect(
        provider.resolveThinkingProfile?.({
          provider: "fireworks",
          modelId,
        }),
        modelId,
      ).toBeDefined();
    }
  });

  it("preserves reasoning replay only for models whose Fireworks contract needs it", async () => {
    const provider = await registerSingleProviderPlugin(fireworksPlugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/routers/kimi-k3-fast",
        modelApi: "openai-completions",
      }),
    ).not.toHaveProperty("dropReasoningFromHistory");
    expect(
      provider.buildReplayPolicy?.({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/gpt-oss-120b",
        modelApi: "openai-completions",
      }),
    ).toHaveProperty("dropReasoningFromHistory", true);
  });
});
