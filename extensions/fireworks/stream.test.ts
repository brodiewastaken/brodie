// Fireworks tests cover stream plugin behavior.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { wrapFireworksProviderStream } from "./stream.js";

type FireworksThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";
type FireworksTransportThinkingLevel = FireworksThinkingLevel | "adaptive" | "minimal";

type ExpectedReasoningPayload = {
  reasoning_effort?: string;
  reasoning_history?: string;
  thinking?: { type: string; budget_tokens?: number };
};

type FireworksReasoningCase = {
  modelId: string;
  levels: Record<Exclude<FireworksThinkingLevel, "off">, ExpectedReasoningPayload>;
  off: ExpectedReasoningPayload;
};

const FIVE_LEVEL_CASES: FireworksReasoningCase[] = [
  {
    modelId: "accounts/fireworks/models/deepseek-v4-flash",
    levels: {
      low: { reasoning_effort: "high", reasoning_history: "interleaved" },
      medium: { reasoning_effort: "high", reasoning_history: "interleaved" },
      high: { reasoning_effort: "high", reasoning_history: "interleaved" },
      xhigh: { reasoning_effort: "max", reasoning_history: "interleaved" },
      max: { reasoning_effort: "max", reasoning_history: "interleaved" },
    },
    off: { reasoning_effort: "none" },
  },
  {
    modelId: "accounts/fireworks/models/deepseek-v4-pro",
    levels: {
      low: { reasoning_effort: "high", reasoning_history: "interleaved" },
      medium: { reasoning_effort: "high", reasoning_history: "interleaved" },
      high: { reasoning_effort: "high", reasoning_history: "interleaved" },
      xhigh: { reasoning_effort: "max", reasoning_history: "interleaved" },
      max: { reasoning_effort: "max", reasoning_history: "interleaved" },
    },
    off: { reasoning_effort: "none" },
  },
  {
    modelId: "accounts/fireworks/models/glm-5p1",
    levels: {
      low: { reasoning_effort: "high" },
      medium: { reasoning_effort: "high" },
      high: { reasoning_effort: "high" },
      xhigh: { reasoning_effort: "high" },
      max: { reasoning_effort: "high" },
    },
    off: { reasoning_effort: "none" },
  },
  {
    modelId: "accounts/fireworks/models/glm-5p2",
    levels: {
      low: { reasoning_effort: "high", reasoning_history: "interleaved" },
      medium: { reasoning_effort: "high", reasoning_history: "interleaved" },
      high: { reasoning_effort: "high", reasoning_history: "interleaved" },
      xhigh: { reasoning_effort: "max", reasoning_history: "interleaved" },
      max: { reasoning_effort: "max", reasoning_history: "interleaved" },
    },
    off: { reasoning_effort: "none" },
  },
  {
    modelId: "accounts/fireworks/models/gpt-oss-120b",
    levels: {
      low: { reasoning_effort: "low" },
      medium: { reasoning_effort: "medium" },
      high: { reasoning_effort: "high" },
      xhigh: { reasoning_effort: "high" },
      max: { reasoning_effort: "high" },
    },
    off: { reasoning_effort: "medium" },
  },
  {
    modelId: "accounts/fireworks/models/gpt-oss-20b",
    levels: {
      low: { reasoning_effort: "low" },
      medium: { reasoning_effort: "medium" },
      high: { reasoning_effort: "high" },
      xhigh: { reasoning_effort: "high" },
      max: { reasoning_effort: "high" },
    },
    off: { reasoning_effort: "medium" },
  },
  {
    modelId: "accounts/fireworks/models/inkling",
    levels: {
      low: { reasoning_effort: "low", reasoning_history: "preserved" },
      medium: { reasoning_effort: "medium", reasoning_history: "preserved" },
      high: { reasoning_effort: "high", reasoning_history: "preserved" },
      xhigh: { reasoning_effort: "xhigh", reasoning_history: "preserved" },
      max: { reasoning_effort: "max", reasoning_history: "preserved" },
    },
    off: { reasoning_effort: "none" },
  },
  {
    modelId: "accounts/fireworks/models/kimi-k2p6",
    levels: {
      low: {
        reasoning_history: "interleaved",
        thinking: { type: "enabled", budget_tokens: 4096 },
      },
      medium: {
        reasoning_history: "interleaved",
        thinking: { type: "enabled", budget_tokens: 4096 },
      },
      high: {
        reasoning_history: "interleaved",
        thinking: { type: "enabled", budget_tokens: 4096 },
      },
      xhigh: {
        reasoning_history: "interleaved",
        thinking: { type: "enabled", budget_tokens: 4096 },
      },
      max: {
        reasoning_history: "interleaved",
        thinking: { type: "enabled", budget_tokens: 4096 },
      },
    },
    off: { thinking: { type: "disabled" } },
  },
  {
    modelId: "accounts/fireworks/models/kimi-k2p7-code",
    levels: {
      low: { reasoning_history: "preserved" },
      medium: { reasoning_history: "preserved" },
      high: { reasoning_history: "preserved" },
      xhigh: { reasoning_history: "preserved" },
      max: { reasoning_history: "preserved" },
    },
    off: { reasoning_history: "preserved" },
  },
  {
    modelId: "accounts/fireworks/models/kimi-k3",
    levels: {
      low: { reasoning_effort: "low", reasoning_history: "preserved" },
      medium: { reasoning_effort: "high", reasoning_history: "preserved" },
      high: { reasoning_effort: "high", reasoning_history: "preserved" },
      xhigh: { reasoning_effort: "max", reasoning_history: "preserved" },
      max: { reasoning_effort: "max", reasoning_history: "preserved" },
    },
    off: { reasoning_effort: "max", reasoning_history: "preserved" },
  },
  {
    modelId: "accounts/fireworks/models/minimax-m2p7",
    levels: {
      low: { reasoning_effort: "low", reasoning_history: "interleaved" },
      medium: { reasoning_effort: "medium", reasoning_history: "interleaved" },
      high: { reasoning_effort: "high", reasoning_history: "interleaved" },
      xhigh: { reasoning_effort: "high", reasoning_history: "interleaved" },
      max: { reasoning_effort: "high", reasoning_history: "interleaved" },
    },
    off: { reasoning_effort: "medium", reasoning_history: "interleaved" },
  },
  {
    modelId: "accounts/fireworks/models/minimax-m3",
    levels: {
      low: { thinking: { type: "adaptive" } },
      medium: { thinking: { type: "adaptive" } },
      high: { thinking: { type: "enabled", budget_tokens: 4096 } },
      xhigh: { thinking: { type: "enabled", budget_tokens: 4096 } },
      max: { thinking: { type: "enabled", budget_tokens: 4096 } },
    },
    off: { thinking: { type: "disabled" } },
  },
  {
    modelId: "accounts/fireworks/models/nemotron-3-ultra-nvfp4",
    levels: {
      low: { reasoning_effort: "high" },
      medium: { reasoning_effort: "high" },
      high: { reasoning_effort: "high" },
      xhigh: { reasoning_effort: "high" },
      max: { reasoning_effort: "high" },
    },
    off: { reasoning_effort: "none" },
  },
  {
    modelId: "accounts/fireworks/models/qwen3p7-plus",
    levels: {
      low: { reasoning_effort: "high", reasoning_history: "preserved" },
      medium: { reasoning_effort: "high", reasoning_history: "preserved" },
      high: { reasoning_effort: "high", reasoning_history: "preserved" },
      xhigh: { reasoning_effort: "high", reasoning_history: "preserved" },
      max: { reasoning_effort: "high", reasoning_history: "preserved" },
    },
    off: { reasoning_effort: "none" },
  },
];

