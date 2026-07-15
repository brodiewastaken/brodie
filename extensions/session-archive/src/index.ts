// Session archive sweep: TTL-archives generated sessions (cron, subagent,
// isolated) from every agent's session store without dispatching to or waking
// any agent. The sweep only rewrites store files and renames transcripts.
import fsSync from "node:fs";
import path from "node:path";
import { parseDurationMs } from "openclaw/plugin-sdk/cli-runtime";
import { getRuntimeConversationScheduler } from "openclaw/plugin-sdk/conversation-scheduler";
import { loadCronStore, resolveCronStorePath } from "openclaw/plugin-sdk/cron-store-runtime";
import {
  isCronSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "openclaw/plugin-sdk/routing";
import {
  archiveRemovedSessionTranscripts,
  listArchiveProtectedSubagentSessionKeys,
} from "openclaw/plugin-sdk/session-artifacts-runtime";
// All store access stays behind the session-store-runtime seam: a future
// SQLite session store changes only the SDK layer, not this sweep.
import {
  listAgentIds,
  resolveStorePath,
  updateSessionStore,
  isStableCronSessionKey,
  relocateCronSessionEntryInStore,
} from "openclaw/plugin-sdk/session-store-runtime";

export const DEFAULT_SESSION_ARCHIVE_TTL_MS = 60 * 60_000;
export const DEFAULT_SESSION_ARCHIVE_SWEEP_INTERVAL_MS = 60_000;
export const MIN_SESSION_ARCHIVE_SWEEP_INTERVAL_MS = 1000;
/** Minimum gap between effective sweeps per store, regardless of the timer. */
export const MIN_SESSION_ARCHIVE_EFFECTIVE_SWEEP_GAP_MS = 5 * 60_000;

export const SESSION_ARCHIVE_TARGETS = ["cron", "subagent", "isolated"] as const;
export type SessionArchiveTarget = (typeof SESSION_ARCHIVE_TARGETS)[number];

/** Built-in isolated key prefixes; operator prefixes come from config. */
const BUILTIN_ISOLATED_KEY_PREFIXES = ["isolated:"] as const;
const BUILTIN_ISOLATED_KEY_EXACT = "isolated";

export type SessionArchiveConfig = {
  enabled: boolean;
  /** null = plugin inert (disabled, or invalid config failed CLOSED). */
  retentionMs: number | null;
  targets: SessionArchiveTarget[];
  isolatedKeyPrefixes: string[];
  archiveTranscripts: boolean;
  intervalMs: number;
  cronStore?: string;
  /** Populated when invalid config forced the plugin inert; log loudly. */
  disabledReasons: string[];
};

type PluginLoggerLike = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type SessionEntryLike = {
  sessionId?: string;
  sessionFile?: string;
  updatedAt?: number;
  status?: string;
  heartbeatIsolatedBaseSessionKey?: string;
  acp?: { mode?: string; state?: string };
  archivedAt?: number;
  cronArchiveReceipt?: unknown;
};

/**
 * Config normalization FAILS CLOSED: a sweep that deletes sessions must never
 * run on a guessed retention. Invalid ttl (garbage, non-string, negative, or
 * "0m") and an all-invalid targets list make the plugin inert with a loud
 * warning rather than falling back to defaults. NOTE: this deliberately
 * overrides the old fork's retention-0 semantics (see MIGRATION).
 */
export function resolveSessionArchiveConfig(raw: unknown): SessionArchiveConfig {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const disabledReasons: string[] = [];
  const enabled = record.enabled !== false;
  let retentionMs: number | null = enabled ? DEFAULT_SESSION_ARCHIVE_TTL_MS : null;
  if (enabled && record.ttl !== undefined) {
    if (typeof record.ttl !== "string" || !record.ttl.trim()) {
      retentionMs = null;
      disabledReasons.push(`invalid ttl ${JSON.stringify(record.ttl)} (expected duration string)`);
    } else {
      let parsed: number | undefined;
      try {
        parsed = parseDurationMs(record.ttl, { defaultUnit: "m" });
      } catch {
        parsed = undefined;
      }
      if (typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0) {
        retentionMs = parsed;
      } else {
        retentionMs = null;
        disabledReasons.push(`invalid ttl ${JSON.stringify(record.ttl)} (must parse to > 0)`);
      }
    }
  }
  const rawTargets = Array.isArray(record.targets) ? record.targets : undefined;
  let targets: SessionArchiveTarget[] = [...SESSION_ARCHIVE_TARGETS];
  if (rawTargets !== undefined) {
    const validTargets = [
      ...new Set(
        rawTargets.filter((target): target is SessionArchiveTarget =>
          SESSION_ARCHIVE_TARGETS.includes(target as SessionArchiveTarget),
        ),
      ),
    ];
    if (validTargets.length === 0) {
      retentionMs = null;
      disabledReasons.push(`targets ${JSON.stringify(rawTargets)} contains no valid target`);
    }
    targets = validTargets;
  }
  const isolatedKeyPrefixes = Array.isArray(record.isolatedKeyPrefixes)
    ? record.isolatedKeyPrefixes
        .filter((prefix): prefix is string => typeof prefix === "string")
        .map((prefix) => prefix.trim())
        .filter(Boolean)
    : [];
  const intervalRaw = record.intervalMs;
  const intervalMs =
    typeof intervalRaw === "number" &&
    Number.isFinite(intervalRaw) &&
    intervalRaw >= MIN_SESSION_ARCHIVE_SWEEP_INTERVAL_MS
      ? Math.floor(intervalRaw)
      : DEFAULT_SESSION_ARCHIVE_SWEEP_INTERVAL_MS;
  const cronStore =
    typeof record.cronStore === "string" && record.cronStore.trim()
      ? record.cronStore.trim()
      : undefined;
  return {
    enabled,
    retentionMs,
    targets,
    isolatedKeyPrefixes,
    archiveTranscripts: record.archiveTranscripts !== false,
    intervalMs,
    ...(cronStore ? { cronStore } : {}),
    disabledReasons,
  };
}

const KEY_SEGMENT_SEPARATORS: ReadonlySet<string> = new Set([":", "-"]);

/**
 * Isolated prefixes are segment-terminated: a bare short prefix like "d" or
 * "main" must never swallow whole key namespaces. Prefixes that already end
 * in a separator (":" / "-", e.g. an operator's "isolated-note-") are
 * self-terminating and match as written.
 */
function matchesIsolatedKeyPrefix(rest: string, prefix: string): boolean {
  const normalizedPrefix = prefix.toLowerCase();
  if (rest === normalizedPrefix) {
    return true;
  }
  const lastChar = normalizedPrefix.at(-1) ?? "";
  if (KEY_SEGMENT_SEPARATORS.has(lastChar)) {
    return rest.startsWith(normalizedPrefix);
  }
  return rest.startsWith(`${normalizedPrefix}:`);
}

function isGeneratedIsolatedSessionKey(params: {
  sessionKey: string;
  entry: SessionEntryLike;
  isolatedKeyPrefixes: string[];
}): boolean {
  if (params.entry.heartbeatIsolatedBaseSessionKey?.trim()) {
    return true;
  }
  if (params.entry.acp?.mode === "oneshot") {
    return true;
  }
  const rest = parseAgentSessionKey(params.sessionKey)?.rest?.toLowerCase() ?? "";
  if (!rest) {
    return false;
  }
  if (rest === BUILTIN_ISOLATED_KEY_EXACT) {
    return true;
  }
  const prefixes = [...BUILTIN_ISOLATED_KEY_PREFIXES, ...params.isolatedKeyPrefixes];
  return prefixes.some((prefix) => matchesIsolatedKeyPrefix(rest, prefix));
}

/** Main sessions are never sweepable, whatever prefixes an operator configures. */
function isMainSessionKey(sessionKey: string): boolean {
  const normalized = sessionKey.trim().toLowerCase();
  if (normalized === "main" || normalized === "global") {
    return true;
  }
  const rest = parseAgentSessionKey(normalized)?.rest;
  return rest === "main" || rest === "global";
}

export function resolveGeneratedSessionTarget(params: {
  sessionKey: string;
  entry: SessionEntryLike;
  targets: ReadonlySet<SessionArchiveTarget>;
  isolatedKeyPrefixes: string[];
}): SessionArchiveTarget | null {
  if (isMainSessionKey(params.sessionKey)) {
    return null;
  }
  if (params.targets.has("cron") && isCronSessionKey(params.sessionKey)) {
    return "cron";
  }
  if (params.targets.has("subagent") && isSubagentSessionKey(params.sessionKey)) {
    return "subagent";
  }
  if (
    params.targets.has("isolated") &&
    isGeneratedIsolatedSessionKey({
      sessionKey: params.sessionKey,
      entry: params.entry,
      isolatedKeyPrefixes: params.isolatedKeyPrefixes,
    })
  ) {
    return "isolated";
  }
  return null;
}

export type SweepProtection = {
  activeSessionKeys: ReadonlySet<string>;
  activeSessionKeyPrefixes: readonly string[];
  activeSessionIds: ReadonlySet<string>;
  /**
   * Cron-store read failed this tick: FAIL CLOSED for cron-classified entries
   * (a running bound cron would otherwise be archivable mid-run).
   */
  cronProtectionUnavailable?: boolean;
  /** Subagent-registry read failed this tick: fail closed for subagent entries. */
  subagentProtectionUnavailable?: boolean;
};

function isProtectedSessionKey(sessionKey: string, protection: SweepProtection): boolean {
  const normalized = sessionKey.trim().toLowerCase();
  if (protection.activeSessionKeys.has(normalized)) {
    return true;
  }
  return protection.activeSessionKeyPrefixes.some((prefix) => {
    const normalizedPrefix = prefix.trim().toLowerCase();
    return (
      normalized === normalizedPrefix ||
      normalized.startsWith(
        normalizedPrefix.endsWith(":") ? normalizedPrefix : `${normalizedPrefix}:`,
      )
    );
  });
}

/**
 * Cron configuration is not liveness. Reading the store proves the control
 * plane is available, while scheduler/task state supplies exact protection.
 */
export async function resolveCronSweepProtection(params: {
  cronStorePath: string;
  agentIds: readonly string[];
  logger?: PluginLoggerLike;
}): Promise<{
  keys: Set<string>;
  prefixes: string[];
  unavailable: boolean;
}> {
  try {
    const store = await loadCronStore(params.cronStorePath);
    void store;
    return { keys: new Set<string>(), prefixes: [], unavailable: false };
  } catch (err) {
    params.logger?.warn?.(
      `session-archive: cron store read FAILED (${params.cronStorePath}); ` +
        `failing closed for cron-classified sessions this sweep: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    return { keys: new Set(), prefixes: [], unavailable: true };
  }
}

export type SweepResult = {
  swept: boolean;
  pruned: number;
  prunedByTarget: Record<SessionArchiveTarget, number>;
  skippedActive: number;
  archivedTranscripts: number;
};

function emptySweepResult(swept: boolean): SweepResult {
  return {
    swept,
    pruned: 0,
    prunedByTarget: { cron: 0, subagent: 0, isolated: 0 },
    skippedActive: 0,
    archivedTranscripts: 0,
  };
}

const lastSweepAtMsByStore = new Map<string, number>();

/** Test helper: clears the per-store effective-sweep throttle. */
export function resetSessionArchiveSweepThrottleForTests(): void {
  lastSweepAtMsByStore.clear();
}

/**
 * Only the entry's own generated transcript name is forwarded as a rename
 * candidate. A sessionFile pointing at ANOTHER session's live transcript must
 * never ride this entry's archive (the referenced-ids guard keys on
 * sessionId, not filename).
 */
function resolveSafeSessionFile(entry: SessionEntryLike): string | undefined {
  const sessionId = entry.sessionId?.trim();
  const sessionFile = entry.sessionFile?.trim();
  if (!sessionId || !sessionFile) {
    return undefined;
  }
  return path.basename(sessionFile).toLowerCase() === `${sessionId.toLowerCase()}.jsonl`
    ? sessionFile
    : undefined;
}

export async function sweepGeneratedSessions(params: {
  storePath: string;
  config: SessionArchiveConfig;
  protection: SweepProtection;
  nowMs?: number;
  force?: boolean;
  logger?: PluginLoggerLike;
}): Promise<SweepResult> {
  const { storePath, config } = params;
  const now = params.nowMs ?? Date.now();
  const lastSweepAtMs = lastSweepAtMsByStore.get(storePath) ?? 0;
  if (params.force !== true && now - lastSweepAtMs < MIN_SESSION_ARCHIVE_EFFECTIVE_SWEEP_GAP_MS) {
    return emptySweepResult(false);
  }
  if (config.retentionMs === null) {
    lastSweepAtMsByStore.set(storePath, now);
    return emptySweepResult(false);
  }
  if (!fsSync.existsSync(storePath)) {
    // Missing store is a successful empty sweep — the agent has no sessions.
    lastSweepAtMsByStore.set(storePath, now);
    return emptySweepResult(true);
  }
  const cutoff = now - config.retentionMs;
  const targetSet = new Set(config.targets);
  const result = emptySweepResult(true);
  const removedSessions = new Map<string, string | undefined>();
  let referencedSessionIds = new Set<string>();
  try {
    // skipMaintenance keeps the sweep from triggering upstream store
    // maintenance (pruning/capping) recursively mid-rewrite.
    await updateSessionStore(
      storePath,
      (store: Record<string, SessionEntryLike | undefined>) => {
        for (const [sessionKey, entry] of Object.entries(store)) {
          if (!entry) {
            continue;
          }
          const target = resolveGeneratedSessionTarget({
            sessionKey,
            entry,
            targets: targetSet,
            isolatedKeyPrefixes: config.isolatedKeyPrefixes,
          });
          if (!target) {
            continue;
          }
          if (target === "cron" && params.protection.cronProtectionUnavailable === true) {
            // Cron store unreadable: no liveness signal → fail closed.
            result.skippedActive += 1;
            continue;
          }
          if (target === "subagent" && params.protection.subagentProtectionUnavailable === true) {
            // Subagent registry unreadable: no liveness signal → fail closed.
            result.skippedActive += 1;
            continue;
          }
          const sessionId = entry.sessionId?.trim().toLowerCase() ?? "";
          if (
            isProtectedSessionKey(sessionKey, params.protection) ||
            (sessionId && params.protection.activeSessionIds.has(sessionId)) ||
            entry.status === "running" ||
            entry.acp?.state === "running"
          ) {
            result.skippedActive += 1;
            continue;
          }
          // Entries without a real updatedAt have unknown age; archiving
          // them on a first boot sweep of a legacy store would be guesswork.
          // (<= 0 also covers store loaders that default missing values.)
          if (
            typeof entry.updatedAt !== "number" ||
            !Number.isFinite(entry.updatedAt) ||
            entry.updatedAt <= 0
          ) {
            continue;
          }
          if (entry.updatedAt >= cutoff) {
            continue;
          }
          if (target === "cron") {
            if (isStableCronSessionKey(sessionKey)) {
              relocateCronSessionEntryInStore({
                store: store as never,
                stableKey: sessionKey,
                nowMs: now,
                idempotencyId: `ttl:${entry.sessionId}:${cutoff}`,
                expectedSessionId: entry.sessionId,
              });
            } else {
              if (entry.archivedAt) {
                continue;
              }
              entry.archivedAt ??= now;
            }
            result.pruned += 1;
            result.prunedByTarget.cron += 1;
            continue;
          }
          if (entry.sessionId) {
            const safeSessionFile = resolveSafeSessionFile(entry);
            const removedKey = entry.sessionId.trim().toLowerCase();
            if (!removedSessions.has(removedKey) || safeSessionFile) {
              removedSessions.set(removedKey, safeSessionFile);
            }
          }
          delete store[sessionKey];
          result.pruned += 1;
          result.prunedByTarget[target] += 1;
        }
        referencedSessionIds = new Set(
          Object.values(store)
            .map((entry) => entry?.sessionId?.trim().toLowerCase())
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
        );
      },
      { skipMaintenance: true },
    );
  } catch (err) {
    // A failed store update does NOT record a sweep — retry next tick.
    params.logger?.warn?.(
      `session-archive: sweep failed for ${storePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return emptySweepResult(false);
  }
  lastSweepAtMsByStore.set(storePath, now);
  if (config.archiveTranscripts && removedSessions.size > 0) {
    try {
      // Core's archiver owns naming, the store-dir restriction, primary-name
      // hardening (never sessions.json / archive artifacts), AND the
      // transcript-update emit that keeps memory/history indexes fresh — a
      // raw fs.rename here would reintroduce the stale reset-archive index
      // regression core's own comments document.
      const archivedDirs = await archiveRemovedSessionTranscripts({
        removedSessionFiles: removedSessions.entries(),
        referencedSessionIds,
        storePath,
        reason: "deleted",
        restrictToStoreDir: true,
      });
      result.archivedTranscripts = archivedDirs.size > 0 ? removedSessions.size : 0;
    } catch (err) {
      params.logger?.warn?.(
        `session-archive: transcript archive failed for ${storePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (result.pruned > 0) {
    params.logger?.info?.(
      `session-archive: archived ${result.pruned} generated session(s) ` +
        `archivedTranscripts=${result.archivedTranscripts} skippedActive=${result.skippedActive} ` +
        `retentionMs=${config.retentionMs} targets=${config.targets.join(",")} ` +
        `prunedByTarget=cron:${result.prunedByTarget.cron},subagent:${result.prunedByTarget.subagent},isolated:${result.prunedByTarget.isolated}`,
    );
  }
  return result;
}

type SessionStoreDiscoveryConfig = {
  session?: { store?: string };
  cron?: { store?: string };
};

export function resolveGeneratedSessionStorePaths(params: {
  config: SessionStoreDiscoveryConfig;
  agentIds: readonly string[];
}): string[] {
  const template = params.config.session?.store;
  const paths = params.agentIds.map((agentId) => resolveStorePath(template, { agentId }));
  return [...new Set(paths)];
}

export type SessionArchiveServiceContext = {
  config: SessionStoreDiscoveryConfig;
  stateDir: string;
  logger?: PluginLoggerLike;
};

type SubagentProtectionReader = () => string[];

/** Creates the background sweep service registered via api.registerService. */
export function createSessionArchiveService(
  config: SessionArchiveConfig,
  deps?: {
    readProtectedSubagentSessionKeys?: SubagentProtectionReader;
    getConversationScheduler?: typeof getRuntimeConversationScheduler;
  },
): {
  id: string;
  start: (ctx: SessionArchiveServiceContext) => Promise<void> | void;
  stop: () => void;
} {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const readProtectedSubagentSessionKeys =
    deps?.readProtectedSubagentSessionKeys ?? listArchiveProtectedSubagentSessionKeys;
  const getConversationScheduler =
    deps?.getConversationScheduler ?? getRuntimeConversationScheduler;

  const tick = async (ctx: SessionArchiveServiceContext, force: boolean): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      const agentIds = listAgentIds(ctx.config as never);
      // ~-expansion + default resolution match core cron-store ownership.
      const cronStorePath = resolveCronStorePath(config.cronStore ?? ctx.config.cron?.store);
      for (const storePath of resolveGeneratedSessionStorePaths({
        config: ctx.config,
        agentIds,
      })) {
        // Protection re-derives PER STORE SWEEP (not once per tick): a cron
        // job or subagent started after a snapshot must not be archivable by
        // the remaining stores' sweeps.
        const cron = await resolveCronSweepProtection({
          cronStorePath,
          agentIds,
          logger: ctx.logger,
        });
        const scheduler = getConversationScheduler();
        let schedulerCronKeys: string[] = [];
        if (!scheduler) {
          cron.unavailable = true;
        } else {
          try {
            const snapshot = await scheduler.snapshot();
            if (!snapshot.storageHealthy) {
              cron.unavailable = true;
            } else {
              schedulerCronKeys = snapshot.lanes
                .filter((lane) => lane.outstandingCount > 0 && lane.producerKinds.includes("cron"))
                .map((lane) => lane.sessionKey.trim().toLowerCase());
            }
          } catch {
            cron.unavailable = true;
          }
        }
        let subagentKeys: string[] = [];
        let subagentProtectionUnavailable = false;
        try {
          // Registry-fed: live runs, parked completion owners, and sticky
          // failed_orphaned rows (their archiveAtMs sweeper owns lifecycle).
          subagentKeys = readProtectedSubagentSessionKeys();
        } catch (err) {
          subagentProtectionUnavailable = true;
          ctx.logger?.warn?.(
            `session-archive: subagent registry read failed; failing closed for subagent-classified sessions this sweep: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        const protection: SweepProtection = {
          activeSessionKeys: new Set(
            [
              ...cron.keys,
              ...schedulerCronKeys,
              ...subagentKeys.map((key) => key.trim().toLowerCase()),
            ].filter(Boolean),
          ),
          activeSessionKeyPrefixes: cron.prefixes,
          activeSessionIds: new Set<string>(),
          cronProtectionUnavailable: cron.unavailable,
          subagentProtectionUnavailable,
        };
        await sweepGeneratedSessions({
          storePath,
          config,
          protection,
          force,
          logger: ctx.logger,
        });
      }
    } finally {
      running = false;
    }
  };

  return {
    id: "session-archive",
    start: (ctx) => {
      if (!config.enabled || config.retentionMs === null) {
        for (const reason of config.disabledReasons) {
          ctx.logger?.warn?.(`session-archive: INERT — ${reason}`);
        }
        return;
      }
      // Service start runs one forced sweep immediately; the per-store
      // 5-minute effective gap throttles the recurring timer.
      void tick(ctx, true).catch((err: unknown) => {
        ctx.logger?.warn?.(
          `session-archive: initial sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      timer = setInterval(() => {
        void tick(ctx, false).catch((err: unknown) => {
          ctx.logger?.warn?.(
            `session-archive: sweep tick failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }, config.intervalMs);
      timer.unref?.();
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
