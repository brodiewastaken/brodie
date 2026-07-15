import { describe, expect, it, vi } from "vitest";
import { testing as heartbeatTesting } from "../infra/heartbeat-runner.js";
import type {
  AdmissionResult,
  ScheduledEvent,
  SchedulerDispatchBatch,
} from "../scheduler/conversation-scheduler.js";
import type { SchedulerProducerRegistration } from "../scheduler/scheduler-producer-registry.js";
import {
  buildScheduledCronEvent,
  registerCronSchedulerProducer,
  runCronThroughScheduler,
} from "./scheduler-admission.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { executeJobCore, executeJobCoreDirect } from "./service/timer.js";
import type { CronJob } from "./types.js";

function mainJob(now: number): CronJob {
  return {
    id: "durable-main-job",
    name: "durable main job",
    enabled: true,
    createdAtMs: now - 60_000,
    updatedAtMs: now - 60_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now - 60_000 },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "durable cron tick" },
    state: { runningAtMs: now },
  };
}

function baseDeps(now: number) {
  return {
    storePath: "/tmp/openclaw-cron-scheduler-admission-test.json",
    cronEnabled: true,
    log: createNoopLogger(),
    nowMs: () => now,
    enqueueSystemEvent: vi.fn(() => ({ accepted: true })),
    requestHeartbeat: vi.fn(),
    runHeartbeatOnce: vi.fn(async () => ({ status: "ran" as const, durationMs: 1 })),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  };
}

