// Fireworks reasoning contracts keep model UX, payload mapping, and replay policy aligned.
import type {
  ProviderReplayPolicy,
  ProviderThinkingProfile,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildOpenAICompatibleReplayPolicy } from "openclaw/plugin-sdk/provider-model-shared";

type CanonicalThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";
type FireworksThinkingLevel = "off" | CanonicalThinkingLevel;
type FireworksInputThinkingLevel = FireworksThinkingLevel | "adaptive" | "minimal";
type FireworksReasoningHistory = "disabled" | "interleaved" | "preserved";
type FireworksThinkingType = "adaptive" | "enabled";

type FireworksReasoningContractBase = {
  defaultLevel: FireworksThinkingLevel;
  reasoningHistory?: FireworksReasoningHistory;
};

type FireworksEffortContract = FireworksReasoningContractBase & {
  mode: "effort";
  map: Record<CanonicalThinkingLevel, string>;
  offEffort?: string;
};

type FireworksThinkingContract = FireworksReasoningContractBase & {
  mode: "thinking";
  map: Record<CanonicalThinkingLevel, FireworksThinkingType>;
  supportsOff: boolean;
  enabledBudgetTokens: number;
};

type FireworksAlwaysThinkingContract = FireworksReasoningContractBase & {
  mode: "always";
};

type FireworksDisabledThinkingContract = FireworksReasoningContractBase & {
  mode: "disabled";
};

type FireworksReasoningContract =
  | FireworksEffortContract
  | FireworksThinkingContract
  | FireworksAlwaysThinkingContract
  | FireworksDisabledThinkingContract;

const CANONICAL_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

// Fireworks requires >=1024 for enabled thinking; 4096 is its documented example budget.
const FIREWORKS_ENABLED_THINKING_BUDGET_TOKENS = 4096;

const DEEPSEEK_V4_CONTRACT = {
  mode: "effort",
  defaultLevel: "high",
  offEffort: "none",
  reasoningHistory: "interleaved",
  map: {
    low: "high",
    medium: "high",
    high: "high",
    xhigh: "max",
    max: "max",
  },
} as const satisfies FireworksReasoningContract;

const BINARY_HIGH_CONTRACT = {
  mode: "effort",
  defaultLevel: "high",
  offEffort: "none",
  map: {
    low: "high",
    medium: "high",
    high: "high",
    xhigh: "high",
    max: "high",
  },
} as const satisfies FireworksReasoningContract;

const GLM_5P2_CONTRACT = {
  ...DEEPSEEK_V4_CONTRACT,
  defaultLevel: "max",
} as const satisfies FireworksReasoningContract;

const THREE_EFFORT_CONTRACT = {
  mode: "effort",
  defaultLevel: "medium",
  map: {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "high",
    max: "high",
  },
} as const satisfies FireworksReasoningContract;

const INKLING_CONTRACT = {
  mode: "effort",
  defaultLevel: "high",
  offEffort: "none",
  reasoningHistory: "preserved",
  map: {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  },
} as const satisfies FireworksReasoningContract;

const KIMI_K2P6_CONTRACT = {
  mode: "thinking",
  defaultLevel: "off",
  supportsOff: true,
  enabledBudgetTokens: FIREWORKS_ENABLED_THINKING_BUDGET_TOKENS,
  reasoningHistory: "interleaved",
  map: {
    low: "enabled",
    medium: "enabled",
    high: "enabled",
    xhigh: "enabled",
    max: "enabled",
  },
} as const satisfies FireworksReasoningContract;

const KIMI_K2P7_CONTRACT = {
  mode: "always",
  defaultLevel: "high",
  reasoningHistory: "preserved",
} as const satisfies FireworksReasoningContract;

const KIMI_K3_CONTRACT = {
  mode: "effort",
  defaultLevel: "max",
  reasoningHistory: "preserved",
  map: {
    low: "low",
    medium: "high",
    high: "high",
    xhigh: "max",
    max: "max",
  },
} as const satisfies FireworksReasoningContract;

