// Runtime system helpers expose host system operations to activated plugin runtimes.
import { randomUUID } from "node:crypto";
import { getRuntimeConfig } from "../../config/io.js";
import { requestHeartbeat } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { createLazyRuntimeMethod, createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { formatNativeDependencyHint } from "./native-deps.js";
import type { RunHeartbeatOnceOptions } from "./types-core.js";
import type { PluginRuntime } from "./types.js";

const loadHeartbeatRunnerRuntime = createLazyRuntimeModule(
  () => import("../../infra/heartbeat-runner.js"),
);
const runHeartbeatOnceInternal = createLazyRuntimeMethod(
  loadHeartbeatRunnerRuntime,
  (runtime) => runtime.runHeartbeatOnce,
);
const admitRuntimeHeartbeatWakeInternal = createLazyRuntimeMethod(
  loadHeartbeatRunnerRuntime,
  (runtime) => runtime.admitRuntimeHeartbeatWake,
);

/** Creates the plugin runtime system facade with heartbeat/event/process helpers. */
export function createRuntimeSystem(): PluginRuntime["system"] {
  const requestHeartbeatNow: PluginRuntime["system"]["requestHeartbeatNow"] = (opts) => {
    const agentId = opts?.agentId ?? resolveAgentIdFromSessionKey(opts?.sessionKey) ?? "main";
    const wake = {
      source: opts?.source ?? "other",
      intent: opts?.intent ?? "immediate",
      reason: opts?.reason,
      coalesceMs: opts?.coalesceMs,
      agentId,
      sessionKey: opts?.sessionKey,
      heartbeat: opts?.heartbeat,
      sourceGeneration: randomUUID(),
      producerKind: "system" as const,
    };
    void admitRuntimeHeartbeatWakeInternal({
      cfg: getRuntimeConfig(),
      ...wake,
    }).then((admission) => {
      if (!admission.accepted) {
        requestHeartbeat(wake);
      }
    });
  };

  return {
    enqueueSystemEvent,
    requestHeartbeat,
    requestHeartbeatNow,
    runHeartbeatOnce: (opts?: RunHeartbeatOnceOptions) => {
      // Destructure to forward only the plugin-safe subset; prevent cfg/deps injection at runtime.
      const { reason, agentId, sessionKey, heartbeat } = opts ?? {};
      return runHeartbeatOnceInternal({
        reason,
        agentId,
        sessionKey,
        heartbeat: heartbeat ? { target: heartbeat.target } : undefined,
      });
    },
    runCommandWithTimeout,
    formatNativeDependencyHint,
  };
}
