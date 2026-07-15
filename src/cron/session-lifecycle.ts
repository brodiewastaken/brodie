import { updateSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";

export type { CronSessionArchiveReceipt } from "../config/sessions/types.js";

export function isStableCronSessionKey(sessionKey: string): boolean {
  return /^agent:[^:]+:cron:[^:]+$/i.test(sessionKey.trim());
}

function resolveCronRunSessionKey(stableKey: string, entry: SessionEntry): string {
  const retainedKey = entry.cronRunSessionKey?.trim();
  if (!retainedKey) {
    return `${stableKey}:run:${entry.sessionId}`;
  }
  if (!retainedKey.startsWith(`${stableKey}:run:`)) {
    throw new Error(`cron run session key does not belong to stable session: ${stableKey}`);
  }
  return retainedKey;
}

export function findLatestCronSessionArchiveInStore(params: {
  store: Record<string, SessionEntry | undefined>;
  stableKey: string;
  idempotencyPrefix?: string;
}): { archivedKey: string; entry: SessionEntry } | undefined {
  const stableKey = params.stableKey.trim();
  let latest: { archivedKey: string; entry: SessionEntry } | undefined;
  for (const [archivedKey, entry] of Object.entries(params.store)) {
    const receipt = entry?.cronArchiveReceipt;
    if (
      !entry ||
      receipt?.stableKey !== stableKey ||
      receipt.archivedKey !== archivedKey ||
      receipt.sessionId !== entry.sessionId ||
      (params.idempotencyPrefix && !receipt.idempotencyId.startsWith(params.idempotencyPrefix))
    ) {
      continue;
    }
    if (!latest || (entry.archivedAt ?? 0) > (latest.entry.archivedAt ?? 0)) {
      latest = { archivedKey, entry };
    }
  }
  return latest;
}

export function relocateCronSessionEntryInStore(params: {
  store: Record<string, SessionEntry | undefined>;
  stableKey: string;
  nowMs: number;
  idempotencyId: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
}): { archivedKey: string; entry: SessionEntry; relocated: boolean } {
  const stableKey = params.stableKey.trim();
  if (!isStableCronSessionKey(stableKey)) {
    throw new Error(`cron archive requires a stable cron session key: ${stableKey}`);
  }
  const entry = params.store[stableKey];
  if (!entry?.sessionId) {
    if (params.expectedSessionId) {
      for (const [archivedKey, archivedEntry] of Object.entries(params.store)) {
        const receipt = archivedEntry?.cronArchiveReceipt;
        if (
          archivedEntry?.sessionId === params.expectedSessionId &&
          receipt?.stableKey === stableKey &&
          receipt.archivedKey === archivedKey &&
          receipt.idempotencyId === params.idempotencyId
        ) {
          return { archivedKey, entry: archivedEntry, relocated: false };
        }
      }
    }
    throw new Error(`cron session not found: ${stableKey}`);
  }
  if (params.expectedSessionId && entry.sessionId !== params.expectedSessionId) {
    throw new Error(`cron session changed before archive: ${stableKey}`);
  }
  if (
    params.expectedLifecycleRevision &&
    entry.lifecycleRevision !== params.expectedLifecycleRevision
  ) {
    throw new Error(`cron session lifecycle changed before archive: ${stableKey}`);
  }
  const archivedKey = resolveCronRunSessionKey(stableKey, entry);
  const existing = params.store[archivedKey];
  const priorReceipt = existing?.cronArchiveReceipt;
  if (existing) {
    if (
      priorReceipt?.idempotencyId === params.idempotencyId &&
      priorReceipt.stableKey === stableKey &&
      priorReceipt.sessionId === entry.sessionId
    ) {
      delete params.store[stableKey];
      return { archivedKey, entry: existing, relocated: false };
    }
    const ownsActiveRunAlias =
      entry.lifecycleRevision !== undefined &&
      existing.sessionId === entry.sessionId &&
      existing.lifecycleRevision === entry.lifecycleRevision &&
      existing.archivedAt === undefined &&
      existing.cronArchiveReceipt === undefined;
    if (!ownsActiveRunAlias) {
      throw new Error(`cron archive destination already exists: ${archivedKey}`);
    }
  }
  const archivedAt = entry.archivedAt ?? params.nowMs;
  const archivedEntry: SessionEntry = {
    ...entry,
    archivedAt,
    cronArchiveReceipt: {
      version: 1,
      stableKey,
      archivedKey,
      sessionId: entry.sessionId,
      idempotencyId: params.idempotencyId,
      archivedAt,
    },
  };
  params.store[archivedKey] = archivedEntry;
  delete params.store[stableKey];
  return { archivedKey, entry: archivedEntry, relocated: true };
}

export async function archiveCronSessionGeneration(params: {
  storePath: string;
  stableKey: string;
  nowMs?: number;
  idempotencyId: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
}): Promise<{ archivedKey: string; entry: SessionEntry; relocated: boolean }> {
  return await updateSessionStore(
    params.storePath,
    (store) =>
      relocateCronSessionEntryInStore({
        store,
        stableKey: params.stableKey,
        nowMs: params.nowMs ?? Date.now(),
        idempotencyId: params.idempotencyId,
        expectedSessionId: params.expectedSessionId,
        expectedLifecycleRevision: params.expectedLifecycleRevision,
      }),
    { skipMaintenance: true },
  );
}
