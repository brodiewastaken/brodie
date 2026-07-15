// Memory Core plugin module persists targeted QMD session-export work.
import crypto from "node:crypto";
import path from "node:path";
import {
  memoryCoreWorkspaceEntryKey,
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
  readMemoryCoreWorkspaceEntries,
} from "../dreaming-state.js";

export const QMD_SESSION_EXPORT_DIRTY_NAMESPACE = "qmd-session-export-dirty";
export const QMD_SESSION_EXPORT_BASELINE_NAMESPACE = "qmd-session-export-baseline";
export const QMD_SESSION_EXPORT_BASELINE_FORMAT_VERSION = 1;
const QMD_SESSION_EXPORT_DIRTY_BUCKET_COUNT = 256;
const QMD_SESSION_EXPORT_DIRTY_ITEMS_PER_BUCKET = 16;
let lastDirtyEntryAtMs = 0;

export type QmdSessionExportDirtyOperation = "upsert" | "delete";

export type QmdSessionExportDirtyEntry = {
  version: 1;
  generation: string;
  agentId: string;
  sessionFile: string;
  operation: QmdSessionExportDirtyOperation;
  updatedAtMs: number;
};

export type QmdSessionExportDirtyWork = QmdSessionExportDirtyEntry & {
  clearItems: Array<{ bucketKey: string; itemKey: string; generation: string }>;
};

type QmdSessionExportDirtyBucket = {
  version: 1;
  workspaceKey: string;
  items: Record<string, QmdSessionExportDirtyEntry>;
};

type QmdSessionExportBaselineState = {
  version: 1;
  workspaceKey: string;
  workspaceDir: string;
  key: string;
  value: QmdSessionExportBaseline;
};

export type QmdSessionExportBaseline = {
  version: 1;
  generation: string;
  formatVersion: number;
  collectionName: string;
  lastFullReconcileAtMs: number;
  requiresFullReconcile: boolean;
};

function store(workspaceDir: string) {
  return openMemoryCoreStateStore<QmdSessionExportDirtyBucket>({
    // A safe path-segment namespace gives each workspace an independent fixed
    // 256 x 16 dirty-set budget. One workspace cannot consume another's rows.
    namespace: `${QMD_SESSION_EXPORT_DIRTY_NAMESPACE}-${memoryCoreWorkspaceStateKey(workspaceDir)}`,
    maxEntries: QMD_SESSION_EXPORT_DIRTY_BUCKET_COUNT,
    overflowPolicy: "reject-new",
  });
}

function baselineStore() {
  return openMemoryCoreStateStore<QmdSessionExportBaselineState>({
    namespace: QMD_SESSION_EXPORT_BASELINE_NAMESPACE,
    maxEntries: 50_000,
  });
}

function itemKey(agentId: string, sessionFile: string): string {
  return `${agentId}\u0000${sessionFile}`;
}

function bucketIndex(item: string, probe: number): number {
  return (
    (crypto.createHash("sha256").update(item).digest().readUInt16BE(0) + probe) %
    QMD_SESSION_EXPORT_DIRTY_BUCKET_COUNT
  );
}

function bucketKey(workspaceDir: string, bucket: number): string {
  return memoryCoreWorkspaceEntryKey(workspaceDir, `qmd-session-export-bucket:${bucket}`);
}

function isEntryForScope(
  value: unknown,
  params: { agentId: string },
): value is QmdSessionExportDirtyEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Partial<QmdSessionExportDirtyEntry>;
  return (
    entry.version === 1 &&
    typeof entry.generation === "string" &&
    entry.generation.length > 0 &&
    entry.agentId === params.agentId &&
    typeof entry.sessionFile === "string" &&
    (entry.operation === "upsert" || entry.operation === "delete") &&
    Number.isFinite(entry.updatedAtMs)
  );
}

