import { describe, expect, it, vi } from "vitest";
import type {
  ScheduledEvent,
  SchedulerDispatchBatch,
  SchedulerDispatchResult,
  SchedulerSettlement,
} from "./conversation-scheduler.js";
import { createSchedulerProducerRegistry } from "./scheduler-producer-registry.js";

function batch(producerKind: ScheduledEvent["producerKind"]): SchedulerDispatchBatch {
  return {
    attemptId: "attempt-1",
    placement: "idle",
    events: [
      {
        id: "event-1",
        route: {
          channel: "internal",
          accountId: "internal",
          conversationKind: "direct",
          conversationId: "controller",
          sessionKey: "agent:main:conversation:test:default:direct:controller",
          queueLaneKey: "controller-lane",
          transcriptOwner: {
            agentId: "main",
            sessionKey: "agent:main:conversation:test:default:direct:controller",
          },
        },
        producerKind,
        createdAt: 1,
        human: false,
        media: false,
        payload: { taskRunId: "task-1" },
        receiptId: "receipt-1",
        sequence: 1,
      },
    ],
  };
}

const completed: SchedulerDispatchResult = {
  outcome: "completed",
  transcriptEvidence: "controller:task-1",
};

describe("SchedulerProducerRegistry", () => {
  it("wakes the scheduler when a producer registers after durable admission", async () => {
    const onProducerAvailable = vi.fn();
    const dispatch = vi.fn(async () => completed);
    const registry = createSchedulerProducerRegistry({ onProducerAvailable });

    expect(registry.owns("subagent_completion")).toBe(false);
    const unregister = registry.register({
      producerKinds: ["subagent_completion"],
      dispatch,
    });

    expect(registry.owns("subagent_completion")).toBe(true);
    expect(onProducerAvailable).toHaveBeenCalledTimes(1);
    await expect(registry.dispatch(batch("subagent_completion"))).resolves.toEqual(completed);
    expect(dispatch).toHaveBeenCalledTimes(1);

    unregister();
    expect(registry.owns("subagent_completion")).toBe(false);
  });

  it("rejects competing owners and batches that cross producer ownership", async () => {
    const registry = createSchedulerProducerRegistry();
    const first = vi.fn(async () => completed);
    const second = vi.fn(async () => completed);
    registry.register({ producerKinds: ["human_message", "human_media"], dispatch: first });

    expect(() => registry.register({ producerKinds: ["human_message"], dispatch: second })).toThrow(
      "already registered",
    );

    const firstEvent = batch("human_message").events[0]!;
    const crossed: SchedulerDispatchBatch = {
      attemptId: "attempt-crossed",
      placement: "idle",
      events: [firstEvent, { ...firstEvent, id: "event-2", producerKind: "cron" }],
    };
    await expect(registry.dispatch(crossed)).rejects.toThrow("crossed producer ownership");
    expect(first).not.toHaveBeenCalled();
  });

  it("routes transcript-backed settlement to the producer that owns the event", async () => {
    const registry = createSchedulerProducerRegistry();
    const settle = vi.fn(async (_settlement: SchedulerSettlement) => {});
    registry.register({
      producerKinds: ["subagent_completion"],
      dispatch: async () => completed,
      settle,
    });
    const event = batch("subagent_completion").events[0]!;
    const settlement: SchedulerSettlement = {
      event,
      transcriptEvidence: "transcript:controller-run",
      runCorrelationId: "controller-run",
    };

    await registry.settle(settlement);

    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(settlement);
  });

  it("rejects settlement until the owning producer is registered", async () => {
    const registry = createSchedulerProducerRegistry();
    const event = batch("subagent_completion").events[0]!;

    await expect(
      registry.settle({
        event,
        transcriptEvidence: "transcript:controller-run",
        runCorrelationId: "controller-run",
      }),
    ).rejects.toThrow("not registered for settlement");
  });
});
