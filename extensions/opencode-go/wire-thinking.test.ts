import { streamSimple, type Api, type Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpencodeGoSimpleCompletionWrapper, createOpencodeGoWrapper } from "./stream.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createGoModel(params: {
  provider?: string;
  id: string;
  api: Api;
  reasoning?: boolean;
  supportedReasoningEfforts?: string[];
}): Model {
  return {
    provider: params.provider ?? "opencode-go",
    id: params.id,
    name: params.id,
    api: params.api,
    baseUrl:
      params.api === "anthropic-messages"
        ? "https://opencode.ai/zen/go"
        : "https://opencode.ai/zen/go/v1",
    reasoning: params.reasoning ?? true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    ...(params.supportedReasoningEfforts
      ? {
          compat: {
            supportsReasoningEffort: true,
            supportedReasoningEfforts: params.supportedReasoningEfforts,
          },
        }
      : {}),
  } as Model;
}

async function captureSerializedBody(
  model: Model,
  reasoning: "xhigh" | "max",
  runtime: "aliased-simple" | "embedded" | "raw" | "simple" = "simple",
) {
  let body: Record<string, unknown> | undefined;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body !== "string") {
      throw new Error("expected a serialized JSON request body");
    }
    body = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ error: { message: "captured", type: "invalid_request_error" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const runtimeModel =
    runtime === "aliased-simple"
      ? ({ ...model, api: "openclaw-provider-simple:opencode-go:test" } as Model)
      : model;
  const restoringSimpleStream: Parameters<typeof createOpencodeGoSimpleCompletionWrapper>[0] = (
    selectedModel,
    context,
    options,
  ) => streamSimple({ ...selectedModel, api: model.api } as Model, context, options);
  const wrapped =
    runtime === "raw"
      ? streamSimple
      : runtime === "embedded"
        ? createOpencodeGoWrapper(streamSimple, reasoning, model)
        : createOpencodeGoSimpleCompletionWrapper(
            runtime === "aliased-simple" ? restoringSimpleStream : streamSimple,
            model,
          );
  if (!wrapped) {
    throw new Error("expected OpenCode Go simple-completion wrapper");
  }
  const stream = wrapped(
    runtimeModel,
    { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    { apiKey: "test-key", reasoning },
  );
  await stream.result().catch(() => undefined);
  expect(fetchMock).toHaveBeenCalledOnce();
  if (!body) {
    throw new Error("expected serialized provider request body");
  }
  return body;
}

describe("OpenCode Go serialized thinking effort", () => {
  it("reproduces the shared transport downgrade before the Go wrapper", async () => {
    const muse = await captureSerializedBody(
      createGoModel({
        id: "muse-spark-1.3-contributor",
        api: "openai-responses",
        supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
      }),
      "xhigh",
      "raw",
    );
    expect(muse.reasoning).toMatchObject({ effort: "high" });

    const deepseek = await captureSerializedBody(
      createGoModel({
        id: "deepseek-v4.1-flash",
        api: "openai-completions",
        supportedReasoningEfforts: ["low", "high", "max"],
      }),
      "max",
      "raw",
    );
    expect(deepseek.reasoning_effort).toBe("high");
  });

  it("emits the native maximum for routed and future effort-based models", async () => {
    const muse = await captureSerializedBody(
      createGoModel({
        id: "muse-spark-1.3-contributor",
        api: "openai-responses",
        supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
      }),
      "xhigh",
    );
    expect(muse.reasoning).toMatchObject({ effort: "xhigh" });

    for (const id of ["deepseek-v4.1-flash", "glm-5.3-flash", "future-go-model"]) {
      const payload = await captureSerializedBody(
        createGoModel({
          id,
          api: "openai-completions",
          supportedReasoningEfforts: ["max", "low", "high"],
        }),
        "max",
      );
      expect(payload.reasoning_effort, id).toBe("max");
      if (id === "glm-5.3-flash") {
        expect(payload).not.toHaveProperty("thinking");
      }
    }

    const embedded = await captureSerializedBody(
      createGoModel({
        id: "glm-5.3-flash",
        api: "openai-completions",
        supportedReasoningEfforts: ["low", "high", "max"],
      }),
      "max",
      "embedded",
    );
    expect(embedded.reasoning_effort).toBe("max");
    expect(embedded).not.toHaveProperty("thinking");

    const nonFlashGlm = await captureSerializedBody(
      createGoModel({
        id: "glm-5.3",
        api: "openai-completions",
        supportedReasoningEfforts: ["low", "high", "max"],
      }),
      "max",
      "embedded",
    );
    expect(nonFlashGlm).toMatchObject({
      reasoning_effort: "max",
      thinking: { type: "enabled" },
    });

    const aliasedSimple = await captureSerializedBody(
      createGoModel({
        id: "deepseek-v4.1-flash",
        api: "openai-completions",
        supportedReasoningEfforts: ["low", "high", "max"],
      }),
      "max",
      "aliased-simple",
    );
    expect(aliasedSimple.reasoning_effort).toBe("max");
  });

  it("preserves fixed and binary model wire semantics", async () => {
    const kimi = await captureSerializedBody(
      createGoModel({ id: "kimi-k2.6", api: "openai-completions", reasoning: false }),
      "max",
    );
    expect(kimi).not.toHaveProperty("reasoning_effort");
    expect(kimi).not.toHaveProperty("reasoning");

    const fixedDeepSeek = await captureSerializedBody(
      createGoModel({
        id: "deepseek-v4.1-flash",
        api: "openai-completions",
        reasoning: false,
        supportedReasoningEfforts: ["low", "high", "max"],
      }),
      "max",
    );
    expect(fixedDeepSeek).toMatchObject({ thinking: { type: "disabled" } });
    expect(fixedDeepSeek).not.toHaveProperty("reasoning_effort");
    expect(fixedDeepSeek).not.toHaveProperty("reasoning");

    const minimax = await captureSerializedBody(
      createGoModel({ id: "minimax-m3", api: "anthropic-messages" }),
      "max",
    );
    expect(minimax).not.toHaveProperty("reasoning_effort");
    expect(minimax).not.toHaveProperty("reasoning");
  });

  it("does not force another provider that advertises the same max effort", async () => {
    const payload = await captureSerializedBody(
      createGoModel({
        provider: "other-provider",
        id: "reasoning-model",
        api: "openai-completions",
        supportedReasoningEfforts: ["low", "high", "max"],
      }),
      "max",
    );
    expect(payload.reasoning_effort).toBe("high");
  });
});