const MINIMAX_M2P7_CONTRACT = {
  ...THREE_EFFORT_CONTRACT,
  reasoningHistory: "interleaved",
} as const satisfies FireworksReasoningContract;

const MINIMAX_M3_CONTRACT = {
  mode: "thinking",
  defaultLevel: "medium",
  supportsOff: true,
  enabledBudgetTokens: FIREWORKS_ENABLED_THINKING_BUDGET_TOKENS,
  map: {
    low: "adaptive",
    medium: "adaptive",
    high: "enabled",
    xhigh: "enabled",
    max: "enabled",
  },
} as const satisfies FireworksReasoningContract;

const QWEN_3P7_CONTRACT = {
  ...BINARY_HIGH_CONTRACT,
  reasoningHistory: "preserved",
} as const satisfies FireworksReasoningContract;

function normalizeFireworksModelName(modelId: string): string {
  const normalized = modelId.trim().toLowerCase();
  const lastSegment = normalized.split("/").pop() ?? normalized;
  return lastSegment.replace(/([a-z0-9])p(?=\d)/gu, "$1.");
}

function resolveFireworksReasoningContract(
  modelId: string,
): FireworksReasoningContract | undefined {
  const name = normalizeFireworksModelName(modelId);
  if (name.startsWith("deepseek-v4-")) {
    return DEEPSEEK_V4_CONTRACT;
  }
  if (name.startsWith("glm-5.1")) {
    return BINARY_HIGH_CONTRACT;
  }
  if (name.startsWith("glm-5.2")) {
    return GLM_5P2_CONTRACT;
  }
  if (name.startsWith("gpt-oss-")) {
    return THREE_EFFORT_CONTRACT;
  }
  if (name === "inkling") {
    return INKLING_CONTRACT;
  }
  if (name.startsWith("kimi-k2.6")) {
    return KIMI_K2P6_CONTRACT;
  }
  if (name.startsWith("kimi-k2.7-code")) {
    return KIMI_K2P7_CONTRACT;
  }
  if (name.startsWith("kimi-k3")) {
    return KIMI_K3_CONTRACT;
  }
  if (name.startsWith("minimax-m2.7")) {
    return MINIMAX_M2P7_CONTRACT;
  }
  if (name.startsWith("minimax-m3")) {
    return MINIMAX_M3_CONTRACT;
  }
  if (name.startsWith("nemotron-3-ultra")) {
    return BINARY_HIGH_CONTRACT;
  }
  if (name.startsWith("qwen3.7-plus")) {
    return QWEN_3P7_CONTRACT;
  }
  return undefined;
}

function resolveEffectiveLevel(
  contract: FireworksReasoningContract,
  level: FireworksThinkingLevel | undefined,
): FireworksThinkingLevel {
  if (!level || (level === "off" && !contractSupportsOff(contract))) {
    return contract.defaultLevel;
  }
  return level;
}

function contractSupportsOff(contract: FireworksReasoningContract): boolean {
  return (
    contract.mode === "disabled" ||
    (contract.mode === "effort" && contract.offEffort !== undefined) ||
    (contract.mode === "thinking" && contract.supportsOff)
  );
}

function resolveDisplayValue(
  contract: FireworksReasoningContract,
  level: CanonicalThinkingLevel,
): string {
  if (contract.mode === "effort") {
    return contract.map[level];
  }
  if (contract.mode === "thinking") {
    return contract.map[level] === "enabled" ? "on" : contract.map[level];
  }
  return contract.mode === "always" ? "on" : "off";
}

export function resolveFireworksThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  const contract = resolveFireworksReasoningContract(modelId);
  if (!contract) {
    return undefined;
  }
  if (contract.mode === "disabled") {
    return {
      levels: [{ id: "off" }],
      defaultLevel: "off",
    };
  }

  const supportsOff = contractSupportsOff(contract);
  const levels: ProviderThinkingProfile["levels"] = [
    ...(supportsOff ? [{ id: "off" as const }] : []),
    ...CANONICAL_LEVELS.map((id) => {
      const displayValue = resolveDisplayValue(contract, id);
      return displayValue === id ? { id } : { id, label: `${id} → ${displayValue}` };
    }),
  ];
  return {
    levels,
    defaultLevel: contract.defaultLevel,
    preserveWhenCatalogReasoningFalse: true,
  };
}

