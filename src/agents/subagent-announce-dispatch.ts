/**
 * Subagent announcement dispatch strategy.
 *
 * Completion handoff and requester-visible replies use this to choose between
 * steering a subagent and directly delivering a message, with phase evidence.
 */
type SubagentDeliveryPath = "steered" | "direct" | "none";
/** Stable reasons an announcement delivery can fail without throwing. */
export type SubagentAnnounceDeliveryFailureReason =
  | "completion_handoff_pending"
  | "completion_handoff_missing_run_id"
  | "generated_media_missing"
  | "message_tool_delivery_missing"
  | "requester_abandoned"
  | "visible_reply_missing";

type SubagentAnnounceSteerOutcome =
  | { status: "steered"; deliveredAt?: number; enqueuedAt?: number }
  | { status: "none" | "dropped" };

type SubagentAnnounceDeliveryCommon = {
  path: SubagentDeliveryPath;
  enqueuedAt?: number;
  phases?: SubagentAnnounceDispatchPhaseResult[];
};

/** Closed result of trying to deliver a subagent announcement. */
export type SubagentAnnounceDeliveryResult =
  | (SubagentAnnounceDeliveryCommon & {
      status: "delivered";
      deliveredAt?: number;
    })
  | (SubagentAnnounceDeliveryCommon & {
      status: "pending";
      path: "direct";
      runCorrelationId: string;
      reason: "completion_handoff_pending";
    })
  | (SubagentAnnounceDeliveryCommon & {
      status: "unresolved";
      path: "direct";
      reason: "completion_handoff_missing_run_id";
      error: string;
    })
  | (SubagentAnnounceDeliveryCommon & {
      status: "failed" | "terminal_failure";
      reason?: SubagentAnnounceDeliveryFailureReason;
      error?: string;
    });

type SubagentAnnounceDispatchPhase = "steer-primary" | "direct-primary" | "steer-fallback";

type SubagentAnnounceDispatchPhaseResult = {
  phase: SubagentAnnounceDispatchPhase;
  status: SubagentAnnounceDeliveryResult["status"];
  path: SubagentDeliveryPath;
  deliveredAt?: number;
  enqueuedAt?: number;
  runCorrelationId?: string;
  reason?: SubagentAnnounceDeliveryFailureReason;
  error?: string;
};

/** Converts a steer outcome into the shared delivery result shape. */
export function mapSteerOutcomeToDeliveryResult(
  outcome: SubagentAnnounceSteerOutcome,
): SubagentAnnounceDeliveryResult {
  if (outcome.status === "steered") {
    return {
      status: "delivered",
      path: "steered",
      deliveredAt: outcome.deliveredAt,
      enqueuedAt: outcome.enqueuedAt,
    };
  }
  return {
    status: "failed",
    path: "none",
  };
}

/** Runs the ordered steer/direct announcement delivery strategy. */
export async function runSubagentAnnounceDispatch(params: {
  expectsCompletionMessage: boolean;
  signal?: AbortSignal;
  steer: () => Promise<SubagentAnnounceSteerOutcome>;
  direct: () => Promise<SubagentAnnounceDeliveryResult>;
}): Promise<SubagentAnnounceDeliveryResult> {
  const phases: SubagentAnnounceDispatchPhaseResult[] = [];
  const appendPhase = (
    phase: SubagentAnnounceDispatchPhase,
    result: SubagentAnnounceDeliveryResult,
  ) => {
    phases.push({
      phase,
      status: result.status,
      path: result.path,
      ...(result.status === "delivered" && typeof result.deliveredAt === "number"
        ? { deliveredAt: result.deliveredAt }
        : {}),
      ...(typeof result.enqueuedAt === "number" ? { enqueuedAt: result.enqueuedAt } : {}),
      ...(result.status === "pending" ? { runCorrelationId: result.runCorrelationId } : {}),
      ...(result.status !== "delivered" && result.reason ? { reason: result.reason } : {}),
      ...((result.status === "failed" ||
        result.status === "terminal_failure" ||
        result.status === "unresolved") &&
      result.error
        ? { error: result.error }
        : {}),
    });
  };
  const withPhases = (result: SubagentAnnounceDeliveryResult): SubagentAnnounceDeliveryResult => ({
    ...result,
    phases,
  });

  if (params.signal?.aborted) {
    return withPhases({
      status: "failed",
      path: "none",
    });
  }

  if (!params.expectsCompletionMessage) {
    const primarySteerOutcome = await params.steer();
    const primarySteer = mapSteerOutcomeToDeliveryResult(primarySteerOutcome);
    appendPhase("steer-primary", primarySteer);
    if (primarySteer.status === "delivered") {
      return withPhases(primarySteer);
    }
    if (primarySteerOutcome.status === "dropped") {
      return withPhases(primarySteer);
    }

    const primaryDirect = await params.direct();
    appendPhase("direct-primary", primaryDirect);
    return withPhases(primaryDirect);
  }

  // Completion handoff prefers direct delivery first so the completion agent's
  // final visible message wins before falling back to steering.
  const primaryDirect = await params.direct();
  appendPhase("direct-primary", primaryDirect);
  if (
    primaryDirect.status === "delivered" ||
    primaryDirect.status === "pending" ||
    primaryDirect.status === "unresolved" ||
    primaryDirect.status === "terminal_failure"
  ) {
    return withPhases(primaryDirect);
  }

  if (params.signal?.aborted) {
    return withPhases(primaryDirect);
  }

  const fallbackSteerOutcome = await params.steer();
  const fallbackSteer = mapSteerOutcomeToDeliveryResult(fallbackSteerOutcome);
  appendPhase("steer-fallback", fallbackSteer);
  if (fallbackSteer.status === "delivered") {
    return withPhases(fallbackSteer);
  }

  return withPhases(primaryDirect);
}
