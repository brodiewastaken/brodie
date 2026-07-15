import type { CompactResult } from "../../../context-engine/types.js";

export type ContextEngineCompactionProgress = {
  /** Persisted context changed, even if the operation later failed. */
  mutated: boolean;
  /** The context mutation completed successfully and owns normal lifecycle work. */
  successfulMutation: boolean;
  /** A strict measured reduction authorizes another model attempt. */
  retryAuthorized: boolean;
  exhausted: boolean;
  reason?: string;
  tokensBefore?: number;
  tokensAfter?: number;
};

/**
 * Classifies whether a compaction result justifies another model attempt.
 *
 * `compacted` records a mutation, not recovery. A retry is safe only when the
 * engine also succeeded and measured a strict prompt-token reduction.
 */
export function classifyContextEngineCompactionProgress(
  result: CompactResult,
): ContextEngineCompactionProgress {
  const tokensBefore =
    typeof result.result?.tokensBefore === "number" &&
    Number.isFinite(result.result.tokensBefore) &&
    result.result.tokensBefore >= 0
      ? Math.floor(result.result.tokensBefore)
      : undefined;
  const tokensAfter =
    typeof result.result?.tokensAfter === "number" &&
    Number.isFinite(result.result.tokensAfter) &&
    result.result.tokensAfter >= 0
      ? Math.floor(result.result.tokensAfter)
      : undefined;
  const mutated = result.compacted;
  const successfulMutation = result.ok && mutated;
  return {
    mutated,
    successfulMutation,
    retryAuthorized:
      successfulMutation &&
      tokensBefore !== undefined &&
      tokensAfter !== undefined &&
      tokensAfter < tokensBefore,
    exhausted: result.exhausted === true,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(tokensBefore !== undefined ? { tokensBefore } : {}),
    ...(tokensAfter !== undefined ? { tokensAfter } : {}),
  };
}