export function resolveFireworksDefaultReasoning(modelId: string): boolean | undefined {
  const contract = resolveFireworksReasoningContract(modelId);
  if (!contract) {
    return undefined;
  }
  return contract.mode !== "disabled";
}

function clearReasoningPayload(payload: Record<string, unknown>): void {
  delete payload.reasoning;
  delete payload.reasoningEffort;
  delete payload.reasoning_effort;
  delete payload.reasoning_history;
  delete payload.thinking;
}

function ensurePreservedAssistantReasoningContent(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.messages)) {
    return;
  }
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (
      record.role === "assistant" &&
      Array.isArray(record.tool_calls) &&
      record.tool_calls.length > 0 &&
      !("reasoning_content" in record)
    ) {
      record.reasoning_content = "";
    }
  }
}

function dropAssistantReasoningContent(payload: Record<string, unknown>): void {
  if (!Array.isArray(payload.messages)) {
    return;
  }
  for (const message of payload.messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const record = message as Record<string, unknown>;
    if (record.role === "assistant") {
      delete record.reasoning_content;
    }
  }
}

export function resolveFireworksReasoningDispatch(params: {
  modelId: string;
  thinkingLevel?: FireworksInputThinkingLevel;
}):
  | {
      reasoning: boolean;
      patchPayload: (payload: Record<string, unknown>) => void;
    }
  | undefined {
  const contract = resolveFireworksReasoningContract(params.modelId);
  if (!contract) {
    return undefined;
  }
  const effectiveLevel = resolveEffectiveLevel(
    contract,
    params.thinkingLevel === "adaptive"
      ? undefined
      : params.thinkingLevel === "minimal"
        ? "low"
        : params.thinkingLevel,
  );
  const reasoning =
    contract.mode !== "disabled" && !(effectiveLevel === "off" && contractSupportsOff(contract));

  return {
    reasoning,
    patchPayload: (payload) => {
      clearReasoningPayload(payload);
      if (!reasoning) {
        dropAssistantReasoningContent(payload);
      }
      if (contract.mode === "disabled") {
        payload.thinking = { type: "disabled" };
        return;
      }
      if (contract.mode === "always") {
        if (contract.reasoningHistory) {
          payload.reasoning_history = contract.reasoningHistory;
        }
        ensurePreservedAssistantReasoningContent(payload);
        return;
      }
      if (contract.mode === "thinking") {
        if (!reasoning) {
          payload.thinking = { type: "disabled" };
          return;
        }
        payload.thinking = {
          type: contract.map[effectiveLevel as CanonicalThinkingLevel],
          ...(contract.map[effectiveLevel as CanonicalThinkingLevel] === "enabled"
            ? { budget_tokens: contract.enabledBudgetTokens }
            : {}),
        };
      } else {
        payload.reasoning_effort =
          effectiveLevel === "off"
            ? contract.offEffort
            : contract.map[effectiveLevel as CanonicalThinkingLevel];
      }
      if (reasoning && contract.reasoningHistory) {
        payload.reasoning_history = contract.reasoningHistory;
      }
      if (reasoning && contract.reasoningHistory === "preserved") {
        ensurePreservedAssistantReasoningContent(payload);
      }
    },
  };
}

export function buildFireworksReplayPolicy(params: {
  modelId?: string | null;
  modelApi?: string | null;
}): ProviderReplayPolicy | undefined {
  const contract = params.modelId ? resolveFireworksReasoningContract(params.modelId) : undefined;
  return buildOpenAICompatibleReplayPolicy(params.modelApi, {
    modelId: params.modelId,
    dropReasoningFromHistory: contract?.reasoningHistory === undefined,
  });
}