describe("cron scheduler admission", () => {
  it("keeps standalone cron execution inert when no runtime scheduler is injected", async () => {
    const now = 1_784_153_600_000;
    const deps = baseDeps(now);
    const state = createCronServiceState(deps);

    await expect(executeJobCore(state, mainJob(now))).resolves.toMatchObject({ status: "ok" });
    expect(deps.runHeartbeatOnce).toHaveBeenCalledOnce();
  });

  it("uses one durable cron receipt and executes the heartbeat inside that reservation", async () => {
    const now = 1_784_153_600_000;
    let registration: SchedulerProducerRegistration | undefined;
    const recordRunCorrelationId = vi.fn();
    const recordRunStarted = vi.fn();
    const recordRunTerminalOutcome = vi.fn();
    const admitted: ScheduledEvent[] = [];
    const scheduler = {
      admit: vi.fn(async (event: ScheduledEvent): Promise<AdmissionResult> => {
        admitted.push(event);
        const batch = {
          attemptId: "cron-attempt-1",
          placement: "idle",
          events: [{ ...event, receiptId: "cron-receipt-1", sequence: 1 }],
          recordRunCorrelationId,
          recordRunStarted,
          recordRunTerminalOutcome,
        } satisfies SchedulerDispatchBatch;
        queueMicrotask(() => void registration?.dispatch(batch));
        return { accepted: true, receiptId: "cron-receipt-1", durableAt: now };
      }),
    };
    const deps = {
      ...baseDeps(now),
      conversationScheduler: scheduler,
      registerConversationSchedulerProducer: (next: SchedulerProducerRegistration) => {
        registration = next;
        return () => {
          registration = undefined;
        };
      },
    };
    const state = createCronServiceState(deps);
    const unregister = registerCronSchedulerProducer({
      state,
      runDirect: async (job) => await executeJobCoreDirect(state, job),
    });

    const result = await executeJobCore(state, mainJob(now));

    expect(result).toMatchObject({ status: "ok" });
    expect(scheduler.admit).toHaveBeenCalledOnce();
    expect(admitted).toHaveLength(1);
    expect(admitted[0]).toMatchObject({ producerKind: "cron" });
    expect(deps.runHeartbeatOnce).toHaveBeenCalledOnce();
    expect(recordRunCorrelationId).toHaveBeenCalledWith("cron-attempt-1");
    expect(recordRunStarted).toHaveBeenCalledOnce();
    expect(recordRunTerminalOutcome).toHaveBeenCalledWith(
      "completed",
      expect.stringContaining(":outcome:completed"),
    );
    unregister?.();
  });

  it("keeps stable ids scoped to the exact cron run slot and source generation", () => {
    const now = 1_784_153_600_000;
    const state = createCronServiceState(baseDeps(now));
    const first = buildScheduledCronEvent({
      state,
      job: mainJob(now),
      dueSlotMs: now,
      producerGeneration: "cron-generation-1",
    });
    const duplicate = buildScheduledCronEvent({
      state,
      job: mainJob(now),
      dueSlotMs: now,
      producerGeneration: "cron-generation-1",
    });
    const next = buildScheduledCronEvent({
      state,
      job: mainJob(now + 60_000),
      dueSlotMs: now + 60_000,
      producerGeneration: "cron-generation-2",
    });

    expect(duplicate.id).toBe(first.id);
    expect(next.id).not.toBe(first.id);
    expect(first.route.sessionKey).toBe("agent:main:main");
    const explicit = buildScheduledCronEvent({
      state,
      job: { ...mainJob(now), sessionKey: "agent:main:discord:channel:ops" },
      dueSlotMs: now,
      producerGeneration: "cron-generation-explicit",
    });
    expect(explicit.route.sessionKey).toBe("agent:main:discord:channel:ops");
  });

  it.each([
    ["delivered", { status: "ok" }],
    ["failed", { status: "error", error: "duplicate cron receipt is failed" }],
  ] as const)(
    "settles an already-terminal duplicate receipt in state %s",
    async (receiptState, expected) => {
      const now = 1_784_153_600_000;
      const scheduler = {
        admit: vi.fn(async () => ({
          accepted: true as const,
          receiptId: "terminal",
          durableAt: now,
        })),
        waitForReceiptTerminal: vi.fn(async () => receiptState),
      };
      const state = createCronServiceState({ ...baseDeps(now), conversationScheduler: scheduler });
      const runDirect = vi.fn();

      await expect(
        runCronThroughScheduler({
          state,
          job: mainJob(now),
          dueSlotMs: now,
          producerGeneration: "duplicate-terminal",
          runDirect,
        }),
      ).resolves.toEqual(expected);
      expect(runDirect).not.toHaveBeenCalled();
    },
  );

  it("dispatches a cron-triggered heartbeat under the existing cron producer owner", async () => {
    const now = 1_784_153_600_000;
    let registration: SchedulerProducerRegistration | undefined;
    const deps = {
      ...baseDeps(now),
      conversationScheduler: { admit: vi.fn() },
      registerConversationSchedulerProducer: (next: SchedulerProducerRegistration) => {
        registration = next;
        return vi.fn();
      },
    };
    const state = createCronServiceState(deps);
    const runDirect = vi.fn();
    const runHeartbeatEvent = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));
    registerCronSchedulerProducer({ state, runDirect, runHeartbeatEvent });
    const event = heartbeatTesting.buildScheduledHeartbeatEvent({
      cfg: {},
      agentId: "main",
      sessionKey: "agent:main:cron:durable-main-job:run:1784153600000",
      source: "cron",
      intent: "immediate",
      sourceGeneration: "cron-wake-generation",
    });
    const recordRunTerminalOutcome = vi.fn();

    const result = await registration?.dispatch({
      attemptId: "cron-heartbeat-attempt",
      placement: "idle",
      events: [{ ...event, receiptId: "receipt", sequence: 1 }],
      recordRunCorrelationId: vi.fn(),
      recordRunStarted: vi.fn(),
      recordRunTerminalOutcome,
    });

    expect(event.producerKind).toBe("cron");
    expect(runHeartbeatEvent).toHaveBeenCalledOnce();
    expect(runDirect).not.toHaveBeenCalled();
    expect(recordRunTerminalOutcome).toHaveBeenCalledWith(
      "completed",
      expect.stringContaining(":outcome:completed"),
    );
    expect(result).toMatchObject({ outcome: "completed" });
  });

  it("restores cron producer ownership when the same service stops and starts", async () => {
    const now = 1_784_153_600_000;
    const unregister = vi.fn();
    const register = vi.fn(() => unregister);
    const service = new CronService({
      ...baseDeps(now),
      cronEnabled: false,
      conversationScheduler: { admit: vi.fn() },
      registerConversationSchedulerProducer: register,
    });

    expect(register).toHaveBeenCalledOnce();
    service.stop();
    expect(unregister).toHaveBeenCalledOnce();

    await service.start();
    expect(register).toHaveBeenCalledTimes(2);
  });
});
