// Gateway hook server wiring translates external hook requests into wake events or isolated agent runs.
import { createHash } from "node:crypto";
import {
  resolveDateTimestampMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeInboundSystemTags } from "../../auto-reply/reply/inbound-text.js";
import type { CliDeps } from "../../cli/deps.types.js";
import { getRuntimeConfig } from "../../config/io.js";
import {
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
  resolveMainSessionKeyFromConfig,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RunCronAgentTurnResult } from "../../cron/isolated-agent/run.types.js";
import type { CronJob } from "../../cron/types.js";
import { admitDurableSystemEventWake } from "../../infra/durable-system-event-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { HookAgentDispatchPayload, HooksConfigResolved } from "../hooks.js";
import { createHooksRequestHandler, type HookClientIpConfig } from "./hooks-request-handler.js";
import {
  admitScheduledHook,
  ensureHookSchedulerProducerRegistered,
  type ScheduledHookPayload,
} from "./hooks-scheduler-admission.js";

/**
 * Gateway hook HTTP handler factory.
 *
 * Hooks can either enqueue wake events or spawn isolated agent turns; both paths
 * sanitize external input before it reaches logs or system-event text.
 */
type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

function resolveHookEventSessionKey(params: { cfg: OpenClawConfig; agentId?: string }): string {
  return params.agentId
    ? resolveAgentMainSessionKey({ cfg: params.cfg, agentId: params.agentId })
    : resolveMainSessionKey(params.cfg);
}

function shouldAnnounceHookRunResult(params: {
  deliver: boolean;
  result: RunCronAgentTurnResult;
}): boolean {
  if (params.result.status !== "ok") {
    return true;
  }
  return (
    params.deliver && params.result.delivered !== true && params.result.deliveryAttempted !== true
  );
}

function resolveHookRunSummary(result: RunCronAgentTurnResult): string {
  const diagnosticsSummary =
    result.status !== "ok" ? normalizeOptionalString(result.diagnostics?.summary) : undefined;
  return (
    diagnosticsSummary ||
    normalizeOptionalString(result.summary) ||
    normalizeOptionalString(result.error) ||
    result.status
  );
}

function sanitizeHookConsoleValue(value: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const withoutControlChars = Array.from(normalized, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127 ? " " : char;
  }).join("");
  return withoutControlChars.replace(/\s+/gu, " ").trim().slice(0, 500);
}

function formatHookRunWarningConsoleMessage(params: {
  status: string;
  model: string | undefined;
  summary: string;
}): string {
  const parts = [
    "hook agent run returned non-ok status",
    `status=${sanitizeHookConsoleValue(params.status) ?? "unknown"}`,
  ];
  const model = sanitizeHookConsoleValue(params.model);
  if (model) {
    parts.push(`model=${model}`);
  }
  const summary = sanitizeHookConsoleValue(params.summary);
  if (summary) {
    parts.push(`summary=${summary}`);
  }
  return parts.join(" ");
}

function deriveHookExecutionId(kind: "job" | "run", sourceGeneration: string): string {
  return createHash("sha256")
    .update(`hook-${kind}\0`)
    .update(sourceGeneration, "utf8")
    .digest("hex");
}

