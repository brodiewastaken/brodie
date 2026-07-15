import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SchedulerDispatchBatch } from "./conversation-scheduler.js";

const runtimeMocks = vi.hoisted(() => ({
  admit: vi.fn(),
  waitForReceiptTerminal: vi.fn(),
  registration: undefined as
    | import("./scheduler-producer-registry.js").SchedulerProducerRegistration
    | undefined,
}));

vi.mock("./runtime-conversation-scheduler.js", () => ({
  getRuntimeConversationScheduler: () => ({
    admit: runtimeMocks.admit,
    waitForReceiptTerminal: runtimeMocks.waitForReceiptTerminal,
  }),
  registerRuntimeConversationSchedulerProducer: (
    registration: import("./scheduler-producer-registry.js").SchedulerProducerRegistration,
  ) => {
    runtimeMocks.registration = registration;
    return vi.fn();
  },
}));

const {
  admitRuntimeTurnThroughScheduler,
  buildScheduledRuntimeTurnEvent,
  dispatchScheduledRuntimeTurnBatch,
  runRuntimeTurnThroughScheduler,
} = await import("./runtime-turn-admission.js");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function batchFor(
  event: ReturnType<typeof buildScheduledRuntimeTurnEvent>,
  placement: "idle" | "recovery" = "idle",
): SchedulerDispatchBatch {
  return {
    attemptId: "attempt-1",
    placement,
    events: [{ ...event, receiptId: "receipt-1", sequence: 1 }],
    recordRunCorrelationId: vi.fn(),
    recordRunStarted: vi.fn(),
    recordRunTerminalOutcome: vi.fn(),
  };
}

describe("runtime turn scheduler", () => {
  beforeEach(() => {
    runtimeMocks.admit.mockReset();
    runtimeMocks.waitForReceiptTerminal.mockReset();
  });

  it("builds stable talk and voice identities on the exact source route", () => {
    const first = buildScheduledRuntimeTurnEvent({
      producerKind: "talk",
      agentId: "main",
      sessionKey: "agent:main:discord:channel:ops",
      callId: "call-1",
      turnId: "turn-1",
    });
    const duplicate = buildScheduledRuntimeTurnEvent({
      producerKind: "talk",
      agentId: "main",
      sessionKey: "agent:main:discord:channel:ops",
      callId: "call-1",
      turnId: "turn-1",
    });
    const nextTurn = buildScheduledRuntimeTurnEvent({
      producerKind: "talk",
      agentId: "main",
      sessionKey: "agent:main:discord:channel:ops",
      callId: "call-1",
      turnId: "turn-2",
    });

    expect(duplicate.id).toBe(first.id);
    expect(nextTurn.id).not.toBe(first.id);
    expect(first.route.sessionKey).toBe("agent:main:discord:channel:ops");
    expect(first.route.conversationId).toBe("agent:main:discord:channel:ops");
    expect(first.payload).toEqual(
      expect.objectContaining({
        producerKind: "talk",
        callId: "call-1",
        turnId: "turn-1",
        runId: `talk:${first.id}`,
      }),
    );
  });

  it("admits before model work and remains pending until the exact run returns", async () => {
    const terminal = deferred<{ text: string }>();
    const order: string[] = [];
    const execute = vi.fn(() => {
      order.push("execute");
      return terminal.promise;
    });
    let dispatched: Promise<unknown> | undefined;
    runtimeMocks.admit.mockImplementation(async (event) => {
      const batch = batchFor(event);
      batch.recordRunCorrelationId = () => order.push("correlate");
      batch.recordRunStarted = () => order.push("started-evidence");
      dispatched = runtimeMocks.registration?.dispatch(batch);
      return { accepted: true, receiptId: "receipt-1", durableAt: 1 };
    });

    let settled = false;
    const admitted = await admitRuntimeTurnThroughScheduler({
      producerKind: "voice",
      agentId: "main",
      sessionKey: "agent:main:voice:call-1",
      callId: "call-1",
      turnId: "turn-1",
      execute,
    });
    void admitted.completion.finally(() => {
      settled = true;
    });
    await admitted.started;
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    expect(order).toEqual(["correlate", "started-evidence", "execute"]);
    expect(settled).toBe(false);
    expect((execute.mock.calls as unknown[][])[0]?.[0]).toMatch(/^voice:[a-f0-9]{64}$/);
    terminal.resolve({ text: "hello" });

    await expect(admitted.completion).resolves.toEqual({ text: "hello" });
    await expect(dispatched).resolves.toEqual(expect.objectContaining({ outcome: "completed" }));
  });

  it("shares one embedded execution across concurrent duplicate turn admissions", async () => {
    const terminal = deferred<string>();
    const execute = vi.fn(() => terminal.promise);
    let admitted = 0;
    runtimeMocks.admit.mockImplementation(async (event) => {
      admitted += 1;
      if (admitted === 1) {
        queueMicrotask(() => void runtimeMocks.registration?.dispatch(batchFor(event)));
      }
      return { accepted: true, receiptId: "receipt-1", durableAt: 1 };
    });
    const params = {
      producerKind: "talk" as const,
      agentId: "main",
      sessionKey: "agent:main:talk:call-1",
      callId: "call-1",
      turnId: "turn-1",
      execute,
    };

    const first = runRuntimeTurnThroughScheduler(params);
    const duplicate = runRuntimeTurnThroughScheduler(params);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    terminal.resolve("answer");

    await expect(Promise.all([first, duplicate])).resolves.toEqual(["answer", "answer"]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("fails recovered work without blindly launching a second model run", async () => {
    const event = buildScheduledRuntimeTurnEvent({
      producerKind: "voice",
      agentId: "main",
      sessionKey: "agent:main:voice:call-1",
      callId: "call-1",
      turnId: "turn-1",
    });
    const batch = batchFor(structuredClone(event), "recovery");

    await expect(dispatchScheduledRuntimeTurnBatch(batch)).resolves.toEqual(
      expect.objectContaining({
        outcome: "failed",
        failure: expect.objectContaining({ kind: "runtime_turn_interrupted" }),
        runCorrelationId: `voice:${event.id}`,
      }),
    );
    expect(batch.recordRunCorrelationId).not.toHaveBeenCalled();
    expect(batch.recordRunStarted).not.toHaveBeenCalled();
  });

  it("rejects a duplicate terminal receipt without executing or hanging", async () => {
    runtimeMocks.admit.mockResolvedValue({
      accepted: true,
      receiptId: "receipt-terminal",
      durableAt: 1,
      existingState: "delivered",
    });
    const execute = vi.fn(async () => "should not run");

    const params = {
      producerKind: "talk" as const,
      agentId: "main",
      sessionKey: "agent:main:talk:call-1",
      callId: "call-1",
      turnId: "turn-1",
      execute,
    };
    await expect(admitRuntimeTurnThroughScheduler(params)).resolves.toMatchObject({
      durablyAccepted: true,
      existingTerminalState: "delivered",
    });
    await expect(runRuntimeTurnThroughScheduler(params)).rejects.toThrow(
      "talk turn was already completed",
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