function isBucketForWorkspace(
  value: unknown,
  workspaceKey: string,
): value is QmdSessionExportDirtyBucket {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as Partial<QmdSessionExportDirtyBucket>).version === 1 &&
    (value as Partial<QmdSessionExportDirtyBucket>).workspaceKey === workspaceKey &&
    typeof (value as Partial<QmdSessionExportDirtyBucket>).items === "object"
  );
}

export async function queueQmdSessionExportDirtyEntry(params: {
  workspaceDir: string;
  agentId: string;
  sessionFile: string;
  operation: QmdSessionExportDirtyOperation;
}): Promise<void> {
  const sessionFile = path.resolve(params.sessionFile);
  const item = itemKey(params.agentId, sessionFile);
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir);
  const updatedAtMs = Math.max(Date.now(), lastDirtyEntryAtMs + 1);
  lastDirtyEntryAtMs = updatedAtMs;
  const dirtyStore = store(params.workspaceDir);
  const update = dirtyStore.update;
  if (!update) {
    throw new Error("qmd dirty session export requires atomic plugin-state updates");
  }
  for (let probe = 0; probe < QMD_SESSION_EXPORT_DIRTY_BUCKET_COUNT; probe += 1) {
    const key = bucketKey(params.workspaceDir, bucketIndex(item, probe));
    const current = await dirtyStore.lookup(key);
    if (
      !isBucketForWorkspace(current, workspaceKey) ||
      current.items[item] ||
      Object.keys(current.items).length < QMD_SESSION_EXPORT_DIRTY_ITEMS_PER_BUCKET
    ) {
      let wrote = false;
      await update(key, (latest) => {
        const bucket = isBucketForWorkspace(latest, workspaceKey)
          ? latest
          : { version: 1 as const, workspaceKey, items: {} };
        if (
          !bucket.items[item] &&
          Object.keys(bucket.items).length >= QMD_SESSION_EXPORT_DIRTY_ITEMS_PER_BUCKET
        ) {
          return latest;
        }
        wrote = true;
        return {
          ...bucket,
          items: {
            ...bucket.items,
            [item]: {
              version: 1,
              generation: crypto.randomUUID(),
              agentId: params.agentId,
              sessionFile,
              operation: params.operation,
              updatedAtMs,
            },
          },
        };
      });
      if (wrote) {
        return;
      }
    }
  }
  throw new Error("qmd dirty session export capacity exceeded");
}

export async function readQmdSessionExportDirtyEntries(params: {
  workspaceDir: string;
  agentId: string;
}): Promise<QmdSessionExportDirtyWork[]> {
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir);
  return (await store(params.workspaceDir).entries())
    .flatMap((bucket) =>
      isBucketForWorkspace(bucket.value, workspaceKey)
        ? Object.entries(bucket.value.items).flatMap(([item, value]) =>
            isEntryForScope(value, params)
              ? [
                  {
                    ...value,
                    clearItems: [
                      { bucketKey: bucket.key, itemKey: item, generation: value.generation },
                    ],
                  },
                ]
              : [],
          )
        : [],
    )
    .toSorted(
      (left, right) =>
        left.updatedAtMs - right.updatedAtMs || left.sessionFile.localeCompare(right.sessionFile),
    );
}

export async function clearQmdSessionExportDirtyEntry(params: {
  workspaceDir: string;
  clearItems: Array<{ bucketKey: string; itemKey: string; generation: string }>;
}): Promise<void> {
  const update = store(params.workspaceDir).update;
  if (!update) {
    throw new Error("qmd dirty session export requires atomic plugin-state updates");
  }
  await Promise.all(
    params.clearItems.map(async ({ bucketKey: key, itemKey: item, generation }) => {
      await update(key, (current) => {
        if (!current || current.items[item]?.generation !== generation) {
          return current;
        }
        const { [item]: _removed, ...items } = current.items;
        return { ...current, items };
      });
    }),
  );
}

function baselineKey(agentId: string): string {
  return `qmd-session-export-baseline:${agentId}`;
}

