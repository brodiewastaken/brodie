import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationRoute } from "../routing/conversation-route.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createConversationScheduler,
  type ScheduledEvent,
  type SchedulerDispatchBatch,
  type SchedulerDispatchResult,
} from "./conversation-scheduler.js";
import { createSchedulerProducerRegistry } from "./scheduler-producer-registry.js";

const roots: string[] = [];

afterEach(async () => {
  closeOpenClawStateDatabase();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "conversation-scheduler-"));
  roots.push(root);
  const route: ConversationRoute = {
    channel: "discord",
    accountId: "default",
    conversationKind: "channel",
    conversationId: "room",
    sessionKey: "agent:main:conversation:test:default:channel:lane",
    queueLaneKey: "lane",
    transcriptOwner: {
      agentId: "main",
      sessionKey: "agent:main:conversation:test:default:channel:lane",
    },
  };
  return { root, route, database: { path: path.join(root, "state.sqlite") } };
}

function event(route: ConversationRoute, id: string, payload: unknown = { text: "hello" }) {
  return {
    id,
    route,
    producerKind: "human_message",
    createdAt: 900,
    human: true,
    media: false,
    payload,
  } as ScheduledEvent;
}

function directRoute(route: ConversationRoute, suffix = ""): ConversationRoute {
  return {
    ...route,
    conversationKind: "direct",
    conversationId: `${route.conversationId}${suffix}`,
    queueLaneKey: `${route.queueLaneKey}${suffix}`,
    sessionKey: `${route.sessionKey}${suffix}`,
    transcriptOwner: {
      ...route.transcriptOwner,
      sessionKey: `${route.transcriptOwner.sessionKey}${suffix}`,
    },
  };
}

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await check())) {
    if (Date.now() >= deadline) {
      throw new Error("condition did not settle");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const delivered = (batch: SchedulerDispatchBatch): SchedulerDispatchResult => ({
  outcome: "sent",
  transcriptEvidence: `transcript:${batch.attemptId}`,
  runCorrelationId: `run:${batch.attemptId}`,
});

describe("ConversationScheduler", () => {
  it("durably dedupes concurrent admission and keeps both distinct events", async () => {
    const { route, database } = await fixture();
    const scheduler = createConversationScheduler({ database, now: () => 1_000 });
    const [first, duplicate, second] = await Promise.all([
      scheduler.admit(event(route, "event-1")),
      scheduler.admit(event(route, "event-1")),
      scheduler.admit(event(route, "event-2")),
    ]);
    expect(first).toMatchObject({ accepted: true });
    expect(duplicate).toMatchObject({
      accepted: true,
      receiptId: first.accepted ? first.receiptId : undefined,
      existingState: "pending",
    });
    expect(second).toMatchObject({ accepted: true });
    expect(await scheduler.snapshot(route)).toMatchObject({
      storageHealthy: true,
      lanes: [{ queueLaneKey: "lane", pendingCount: 2, readyAt: 5_200 }],
    });
  });

  it("rejects conflicting reuse of a durable event id", async () => {
    const { route, database } = await fixture();
    const scheduler = createConversationScheduler({ database, now: () => 1_000 });
    const first = await scheduler.admit(event(route, "stable-id", { slot: "first" }));

    expect(first).toMatchObject({ accepted: true });
    await expect(
      scheduler.admit(event(route, "stable-id", { slot: "conflicting" })),
    ).resolves.toEqual({ accepted: false, reason: "invalid" });
    expect(await scheduler.snapshot(route)).toMatchObject({
      lanes: [{ pendingCount: 1 }],
    });
  });

  it("settles an externally dispatched receipt with transcript evidence exactly once", async () => {
    const { route, database } = await fixture();
    const scheduler = createConversationScheduler({ database, now: () => 1_000 });
    const admitted = await scheduler.admit(event(route, "external"));
    expect(admitted).toMatchObject({ accepted: true });
    if (!admitted.accepted) {
      throw new Error("expected scheduler admission");
    }
    const result: SchedulerDispatchResult = {
      outcome: "completed",
      transcriptEvidence: "transcript:controller-consumed",
      runCorrelationId: "run:controller",
    };
    expect(await scheduler.settle(admitted.receiptId, result)).toBe(true);
    expect(await scheduler.settle(admitted.receiptId, result)).toBe(true);
    expect(await scheduler.snapshot(route)).toMatchObject({
      lanes: [{ pendingCount: 0, callbackPendingCount: 0 }],
    });
  });

  it("terminalizes an accepted pending dispatch and releases the lane", async () => {
    const { route, database } = await fixture();
    const batches: SchedulerDispatchBatch[] = [];
    const callbacks: string[] = [];
    const scheduler = createConversationScheduler({
      database,
      dispatch: async (batch) => {
        batches.push(batch);
        return batch.events[0]!.id === "pending-send"
          ? { outcome: "pending", runCorrelationId: "run:pending-send" }
          : delivered(batch);
      },
      settleCallback: async (settlement) => {
        callbacks.push(settlement.transcriptEvidence);
      },
    });
    const pending = await scheduler.admit({
      ...event(route, "pending-send"),
      producerKind: "sessions_send",
      human: false,
    });
    if (!pending.accepted) {
      throw new Error("expected pending sessions_send admission");
    }
    await eventually(
      async () => (await scheduler.snapshot(route)).lanes[0]?.activeState === "running",
    );
    await scheduler.admit({
      ...event(route, "next-send"),
      producerKind: "sessions_send",
      human: false,
    });

    expect(
      await scheduler.settle(pending.receiptId, {
        outcome: "completed",
        transcriptEvidence: "transcript:pending-send",
        runCorrelationId: "run:pending-send",
      }),
    ).toBe(true);

    await eventually(() => batches.length === 2);
    await eventually(() => callbacks.length === 2);
    expect(batches.map((batch) => batch.events.map((entry) => entry.id))).toEqual([
      ["pending-send"],
      ["next-send"],
    ]);
    expect(callbacks).toContain("transcript:pending-send");
  });

  it("declines unsupported payloads without claiming ownership", async () => {
    const { route, database } = await fixture();
    const scheduler = createConversationScheduler({ database });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(await scheduler.admit(event(route, "cyclic", cyclic))).toEqual({
      accepted: false,
      reason: "invalid",
    });
    expect(await scheduler.admit(event(route, "undefined", { value: undefined }))).toEqual({
      accepted: false,
      reason: "invalid",
    });
    expect((await scheduler.snapshot(route)).lanes).toEqual([]);
  });

  it("makes media debounce sticky across a pending human batch", async () => {
    const { route, database } = await fixture();
    let now = 1_000;
    const scheduler = createConversationScheduler({ database, now: () => now });
    await scheduler.admit(event(route, "text"));
    now = 2_000;
    await scheduler.admit({ ...event(route, "media"), producerKind: "human_media", media: true });
    now = 3_000;
    await scheduler.admit(event(route, "more-text"));
    expect(await scheduler.snapshot(route)).toMatchObject({
      lanes: [{ pendingCount: 3, readyAt: 9_900 }],
    });
  });

  it("typing resets only an unopened text batch", async () => {
    const { route, database } = await fixture();
    let now = 1_000;
    const scheduler = createConversationScheduler({
      database,
      now: () => now,
      resolveDebounceMs: () => 1_000,
    });
    await scheduler.admit(event(route, "text"));
    now = 1_500;
    expect(await scheduler.noteTyping(route)).toBe(true);
    expect(await scheduler.snapshot(route)).toMatchObject({
      lanes: [{ pendingCount: 1, readyAt: 2_500 }],
    });

    const mediaRoute = directRoute(route, "-media");
    await scheduler.admit({
      ...event(mediaRoute, "media"),
      producerKind: "human_media",
      media: true,
    });
    expect(await scheduler.noteTyping(mediaRoute)).toBe(false);
  });

  it("reserves before dispatch and preserves arrivals during the active run", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const firstGate = deferred();
    const batches: SchedulerDispatchBatch[] = [];
    const scheduler = createConversationScheduler({
      database,
      dispatch: async (batch) => {
        batches.push(batch);
        if (batches.length === 1) {
          await firstGate.promise;
        }
        return delivered(batch);
      },
    });
    await scheduler.admit(event(route, "first"));
    await eventually(() => batches.length === 1);
    await scheduler.admit(event(route, "during-run"));
    await eventually(async () => {
      const lane = (await scheduler.snapshot(route)).lanes[0];
      return lane?.activeState === "running" && lane.pendingCount === 1;
    });
    firstGate.resolve();
    await eventually(() => batches.length === 2);
    await eventually(async () => (await scheduler.snapshot(route)).lanes[0]?.pendingCount === 0);
    expect(batches.map((batch) => batch.events.map((entry) => entry.id))).toEqual([
      ["first"],
      ["during-run"],
    ]);
  });

  it("claims one ordered human batch at the post-tool-result boundary", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const boundaryReady = deferred();
    const claimedIds: string[][] = [];
    const batches: SchedulerDispatchBatch[] = [];
    const scheduler = createConversationScheduler({
      database,
      dispatch: async (batch) => {
        batches.push(batch);
        if (batches.length === 1) {
          await boundaryReady.promise;
          const claimed = await batch.claimMidTurnHumanEvents?.();
          claimedIds.push(claimed?.map((entry) => entry.id) ?? []);
        }
        return delivered(batch);
      },
    });

    await scheduler.admit(event(route, "first"));
    await eventually(() => batches.length === 1);
    await scheduler.admit(event(route, "during-run-1"));
    await scheduler.admit(event(route, "during-run-2"));
    boundaryReady.resolve();

    await eventually(async () => (await scheduler.snapshot(route)).lanes[0]?.pendingCount === 0);
    expect(claimedIds).toEqual([["during-run-1", "during-run-2"]]);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.events.map((entry) => entry.id)).toEqual([
      "first",
      "during-run-1",
      "during-run-2",
    ]);
  });

  it("auto-dispatches only events selected by the runtime owner", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const batches: SchedulerDispatchBatch[] = [];
    const scheduler = createConversationScheduler({
      database,
      shouldDispatch: (candidate) => candidate.human,
      dispatch: async (batch) => {
        batches.push(batch);
        return delivered(batch);
      },
    });
    await scheduler.admit({
      ...event(route, "passive"),
      producerKind: "cron",
      human: false,
    });
    await scheduler.admit(event(route, "owned"));
    await eventually(() => batches.length === 1);
    expect(batches[0]?.events.map((entry) => entry.id)).toEqual(["owned"]);
    expect(await scheduler.snapshot(route)).toMatchObject({
      lanes: [{ pendingCount: 1, producerKinds: ["cron", "human_message"] }],
    });
  });

  it("drains durable admissions after their runtime producer becomes available", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    let producerAvailable = false;
    const batches: SchedulerDispatchBatch[] = [];
    const scheduler = createConversationScheduler({
      database,
      shouldDispatch: () => producerAvailable,
      dispatch: async (batch) => {
        batches.push(batch);
        return delivered(batch);
      },
    });

    await scheduler.admit({ ...event(route, "late-owner"), producerKind: "cron", human: false });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(batches).toEqual([]);
    expect(await scheduler.snapshot(route)).toMatchObject({ lanes: [{ pendingCount: 1 }] });

    producerAvailable = true;
    await scheduler.drain();
    await eventually(() => batches.length === 1);
    expect(batches[0]?.events.map((entry) => entry.id)).toEqual(["late-owner"]);
  });

  it("runs unrelated lanes concurrently", async () => {
    const { route: baseRoute, database } = await fixture();
    const firstRoute = directRoute(baseRoute, "-one");
    const secondRoute = directRoute(baseRoute, "-two");
    const gate = deferred();
    const started = new Set<string>();
    const scheduler = createConversationScheduler({
      database,
      dispatch: async (batch) => {
        started.add(batch.events[0]!.route.queueLaneKey);
        await gate.promise;
        return delivered(batch);
      },
    });
    await Promise.all([
      scheduler.admit(event(firstRoute, "first")),
      scheduler.admit(event(secondRoute, "second")),
    ]);
    await eventually(() => started.size === 2);
    gate.resolve();
  });

  it("accumulates a failed human batch into the next inbound recovery run", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const batches: SchedulerDispatchBatch[] = [];
    const scheduler = createConversationScheduler({
      database,
      dispatch: async (batch) => {
        batches.push(batch);
        return batches.length === 1
          ? { outcome: "failed", failure: { kind: "model" } }
          : delivered(batch);
      },
    });
    await scheduler.admit(event(route, "failed"));
    await eventually(async () => (await scheduler.snapshot(route)).lanes[0]?.failureCount === 1);
    await scheduler.admit(event(route, "recovery"));
    await eventually(() => batches.length === 2);
    expect(batches[1]?.placement).toBe("recovery");
    expect(batches[1]?.events.map((entry) => entry.id)).toEqual(["failed", "recovery"]);
  });

  it("does not replay a human inbound after a terminal reaction outcome", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const batches: SchedulerDispatchBatch[] = [];
    const scheduler = createConversationScheduler({
      database,
      dispatch: async (batch) => {
        batches.push(batch);
        return batches.length === 1
          ? {
              outcome: "reacted",
              transcriptEvidence: `transcript:${batch.attemptId}`,
              runCorrelationId: `run:${batch.attemptId}`,
            }
          : delivered(batch);
      },
    });

    await scheduler.admit(event(route, "reacted"));
    await eventually(async () => (await scheduler.snapshot(route)).lanes[0]?.pendingCount === 0);
    await scheduler.admit(event(route, "next-inbound"));
    await eventually(() => batches.length === 2);

    expect(batches[1]?.placement).toBe("idle");
    expect(batches[1]?.events.map((entry) => entry.id)).toEqual(["next-inbound"]);
  });

  it("keeps an ordinary debounced human batch on idle placement", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    let now = 1_000;
    const batches: SchedulerDispatchBatch[] = [];
    const scheduler = createConversationScheduler({
      database,
      now: () => now,
      resolveDebounceMs: () => 100,
      dispatch: async (batch) => {
        batches.push(batch);
        return delivered(batch);
      },
    });
    await scheduler.admit(event(route, "first"));
    await scheduler.admit(event(route, "second"));
    now = 1_100;
    await scheduler.drain();
    await eventually(() => batches.length === 1);
    expect(batches[0]?.placement).toBe("idle");
    expect(batches[0]?.events.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("settles receipt-local completion events independently", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    let now = 1_000;
    const batches: SchedulerDispatchBatch[] = [];
    const scheduler = createConversationScheduler({
      database,
      now: () => now,
      resolveDebounceMs: () => 100,
      dispatch: async (batch) => {
        batches.push(batch);
        const id = batch.events[0]!.id;
        return id === "completion-ok"
          ? {
              outcome: "completed",
              transcriptEvidence: "transcript:completion-ok",
              runCorrelationId: "run:completion-ok",
            }
          : {
              outcome: "failed",
              failure: { kind: "controller_delivery_failed" },
              transcriptEvidence: "transcript:completion-failed",
              runCorrelationId: "run:completion-failed",
            };
      },
    });
    const completion = (id: string): ScheduledEvent => ({
      ...event(route, id),
      producerKind: "subagent_completion",
      human: false,
    });
    await scheduler.admit(completion("completion-ok"));
    await scheduler.admit(completion("completion-failed"));
    now = 1_100;
    await scheduler.drain();
    await eventually(() => batches.length === 2);
    expect(batches.map((batch) => batch.events.map((entry) => entry.id))).toEqual([
      ["completion-ok"],
      ["completion-failed"],
    ]);
    const rows = openOpenClawStateDatabase(database)
      .db.prepare(
        `SELECT event_id, state, transcript_evidence, run_correlation_id, callback_state
           FROM conversation_scheduler_events
          WHERE event_id IN ('completion-ok', 'completion-failed')
          ORDER BY sequence`,
      )
      .all();
    expect(rows).toEqual([
      {
        event_id: "completion-ok",
        state: "delivered",
        transcript_evidence: "transcript:completion-ok",
        run_correlation_id: "run:completion-ok",
        callback_state: "settled",
      },
      {
        event_id: "completion-failed",
        state: "failed",
        transcript_evidence: "transcript:completion-failed",
        run_correlation_id: "run:completion-failed",
        callback_state: "settled",
      },
    ]);
  });

  it("retries only the failed receipt requested by its controller", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const original = createConversationScheduler({
      database,
      dispatch: async () => ({
        outcome: "failed",
        failure: { kind: "controller_delivery_failed" },
      }),
    });
    const completion = (id: string): ScheduledEvent => ({
      ...event(route, id),
      producerKind: "subagent_completion",
      human: false,
    });
    const older = await original.admit(completion("failed-older-controller"));
    const requested = await original.admit(completion("failed-requested-controller"));
    if (!older.accepted || !requested.accepted) {
      throw new Error("expected durable completion admissions");
    }
    await eventually(async () => {
      return (
        (await original.waitForReceiptTerminal?.(older.receiptId)) === "failed" &&
        (await original.waitForReceiptTerminal?.(requested.receiptId)) === "failed"
      );
    });

    const retried: SchedulerDispatchBatch[] = [];
    const recovered = createConversationScheduler({
      database,
      dispatch: async (batch) => {
        retried.push(batch);
        return delivered(batch);
      },
    });
    await recovered.retryReceipt(requested.receiptId);
    await eventually(() => retried.length === 1);

    expect(retried[0]?.events.map((entry) => entry.id)).toEqual(["failed-requested-controller"]);
    expect(await recovered.waitForReceiptTerminal?.(older.receiptId)).toBe("failed");
  });

  it("parks a deferred receipt without blocking its lane and resumes only that receipt", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const batches: string[][] = [];
    const scheduler = createConversationScheduler({
      database,
      dispatch: async (batch) => {
        const eventIds = batch.events.map((entry) => entry.id);
        batches.push(eventIds);
        if (
          eventIds.includes("deferred-controller") &&
          batches.filter((candidate) => candidate.includes("deferred-controller")).length === 1
        ) {
          return {
            outcome: "deferred",
            reason: { kind: "pending_descendants" },
            runCorrelationId: "run:deferred-controller",
          } as unknown as SchedulerDispatchResult;
        }
        return delivered(batch);
      },
    });
    const completion = (id: string): ScheduledEvent => ({
      ...event(route, id),
      producerKind: "subagent_completion",
      human: false,
    });
    const deferredAdmission = await scheduler.admit(completion("deferred-controller"));
    if (!deferredAdmission.accepted) {
      throw new Error("expected deferred completion admission");
    }
    await eventually(async () => {
      const lane = (await scheduler.snapshot(route)).lanes[0];
      return lane?.pendingCount === 1 && lane.activeState === undefined;
    });

    await scheduler.admit(completion("unrelated-controller"));
    await eventually(() => batches.some((batch) => batch.includes("unrelated-controller")));
    expect((await scheduler.snapshot(route)).lanes[0]?.failureCount).toBe(0);

    await scheduler.retryReceipt(deferredAdmission.receiptId);
    await eventually(
      () => batches.filter((batch) => batch.includes("deferred-controller")).length === 2,
    );
  });

  it("settles successful callbacks once and retains callback failures for recovery", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const calls = new Map<string, number>();
    let reject = true;
    const scheduler = createConversationScheduler({
      database,
      dispatch: async (batch) => delivered(batch),
      settleCallback: async ({ event: settledEvent }) => {
        const receiptId = settledEvent.receiptId;
        calls.set(receiptId, (calls.get(receiptId) ?? 0) + 1);
        if (reject) {
          throw new Error("callback unavailable");
        }
      },
    });
    const admitted = await scheduler.admit(event(route, "callback"));
    expect(admitted.accepted).toBe(true);
    await eventually(async () => {
      const lane = (await scheduler.snapshot(route)).lanes[0];
      return lane?.pendingCount === 0 && lane.callbackPendingCount === 1 && calls.size === 1;
    });
    reject = false;
    createConversationScheduler({
      database,
      dispatch: async (batch) => delivered(batch),
      settleCallback: async ({ event: settledEvent }) => {
        const receiptId = settledEvent.receiptId;
        calls.set(receiptId, (calls.get(receiptId) ?? 0) + 1);
      },
    });
    await eventually(
      async () => (await scheduler.snapshot(route)).lanes[0]?.callbackPendingCount === 0,
    );
    expect([...calls.values()]).toEqual([2]);
  });

  it("retains a delivered callback until its producer registers after restart", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const settlements: string[] = [];
    const transcriptEvidence = "transcript:producer-registers-late";
    const firstCallbackStarted = deferred();
    const releaseFirstCallback = deferred();
    let holdFirstUnownedCallback = true;
    const registry = createSchedulerProducerRegistry({
      onProducerAvailable: () => {
        void scheduler.drain();
      },
    });
    const scheduler = createConversationScheduler({
      database,
      dispatch: async () => ({ outcome: "completed", transcriptEvidence }),
      settleCallback: async (settlement) => {
        if (holdFirstUnownedCallback && !registry.owns(settlement.event.producerKind)) {
          holdFirstUnownedCallback = false;
          firstCallbackStarted.resolve();
          await releaseFirstCallback.promise;
          throw new Error("producer was not registered when callback attempt started");
        }
        await registry.settle(settlement);
      },
    });
    await scheduler.admit({
      ...event(route, "producer-registers-late", { taskRunId: "task-late" }),
      producerKind: "subagent_completion",
      human: false,
    });
    await eventually(async () => {
      const lane = (await scheduler?.snapshot(route))?.lanes[0];
      return lane?.pendingCount === 0 && lane.callbackPendingCount === 1;
    });
    await firstCallbackStarted.promise;

    registry.register({
      producerKinds: ["subagent_completion"],
      dispatch: async (batch) => delivered(batch),
      settle: async (settlement) => {
        settlements.push(settlement.transcriptEvidence);
      },
    });
    releaseFirstCallback.resolve();

    await eventually(
      async () => (await scheduler?.snapshot(route))?.lanes[0]?.callbackPendingCount === 0,
    );
    expect(settlements).toEqual([transcriptEvidence]);
  });

  it("keeps an accepted controller handoff nonterminal until transcript reconciliation", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const reconciliationGate = deferred();
    const batches: SchedulerDispatchBatch[] = [];
    const settlements: string[] = [];
    const scheduler = createConversationScheduler({
      database,
      reconcileIntervalMs: 1,
      dispatch: async (batch) => {
        batches.push(batch);
        return { outcome: "pending", runCorrelationId: "controller-run-pending" };
      },
      reconcileInterruptedAttempt: async () => {
        await reconciliationGate.promise;
        return {
          status: "delivered",
          transcriptEvidence: "transcript:controller-run-pending",
          runCorrelationId: "controller-run-pending",
        };
      },
      settleCallback: async (settlement) => {
        settlements.push(settlement.transcriptEvidence);
      },
    });
    const completion = {
      ...event(route, "pending-controller-handoff", { taskRunId: "task-pending" }),
      producerKind: "subagent_completion" as const,
      human: false,
    };

    await scheduler.admit(completion);
    await eventually(
      async () => (await scheduler.snapshot(route)).lanes[0]?.activeState === "running",
    );
    const { db } = openOpenClawStateDatabase(database);
    expect(
      db
        .prepare(
          `SELECT state, run_correlation_id, failure_json
             FROM conversation_scheduler_events WHERE event_id = 'pending-controller-handoff'`,
        )
        .get(),
    ).toMatchObject({
      state: "running",
      run_correlation_id: "controller-run-pending",
      failure_json: JSON.stringify({ kind: "dispatch_pending" }),
    });

    reconciliationGate.resolve();
    await eventually(() => settlements.length === 1);
    expect(batches).toHaveLength(1);
    expect(settlements).toEqual(["transcript:controller-run-pending"]);
    expect(
      db
        .prepare(
          `SELECT state, transcript_evidence, run_correlation_id, failure_json, callback_state
             FROM conversation_scheduler_events WHERE event_id = 'pending-controller-handoff'`,
        )
        .get(),
    ).toMatchObject({
      state: "delivered",
      transcript_evidence: "transcript:controller-run-pending",
      run_correlation_id: "controller-run-pending",
      failure_json: null,
      callback_state: "settled",
    });
  });

  it("marks interrupted active rows for reconciliation instead of blindly redispatching", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const scheduler = createConversationScheduler({ database });
    await scheduler.admit(event(route, "interrupted"));
    const { db } = openOpenClawStateDatabase(database);
    db.prepare(
      `UPDATE conversation_scheduler_events SET state = 'running', dispatch_attempt_id = 'attempt'
       WHERE event_id = 'interrupted'`,
    ).run();
    db.prepare(
      `UPDATE conversation_scheduler_lanes SET active_event_id = 'interrupted'
       WHERE lane_key = ?`,
    ).run(route.queueLaneKey);
    const batches: SchedulerDispatchBatch[] = [];
    createConversationScheduler({
      database,
      dispatch: async (batch) => {
        batches.push(batch);
        return delivered(batch);
      },
    });
    await eventually(async () => (await scheduler.snapshot(route)).lanes[0]?.failureCount === 1);
    expect(batches).toEqual([]);
  });

  it("keeps a proven live interrupted attempt active without redispatching it", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const scheduler = createConversationScheduler({ database });
    const admitted = await scheduler.admit(event(route, "live-interrupted"));
    if (!admitted.accepted) {
      throw new Error("expected live interrupted admission");
    }
    const { db } = openOpenClawStateDatabase(database);
    db.prepare(
      `UPDATE conversation_scheduler_events
       SET state = 'running', dispatch_attempt_id = 'attempt-live', run_correlation_id = 'run-live'
       WHERE event_id = 'live-interrupted'`,
    ).run();
    db.prepare(
      `UPDATE conversation_scheduler_lanes SET active_event_id = 'live-interrupted'
       WHERE lane_key = ?`,
    ).run(route.queueLaneKey);
    const batches: SchedulerDispatchBatch[] = [];
    const recovered = createConversationScheduler({
      database,
      reconcileInterruptedAttempt: async () => ({ status: "live" }),
      dispatch: async (batch) => {
        batches.push(batch);
        return delivered(batch);
      },
    });

    await eventually(
      async () => (await recovered.snapshot(route)).lanes[0]?.activeState === "running",
    );
    await recovered.retryReceipt(admitted.receiptId);

    expect(batches).toEqual([]);
    expect((await recovered.snapshot(route)).lanes[0]?.activeState).toBe("running");
  });

  it("resumes reconciliation for a durable pending handoff after restart", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const scheduler = createConversationScheduler({ database });
    await scheduler.admit({
      ...event(route, "restarted-pending-handoff", { taskRunId: "task-restarted" }),
      producerKind: "subagent_completion",
      human: false,
    });
    const { db } = openOpenClawStateDatabase(database);
    db.prepare(
      `UPDATE conversation_scheduler_events
          SET state = 'running',
              dispatch_attempt_id = 'attempt-restarted-pending',
              run_correlation_id = 'controller-run-restarted',
              failure_json = ?
        WHERE event_id = 'restarted-pending-handoff'`,
    ).run(JSON.stringify({ kind: "dispatch_pending" }));
    db.prepare(
      `UPDATE conversation_scheduler_lanes SET active_event_id = 'restarted-pending-handoff'
        WHERE lane_key = ?`,
    ).run(route.queueLaneKey);
    const batches: SchedulerDispatchBatch[] = [];
    const settlements: string[] = [];
    let reconciliationCalls = 0;
    const recovered = createConversationScheduler({
      database,
      reconcileIntervalMs: 1,
      reconcileInterruptedAttempt: async () => {
        reconciliationCalls += 1;
        if (reconciliationCalls === 1) {
          return { status: "live" };
        }
        return {
          status: "delivered",
          transcriptEvidence: "transcript:controller-run-restarted",
          runCorrelationId: "controller-run-restarted",
        };
      },
      dispatch: async (batch) => {
        batches.push(batch);
        return delivered(batch);
      },
      settleCallback: async (settlement) => {
        settlements.push(settlement.transcriptEvidence);
      },
    });

    await eventually(() => settlements.length === 1);
    expect(batches).toEqual([]);
    expect(reconciliationCalls).toBeGreaterThanOrEqual(2);
    expect(settlements).toEqual(["transcript:controller-run-restarted"]);
    expect(await recovered.snapshot(route)).toMatchObject({
      lanes: [{ pendingCount: 0, callbackPendingCount: 0 }],
    });
    expect(
      db
        .prepare(
          `SELECT state, transcript_evidence, run_correlation_id
             FROM conversation_scheduler_events WHERE event_id = 'restarted-pending-handoff'`,
        )
        .get(),
    ).toMatchObject({
      state: "delivered",
      transcript_evidence: "transcript:controller-run-restarted",
      run_correlation_id: "controller-run-restarted",
    });
  });

  it("rekeys durable subagent receipts on restart without reviving failed work", async () => {
    const { route: baseRoute, database } = await fixture();
    const oldRoute = directRoute(baseRoute, "-root");
    const controllerSessionKey = "agent:main:subagent:controller-a";
    const correctedRoute: ConversationRoute = {
      channel: "internal",
      accountId: "main",
      conversationKind: "direct",
      conversationId: controllerSessionKey,
      sessionKey: controllerSessionKey,
      queueLaneKey: "internal:main:direct:agent%3Amain%3Asubagent%3Acontroller-a",
      transcriptOwner: { agentId: "main", sessionKey: controllerSessionKey },
    };
    const original = createConversationScheduler({
      database,
      dispatch: async () => ({
        outcome: "failed",
        failure: { kind: "controller_delivery_failed" },
      }),
    });
    const admitted = await original.admit({
      ...event(oldRoute, "legacy-controller-completion", { taskRunId: "task-legacy" }),
      producerKind: "subagent_completion",
      human: false,
    });
    if (!admitted.accepted) {
      throw new Error("expected durable completion admission");
    }
    await eventually(
      async () => (await original.waitForReceiptTerminal?.(admitted.receiptId)) === "failed",
    );
    const { db } = openOpenClawStateDatabase(database);
    const beforeMigration = db
      .prepare(
        `SELECT receipt_id, state, ready_at, failure_json, callback_state
           FROM conversation_scheduler_events WHERE event_id = 'legacy-controller-completion'`,
      )
      .get();

    const batches: SchedulerDispatchBatch[] = [];
    const recovered = createConversationScheduler({
      database,
      resolveDurableRoute: (durableEvent) =>
        durableEvent.producerKind === "subagent_completion" ? correctedRoute : undefined,
      dispatch: async (batch) => {
        batches.push(batch);
        return delivered(batch);
      },
    });

    await eventually(async () => {
      const snapshot = await recovered.snapshot(correctedRoute);
      return snapshot.lanes[0]?.failureCount === 1;
    });
    expect(batches).toEqual([]);
    expect(await recovered.waitForReceiptTerminal?.(admitted.receiptId)).toBe("failed");
    expect((await recovered.snapshot(oldRoute)).lanes).toEqual([]);
    expect(
      db
        .prepare(
          `SELECT receipt_id, state, ready_at, failure_json, callback_state
             FROM conversation_scheduler_events WHERE event_id = 'legacy-controller-completion'`,
        )
        .get(),
    ).toEqual(beforeMigration);
  });

  it("fails a cold pending handoff once when runtime proof stays absent after grace", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const scheduler = createConversationScheduler({ database });
    await scheduler.admit({
      ...event(route, "cold-unresolved-handoff", { taskRunId: "task-cold-unresolved" }),
      producerKind: "subagent_completion",
      human: false,
    });
    const { db } = openOpenClawStateDatabase(database);
    db.prepare(
      `UPDATE conversation_scheduler_events
          SET state = 'running',
              dispatch_attempt_id = 'attempt-cold-unresolved',
              run_correlation_id = 'controller-run-cold-unresolved',
              failure_json = ?
        WHERE event_id = 'cold-unresolved-handoff'`,
    ).run(JSON.stringify({ kind: "dispatch_pending" }));
    db.prepare(
      `UPDATE conversation_scheduler_lanes SET active_event_id = 'cold-unresolved-handoff'
        WHERE lane_key = ?`,
    ).run(route.queueLaneKey);
    let reconciliationCalls = 0;
    const recovered = createConversationScheduler({
      database,
      reconcileIntervalMs: 1,
      reconcileInterruptedAttempt: async () => {
        reconciliationCalls += 1;
        return { status: "unresolved" };
      },
      dispatch: async (batch) => delivered(batch),
    });

    await eventually(
      async () => (await recovered.snapshot(route)).lanes[0]?.activeState === undefined,
    );
    expect(reconciliationCalls).toBeGreaterThanOrEqual(3);
    expect(
      db
        .prepare(
          `SELECT state, failure_json FROM conversation_scheduler_events
             WHERE event_id = 'cold-unresolved-handoff'`,
        )
        .get(),
    ).toMatchObject({
      state: "failed",
      failure_json: JSON.stringify({ kind: "cold_pending_run_unresolved_after_grace" }),
    });
  });

  it("grants cold grace when restart lands after correlation persistence but before pending persistence", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const scheduler = createConversationScheduler({ database });
    await scheduler.admit({
      ...event(route, "correlated-before-pending", { taskRunId: "task-correlated-before-pending" }),
      producerKind: "subagent_completion",
      human: false,
    });
    const { db } = openOpenClawStateDatabase(database);
    db.prepare(
      `UPDATE conversation_scheduler_events
          SET state = 'running',
              dispatch_attempt_id = 'attempt-correlated-before-pending',
              run_correlation_id = 'controller-run-correlated-before-pending'
        WHERE event_id = 'correlated-before-pending'`,
    ).run();
    db.prepare(
      `UPDATE conversation_scheduler_lanes SET active_event_id = 'correlated-before-pending'
        WHERE lane_key = ?`,
    ).run(route.queueLaneKey);
    let reconciliationCalls = 0;
    const recovered = createConversationScheduler({
      database,
      reconcileIntervalMs: 1,
      reconcileInterruptedAttempt: async () => {
        reconciliationCalls += 1;
        return { status: "unresolved" };
      },
      dispatch: async (batch) => delivered(batch),
    });

    await eventually(
      async () => (await recovered.snapshot(route)).lanes[0]?.activeState === undefined,
    );
    expect(reconciliationCalls).toBeGreaterThanOrEqual(3);
    expect(
      db
        .prepare(
          `SELECT state, failure_json FROM conversation_scheduler_events
             WHERE event_id = 'correlated-before-pending'`,
        )
        .get(),
    ).toMatchObject({
      state: "failed",
      failure_json: JSON.stringify({ kind: "cold_pending_run_unresolved_after_grace" }),
    });
  });

  it("persists the runtime run correlation before dispatch continues", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const { db } = openOpenClawStateDatabase(database);
    const scheduler = createConversationScheduler({
      database,
      dispatch: async (batch) => {
        batch.recordRunCorrelationId?.("run-started");
        batch.recordRunStarted?.("transcript:run-started");
        expect(
          db
            .prepare(
              `SELECT state, run_correlation_id, transcript_evidence
               FROM conversation_scheduler_events WHERE event_id = 'correlated'`,
            )
            .get(),
        ).toMatchObject({
          state: "running",
          run_correlation_id: "run-started",
          transcript_evidence: "transcript:run-started",
        });
        return {
          outcome: "sent",
          transcriptEvidence: `transcript:${batch.attemptId}`,
          runCorrelationId: "run-started",
        };
      },
    });

    await scheduler.admit(event(route, "correlated"));
    await eventually(async () => (await scheduler.snapshot(route)).lanes[0]?.pendingCount === 0);

    expect(
      db
        .prepare(
          `SELECT state, run_correlation_id
           FROM conversation_scheduler_events WHERE event_id = 'correlated'`,
        )
        .get(),
    ).toMatchObject({ state: "delivered", run_correlation_id: "run-started" });
  });

  it("settles a proven delivered interrupted attempt without redispatching it", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const scheduler = createConversationScheduler({ database });
    await scheduler.admit(event(route, "delivered-interrupted"));
    const { db } = openOpenClawStateDatabase(database);
    db.prepare(
      `UPDATE conversation_scheduler_events
       SET state = 'running',
           dispatch_attempt_id = 'attempt-delivered',
           run_correlation_id = 'run-delivered',
           transcript_evidence = 'transcript:terminal-before-crash'
       WHERE event_id = 'delivered-interrupted'`,
    ).run();
    db.prepare(
      `UPDATE conversation_scheduler_lanes SET active_event_id = 'delivered-interrupted'
       WHERE lane_key = ?`,
    ).run(route.queueLaneKey);
    const batches: SchedulerDispatchBatch[] = [];
    createConversationScheduler({
      database,
      reconcileInterruptedAttempt: async (attempt) => {
        const transcriptEvidence = attempt.transcriptEvidence;
        expect(transcriptEvidence).toBe("transcript:terminal-before-crash");
        if (!transcriptEvidence) {
          throw new Error("expected terminal evidence to survive scheduler rehydration");
        }
        return {
          status: "delivered",
          transcriptEvidence,
          runCorrelationId: "run-delivered",
        };
      },
      dispatch: async (batch) => {
        batches.push(batch);
        return delivered(batch);
      },
    });

    await eventually(() => {
      const row = db
        .prepare(
          `SELECT state, transcript_evidence, run_correlation_id
           FROM conversation_scheduler_events WHERE event_id = 'delivered-interrupted'`,
        )
        .get() as Record<string, unknown>;
      return row.state === "delivered";
    });

    expect(batches).toEqual([]);
    expect(
      db
        .prepare(
          `SELECT state, transcript_evidence, run_correlation_id
           FROM conversation_scheduler_events WHERE event_id = 'delivered-interrupted'`,
        )
        .get(),
    ).toMatchObject({
      state: "delivered",
      transcript_evidence: "transcript:terminal-before-crash",
      run_correlation_id: "run-delivered",
    });
  });

  it("does not let operator retry blindly redispatch uncorrelated interrupted work", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const scheduler = createConversationScheduler({ database });
    const admitted = await scheduler.admit(event(route, "unresolved-interrupted"));
    if (!admitted.accepted) {
      throw new Error("expected unresolved interrupted admission");
    }
    const { db } = openOpenClawStateDatabase(database);
    db.prepare(
      `UPDATE conversation_scheduler_events
       SET state = 'running', dispatch_attempt_id = 'attempt-unresolved'
       WHERE event_id = 'unresolved-interrupted'`,
    ).run();
    db.prepare(
      `UPDATE conversation_scheduler_lanes SET active_event_id = 'unresolved-interrupted'
       WHERE lane_key = ?`,
    ).run(route.queueLaneKey);
    const batches: SchedulerDispatchBatch[] = [];
    const recovered = createConversationScheduler({
      database,
      reconcileInterruptedAttempt: async () => ({ status: "unresolved" }),
      dispatch: async (batch) => {
        batches.push(batch);
        return delivered(batch);
      },
    });
    await eventually(async () => (await recovered.snapshot(route)).lanes[0]?.failureCount === 1);

    await recovered.retryReceipt(admitted.receiptId);

    expect(batches).toEqual([]);
    expect(
      db
        .prepare(
          `SELECT state, failure_json
           FROM conversation_scheduler_events WHERE event_id = 'unresolved-interrupted'`,
        )
        .get(),
    ).toMatchObject({
      state: "storage_error",
      failure_json: JSON.stringify({ kind: "restart_reconciliation_unresolved" }),
    });
  });

  it("replays a durably accepted operator turn only when startup proves it never started", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const scheduler = createConversationScheduler({ database });
    await scheduler.admit({
      ...event(route, "operator-before-start", {
        kind: "runtime_turn",
        recoveryPayload: { kind: "gateway_operator_chat" },
      }),
      producerKind: "operator",
      human: false,
    });
    const { db } = openOpenClawStateDatabase(database);
    db.prepare(
      `UPDATE conversation_scheduler_events
       SET state = 'running', dispatch_attempt_id = 'attempt-before-start'
       WHERE event_id = 'operator-before-start'`,
    ).run();
    db.prepare(
      `UPDATE conversation_scheduler_lanes SET active_event_id = 'operator-before-start'
       WHERE lane_key = ?`,
    ).run(route.queueLaneKey);
    const batches: SchedulerDispatchBatch[] = [];
    createConversationScheduler({
      database,
      reconcileInterruptedAttempt: async () => ({
        status: "replayable",
        evidence: { kind: "authorized_operator_turn_never_started" },
      }),
      dispatch: async (batch) => {
        batches.push(batch);
        return delivered(batch);
      },
    });

    await eventually(() => batches.length === 1);
    await eventually(() => {
      const row = db
        .prepare(
          `SELECT state FROM conversation_scheduler_events
           WHERE event_id = 'operator-before-start'`,
        )
        .get() as { state?: string } | undefined;
      return row?.state === "delivered";
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]?.placement).toBe("recovery");
    expect(batches[0]?.events.map((entry) => entry.id)).toEqual(["operator-before-start"]);
  });

  it("fails closed when an interrupted active row has no dispatch attempt id", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const scheduler = createConversationScheduler({ database });
    await scheduler.admit(event(route, "missing-attempt"));
    const { db } = openOpenClawStateDatabase(database);
    db.prepare(
      `UPDATE conversation_scheduler_events
       SET state = 'running', dispatch_attempt_id = NULL
       WHERE event_id = 'missing-attempt'`,
    ).run();
    db.prepare(
      `UPDATE conversation_scheduler_lanes SET active_event_id = 'missing-attempt'
       WHERE lane_key = ?`,
    ).run(route.queueLaneKey);
    const recovered = createConversationScheduler({
      database,
      reconcileInterruptedAttempt: async () => ({ status: "unresolved" }),
      dispatch: async (batch) => delivered(batch),
    });

    await eventually(async () => (await recovered.snapshot(route)).lanes[0]?.failureCount === 1);

    expect(
      db
        .prepare(
          `SELECT state, failure_json
           FROM conversation_scheduler_events WHERE event_id = 'missing-attempt'`,
        )
        .get(),
    ).toMatchObject({
      state: "storage_error",
      failure_json: JSON.stringify({ kind: "restart_reconciliation_unresolved" }),
    });
    expect((await recovered.snapshot(route)).lanes[0]?.activeState).toBeUndefined();
  });

  it("allows retry only after reconciliation positively proves it retryable", async () => {
    const { route: baseRoute, database } = await fixture();
    const route = directRoute(baseRoute);
    const scheduler = createConversationScheduler({ database });
    const admitted = await scheduler.admit(event(route, "retryable-interrupted"));
    if (!admitted.accepted) {
      throw new Error("expected retryable interrupted admission");
    }
    const { db } = openOpenClawStateDatabase(database);
    db.prepare(
      `UPDATE conversation_scheduler_events
       SET state = 'running', dispatch_attempt_id = 'attempt-retryable', run_correlation_id = 'run-retryable'
       WHERE event_id = 'retryable-interrupted'`,
    ).run();
    db.prepare(
      `UPDATE conversation_scheduler_lanes SET active_event_id = 'retryable-interrupted'
       WHERE lane_key = ?`,
    ).run(route.queueLaneKey);
    const batches: SchedulerDispatchBatch[] = [];
    const recovered = createConversationScheduler({
      database,
      reconcileInterruptedAttempt: async () => ({
        status: "retryable",
        evidence: { kind: "provider_confirmed_not_delivered" },
      }),
      dispatch: async (batch) => {
        batches.push(batch);
        return delivered(batch);
      },
    });
    await eventually(() => {
      const row = db
        .prepare(
          `SELECT state FROM conversation_scheduler_events
           WHERE event_id = 'retryable-interrupted'`,
        )
        .get() as Record<string, unknown>;
      return row.state === "failed";
    });

    expect(batches).toEqual([]);
    expect(
      db
        .prepare(
          `SELECT failure_json FROM conversation_scheduler_events
           WHERE event_id = 'retryable-interrupted'`,
        )
        .get(),
    ).toMatchObject({
      failure_json: JSON.stringify({
        kind: "restart_reconciliation_retryable",
        evidence: { kind: "provider_confirmed_not_delivered" },
      }),
    });

    await recovered.retryReceipt(admitted.receiptId);
    await eventually(() => batches.length === 1);
    await eventually(async () => (await recovered.snapshot(route)).lanes[0]?.pendingCount === 0);
  });

  it("cancels every nonterminal event in the lane", async () => {
    const { route, database } = await fixture();
    const scheduler = createConversationScheduler({ database });
    await scheduler.admit(event(route, "event-1"));
    await scheduler.admit(event(route, "event-2"));
    await scheduler.stopSession(route, { descendants: true });
    expect(await scheduler.snapshot(route)).toMatchObject({
      lanes: [{ pendingCount: 0, callbackPendingCount: 0 }],
    });
  });

  it("cancels one receipt without terminalizing its sibling", async () => {
    const { route, database } = await fixture();
    const scheduler = createConversationScheduler({ database });
    const first = await scheduler.admit(event(route, "cancel-one"));
    const second = await scheduler.admit(event(route, "keep-one"));
    if (!first.accepted || !second.accepted) {
      throw new Error("expected scheduler admissions");
    }

    await expect(scheduler.cancelReceipt(first.receiptId)).resolves.toBe(true);
    expect(await scheduler.waitForReceiptTerminal?.(first.receiptId)).toBe("cancelled");
    expect(await scheduler.snapshot(route)).toMatchObject({
      lanes: [{ pendingCount: 1, outstandingCount: 1 }],
    });
  });

  it("cancels descendant lanes without touching unrelated conversations", async () => {
    const { route, database } = await fixture();
    const childRoute = {
      ...route,
      queueLaneKey: `${route.queueLaneKey}-child`,
      sessionKey: `${route.sessionKey}:subagent:child`,
      transcriptOwner: {
        ...route.transcriptOwner,
        sessionKey: `${route.sessionKey}:subagent:child`,
      },
    };
    const unrelatedRoute = directRoute(route, "-unrelated");
    const scheduler = createConversationScheduler({ database });
    await scheduler.admit(event(route, "root"));
    await scheduler.admit(event(childRoute, "child"));
    await scheduler.admit(event(unrelatedRoute, "unrelated"));
    await scheduler.stopSession(route, { descendants: true });
    expect((await scheduler.snapshot(route)).lanes[0]?.pendingCount).toBe(0);
    expect((await scheduler.snapshot(childRoute)).lanes[0]?.pendingCount).toBe(0);
    expect((await scheduler.snapshot(unrelatedRoute)).lanes[0]?.pendingCount).toBe(1);
  });

  it("rejects capacity without silently evicting accepted rows", async () => {
    const { route, database } = await fixture();
    const scheduler = createConversationScheduler({ database, maxRows: 1 });
    expect(await scheduler.admit(event(route, "event-1"))).toMatchObject({ accepted: true });
    expect(await scheduler.admit(event(route, "event-2"))).toEqual({
      accepted: false,
      reason: "storage_failed",
    });
    expect((await scheduler.snapshot(route)).lanes[0]?.pendingCount).toBe(1);
  });
});
