/** Stable host metadata for one scheduler-owned conversational batch. */
export type QueueBatchIdentity = {
  version: 1;
  routeKey: string;
  /** Ordered source ids; order is part of the materialized batch identity. */
  sourceMessageIds: string[];
  /** Native image refs attached by the host for this batch. */
  nativeImageCount: number;
};

export function buildQueueBatchIdentity(params: {
  routeKey: string;
  sourceMessageIds: readonly string[];
  nativeImageCount: number;
}): QueueBatchIdentity | undefined {
  return normalizeQueueBatchIdentity({ version: 1, ...params });
}

export function mergeQueueBatchIdentities(
  identities: readonly (QueueBatchIdentity | undefined)[],
): QueueBatchIdentity | undefined {
  if (identities.length === 0 || identities.some((identity) => !identity)) {
    return undefined;
  }
  const complete = identities as QueueBatchIdentity[];
  const routeKey = complete[0]?.routeKey;
  if (!routeKey || complete.some((identity) => identity.routeKey !== routeKey)) {
    return undefined;
  }
  return buildQueueBatchIdentity({
    routeKey,
    sourceMessageIds: complete.flatMap((identity) => identity.sourceMessageIds),
    nativeImageCount: complete.reduce((total, identity) => total + identity.nativeImageCount, 0),
  });
}

/** Validates untrusted or replayed metadata before it controls dedupe. */
export function normalizeQueueBatchIdentity(value: unknown): QueueBatchIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const routeKey = typeof record.routeKey === "string" ? record.routeKey.trim() : "";
  const sourceMessageIds = Array.isArray(record.sourceMessageIds)
    ? record.sourceMessageIds.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    : [];
  if (
    record.version !== 1 ||
    !routeKey ||
    sourceMessageIds.length === 0 ||
    sourceMessageIds.some((entry) => !entry) ||
    typeof record.nativeImageCount !== "number" ||
    !Number.isSafeInteger(record.nativeImageCount) ||
    record.nativeImageCount < 0
  ) {
    return undefined;
  }
  return {
    version: 1,
    routeKey,
    sourceMessageIds,
    nativeImageCount: record.nativeImageCount,
  };
}
