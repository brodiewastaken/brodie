import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { sql, type Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { ConversationRoute } from "../routing/conversation-route.js";
import type {
  ConversationSchedulerEvents,
  DB as OpenClawStateKyselyDatabase,
} from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type SchedulerProducerKind =
  | "human_message"
  | "human_media"
  | "human_reaction"
  | "human_edit"
  | "human_deletion"
  | "human_reply"
  | "human_forward"
  | "human_location"
  | "subagent_completion"
  | "subagent_interruption"
  | "subagent_timeout"
  | "subagent_failure"
  | "heartbeat"
  | "cron"
  | "exec_completion"
  | "media_generation_completion"
  | "sessions_send"
  | "hook"
  | "node"
  | "restart"
  | "recovery"
  | "system"
  | "operator"
  | "talk"
  | "voice";

export type ScheduledEvent = {
  id: string;
  route: ConversationRoute;
  producerKind: SchedulerProducerKind;
  createdAt: number;
  human: boolean;
  media: boolean;
  payload: JsonValue;
};

export type AdmissionResult =
  | {
      accepted: true;
      receiptId: string;
      durableAt: number;
      existingState?: SchedulerEventState;
    }
  | { accepted: false; reason: "disabled" | "invalid" | "storage_failed" };

export type SchedulerEventState =
  | "pending"
  | "reserved"
  | "dispatching"
  | "running"
  | "delivered"
  | "failed"
  | "storage_error"
  | "cancelled";

export type SchedulerSnapshot = {
  storageHealthy: boolean;
  lanes: Array<{
    queueLaneKey: string;
    sessionKey: string;
    pendingCount: number;
    outstandingCount: number;
    producerKinds: SchedulerProducerKind[];
    readyAt?: number;
    failureCount: number;
    activeState?: SchedulerEventState;
    callbackPendingCount: number;
    dispatchAttemptIds: string[];
    runCorrelationIds: string[];
  }>;
};

export interface ConversationScheduler {
  admit(event: ScheduledEvent): Promise<AdmissionResult>;
  /** Waits until durable reconciliation gives a receipt a terminal state. */
  waitForReceiptTerminal?(receiptId: string): Promise<SchedulerEventState | undefined>;
  /** Re-check every durable pending lane after runtime producer registration. */
  drain(): Promise<void>;
  settle(
    receiptId: string,
    result: Exclude<SchedulerDispatchResult, { outcome: "pending" }>,
  ): Promise<boolean>;
  noteTyping(route: ConversationRoute): Promise<boolean>;
  stopSession(route: ConversationRoute, options: { descendants: boolean }): Promise<void>;
  snapshot(route?: ConversationRoute): Promise<SchedulerSnapshot>;
  retryFailed(route: ConversationRoute): Promise<void>;
}

export type SchedulerDispatchBatch = {
  attemptId: string;
  placement: "idle" | "recovery";
  events: ReadonlyArray<ScheduledEvent & { receiptId: string; sequence: number }>;
  /** Durably joins human arrivals to this active attempt at a post-tool boundary. */
  claimMidTurnHumanEvents?: () => Promise<
    ReadonlyArray<ScheduledEvent & { receiptId: string; sequence: number }>
  >;
  /** Returns a rejected mid-turn claim to the lane without losing its order. */
  releaseMidTurnHumanEvents?: (eventIds: ReadonlyArray<string>) => Promise<void>;
  /** Persists the real runtime run id before dispatch performs external work. */
  recordRunCorrelationId?: (runCorrelationId: string) => void;
  /** Persists that model execution crossed its side-effect boundary. */
  recordRunStarted?: (transcriptEvidence: string) => void;
  /** Persists a terminal conversational outcome before dispatch returns. */
  recordRunTerminalOutcome?: (
    outcome: "sent" | "reacted" | "deliberate_silence" | "implicit_silence" | "completed",
    transcriptEvidence: string,
  ) => void;
};

export type SchedulerDispatchResult =
  | {
      outcome: "pending";
      runCorrelationId: string;
    }
  | {
      outcome: "sent" | "reacted" | "deliberate_silence" | "implicit_silence" | "completed";
      transcriptEvidence: string;
      runCorrelationId?: string;
    }
  | {
      outcome: "failed" | "partial_delivery";
      failure: JsonValue;
      transcriptEvidence?: string;
      runCorrelationId?: string;
    };

export type SchedulerInterruptedAttempt = {
  attemptId: string;
  laneKey: string;
  runCorrelationId?: string;
  transcriptEvidence?: string;
  events: ReadonlyArray<ScheduledEvent & { receiptId: string; sequence: number }>;
};

export type SchedulerInterruptedAttemptReconciliation =
  | { status: "live" }
  | {
      status: "delivered";
      transcriptEvidence: string;
      runCorrelationId?: string;
    }
  | { status: "replayable"; evidence: JsonValue }
  | { status: "retryable"; evidence: JsonValue }
  | { status: "unresolved" };

export type SchedulerSettlement = {
  event: ScheduledEvent & { receiptId: string; sequence: number };
  transcriptEvidence: string;
  runCorrelationId?: string;
};

type SchedulerOptions = {
  enabled?: boolean;
  database?: OpenClawStateDatabaseOptions;
  maxRows?: number;
  maxBytes?: number;
  now?: () => number;
  resolveDebounceMs?: (event: ScheduledEvent) => number;
  shouldDispatch?: (event: ScheduledEvent) => boolean;
  dispatch?: (batch: SchedulerDispatchBatch) => Promise<SchedulerDispatchResult>;
  reconcileInterruptedAttempt?: (
    attempt: SchedulerInterruptedAttempt,
  ) => Promise<SchedulerInterruptedAttemptReconciliation>;
  reconcileIntervalMs?: number;
  settleCallback?: (settlement: SchedulerSettlement) => Promise<void>;
  onStorageError?: (error: unknown, route?: ConversationRoute) => void;
};

type SchedulerDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "conversation_scheduler_events" | "conversation_scheduler_lanes"
>;
type EventRow = Omit<Selectable<ConversationSchedulerEvents>, "state"> & {
  state: SchedulerEventState;
};

type SnapshotRow = Pick<
  EventRow,
  | "lane_key"
  | "session_key"
  | "producer_kind"
  | "ready_at"
  | "state"
  | "callback_state"
  | "dispatch_attempt_id"
  | "run_correlation_id"
>;

type Reservation = {
  laneKey: string;
  attemptId: string;
  placement: "idle" | "recovery";
  rows: EventRow[];
};

const ACTIVE_STATES = ["reserved", "dispatching", "running"] as const;
const SUCCESS_OUTCOMES = new Set<SchedulerDispatchResult["outcome"]>([
  "sent",
  "reacted",
  "deliberate_silence",
  "implicit_silence",
  "completed",
]);
const DEFAULT_RECONCILE_INTERVAL_MS = 1_000;
const DISPATCH_PENDING_FAILURE_JSON = JSON.stringify({ kind: "dispatch_pending" });
const RECEIPT_LOCAL_PRODUCER_KINDS = new Set<SchedulerProducerKind>([
  "subagent_completion",
  "subagent_interruption",
  "subagent_timeout",
  "subagent_failure",
  "sessions_send",
  "operator",
  "talk",
  "voice",
]);

class KeyedCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}