function capturePayload(params: {
  modelId: string;
  thinkingLevel: FireworksTransportThinkingLevel;
  initialPayload?: Record<string, unknown>;
  mutatePayload?: (payload: Record<string, unknown>) => void;
}): { payload: Record<string, unknown>; reasoning: boolean | undefined } {
  let capturedPayload: Record<string, unknown> = {};
  let capturedReasoning: boolean | undefined;
  const baseStreamFn: StreamFn = (model, _context, options) => {
    const payload = { ...params.initialPayload };
    options?.onPayload?.(payload, model);
    capturedPayload = payload;
    capturedReasoning = model.reasoning;
    return {} as ReturnType<StreamFn>;
  };
  const model = {
    api: "openai-completions",
    provider: "fireworks",
    id: params.modelId,
    reasoning: false,
  } as Model<"openai-completions">;
  const wrapped = wrapFireworksProviderStream({
    provider: "fireworks",
    modelId: params.modelId,
    model,
    thinkingLevel: params.thinkingLevel,
    streamFn: baseStreamFn,
  } as never);
  if (!wrapped) {
    throw new Error(`expected Fireworks wrapper for ${params.modelId}`);
  }

  void wrapped(model, { messages: [] } as Context, {
    onPayload: params.mutatePayload,
  });
  return { payload: capturedPayload, reasoning: capturedReasoning };
}