function isCurrentBaseline(
  value: unknown,
  params: { collectionName: string },
): value is QmdSessionExportBaseline {
  if (!value || typeof value !== "object") {
    return false;
  }
  const baseline = value as Partial<QmdSessionExportBaseline>;
  return (
    baseline.version === 1 &&
    typeof baseline.generation === "string" &&
    baseline.generation.length > 0 &&
    baseline.formatVersion === QMD_SESSION_EXPORT_BASELINE_FORMAT_VERSION &&
    baseline.collectionName === params.collectionName &&
    typeof baseline.lastFullReconcileAtMs === "number" &&
    Number.isFinite(baseline.lastFullReconcileAtMs) &&
    typeof baseline.requiresFullReconcile === "boolean"
  );
}

/**
 * A baseline is deliberately a logical index-format marker, not filesystem state.
 * Bumping the format version forces one durable full repair after a mapping/index
 * contract changes, while ordinary restarts retain the incremental path.
 */
export async function hasQmdSessionExportBaseline(params: {
  workspaceDir: string;
  agentId: string;
  collectionName: string;
}): Promise<boolean> {
  return (await readQmdSessionExportBaseline(params)) !== null;
}

export async function readQmdSessionExportBaseline(params: {
  workspaceDir: string;
  agentId: string;
  collectionName: string;
}): Promise<QmdSessionExportBaseline | null> {
  const key = baselineKey(params.agentId);
  const entries = await readMemoryCoreWorkspaceEntries<unknown>({
    namespace: QMD_SESSION_EXPORT_BASELINE_NAMESPACE,
    workspaceDir: params.workspaceDir,
  });
  const entry = entries.find(
    (candidate) => candidate.key === key && isCurrentBaseline(candidate.value, params),
  );
  return entry && isCurrentBaseline(entry.value, params) ? entry.value : null;
}

export async function writeQmdSessionExportBaseline(params: {
  workspaceDir: string;
  agentId: string;
  collectionName: string;
  lastFullReconcileAtMs?: number;
  requiresFullReconcile?: boolean;
  expectedGeneration?: string | null;
}): Promise<boolean> {
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir);
  const key = baselineKey(params.agentId);
  const stateKey = memoryCoreWorkspaceEntryKey(params.workspaceDir, key);
  const next: QmdSessionExportBaseline = {
    version: 1,
    generation: crypto.randomUUID(),
    formatVersion: QMD_SESSION_EXPORT_BASELINE_FORMAT_VERSION,
    collectionName: params.collectionName,
    lastFullReconcileAtMs: params.lastFullReconcileAtMs ?? Date.now(),
    requiresFullReconcile: params.requiresFullReconcile ?? false,
  };
  const update = baselineStore().update;
  if (!update) {
    throw new Error("qmd session export baseline requires atomic plugin-state updates");
  }
  let wrote = false;
  await update(stateKey, (current) => {
    const rawBaseline =
      current?.version === 1 && current.workspaceKey === workspaceKey && current.key === key
        ? current.value
        : null;
    const baseline = isCurrentBaseline(rawBaseline, params) ? rawBaseline : null;
    if (
      params.expectedGeneration !== undefined &&
      (baseline?.generation ?? null) !== params.expectedGeneration
    ) {
      return current;
    }
    wrote = true;
    return {
      version: 1,
      workspaceKey,
      workspaceDir: path.resolve(params.workspaceDir),
      key,
      value: next,
    };
  });
  return wrote;
}

/** Records an overflow repair obligation in a separate bounded state record. */
export async function markQmdSessionExportFullReconcileRequired(params: {
  workspaceDir: string;
  agentId: string;
  collectionName: string;
  expectedGeneration?: string | null;
}): Promise<QmdSessionExportBaseline | null> {
  const current = await readQmdSessionExportBaseline(params);
  const wrote = await writeQmdSessionExportBaseline({
    ...params,
    lastFullReconcileAtMs: current?.lastFullReconcileAtMs ?? 0,
    requiresFullReconcile: true,
    expectedGeneration: params.expectedGeneration ?? current?.generation,
  });
  return wrote ? await readQmdSessionExportBaseline(params) : null;
}
