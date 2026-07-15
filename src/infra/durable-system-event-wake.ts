import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { SchedulerProducerKind } from "../scheduler/conversation-scheduler.js";
import { admitRuntimeHeartbeatWake } from "./heartbeat-runner.js";
import type { HeartbeatWakeIntent, HeartbeatWakeSource } from "./heartbeat-wake.js";
import { requestHeartbeat } from "./heartbeat-wake.js";
import {
  enqueueNormalizedSystemEventEntry,
  normalizeSystemEventEntry,
  type SystemEvent,
} from "./system-events.js";

type DurableSystemEventWake = {
  cfg?: OpenClawConfig;
  sessionKey: string;
  systemEvent: Pick<SystemEvent, "text" | "contextKey" | "deliveryContext">;
  source: HeartbeatWakeSource;
  intent: HeartbeatWakeIntent;
  reason: string;
  sourceGeneration: string;
  producerKind: Extract<SchedulerProducerKind, "system" | "exec_completion" | "hook" | "node">;
  agentId?: string;
  heartbeat?: Parameters<typeof admitRuntimeHeartbeatWake>[0]["heartbeat"];
  coalesceMs?: number;
};

/** Commits a model-visible system event before relinquishing source ownership. */
export async function admitDurableSystemEventWake(params: DurableSystemEventWake) {
  const systemEvent = normalizeSystemEventEntry(params.systemEvent.text, {
    sessionKey: params.sessionKey,
    contextKey: params.systemEvent.contextKey,
    deliveryContext: params.systemEvent.deliveryContext,
  });
  if (!systemEvent) {
    return { accepted: false as const, reason: "invalid" as const };
  }
  enqueueNormalizedSystemEventEntry(systemEvent, params.sessionKey);
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey) ?? "main";
  const admission = await admitRuntimeHeartbeatWake({
    cfg: params.cfg ?? getRuntimeConfig(),
    agentId,
    sessionKey: params.sessionKey,
    source: params.source,
    intent: params.intent,
    reason: params.reason,
    sourceGeneration: params.sourceGeneration,
    producerKind: params.producerKind,
    heartbeat: params.heartbeat,
    systemEvent,
  });
  if (!admission.accepted) {
    requestHeartbeat({
      source: params.source,
      intent: params.intent,
      reason: params.reason,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionKey: params.sessionKey,
      sourceGeneration: params.sourceGeneration,
      producerKind: params.producerKind,
      ...(params.heartbeat ? { heartbeat: params.heartbeat } : {}),
      ...(params.coalesceMs === undefined ? {} : { coalesceMs: params.coalesceMs }),
    });
  }
  return admission;
}