async function captureReplacementPayload(params: {
  replacement: Record<string, unknown> | Promise<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  const modelId = "accounts/fireworks/models/gpt-oss-120b";
  let resultPromise: Promise<Record<string, unknown>> | undefined;
  const baseStreamFn: StreamFn = (model, _context, options) => {
    const originalPayload = {};
    resultPromise = Promise.resolve(options?.onPayload?.(originalPayload, model)).then((result) =>
      result === undefined ? originalPayload : (result as Record<string, unknown>),
    );
    return {} as ReturnType<StreamFn>;
  };
  const model = {
    api: "openai-completions",
    provider: "fireworks",
    id: modelId,
    reasoning: false,
  } as Model<"openai-completions">;
  const wrapped = wrapFireworksProviderStream({
    provider: "fireworks",
    modelId,
    model,
    thinkingLevel: "max",
    streamFn: baseStreamFn,
  } as never);
  if (!wrapped) {
    throw new Error("expected Fireworks wrapper");
  }

  void wrapped(model, { messages: [] } as Context, {
    onPayload: () => params.replacement,
  });
  if (!resultPromise) {
    throw new Error("expected payload result");
  }
  return await resultPromise;
}

describe("wrapFireworksProviderStream", () => {
  it.each(FIVE_LEVEL_CASES)(
    "maps all canonical levels for $modelId",
    ({ modelId, levels, off }) => {
      for (const [thinkingLevel, expected] of Object.entries(levels)) {
        const result = capturePayload({
          modelId,
          thinkingLevel: thinkingLevel as FireworksThinkingLevel,
          initialPayload: {
            reasoning: { effort: "wrong" },
            reasoningEffort: "wrong",
            reasoning_effort: "wrong",
            reasoning_history: "disabled",
            thinking: { type: "wrong" },
          },
        });
        expect(result.payload, `${modelId} ${thinkingLevel}`).toEqual(expected);
        expect(result.reasoning, `${modelId} ${thinkingLevel} parser mode`).toBe(true);
      }

      const offResult = capturePayload({
        modelId,
        thinkingLevel: "off",
        initialPayload: {
          messages: [{ role: "assistant", content: "kept", reasoning_content: "drop when off" }],
          reasoning: { effort: "wrong" },
          reasoningEffort: "wrong",
          reasoning_effort: "wrong",
          reasoning_history: "disabled",
          thinking: { type: "wrong" },
        },
      });
      const offReasoning = off.reasoning_effort !== "none" && off.thinking?.type !== "disabled";
      expect(offResult.payload, `${modelId} off`).toEqual({
        messages: [
          {
            role: "assistant",
            content: "kept",
            ...(offReasoning ? { reasoning_content: "drop when off" } : {}),
          },
        ],
        ...off,
      });
      expect(offResult.reasoning, `${modelId} off parser mode`).toBe(offReasoning);
    },
  );

  it("reapplies the contract after caller payload mutation", () => {
    const result = capturePayload({
      modelId: "accounts/fireworks/models/gpt-oss-120b",
      thinkingLevel: "max",
      mutatePayload: (payload) => {
        payload.reasoning_effort = "max";
        payload.thinking = { type: "disabled" };
      },
    });

    expect(result.payload).toEqual({ reasoning_effort: "high" });
  });

  it("reapplies the contract to a synchronous replacement payload", async () => {
    const payload = await captureReplacementPayload({
      replacement: {
        reasoning_effort: "max",
        thinking: { type: "disabled" },
      },
    });

    expect(payload).toEqual({ reasoning_effort: "high" });
  });

  it("reapplies the contract to an asynchronous replacement payload", async () => {
    const payload = await captureReplacementPayload({
      replacement: Promise.resolve({
        reasoning_effort: "max",
        thinking: { type: "disabled" },
      }),
    });

    expect(payload).toEqual({ reasoning_effort: "high" });
  });

  it("maps an inherited adaptive level to the Fireworks model default", () => {
    const result = capturePayload({
      modelId: "accounts/fireworks/models/kimi-k3",
      thinkingLevel: "adaptive",
    });

    expect(result.payload).toEqual({
      reasoning_effort: "max",
      reasoning_history: "preserved",
    });
    expect(result.reasoning).toBe(true);
  });

  it("maps an inherited minimal level to the Fireworks model low tier", () => {
    const result = capturePayload({
      modelId: "accounts/fireworks/models/kimi-k3",
      thinkingLevel: "minimal",
    });

    expect(result.payload).toEqual({
      reasoning_effort: "low",
      reasoning_history: "preserved",
    });
    expect(result.reasoning).toBe(true);
  });

  it("preserves K3 reasoning content and backfills tool-call replay messages", () => {
    const result = capturePayload({
      modelId: "accounts/fireworks/models/kimi-k3",
      thinkingLevel: "max",
      initialPayload: {
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_1", type: "function" }],
          },
          {
            role: "assistant",
            content: "kept",
            reasoning_content: "native reasoning",
          },
        ],
      },
    });

    expect(result.payload).toEqual({
      messages: [
        {
          role: "assistant",
          content: "",
          reasoning_content: "",
          tool_calls: [{ id: "call_1", type: "function" }],
        },
        {
          role: "assistant",
          content: "kept",
          reasoning_content: "native reasoning",
        },
      ],
      reasoning_effort: "max",
      reasoning_history: "preserved",
    });
  });

  it("returns no wrapper outside recognized Fireworks chat-completion models", () => {
    expect(
      wrapFireworksProviderStream({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/unknown-model",
        model: {
          api: "openai-completions",
          provider: "fireworks",
          id: "accounts/fireworks/models/unknown-model",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
    expect(
      wrapFireworksProviderStream({
        provider: "fireworks",
        modelId: "accounts/fireworks/models/kimi-k3",
        model: {
          api: "openai-responses",
          provider: "fireworks",
          id: "accounts/fireworks/models/kimi-k3",
        } as Model<"openai-responses">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
    expect(
      wrapFireworksProviderStream({
        provider: "openai",
        modelId: "gpt-5.6",
        model: {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-5.6",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
  });
});
