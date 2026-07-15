import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SchedulerDispatchBatch } from "../scheduler/conversation-scheduler.js";
import { testing } from "./heartbeat-runner.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "./system-events.js";

const cfg = {} satisfies OpenClawConfig;

afterEach(() => {
  resetSystemEventsForTest();
});

function buildEvent(
  overrides: {
    sourceGeneration?: string;
    dueSlotMs?: number;
    sessionKey?: string;
  } = {},
) {
  return testing.buildScheduledHeartbeatEvent({
    cfg,
    agentId: "main",
    sessionKey: overrides.sessionKey ?? "agent:main:discord:channel:ops",
    source: "interval",
    intent: "scheduled",
    reason: "interval",
    runScope: "global",
    sourceGeneration: overrides.sourceGeneration ?? "wake-generation-1",
    dueSlotMs: overrides.dueSlotMs ?? 1_784_153_600_000,
  });
}

describe("heartbeat scheduler admission", () => {
  it("derives a stable id from the exact source session, wake generation, and due slot", () => {
    const first = buildEvent();
    const duplicate = buildEvent();
    const nextWake = buildEvent({ sourceGeneration: "wake-generation-2" });
    const nextSlot = buildEvent({ dueSlotMs: 1_784_155_400_000 });

    expect(duplicate.id).toBe(first.id);
    expect(nextWake.id).not.toBe(first.id);
    expect(nextSlot.id).not.toBe(first.id);
    expect(first.route.sessionKey).toBe("agent:main:discord:channel:ops");
    expect(first.route.conversationId).toBe("agent:main:discord:channel:ops");
  });

  it.each([
    ["interval", "heartbeat"],
    ["manual", "heartbeat"],
    ["retry", "heartbeat"],
    ["other", "heartbeat"],
    ["exec-event", "exec_completion"],
    ["cli-watchdog", "exec_completion"],
    ["cron", "cron"],
    ["hook", "hook"],
    ["restart-sentinel", "restart"],
    ["notifications-event", "system"],
    ["background-task", "system"],
    ["background-task-blocked", "system"],
    ["acp-spawn", "system"],
  ] as const)("maps %s wakes to the %s producer", (source, producerKind) => {
    const event = testing.buildScheduledHeartbeatEvent({
      cfg,
      agentId: "main",
      sessionKey: "agent:main:discord:channel:ops",
      source,
      intent: "event",
      sourceGeneration: "source-generation",
    });

    expect(event.producerKind).toBe(producerKind);
  });

  it("reconstructs dispatch from the durable payload and records lifecycle evidence", async () => {
    const event = structuredClone(buildEvent());
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped" as const, reason: "requests-in-flight" })
      .mockResolvedValueOnce({ status: "ran" as const, durationMs: 4 });
    const recordRunCorrelationId = vi.fn();
    const recordRunStarted = vi.fn();
    const recordRunTerminalOutcome = vi.fn();
    const batch = {
      attemptId: "heartbeat-attempt-1",
      placement: "idle",
      events: [{ ...event, receiptId: "receipt-1", sequence: 1 }],
      recordRunCorrelationId,
      recordRunStarted,
      recordRunTerminalOutcome,
    } satisfies SchedulerDispatchBatch;

    const result = await testing.dispatchScheduledHeartbeatBatch(batch, {
      cfg,
      runOnce: runOnce as never,
      retryDelayMs: 0,
    });

    expect(runOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "agent:main:discord:channel:ops",
        source: "interval",
        intent: "scheduled",
        reason: "interval",
        runScope: "global",
      }),
    );
    expect(recordRunCorrelationId).toHaveBeenCalledWith("heartbeat-attempt-1");
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(recordRunStarted).toHaveBeenCalledOnce();
    expect(recordRunTerminalOutcome).toHaveBeenCalledWith(
      "completed",
      expect.stringContaining(":outcome:completed"),
    );
    expect(result).toEqual(
      expect.objectContaining({ outcome: "completed", runCorrelationId: "heartbeat-attempt-1" }),
    );
  });

  it("reconstructs the exact system event from durable payload before a restart replay runs", async () => {
    const sessionKey = "agent:main:discord:channel:ops";
    const event = structuredClone(
      testing.buildScheduledHeartbeatEvent({
        cfg,
        agentId: "main",
        sessionKey,
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        sourceGeneration: "exec-1:started-1:pid-1",
        producerKind: "exec_completion",
        systemEvent: {
          text: "Exec completed (exec-1, code 0) :: deployment finished",
          contextKey: "Discord:Ops",
          deliveryContext: { channel: "discord", to: "channel:ops" },
        },
      }),
    );
    resetSystemEventsForTest();
    const runOnce = vi.fn(async () => {
      expect(peekSystemEventEntries(sessionKey)).toEqual([
        expect.objectContaining({
          text: "Exec completed (exec-1, code 0) :: deployment finished",
          contextKey: "discord:ops",
          deliveryContext: { channel: "discord", to: "channel:ops" },
        }),
      ]);
      return { status: "ran" as const, durationMs: 1 };
    });
    const batch = {
      attemptId: "heartbeat-replay-1",
      placement: "idle",
      events: [{ ...event, receiptId: "receipt-replay-1", sequence: 1 }],
      recordRunCorrelationId: vi.fn(),
      recordRunStarted: vi.fn(),
      recordRunTerminalOutcome: vi.fn(),
    } satisfies SchedulerDispatchBatch;

    await testing.dispatchScheduledHeartbeatBatch(batch, {
      cfg,
      runOnce: runOnce as never,
    });
    await testing.dispatchScheduledHeartbeatBatch(batch, {
      cfg,
      runOnce: runOnce as never,
    });

    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(peekSystemEventEntries(sessionKey)).toHaveLength(1);
  });
});