function normalizeJson(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("scheduler payload contains a non-finite number");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`scheduler payload contains unsupported ${typeof value}`);
  }
  if (seen.has(value)) {
    throw new Error("scheduler payload contains a cycle");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeJson(entry, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("scheduler payload contains a class instance");
    }
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = normalizeJson(entry, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function defaultDebounceMs(event: ScheduledEvent): number {
  if (!event.human) {
    return 0;
  }
  if (event.media) {
    return 6_900;
  }
  return event.route.conversationKind === "direct" ? 0 : 4_200;
}

function schedulerDatabase(db: DatabaseSync) {
  return getNodeSqliteKysely<SchedulerDatabase>(db);
}

function affectedRows(result: { numAffectedRows?: bigint }): number {
  return Number(result.numAffectedRows ?? 0n);
}

function queryCapacity(db: DatabaseSync): { rows: number; bytes: number } {
  const rows = executeSqliteQuerySync(
    db,
    schedulerDatabase(db)
      .selectFrom("conversation_scheduler_events")
      .select("payload_bytes")
      .where("state", "not in", ["delivered", "cancelled"]),
  ).rows;
  return {
    rows: rows.length,
    bytes: rows.reduce((total, row) => total + row.payload_bytes, 0),
  };
}

function snapshotFromRows(rows: SnapshotRow[], storageHealthy: boolean): SchedulerSnapshot {
  const lanes = new Map<string, SchedulerSnapshot["lanes"][number]>();
  for (const row of rows) {
    const lane = lanes.get(row.lane_key) ?? {
      queueLaneKey: row.lane_key,
      sessionKey: row.session_key,
      pendingCount: 0,
      outstandingCount: 0,
      producerKinds: [],
      failureCount: 0,
      callbackPendingCount: 0,
      dispatchAttemptIds: [],
      runCorrelationIds: [],
    };
    if (row.state === "pending" || row.state === "storage_error" || row.state === "failed") {
      lane.pendingCount += 1;
      lane.readyAt =
        lane.readyAt === undefined ? row.ready_at : Math.min(lane.readyAt, row.ready_at);
    }
    if (!["delivered", "failed", "cancelled"].includes(row.state)) {
      lane.outstandingCount += 1;
    }
    if (row.state === "failed" || row.state === "storage_error") {
      lane.failureCount += 1;
    }
    if (ACTIVE_STATES.includes(row.state as (typeof ACTIVE_STATES)[number])) {
      lane.activeState = row.state;
    }
    if (row.callback_state === "pending") {
      lane.callbackPendingCount += 1;
    }
    const kind = row.producer_kind as SchedulerProducerKind;
    if (!lane.producerKinds.includes(kind)) {
      lane.producerKinds.push(kind);
    }
    if (row.dispatch_attempt_id && !lane.dispatchAttemptIds.includes(row.dispatch_attempt_id)) {
      lane.dispatchAttemptIds.push(row.dispatch_attempt_id);
    }
    if (row.run_correlation_id && !lane.runCorrelationIds.includes(row.run_correlation_id)) {
      lane.runCorrelationIds.push(row.run_correlation_id);
    }
    lanes.set(row.lane_key, lane);
  }
  return { storageHealthy, lanes: [...lanes.values()] };
}

function rowToEvent(row: EventRow): ScheduledEvent & { receiptId: string; sequence: number } {
  return {
    id: row.event_id,
    route: JSON.parse(row.route_json) as ConversationRoute,
    producerKind: row.producer_kind as SchedulerProducerKind,
    createdAt: row.created_at,
    human: row.human === 1,
    media: row.media === 1,
    payload: JSON.parse(row.payload_json) as JsonValue,
    receiptId: row.receipt_id,
    sequence: row.sequence,
  };
}

function matchesDurableEventIdentity(params: {
  existing: Pick<EventRow, "route_json" | "producer_kind" | "human" | "media" | "payload_json">;
  event: ScheduledEvent;
  payload: JsonValue;
}): boolean {
  try {
    return (
      params.existing.producer_kind === params.event.producerKind &&
      params.existing.human === (params.event.human ? 1 : 0) &&
      params.existing.media === (params.event.media ? 1 : 0) &&
      isDeepStrictEqual(JSON.parse(params.existing.route_json), params.event.route) &&
      isDeepStrictEqual(JSON.parse(params.existing.payload_json), params.payload)
    );
  } catch {
    return false;
  }
}

class SqliteConversationScheduler implements ConversationScheduler {
  private readonly coordinator = new KeyedCoordinator();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reconciliationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly coldPendingGraceRemaining = new Map<string, number>();
  private callbackDrain: Promise<void> | undefined;
  private callbackDrainRequested = false;
  private storageHealthy = true;

  constructor(private readonly options: SchedulerOptions) {
    if (options.dispatch) {
      queueMicrotask(() => void this.rehydrate());
    }
  }

  async admit(event: ScheduledEvent): Promise<AdmissionResult> {
    if (this.options.enabled === false) {
      return { accepted: false, reason: "disabled" };
    }
    let payload: JsonValue;
    try {
      if (!event.id.trim() || !event.route.queueLaneKey.trim() || !event.route.sessionKey.trim()) {
        return { accepted: false, reason: "invalid" };
      }
      payload = normalizeJson(event.payload);
    } catch {
      return { accepted: false, reason: "invalid" };
    }
    const result = await this.coordinator.run(event.route.queueLaneKey, () => {
      try {
        const admitted = runOpenClawStateWriteTransaction(({ db }) => {
          const kysely = schedulerDatabase(db);
          const existing = executeSqliteQueryTakeFirstSync(
            db,
            kysely
              .selectFrom("conversation_scheduler_events")
              .select([
                "receipt_id",
                "durable_at",
                "state",
                "route_json",
                "producer_kind",
                "human",
                "media",
                "payload_json",
              ])
              .where("event_id", "=", event.id),
          );
          if (existing) {
            if (!matchesDurableEventIdentity({ existing, event, payload })) {
              return { accepted: false, reason: "invalid" } as const;
            }
            return {
              accepted: true,
              receiptId: existing.receipt_id,
              durableAt: existing.durable_at,
              existingState: existing.state as SchedulerEventState,
            } as const;
          }
          const payloadJson = JSON.stringify(payload);
          const capacity = queryCapacity(db);
          if (
            capacity.rows >= (this.options.maxRows ?? 10_000) ||
            capacity.bytes + Buffer.byteLength(payloadJson, "utf8") >
              (this.options.maxBytes ?? 64 * 1024 * 1024)
          ) {
            return { accepted: false, reason: "storage_failed" } as const;
          }
          const durableAt = this.options.now?.() ?? Date.now();
          const receiptId = randomUUID();
          const openHuman = event.human
            ? executeSqliteQueryTakeFirstSync(
                db,
                kysely
                  .selectFrom("conversation_scheduler_events")
                  .select("media")
                  .where("lane_key", "=", event.route.queueLaneKey)
                  .where("human", "=", 1)
                  .where("media", "=", 1)
                  .where("state", "in", ["pending", "failed"]),
              )
            : undefined;
          const stickyMedia = event.media || openHuman?.media === 1;
          const debounceEvent = stickyMedia ? { ...event, media: true } : event;
          const debounce = Math.max(
            0,
            this.options.resolveDebounceMs?.(debounceEvent) ?? defaultDebounceMs(debounceEvent),
          );
          const readyAt = durableAt + debounce;
          if (event.human) {
            executeSqliteQuerySync(
              db,
              kysely
                .updateTable("conversation_scheduler_events")
                .set({
                  state: "pending",
                  ready_at: readyAt,
                  revision: sql`revision + 1`,
                  updated_at: durableAt,
                })
                .where("lane_key", "=", event.route.queueLaneKey)
                .where("human", "=", 1)
                .where("state", "in", ["pending", "failed"]),
            );
          }
          executeSqliteQuerySync(
            db,
            kysely.insertInto("conversation_scheduler_events").values({
              event_id: event.id,
              receipt_id: receiptId,
              lane_key: event.route.queueLaneKey,
              session_key: event.route.sessionKey,
              route_json: JSON.stringify(event.route),
              producer_kind: event.producerKind,
              created_at: event.createdAt,
              durable_at: durableAt,
              human: event.human ? 1 : 0,
              media: stickyMedia ? 1 : 0,
              payload_json: payloadJson,
              payload_bytes: Buffer.byteLength(payloadJson, "utf8"),
              ready_at: readyAt,
              state: "pending",
              callback_state: "pending",
              updated_at: durableAt,
            }),
          );
          executeSqliteQuerySync(
            db,
            kysely
              .insertInto("conversation_scheduler_lanes")
              .values({ lane_key: event.route.queueLaneKey, revision: 1, updated_at: durableAt })
              .onConflict((conflict) =>
                conflict.column("lane_key").doUpdateSet({
                  revision: sql`conversation_scheduler_lanes.revision + 1`,
                  updated_at: durableAt,
                }),
              ),
          );
          return { accepted: true, receiptId, durableAt } as const;
        }, this.options.database);
        this.storageHealthy = true;
        return admitted;
      } catch (error) {
        this.noteStorageError(error, event.route);
        return { accepted: false, reason: "storage_failed" } as const;
      }
    });
    if (result.accepted && this.options.dispatch) {
      this.signalLane(event.route.queueLaneKey);
    }
    return result;
  }

  private async readReceiptState(receiptId: string): Promise<SchedulerEventState | undefined> {
    const normalizedReceiptId = receiptId.trim();
    if (!normalizedReceiptId) {
      return undefined;
    }
    try {
      const { db } = openOpenClawStateDatabase(this.options.database);
      const row = executeSqliteQueryTakeFirstSync(
        db,
        schedulerDatabase(db)
          .selectFrom("conversation_scheduler_events")
          .select("state")
          .where("receipt_id", "=", normalizedReceiptId),
      );
      this.storageHealthy = true;
      return row?.state as SchedulerEventState | undefined;
    } catch (error) {
      this.noteStorageError(error);
      return undefined;
    }
  }

  async waitForReceiptTerminal(receiptId: string): Promise<SchedulerEventState | undefined> {
    while (true) {
      const state = await this.readReceiptState(receiptId);
      if (
        state === undefined ||
        state === "delivered" ||
        state === "failed" ||
        state === "storage_error" ||
        state === "cancelled"
      ) {
        return state;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        timer.unref?.();
      });
    }
  }

  async drain(): Promise<void> {
    if (!this.options.dispatch && !this.options.settleCallback) {
      return;
    }
    try {
      if (this.options.dispatch) {
        const { db } = openOpenClawStateDatabase(this.options.database);
        const lanes = executeSqliteQuerySync(
          db,
          schedulerDatabase(db)
            .selectFrom("conversation_scheduler_events")
            .select("lane_key")
            .distinct()
            .where("state", "=", "pending"),
        ).rows;
        for (const row of lanes) {
          this.signalLane(row.lane_key);
        }
      }
      await this.retryPendingCallbacks();
      this.storageHealthy = true;
    } catch (error) {
      this.noteStorageError(error);
    }
  }

  async settle(
    receiptId: string,
    result: Exclude<SchedulerDispatchResult, { outcome: "pending" }>,
  ): Promise<boolean> {
    const normalizedReceiptId = receiptId.trim();
    if (!normalizedReceiptId) {
      return false;
    }
    let laneKey: string | undefined;
    try {
      const { db } = openOpenClawStateDatabase(this.options.database);
      laneKey = executeSqliteQueryTakeFirstSync(
        db,
        schedulerDatabase(db)
          .selectFrom("conversation_scheduler_events")
          .select("lane_key")
          .where("receipt_id", "=", normalizedReceiptId),
      )?.lane_key;
    } catch (error) {
      this.noteStorageError(error);
      return false;
    }
    if (!laneKey) {
      return false;
    }
    const settlement = await this.coordinator.run(laneKey, () => {
      try {
        const settled = runOpenClawStateWriteTransaction(({ db }) => {
          const kysely = schedulerDatabase(db);
          const row = executeSqliteQueryTakeFirstSync(
            db,
            kysely
              .selectFrom("conversation_scheduler_events")
              .select(["event_id", "state", "failure_json"])
              .where("receipt_id", "=", normalizedReceiptId),
          );
          if (!row || row.state === "cancelled") {
            return { settled: false, releasedActiveLane: false };
          }
          if (row.state === "delivered") {
            return {
              settled: SUCCESS_OUTCOMES.has(result.outcome),
              releasedActiveLane: false,
            };
          }
          const terminalizingPendingDispatch =
            row.state === "running" && row.failure_json === DISPATCH_PENDING_FAILURE_JSON;
          if (
            ACTIVE_STATES.includes(row.state as (typeof ACTIVE_STATES)[number]) &&
            !terminalizingPendingDispatch
          ) {
            return { settled: false, releasedActiveLane: false };
          }
          const now = this.options.now?.() ?? Date.now();
          const state = SUCCESS_OUTCOMES.has(result.outcome) ? "delivered" : "failed";
          const failure =
            "failure" in result ? JSON.stringify(normalizeJson(result.failure)) : null;
          const update = executeSqliteQuerySync(
            db,
            kysely
              .updateTable("conversation_scheduler_events")
              .set({
                state,
                run_correlation_id: result.runCorrelationId ?? null,
                transcript_evidence: result.transcriptEvidence ?? null,
                failure_json: failure,
                callback_state: state === "delivered" ? "pending" : "settled",
                revision: sql`revision + 1`,
                updated_at: now,
              })
              .where("receipt_id", "=", normalizedReceiptId)
              .where("state", "=", row.state),
          );
          if (affectedRows(update) !== 1) {
            return { settled: false, releasedActiveLane: false };
          }
          if (terminalizingPendingDispatch) {
            executeSqliteQuerySync(
              db,
              kysely
                .updateTable("conversation_scheduler_lanes")
                .set({ active_event_id: null, revision: sql`revision + 1`, updated_at: now })
                .where("lane_key", "=", laneKey)
                .where("active_event_id", "=", row.event_id),
            );
          }
          return { settled: true, releasedActiveLane: terminalizingPendingDispatch };
        }, this.options.database);
        this.storageHealthy = true;
        return settled;
      } catch (error) {
        this.noteStorageError(error);
        return { settled: false, releasedActiveLane: false };
      }
    });
    if (!settlement.settled) {
      return false;
    }
    if (settlement.releasedActiveLane) {
      this.clearReconciliationTimer(laneKey);
      this.signalLane(laneKey);
    }
    await this.retryPendingCallbacks();
    return true;
  }

  async stopSession(route: ConversationRoute, options: { descendants: boolean }): Promise<void> {
    let cancelledLaneKeys: string[] = [];
    await this.coordinator.run(route.queueLaneKey, () => {
      try {
        cancelledLaneKeys = runOpenClawStateWriteTransaction(({ db }) => {
          const now = this.options.now?.() ?? Date.now();
          const kysely = schedulerDatabase(db);
          const candidateRows = executeSqliteQuerySync(
            db,
            kysely
              .selectFrom("conversation_scheduler_events")
              .select(["event_id", "lane_key", "session_key"])
              .where("state", "not in", ["delivered", "cancelled"]),
          ).rows.filter(
            (row) =>
              row.lane_key === route.queueLaneKey ||
              (options.descendants && row.session_key.startsWith(`${route.sessionKey}:`)),
          );
          const laneKeys = [...new Set(candidateRows.map((row) => row.lane_key))];
          const eventIds = candidateRows.map((row) => row.event_id);
          if (eventIds.length > 0) {
            executeSqliteQuerySync(
              db,
              kysely
                .updateTable("conversation_scheduler_events")
                .set({
                  state: "cancelled",
                  callback_state: "settled",
                  revision: sql`revision + 1`,
                  updated_at: now,
                })
                .where("event_id", "in", eventIds)
                .where("state", "not in", ["delivered", "cancelled"]),
            );
          }
          if (laneKeys.length > 0) {
            executeSqliteQuerySync(
              db,
              kysely
                .updateTable("conversation_scheduler_lanes")
                .set({
                  active_event_id: null,
                  revision: sql`revision + 1`,
                  updated_at: now,
                })
                .where("lane_key", "in", laneKeys),
            );
          }
          return laneKeys;
        }, this.options.database);
        this.storageHealthy = true;
      } catch (error) {
        this.noteStorageError(error, route);
        throw error;
      }
    });
    for (const laneKey of cancelledLaneKeys) {
      this.clearTimer(laneKey);
      this.clearReconciliationTimer(laneKey);
    }
  }

  async snapshot(route?: ConversationRoute): Promise<SchedulerSnapshot> {
    try {
      const { db } = openOpenClawStateDatabase(this.options.database);
      const kysely = schedulerDatabase(db);
      const base = kysely
        .selectFrom("conversation_scheduler_events")
        .select([
          "lane_key",
          "session_key",
          "producer_kind",
          "ready_at",
          "state",
          "callback_state",
          "dispatch_attempt_id",
          "run_correlation_id",
        ])
        .orderBy("sequence");
      const rows = executeSqliteQuerySync(
        db,
        route ? base.where("lane_key", "=", route.queueLaneKey) : base,
      ).rows as SnapshotRow[];
      this.storageHealthy = true;
      return snapshotFromRows(rows, this.storageHealthy);
    } catch (error) {
      this.noteStorageError(error, route);
      return { storageHealthy: false, lanes: [] };
    }
  }

  async retryFailed(route: ConversationRoute): Promise<void> {
    await this.coordinator.run(route.queueLaneKey, () => {
      try {
        runOpenClawStateWriteTransaction(({ db }) => {
          const now = this.options.now?.() ?? Date.now();
          executeSqliteQuerySync(
            db,
            schedulerDatabase(db)
              .updateTable("conversation_scheduler_events")
              .set({
                state: "pending",
                ready_at: now,
                dispatch_attempt_id: null,
                revision: sql`revision + 1`,
                updated_at: now,
              })
              .where("lane_key", "=", route.queueLaneKey)
              .where("state", "=", "failed"),
          );
        }, this.options.database);
        this.storageHealthy = true;
      } catch (error) {
        this.noteStorageError(error, route);
        throw error;
      }
    });
    if (this.options.dispatch) {
      await this.pumpLane(route.queueLaneKey);
    }
  }

  private signalLane(laneKey: string): void {
    this.clearTimer(laneKey);
    queueMicrotask(() => void this.pumpLane(laneKey));
  }

  private async pumpLane(laneKey: string): Promise<void> {
    let reservation: Reservation | undefined;
    try {
      reservation = await this.coordinator.run(laneKey, () => this.reserveReadyBatch(laneKey));
    } catch (error) {
      this.noteStorageError(error);
      return;
    }
    if (!reservation) {
      this.armNextReady(laneKey);
      return;
    }
    await this.dispatchReservation(reservation);
    this.signalLane(laneKey);
  }

  private reserveReadyBatch(laneKey: string): Reservation | undefined {
    return runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = schedulerDatabase(db);
      const lane = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("conversation_scheduler_lanes")
          .select("active_event_id")
          .where("lane_key", "=", laneKey),
      );
      if (lane?.active_event_id) {
        return undefined;
      }
      const now = this.options.now?.() ?? Date.now();
      const readyRows = executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("conversation_scheduler_events")
          .selectAll()
          .where("lane_key", "=", laneKey)
          .where("state", "=", "pending")
          .where("ready_at", "<=", now)
          .orderBy("human", "desc")
          .orderBy("sequence"),
      ).rows as EventRow[];
      const first = readyRows.find((row) => this.shouldDispatchRow(row));
      if (!first) {
        return undefined;
      }
      const rows =
        first.human === 0 &&
        RECEIPT_LOCAL_PRODUCER_KINDS.has(first.producer_kind as SchedulerProducerKind)
          ? [first]
          : readyRows.filter(
              (row) =>
                this.shouldDispatchRow(row) &&
                (first.human === 1
                  ? row.human === 1
                  : row.human === 0 && row.producer_kind === first.producer_kind),
            );
      const attemptId = randomUUID();
      const ids = rows.map((row) => row.event_id);
      const update = executeSqliteQuerySync(
        db,
        kysely
          .updateTable("conversation_scheduler_events")
          .set({
            state: "reserved",
            dispatch_attempt_id: attemptId,
            revision: sql`revision + 1`,
            updated_at: now,
          })
          .where("event_id", "in", ids)
          .where("state", "=", "pending"),
      );
      if (affectedRows(update) !== ids.length) {
        throw new Error("scheduler reservation compare-and-swap failed");
      }
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("conversation_scheduler_lanes")
          .set({
            active_event_id: first.event_id,
            revision: sql`revision + 1`,
            updated_at: now,
          })
          .where("lane_key", "=", laneKey)
          .where("active_event_id", "is", null),
      );
      return {
        laneKey,
        attemptId,
        // A retained failure is the recovery fact. Revision also changes during
        // ordinary debounce updates, so it cannot classify placement.
        placement: rows.some((row) => row.failure_json !== null) ? "recovery" : "idle",
        rows,
      };
    }, this.options.database);
  }

  private async dispatchReservation(reservation: Reservation): Promise<void> {
    const dispatch = this.options.dispatch;
    if (!dispatch) {
      return;
    }
    try {
      await this.transitionReservation(reservation, "reserved", "dispatching");
      await this.transitionReservation(reservation, "dispatching", "running");
      const events = reservation.rows.map(rowToEvent);
      const result = await dispatch({
        attemptId: reservation.attemptId,
        placement: reservation.placement,
        events,
        claimMidTurnHumanEvents: async () => {
          const claimed = await this.claimMidTurnHumanEvents(reservation);
          events.push(...claimed);
          return claimed;
        },
        releaseMidTurnHumanEvents: async (eventIds) => {
          await this.releaseMidTurnHumanEvents(reservation, eventIds);
          const released = new Set(eventIds);
          for (let index = events.length - 1; index >= 0; index -= 1) {
            if (released.has(events[index]!.id)) {
              events.splice(index, 1);
            }
          }
        },
        recordRunCorrelationId: (runCorrelationId) => {
          this.recordRunCorrelationId(reservation, runCorrelationId);
        },
        recordRunStarted: (transcriptEvidence) => {
          this.recordRunEvidence(reservation, transcriptEvidence, "run start");
        },
        recordRunTerminalOutcome: (outcome, transcriptEvidence) => {
          this.recordRunTerminalOutcome(reservation, outcome, transcriptEvidence);
        },
      });
      if (result.outcome === "pending") {
        await this.persistPendingReservation(reservation, result.runCorrelationId);
        this.schedulePendingReconciliation(reservation.laneKey);
        return;
      }
      await this.finishReservation(reservation, result);
      if (SUCCESS_OUTCOMES.has(result.outcome)) {
        await this.settleCallbacks(reservation);
      }
    } catch (error) {
      await this.failReservation(reservation, error);
    }
  }

  private async claimMidTurnHumanEvents(
    reservation: Reservation,
  ): Promise<Array<ScheduledEvent & { receiptId: string; sequence: number }>> {
    return await this.coordinator.run(reservation.laneKey, () =>
      runOpenClawStateWriteTransaction(({ db }) => {
        const kysely = schedulerDatabase(db);
        const active = executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("conversation_scheduler_events")
            .select(["run_correlation_id", "transcript_evidence"])
            .where("lane_key", "=", reservation.laneKey)
            .where("dispatch_attempt_id", "=", reservation.attemptId)
            .where("state", "=", "running"),
        );
        if (!active) {
          return [];
        }
        const rows = (
          executeSqliteQuerySync(
            db,
            kysely
              .selectFrom("conversation_scheduler_events")
              .selectAll()
              .where("lane_key", "=", reservation.laneKey)
              .where("state", "=", "pending")
              .where("human", "=", 1)
              .orderBy("sequence"),
          ).rows as EventRow[]
        ).filter((row) => this.shouldDispatchRow(row));
        if (rows.length === 0) {
          return [];
        }
        const now = this.options.now?.() ?? Date.now();
        const ids = rows.map((row) => row.event_id);
        const update = executeSqliteQuerySync(
          db,
          kysely
            .updateTable("conversation_scheduler_events")
            .set({
              state: "running",
              dispatch_attempt_id: reservation.attemptId,
              run_correlation_id: active.run_correlation_id,
              transcript_evidence: active.transcript_evidence,
              ready_at: now,
              revision: sql`revision + 1`,
              updated_at: now,
            })
            .where("event_id", "in", ids)
            .where("state", "=", "pending"),
        );
        if (affectedRows(update) !== rows.length) {
          throw new Error("scheduler mid-turn claim compare-and-swap failed");
        }
        const claimed: EventRow[] = [];
        for (const row of rows) {
          claimed.push({
            ...row,
            state: "running",
            dispatch_attempt_id: reservation.attemptId,
            run_correlation_id: active.run_correlation_id,
            transcript_evidence: active.transcript_evidence,
            ready_at: now,
            updated_at: now,
          });
        }
        reservation.rows.push(...claimed);
        return claimed.map(rowToEvent);
      }, this.options.database),
    );
  }

  private async releaseMidTurnHumanEvents(
    reservation: Reservation,
    eventIds: ReadonlyArray<string>,
  ): Promise<void> {
    const released = new Set(eventIds);
    if (released.size === 0) {
      return;
    }
    await this.coordinator.run(reservation.laneKey, () => {
      runOpenClawStateWriteTransaction(({ db }) => {
        const now = this.options.now?.() ?? Date.now();
        const result = executeSqliteQuerySync(
          db,
          schedulerDatabase(db)
            .updateTable("conversation_scheduler_events")
            .set({
              state: "pending",
              dispatch_attempt_id: null,
              run_correlation_id: null,
              transcript_evidence: null,
              ready_at: now,
              revision: sql`revision + 1`,
              updated_at: now,
            })
            .where("lane_key", "=", reservation.laneKey)
            .where("dispatch_attempt_id", "=", reservation.attemptId)
            .where("state", "=", "running")
            .where("event_id", "in", [...released]),
        );
        if (affectedRows(result) !== released.size) {
          throw new Error("scheduler mid-turn release compare-and-swap failed");
        }
        reservation.rows = reservation.rows.filter((row) => !released.has(row.event_id));
      }, this.options.database);
    });
  }

  private recordRunCorrelationId(reservation: Reservation, runCorrelationId: string): void {
    const normalizedRunCorrelationId = runCorrelationId.trim();
    if (!normalizedRunCorrelationId) {
      throw new Error("scheduler run correlation id must not be empty");
    }
    runOpenClawStateWriteTransaction(({ db }) => {
      const now = this.options.now?.() ?? Date.now();
      const result = executeSqliteQuerySync(
        db,
        schedulerDatabase(db)
          .updateTable("conversation_scheduler_events")
          .set({
            run_correlation_id: normalizedRunCorrelationId,
            revision: sql`revision + 1`,
            updated_at: now,
          })
          .where("lane_key", "=", reservation.laneKey)
          .where("dispatch_attempt_id", "=", reservation.attemptId)
          .where("state", "=", "running"),
      );
      if (affectedRows(result) !== reservation.rows.length) {
        throw new Error("scheduler run correlation compare-and-swap failed");
      }
    }, this.options.database);
  }

  private recordRunTerminalOutcome(
    reservation: Reservation,
    outcome: "sent" | "reacted" | "deliberate_silence" | "implicit_silence" | "completed",
    transcriptEvidence: string,
  ): void {
    const normalizedEvidence = transcriptEvidence.trim();
    if (!normalizedEvidence || !SUCCESS_OUTCOMES.has(outcome)) {
      throw new Error("scheduler terminal outcome evidence must describe a successful action");
    }
    this.recordRunEvidence(reservation, normalizedEvidence, "terminal outcome");
  }

  private recordRunEvidence(
    reservation: Reservation,
    transcriptEvidence: string,
    evidenceKind: string,
  ): void {
    const normalizedEvidence = transcriptEvidence.trim();
    if (!normalizedEvidence) {
      throw new Error(`scheduler ${evidenceKind} evidence must not be empty`);
    }
    runOpenClawStateWriteTransaction(({ db }) => {
      const now = this.options.now?.() ?? Date.now();
      const result = executeSqliteQuerySync(
        db,
        schedulerDatabase(db)
          .updateTable("conversation_scheduler_events")
          .set({
            transcript_evidence: normalizedEvidence,
            revision: sql`revision + 1`,
            updated_at: now,
          })
          .where("lane_key", "=", reservation.laneKey)
          .where("dispatch_attempt_id", "=", reservation.attemptId)
          .where("state", "=", "running"),
      );
      if (affectedRows(result) !== reservation.rows.length) {
        throw new Error(`scheduler ${evidenceKind} compare-and-swap failed`);
      }
    }, this.options.database);
  }

  private async transitionReservation(
    reservation: Reservation,
    from: SchedulerEventState,
    to: SchedulerEventState,
  ): Promise<void> {
    await this.coordinator.run(reservation.laneKey, () => {
      runOpenClawStateWriteTransaction(({ db }) => {
        const now = this.options.now?.() ?? Date.now();
        const result = executeSqliteQuerySync(
          db,
          schedulerDatabase(db)
            .updateTable("conversation_scheduler_events")
            .set({ state: to, revision: sql`revision + 1`, updated_at: now })
            .where("lane_key", "=", reservation.laneKey)
            .where("dispatch_attempt_id", "=", reservation.attemptId)
            .where("state", "=", from),
        );
        if (affectedRows(result) !== reservation.rows.length) {
          throw new Error(`scheduler ${from} to ${to} compare-and-swap failed`);
        }
      }, this.options.database);
    });
  }

  private async finishReservation(
    reservation: Reservation,
    result: Exclude<SchedulerDispatchResult, { outcome: "pending" }>,
  ): Promise<void> {
    await this.coordinator.run(reservation.laneKey, () => {
      runOpenClawStateWriteTransaction(({ db }) => {
        const now = this.options.now?.() ?? Date.now();
        const kysely = schedulerDatabase(db);
        const state = SUCCESS_OUTCOMES.has(result.outcome) ? "delivered" : "failed";
        const failure = "failure" in result ? JSON.stringify(normalizeJson(result.failure)) : null;
        const update = executeSqliteQuerySync(
          db,
          kysely
            .updateTable("conversation_scheduler_events")
            .set({
              state,
              run_correlation_id: result.runCorrelationId ?? null,
              transcript_evidence: result.transcriptEvidence ?? null,
              failure_json: failure,
              callback_state: state === "delivered" ? "pending" : "settled",
              revision: sql`revision + 1`,
              updated_at: now,
            })
            .where("lane_key", "=", reservation.laneKey)
            .where("dispatch_attempt_id", "=", reservation.attemptId)
            .where("state", "=", "running"),
        );
        if (affectedRows(update) !== reservation.rows.length) {
          throw new Error("scheduler completion compare-and-swap failed");
        }
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("conversation_scheduler_lanes")
            .set({ active_event_id: null, revision: sql`revision + 1`, updated_at: now })
            .where("lane_key", "=", reservation.laneKey),
        );
      }, this.options.database);
    });
  }

  private async persistPendingReservation(
    reservation: Reservation,
    runCorrelationId: string,
  ): Promise<void> {
    const correlation = runCorrelationId.trim();
    if (!correlation) {
      throw new Error("pending scheduler dispatch requires a stable run correlation id");
    }
    await this.coordinator.run(reservation.laneKey, () => {
      runOpenClawStateWriteTransaction(({ db }) => {
        const kysely = schedulerDatabase(db);
        const current = executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("conversation_scheduler_events")
            .select("run_correlation_id")
            .where("lane_key", "=", reservation.laneKey)
            .where("dispatch_attempt_id", "=", reservation.attemptId)
            .where("state", "=", "running"),
        );
        if (current?.run_correlation_id && current.run_correlation_id !== correlation) {
          throw new Error("pending scheduler dispatch changed its run correlation id");
        }
        const update = executeSqliteQuerySync(
          db,
          kysely
            .updateTable("conversation_scheduler_events")
            .set({
              run_correlation_id: correlation,
              failure_json: DISPATCH_PENDING_FAILURE_JSON,
              revision: sql`revision + 1`,
              updated_at: this.options.now?.() ?? Date.now(),
            })
            .where("lane_key", "=", reservation.laneKey)
            .where("dispatch_attempt_id", "=", reservation.attemptId)
            .where("state", "=", "running"),
        );
        if (affectedRows(update) !== reservation.rows.length) {
          throw new Error("scheduler pending persistence compare-and-swap failed");
        }
      }, this.options.database);
    });
  }

  private clearReconciliationTimer(laneKey: string): void {
    const timer = this.reconciliationTimers.get(laneKey);
    if (timer) {
      clearTimeout(timer);
      this.reconciliationTimers.delete(laneKey);
    }
  }

  private schedulePendingReconciliation(laneKey: string): void {
    if (!this.options.reconcileInterruptedAttempt || this.reconciliationTimers.has(laneKey)) {
      return;
    }
    const delay = Math.max(1, this.options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS);
    const timer = setTimeout(() => {
      this.reconciliationTimers.delete(laneKey);
      void this.reconcilePendingLane(laneKey);
    }, delay);
    timer.unref?.();
    this.reconciliationTimers.set(laneKey, timer);
  }

  private async reconcilePendingLane(laneKey: string): Promise<void> {
    const reconcile = this.options.reconcileInterruptedAttempt;
    if (!reconcile) {
      return;
    }
    try {
      const { db } = openOpenClawStateDatabase(this.options.database);
      const rows = executeSqliteQuerySync(
        db,
        schedulerDatabase(db)
          .selectFrom("conversation_scheduler_events")
          .selectAll()
          .where("lane_key", "=", laneKey)
          .where("state", "=", "running")
          .orderBy("sequence"),
      ).rows as EventRow[];
      const first = rows[0];
      if (!first?.dispatch_attempt_id || first.failure_json !== DISPATCH_PENDING_FAILURE_JSON) {
        return;
      }
      const reservation: Reservation = {
        laneKey,
        attemptId: first.dispatch_attempt_id,
        placement: "recovery",
        rows,
      };
      const reconciliation = await reconcile({
        attemptId: reservation.attemptId,
        laneKey,
        ...(first.run_correlation_id ? { runCorrelationId: first.run_correlation_id } : {}),
        events: rows.map(rowToEvent),
      });
      if (reconciliation.status === "live") {
        this.schedulePendingReconciliation(laneKey);
        return;
      }
      if (reconciliation.status === "unresolved") {
        const coldGrace = this.coldPendingGraceRemaining.get(reservation.attemptId);
        if (coldGrace === undefined) {
          this.schedulePendingReconciliation(laneKey);
          return;
        }
        if (coldGrace > 0) {
          this.coldPendingGraceRemaining.set(reservation.attemptId, coldGrace - 1);
          this.schedulePendingReconciliation(laneKey);
          return;
        }
        this.coldPendingGraceRemaining.delete(reservation.attemptId);
        await this.finishReservation(reservation, {
          outcome: "failed",
          failure: { kind: "cold_pending_run_unresolved_after_grace" },
          runCorrelationId: first.run_correlation_id ?? undefined,
        });
        this.signalLane(laneKey);
        return;
      }
      if (reconciliation.status === "delivered") {
        await this.finishReservation(reservation, {
          outcome: "completed",
          transcriptEvidence: reconciliation.transcriptEvidence,
          runCorrelationId:
            reconciliation.runCorrelationId ?? first.run_correlation_id ?? undefined,
        });
        await this.settleCallbacks(reservation);
      } else {
        await this.finishReservation(reservation, {
          outcome: "failed",
          failure: {
            kind: "pending_reconciliation_retryable",
            evidence: reconciliation.evidence,
          },
          runCorrelationId: first.run_correlation_id ?? undefined,
        });
      }
      this.signalLane(laneKey);
    } catch {
      this.schedulePendingReconciliation(laneKey);
    }
  }

  private async failReservation(reservation: Reservation, error: unknown): Promise<void> {
    try {
      await this.coordinator.run(reservation.laneKey, () => {
        runOpenClawStateWriteTransaction(({ db }) => {
          const now = this.options.now?.() ?? Date.now();
          const kysely = schedulerDatabase(db);
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable("conversation_scheduler_events")
              .set({
                state: "failed",
                failure_json: JSON.stringify({ kind: "dispatch_error", message: String(error) }),
                revision: sql`revision + 1`,
                updated_at: now,
              })
              .where("lane_key", "=", reservation.laneKey)
              .where("dispatch_attempt_id", "=", reservation.attemptId)
              .where("state", "in", ["reserved", "dispatching", "running"]),
          );
          executeSqliteQuerySync(
            db,
            kysely
              .updateTable("conversation_scheduler_lanes")
              .set({ active_event_id: null, revision: sql`revision + 1`, updated_at: now })
              .where("lane_key", "=", reservation.laneKey),
          );
        }, this.options.database);
      });
    } catch (storageError) {
      this.noteStorageError(storageError);
    }
  }

  private async settleCallbacks(_reservation: Reservation): Promise<void> {
    await this.retryPendingCallbacks();
  }

  private async retryPendingCallbacks(): Promise<void> {
    this.callbackDrainRequested = true;
    const activeDrain = this.callbackDrain;
    if (activeDrain) {
      await activeDrain;
      return;
    }
    const drain = (async () => {
      do {
        this.callbackDrainRequested = false;
        await this.retryPendingCallbacksOnce();
      } while (this.callbackDrainRequested);
    })();
    this.callbackDrain = drain;
    try {
      await drain;
    } finally {
      if (this.callbackDrain === drain) {
        this.callbackDrain = undefined;
      }
    }
  }

  private async retryPendingCallbacksOnce(): Promise<void> {
    const { db } = openOpenClawStateDatabase(this.options.database);
    const callbacks = executeSqliteQuerySync(
      db,
      schedulerDatabase(db)
        .selectFrom("conversation_scheduler_events")
        .selectAll()
        .where("state", "=", "delivered")
        .where("callback_state", "=", "pending"),
    ).rows as EventRow[];
    if (!this.options.settleCallback) {
      await this.markCallbacksSettled(callbacks.map((row) => row.receipt_id));
      return;
    }
    for (const row of callbacks) {
      try {
        if (!row.transcript_evidence) {
          continue;
        }
        await this.options.settleCallback({
          event: rowToEvent(row),
          transcriptEvidence: row.transcript_evidence,
          ...(row.run_correlation_id ? { runCorrelationId: row.run_correlation_id } : {}),
        });
        await this.markCallbacksSettled([row.receipt_id]);
      } catch {
        // Keep the durable pending marker until its producer becomes available.
      }
    }
  }

  private async markCallbacksSettled(receiptIds: string[]): Promise<void> {
    if (receiptIds.length === 0) {
      return;
    }
    await this.coordinator.run(`callbacks:${receiptIds.join(":")}`, () => {
      runOpenClawStateWriteTransaction(({ db }) => {
        executeSqliteQuerySync(
          db,
          schedulerDatabase(db)
            .updateTable("conversation_scheduler_events")
            .set({
              callback_state: "settled",
              revision: sql`revision + 1`,
              updated_at: this.options.now?.() ?? Date.now(),
            })
            .where("receipt_id", "in", receiptIds)
            .where("state", "=", "delivered")
            .where("callback_state", "=", "pending"),
        );
      }, this.options.database);
    });
  }

  private armNextReady(laneKey: string): void {
    if (!this.options.dispatch) {
      return;
    }
    try {
      const { db } = openOpenClawStateDatabase(this.options.database);
      const rows = executeSqliteQuerySync(
        db,
        schedulerDatabase(db)
          .selectFrom("conversation_scheduler_events")
          .selectAll()
          .where("lane_key", "=", laneKey)
          .where("state", "=", "pending")
          .orderBy("ready_at")
          .orderBy("sequence"),
      ).rows as EventRow[];
      const row = rows.find((candidate) => this.shouldDispatchRow(candidate));
      if (!row) {
        return;
      }
      const delay = Math.max(0, row.ready_at - (this.options.now?.() ?? Date.now()));
      const timer = setTimeout(() => {
        this.timers.delete(laneKey);
        void this.pumpLane(laneKey);
      }, delay);
      timer.unref?.();
      this.timers.set(laneKey, timer);
    } catch (error) {
      this.noteStorageError(error);
    }
  }

  private clearTimer(laneKey: string): void {
    const timer = this.timers.get(laneKey);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(laneKey);
    }
  }

  private shouldDispatchRow(row: EventRow): boolean {
    return this.options.shouldDispatch?.(rowToEvent(row)) ?? true;
  }

  private async rehydrate(): Promise<void> {
    try {
      const { db } = openOpenClawStateDatabase(this.options.database);
      const activeRows = executeSqliteQuerySync(
        db,
        schedulerDatabase(db)
          .selectFrom("conversation_scheduler_events")
          .selectAll()
          .where("state", "in", ["reserved", "dispatching", "running"]),
      ).rows as EventRow[];
      const interruptedByLane = new Map<string, EventRow[]>();
      for (const row of activeRows) {
        const rows = interruptedByLane.get(row.lane_key) ?? [];
        rows.push(row);
        interruptedByLane.set(row.lane_key, rows);
      }
      for (const [laneKey, rows] of interruptedByLane) {
        const first = rows[0];
        if (!first) {
          continue;
        }
        const attemptId = first.dispatch_attempt_id ?? `unresolved:${laneKey}`;
        let reconciliation: SchedulerInterruptedAttemptReconciliation = {
          status: "unresolved",
        };
        try {
          reconciliation =
            (await this.options.reconcileInterruptedAttempt?.({
              attemptId,
              laneKey,
              ...(first.run_correlation_id ? { runCorrelationId: first.run_correlation_id } : {}),
              ...(first.transcript_evidence
                ? { transcriptEvidence: first.transcript_evidence }
                : {}),
              events: rows.map(rowToEvent),
            })) ?? reconciliation;
        } catch {
          reconciliation = { status: "unresolved" };
        }
        const persistedPending =
          first.state === "running" &&
          first.failure_json === DISPATCH_PENDING_FAILURE_JSON &&
          Boolean(first.run_correlation_id);
        const correlatedRunningAttempt =
          first.state === "running" && Boolean(first.run_correlation_id);
        const keepPending =
          correlatedRunningAttempt &&
          (reconciliation.status === "live" || reconciliation.status === "unresolved");
        if (keepPending && reconciliation.status === "unresolved") {
          this.coldPendingGraceRemaining.set(attemptId, 1);
        }
        await this.coordinator.run(laneKey, () => {
          runOpenClawStateWriteTransaction(({ db: tx }) => {
            const now = this.options.now?.() ?? Date.now();
            const kysely = schedulerDatabase(tx);
            if (keepPending && !persistedPending) {
              executeSqliteQuerySync(
                tx,
                kysely
                  .updateTable("conversation_scheduler_events")
                  .set({
                    failure_json: DISPATCH_PENDING_FAILURE_JSON,
                    revision: sql`revision + 1`,
                    updated_at: now,
                  })
                  .where("lane_key", "=", laneKey)
                  .where("state", "=", "running"),
              );
            }
            if (reconciliation.status === "live" || keepPending) {
              return;
            }
            if (reconciliation.status === "replayable") {
              executeSqliteQuerySync(
                tx,
                kysely
                  .updateTable("conversation_scheduler_events")
                  .set({
                    state: "pending",
                    ready_at: now,
                    dispatch_attempt_id: null,
                    run_correlation_id: null,
                    transcript_evidence: null,
                    failure_json: JSON.stringify({
                      kind: "restart_replayable",
                      evidence: reconciliation.evidence,
                    }),
                    revision: sql`revision + 1`,
                    updated_at: now,
                  })
                  .where("lane_key", "=", laneKey)
                  .where("state", "in", ["reserved", "dispatching", "running"]),
              );
              executeSqliteQuerySync(
                tx,
                kysely
                  .updateTable("conversation_scheduler_lanes")
                  .set({ active_event_id: null, revision: sql`revision + 1`, updated_at: now })
                  .where("lane_key", "=", laneKey),
              );
              return;
            }
            const state =
              reconciliation.status === "delivered"
                ? "delivered"
                : reconciliation.status === "retryable"
                  ? "failed"
                  : "storage_error";
            const failure =
              reconciliation.status === "retryable"
                ? {
                    kind: "restart_reconciliation_retryable",
                    evidence: reconciliation.evidence,
                  }
                : reconciliation.status === "unresolved"
                  ? { kind: "restart_reconciliation_unresolved" }
                  : null;
            const interruptedUpdate = kysely
              .updateTable("conversation_scheduler_events")
              .set({
                state,
                callback_state: reconciliation.status === "delivered" ? "pending" : "settled",
                failure_json: failure === null ? null : JSON.stringify(failure),
                transcript_evidence:
                  reconciliation.status === "delivered"
                    ? reconciliation.transcriptEvidence
                    : undefined,
                run_correlation_id:
                  reconciliation.status === "delivered"
                    ? (reconciliation.runCorrelationId ?? first.run_correlation_id)
                    : undefined,
                revision: sql`revision + 1`,
                updated_at: now,
              })
              .where("lane_key", "=", laneKey)
              .where("state", "in", ["reserved", "dispatching", "running"]);
            executeSqliteQuerySync(tx, interruptedUpdate);
            executeSqliteQuerySync(
              tx,
              kysely
                .updateTable("conversation_scheduler_lanes")
                .set({ active_event_id: null, revision: sql`revision + 1`, updated_at: now })
                .where("lane_key", "=", laneKey),
            );
          }, this.options.database);
        });
        if (keepPending) {
          this.schedulePendingReconciliation(laneKey);
        }
      }
      await this.drain();
      await this.retryPendingCallbacks();
      this.storageHealthy = true;
    } catch (error) {
      this.noteStorageError(error);
    }
  }

  private noteStorageError(error: unknown, route?: ConversationRoute): void {
    this.storageHealthy = false;
    this.options.onStorageError?.(error, route);
  }
}

export function createConversationScheduler(options: SchedulerOptions = {}): ConversationScheduler {
  return new SqliteConversationScheduler(options);
}
