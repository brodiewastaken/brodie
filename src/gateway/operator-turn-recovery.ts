import type { JsonValue } from "../scheduler/conversation-scheduler.js";
import { registerRuntimeOperatorTurnRecoveryExecutor } from "../scheduler/runtime-turn-admission.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

let installedContext: GatewayRequestContext | undefined;
let unregisterSchedulerExecutor: (() => void) | undefined;

function payloadKind(payload: JsonValue): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  return typeof payload.kind === "string" ? payload.kind : undefined;
}

async function executeRecoveredOperatorTurn(params: {
  agentId: string;
  sessionKey: string;
  runId: string;
  payload: JsonValue;
}): Promise<unknown> {
  const context = installedContext;
  if (!context) {
    throw new Error("gateway operator recovery runtime is unavailable");
  }
  switch (payloadKind(params.payload)) {
    case "gateway_operator_agent": {
      const { executeRecoveredGatewayAgentTurn } = await import("./server-methods/agent.js");
      return await executeRecoveredGatewayAgentTurn({ ...params, context });
    }
    case "gateway_operator_chat": {
      const chatModule =
        (await import("./server-methods/chat.js")) as typeof import("./server-methods/chat.js") & {
          executeRecoveredGatewayChatTurn: (params: {
            agentId: string;
            sessionKey: string;
            runId: string;
            payload: JsonValue;
            context: GatewayRequestContext;
          }) => Promise<unknown>;
        };
      const { executeRecoveredGatewayChatTurn } = chatModule;
      return await executeRecoveredGatewayChatTurn({ ...params, context });
    }
    default:
      throw new Error("gateway operator recovery payload kind is invalid");
  }
}

/** Installs the post-authorization recovery runtime before scheduler rehydration drains. */
export function installGatewayOperatorTurnRecovery(context: GatewayRequestContext): void {
  installedContext = context;
  unregisterSchedulerExecutor ??= registerRuntimeOperatorTurnRecoveryExecutor(
    executeRecoveredOperatorTurn,
  );
}
