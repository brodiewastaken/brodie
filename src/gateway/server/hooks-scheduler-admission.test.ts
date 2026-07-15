import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../../cron/types.js";
import type { SchedulerProducerRegistration } from "../../scheduler/scheduler-producer-registry.js";

const runtimeMocks = vi.hoisted(() => ({
  admit: vi.fn(),
  register: vi.fn(),
}));
const executeScheduledHeartbeatEventMock = vi.hoisted(() => vi.fn());

vi.mock("../../scheduler/runtime-conversation-scheduler.js", () => ({
  getRuntimeConversationScheduler: () => ({ admit: runtimeMocks.admit }),
  registerRuntimeConversationSchedulerProducer: runtimeMocks.register,
}));
vi.mock("../../infra/heartbeat-runner.js", () => ({
  executeScheduledHeartbeatEvent: executeScheduledHeartbeatEventMock,
}));

const {
  admitScheduledHook,
  buildScheduledHookEvent,
  ensureHookSchedulerProducerRegistered,
  resetHookSchedulerProducerRegistrationForTests,
} = await import("./hooks-scheduler-admission.js");

function hookJob(): CronJob {
  return {
    id: "hook-job-1",
    agentId: "main",
    name: "Email",
    enabled: true,
    createdAtMs: 1_784_153_600_000,
    updatedAtMs: 1_784_153_600_000,
    schedule: { kind: "at", at: "2026-07-16T00:00:00.000Z" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "process email" },
    delivery: { mode: "none" },
    state: { nextRunAtMs: 1_784_153_600_000 },
  };
}

function hookPayload() {
  return {
    version: 1 as const,
    kind: "hook_run" as const,
    job: hookJob(),
    message: "process email",
    sessionKey: "agent:main:main",
    lane: "cron" as const,
    runId: "hook-run-1",
    sourcePath: "/hooks/agent",
    sourceGeneration: "hook-generation-1",
  };
}

describe("hook scheduler admission", () => {
  afterEach(() => {
    resetHookSchedulerProducerRegistrationForTests();
    vi.clearAllMocks();
  });

  it("durably admits a reconstructable hook turn on the exact source session", async () => {
    runtimeMocks.register.mockReturnValue(vi.fn());
    runtimeMocks.admit.mockResolvedValue({
      accepted: true,
      receiptId: "hook-receipt-1",
      durableAt: 1_784_153_600_001,
    });
    const execute = vi.fn(async () => ({ ok: true as const }));
    ensureHookSchedulerProducerRegistered(execute);

    const admission = await admitScheduledHook(hookPayload());

    expect(admission).toMatchObject({ accepted: true, receiptId: "hook-receipt-1" });
    expect(runtimeMocks.admit).toHaveBeenCalledOnce();
    const event = runtimeMocks.admit.mock.calls[0]?.[0];
    expect(event).toMatchObject({
      producerKind: "hook",
      route: { sessionKey: "agent:main:main" },
      payload: hookPayload(),
    });
    expect(buildScheduledHookEvent(hookPayload()).id).toBe(event.id);
  });

  it("reconstructs and executes the durable hook payload under one run receipt", async () => {
    let registration: SchedulerProducerRegistration | undefined;
    runtimeMocks.register.mockImplementation((next: SchedulerProducerRegistration) => {
      registration = next;
      return vi.fn();
    });
    const execute = vi.fn(async () => ({ ok: true as const }));
    ensureHookSchedulerProducerRegistered(execute);
    const event = buildScheduledHookEvent(hookPayload());
    const recordRunTerminalOutcome = vi.fn();

    const result = await registration?.dispatch({
      attemptId: "hook-attempt-1",
      placement: "idle",
      events: [{ ...event, receiptId: "hook-receipt-1", sequence: 1 }],
      recordRunCorrelationId: vi.fn(),
      recordRunStarted: vi.fn(),
      recordRunTerminalOutcome,
    });

    expect(execute).toHaveBeenCalledWith(hookPayload());
    expect(recordRunTerminalOutcome).toHaveBeenCalledWith(
      "completed",
      expect.stringContaining(":outcome:completed"),
    );
    expect(result).toMatchObject({ outcome: "completed" });
  });

  it("records a terminal failed outcome when the reconstructed hook run fails", async () => {
    let registration: SchedulerProducerRegistration | undefined;
    runtimeMocks.register.mockImplementation((next: SchedulerProducerRegistration) => {
      registration = next;
      return vi.fn();
    });
    const execute = vi.fn(async () => ({ ok: false as const, reason: "hook model failed" }));
    ensureHookSchedulerProducerRegistered(execute);
    const event = buildScheduledHookEvent(hookPayload());

    const result = await registration?.dispatch({
      attemptId: "hook-attempt-failed",
      placement: "idle",
      events: [{ ...event, receiptId: "hook-receipt-failed", sequence: 1 }],
      recordRunCorrelationId: vi.fn(),
      recordRunStarted: vi.fn(),
      recordRunTerminalOutcome: vi.fn(),
    });

    expect(result).toMatchObject({
      outcome: "failed",
      failure: {
        kind: "hook_failed",
        failures: [{ eventId: event.id, reason: "hook model failed" }],
      },
    });
  });

  it("multiplexes hook-owned heartbeat payloads without a second owner", async () => {
    let registration: SchedulerProducerRegistration | undefined;
    runtimeMocks.register.mockImplementation((next: SchedulerProducerRegistration) => {
      registration = next;
      return vi.fn();
    });
    executeScheduledHeartbeatEventMock.mockResolvedValue({ status: "ran", durationMs: 1 });
    ensureHookSchedulerProducerRegistered(vi.fn(async () => ({ ok: true as const })));
    const event = {
      ...buildScheduledHookEvent(hookPayload()),
      payload: { kind: "heartbeat_wake" as const },
    };

    const result = await registration?.dispatch({
      attemptId: "hook-heartbeat-attempt-1",
      placement: "idle",
      events: [{ ...event, receiptId: "hook-heartbeat-receipt-1", sequence: 1 }],
      recordRunCorrelationId: vi.fn(),
      recordRunStarted: vi.fn(),
      recordRunTerminalOutcome: vi.fn(),
    });

    expect(executeScheduledHeartbeatEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { kind: "heartbeat_wake" } }),
    );
    expect(result).toMatchObject({ outcome: "completed" });
  });
});
