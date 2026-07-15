/**
 * Post-restart reconciliation for interrupted subagent sessions.
 *
 * `abortedLastRun` proves that the embedded run stopped. It does not prove that
 * replaying the task is safe. Without a durable live runtime identity, recovery
 * finalizes one structured interruption and lets the controller decide whether
 * to retry.
 */

import { getRuntimeConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
  updateSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { markSubagentRecoveryWedged } from "./subagent-recovery-state.js";
import { finalizeInterruptedSubagentRun } from "./subagent-registry-steer-runtime.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";

const log = createSubsystemLogger("subagent-interrupted-resume");
const UNSAFE_REPLAY_INTERRUPTION_REASON =
  "durable runtime proof is unavailable after the gateway restart; automatic replay is unsafe";

/** Delay before attempting recovery to let the gateway finish bootstrapping. */
const DEFAULT_RECOVERY_DELAY_MS = 5_000;

function isLegacyRestartInterruptedTimeout(
  runRecord: SubagentRunRecord,
  entry: SessionEntry | undefined,
): boolean {
  return (
    entry?.abortedLastRun === true &&
    runRecord.outcome?.status === "timeout" &&
    typeof runRecord.endedAt === "number" &&
    runRecord.endedAt > 0
  );
}

function reclassifyLegacyRestartInterruptedRun(runRecord: SubagentRunRecord): void {
  const interruptedAt = runRecord.endedAt;
  runRecord.execution = {
    ...runRecord.execution,
    status: "interrupted",
    interruptedAt,
    interruptionReason: "gateway-restart",
    endedAt: undefined,
    outcome: undefined,
  };
  runRecord.endedAt = undefined;
  runRecord.endedReason = undefined;
  runRecord.outcome = undefined;
}

/**
 * Scan interrupted subagent sessions after a gateway restart.
 *
 * An orphaned session is one where:
 * 1. It has an active (not ended) entry in the subagent run registry
 * 2. Its session store entry has `abortedLastRun: true`
 *
 * The embedded runtime is gone at this point, so the task is never replayed.
 * Each qualifying row is marked once and returned for structured interruption
 * finalization by the startup scheduler.
 */
export async function recoverOrphanedSubagentSessions(params: {
  getActiveRuns: () => Map<string, SubagentRunRecord>;
  /** Persisted across retries so already-resumed sessions are not resumed again. */
  resumedSessionKeys?: Set<string>;
}): Promise<{
  recovered: number;
  failed: number;
  skipped: number;
  failedRuns: Array<{ runId: string; childSessionKey: string; error?: string }>;
}> {
  const result = {
    recovered: 0,
    failed: 0,
    skipped: 0,
    failedRuns: [] as Array<{ runId: string; childSessionKey: string; error?: string }>,
  };
  const resumedRunIds = params.resumedSessionKeys ?? new Set<string>();

  try {
    const activeRuns = params.getActiveRuns();
    if (activeRuns.size === 0) {
      return result;
    }

    const cfg = getRuntimeConfig();
    const storeCache = new Map<string, Record<string, SessionEntry>>();
    const latestRunIdByChildSession = new Map<string, string>();
    for (const [runId, runRecord] of activeRuns) {
      const childSessionKey = runRecord.childSessionKey?.trim();
      if (!childSessionKey) {
        continue;
      }
      const currentRunId = latestRunIdByChildSession.get(childSessionKey);
      const current = currentRunId ? activeRuns.get(currentRunId) : undefined;
      if (!current || compareSubagentRunGeneration(runRecord, current) > 0) {
        latestRunIdByChildSession.set(childSessionKey, runId);
      }
    }

    for (const [runId, runRecord] of activeRuns.entries()) {
      const childSessionKey = runRecord.childSessionKey?.trim();
      if (!childSessionKey) {
        continue;
      }
      const now = Date.now();
      if (resumedRunIds.has(runId)) {
        result.skipped++;
        continue;
      }

      try {
        const agentId = resolveAgentIdFromSessionKey(childSessionKey);
        const storePath = resolveStorePath(cfg.session?.store, { agentId });

        let store = storeCache.get(storePath);
        if (!store) {
          store = loadSessionStore(storePath);
          storeCache.set(storePath, store);
        }

        const entry = store[childSessionKey];
        if (!entry) {
          result.skipped++;
          continue;
        }

        const persistedMarkerRunId = entry.subagentRecovery?.lastRunId?.trim();
        const persistedMarkerRun = persistedMarkerRunId
          ? activeRuns.get(persistedMarkerRunId)
          : undefined;
        const hasPersistedInterruptionMarker =
          entry.subagentRecovery?.wedgedReason === UNSAFE_REPLAY_INTERRUPTION_REASON &&
          Boolean(
            persistedMarkerRun &&
            (typeof persistedMarkerRun.endedAt !== "number" ||
              isLegacyRestartInterruptedTimeout(persistedMarkerRun, entry)),
          );
        const persistedInterruptionMarker =
          hasPersistedInterruptionMarker && persistedMarkerRunId === runId;
        const isLatestRunForSession = latestRunIdByChildSession.get(childSessionKey) === runId;
        const claimsLatestAbortedRun = entry.abortedLastRun === true && isLatestRunForSession;
        if (!persistedInterruptionMarker && !claimsLatestAbortedRun) {
          result.skipped++;
          continue;
        }
        if (isLegacyRestartInterruptedTimeout(runRecord, entry)) {
          reclassifyLegacyRestartInterruptedRun(runRecord);
        }

        // Terminal child outcomes are immutable. Restart resume only applies to
        // non-terminal interrupted execution; delivery retry handles terminal
        // child results separately.
        if (typeof runRecord.endedAt === "number" && runRecord.endedAt > 0) {
          result.skipped++;
          continue;
        }
        if (claimsLatestAbortedRun) {
          await updateSessionStore(storePath, (currentStore) => {
            const current = currentStore[childSessionKey];
            if (!current) {
              return;
            }
            current.abortedLastRun = false;
            markSubagentRecoveryWedged({
              entry: current,
              now,
              runId,
              reason: UNSAFE_REPLAY_INTERRUPTION_REASON,
            });
            current.updatedAt = now;
            currentStore[childSessionKey] = current;
          });
        }
        resumedRunIds.add(runId);
        result.skipped++;
        result.failedRuns.push({
          runId,
          childSessionKey,
          error: UNSAFE_REPLAY_INTERRUPTION_REASON,
        });
        log.warn(
          `finalizing interrupted subagent ${childSessionKey}: ${UNSAFE_REPLAY_INTERRUPTION_REASON}`,
        );
      } catch (err) {
        const error = formatErrorMessage(err);
        log.warn(`error processing orphaned session ${childSessionKey}: ${error}`);
        result.failed++;
        result.failedRuns.push({
          runId,
          childSessionKey,
          error,
        });
      }
    }
  } catch (err) {
    log.warn(`orphan recovery scan failed: ${String(err)}`);
    // Ensure retry logic fires for scan-level exceptions.
    if (result.failed === 0) {
      result.failed = 1;
    }
  }

  if (result.recovered > 0 || result.failed > 0) {
    log.info(
      `orphan recovery complete: recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped}`,
    );
  }

  return result;
}

/** Maximum number of retry attempts for orphan recovery. */
const MAX_RECOVERY_RETRIES = 3;
/** Backoff multiplier between retries (exponential). */
const RETRY_BACKOFF_MULTIPLIER = 2;

function buildRecoveryFailureMessage(params: { error?: string }): string {
  const base =
    `Subagent run was interrupted by a gateway restart or connection loss. ` +
    `Automatic replay was not attempted because no durable live runtime proof remained. ` +
    `Review known side effects before retrying.`;
  const detail = params.error?.trim();
  if (!detail) {
    return base;
  }
  return `${base} (${detail})`;
}

/**
 * Schedule orphan recovery after a delay, with retry logic.
 * The delay gives the gateway time to fully bootstrap after restart.
 * If recovery fails (e.g. gateway not yet ready), retries with exponential backoff.
 */
export function scheduleOrphanRecovery(params: {
  getActiveRuns: () => Map<string, SubagentRunRecord>;
  delayMs?: number;
  maxRetries?: number;
}): void {
  const initialDelay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  const maxRetries = params.maxRetries ?? MAX_RECOVERY_RETRIES;

  const resumedRunIds = new Set<string>();
  const attemptRecovery = (attempt: number, delay: number) => {
    setTimeout(() => {
      void (async () => {
        try {
          const result = await recoverOrphanedSubagentSessions({
            ...params,
            resumedSessionKeys: resumedRunIds,
          });
          if (result.failed > 0 && attempt < maxRetries) {
            const nextDelay = delay * RETRY_BACKOFF_MULTIPLIER;
            log.info(
              `orphan recovery had ${result.failed} failure(s); retrying in ${nextDelay}ms (attempt ${attempt + 1}/${maxRetries})`,
            );
            attemptRecovery(attempt + 1, nextDelay);
            return;
          }
          await Promise.all(
            result.failedRuns.map(async (run) => {
              try {
                await finalizeInterruptedSubagentRun({
                  runId: run.runId,
                  childSessionKey: run.childSessionKey,
                  error: buildRecoveryFailureMessage({ error: run.error }),
                });
              } catch (error) {
                resumedRunIds.delete(run.runId);
                throw error;
              }
            }),
          );
        } catch (err) {
          if (attempt < maxRetries) {
            const nextDelay = delay * RETRY_BACKOFF_MULTIPLIER;
            log.warn(
              `scheduled orphan recovery failed: ${String(err)}; retrying in ${nextDelay}ms (attempt ${attempt + 1}/${maxRetries})`,
            );
            attemptRecovery(attempt + 1, nextDelay);
          } else {
            log.warn(
              `scheduled orphan recovery failed after ${maxRetries} retries: ${String(err)}; continuing in ${delay}ms`,
            );
            attemptRecovery(0, delay);
          }
        }
      })();
    }, delay).unref?.();
  };

  attemptRecovery(0, initialDelay);
}