/** Creates the HTTP handler used by gateway hook endpoints. */
export function createGatewayHooksRequestHandler(params: {
  deps: CliDeps;
  getHooksConfig: () => HooksConfigResolved | null;
  getClientIpConfig: () => HookClientIpConfig;
  bindHost: string;
  port: number;
  logHooks: SubsystemLogger;
}) {
  const { deps, getHooksConfig, getClientIpConfig, bindHost, port, logHooks } = params;

  const dispatchHeartbeatWake = async (wakeParams: {
    sessionKey: string;
    sourceGeneration: string;
    producerKind: "hook" | "system";
    reason: string;
    systemEvent: { text: string };
  }) => {
    const cfg = getRuntimeConfig();
    const agentId = resolveAgentIdFromSessionKey(wakeParams.sessionKey) ?? "main";
    await admitDurableSystemEventWake({
      cfg,
      agentId,
      source: "hook",
      intent: "immediate",
      reason: wakeParams.reason,
      sessionKey: wakeParams.sessionKey,
      sourceGeneration: wakeParams.sourceGeneration,
      producerKind: wakeParams.producerKind,
      systemEvent: wakeParams.systemEvent,
    });
  };

  const dispatchWakeHook = async (value: {
    text: string;
    mode: "now" | "next-heartbeat";
    sourceGeneration: string;
  }): Promise<void> => {
    const sessionKey = resolveMainSessionKeyFromConfig();
    if (value.mode === "now") {
      await dispatchHeartbeatWake({
        reason: "hook:wake",
        sessionKey,
        sourceGeneration: value.sourceGeneration,
        producerKind: "hook",
        systemEvent: { text: value.text },
      });
    } else {
      enqueueSystemEvent(value.text, { sessionKey });
    }
  };

  const executeScheduledHook = async (
    payload: ScheduledHookPayload,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const { job, message, sessionKey, lane, runId, sourcePath } = payload;
    const safeName = job.name;
    const jobId = job.id;
    const deliver = job.delivery?.mode !== undefined && job.delivery.mode !== "none";
    const model = job.payload.kind === "agentTurn" ? job.payload.model : undefined;
    let hookEventSessionKey: string | undefined;
    try {
      const cfg = getRuntimeConfig();
      hookEventSessionKey = resolveHookEventSessionKey({
        cfg,
        agentId: job.agentId,
      });
      const { runCronIsolatedAgentTurn } = await import("../../cron/isolated-agent.js");
      const result = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job,
        message,
        sessionKey,
        lane,
      });
      const summary = resolveHookRunSummary(result);
      const prefix =
        result.status === "ok" ? `Hook ${safeName}` : `Hook ${safeName} (${result.status})`;
      const shouldAnnounce = shouldAnnounceHookRunResult({ deliver, result });
      if (result.status !== "ok") {
        logHooks.warn("hook agent run returned non-ok status", {
          sourcePath,
          name: safeName,
          runId,
          jobId,
          agentId: job.agentId,
          sessionKey,
          status: result.status,
          model,
          summary,
          consoleMessage: formatHookRunWarningConsoleMessage({
            status: result.status,
            model,
            summary,
          }),
        });
      }
      if (shouldAnnounce) {
        const eventSessionKey = hookEventSessionKey ?? resolveMainSessionKeyFromConfig();
        const systemEventText = `${prefix}: ${summary}`.trim();
        if (job.wakeMode === "now") {
          await dispatchHeartbeatWake({
            reason: `hook:${jobId}`,
            sessionKey: eventSessionKey,
            sourceGeneration: `${jobId}:announcement`,
            producerKind: "system",
            systemEvent: { text: systemEventText },
          });
        } else {
          enqueueSystemEvent(systemEventText, { sessionKey: eventSessionKey });
        }
      } else if (result.status === "ok" && !deliver) {
        logHooks.info("hook agent run completed without announcement", {
          sourcePath,
          name: safeName,
          runId,
          jobId,
          agentId: job.agentId,
          sessionKey,
          completedAt: new Date().toISOString(),
        });
      }
      return result.status === "ok" ? { ok: true } : { ok: false, reason: summary };
    } catch (err) {
      logHooks.warn(`hook agent failed: ${String(err)}`);
      const eventSessionKey = hookEventSessionKey ?? resolveMainSessionKeyFromConfig();
      const systemEventText = `Hook ${safeName} (error): ${String(err)}`;
      if (job.wakeMode === "now") {
        await dispatchHeartbeatWake({
          reason: `hook:${jobId}:error`,
          sessionKey: eventSessionKey,
          sourceGeneration: `${jobId}:announcement`,
          producerKind: "system",
          systemEvent: { text: systemEventText },
        });
      } else {
        enqueueSystemEvent(systemEventText, { sessionKey: eventSessionKey });
      }
      return { ok: false, reason: String(err) };
    }
  };

  ensureHookSchedulerProducerRegistered(executeScheduledHook);

  const dispatchAgentHook = async (value: HookAgentDispatchPayload): Promise<string> => {
    const sessionKey = value.sessionKey;
    const safeName = sanitizeInboundSystemTags(value.name);
    const jobId = deriveHookExecutionId("job", value.sourceGeneration);
    const runId = deriveHookExecutionId("run", value.sourceGeneration);
    const nowMs = resolveDateTimestampMs(Date.now());
    const delivery = value.deliver
      ? {
          mode: "announce" as const,
          channel: value.channel,
          to: value.to,
        }
      : { mode: "none" as const };
    const job: CronJob = {
      id: jobId,
      agentId: value.agentId,
      name: safeName,
      enabled: true,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: { kind: "at", at: resolveTimestampMsToIsoString(nowMs) },
      sessionTarget: "isolated",
      wakeMode: value.wakeMode,
      payload: {
        kind: "agentTurn",
        message: value.message,
        model: value.model,
        thinking: value.thinking,
        timeoutSeconds: value.timeoutSeconds,
        allowUnsafeExternalContent: value.allowUnsafeExternalContent,
        externalContentSource: value.externalContentSource,
      },
      delivery,
      state: { nextRunAtMs: nowMs },
    };

    const payload: ScheduledHookPayload = {
      version: 1,
      kind: "hook_run",
      job,
      message: value.message,
      sessionKey,
      lane: "cron",
      runId,
      sourcePath: value.sourcePath,
      sourceGeneration: value.sourceGeneration,
    };
    const admission = await admitScheduledHook(payload);
    if (!admission.accepted) {
      void executeScheduledHook(payload);
    }

    return runId;
  };

  return createHooksRequestHandler({
    getHooksConfig,
    bindHost,
    port,
    logHooks,
    getClientIpConfig,
    dispatchAgentHook,
    dispatchWakeHook,
  });
}
