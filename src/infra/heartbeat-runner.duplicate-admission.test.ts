import { beforeEach, describe, expect, it, vi } from "vitest";

const schedulerMocks = vi.hoisted(() => ({
  admit: vi.fn(),
  waitForReceiptTerminal: vi.fn(),
  register: vi.fn(() => vi.fn()),
}));

vi.mock("../scheduler/runtime-conversation-scheduler.js", () => ({
  getRuntimeConversationScheduler: () => ({
    admit: schedulerMocks.admit,
    waitForReceiptTerminal: schedulerMocks.waitForReceiptTerminal,
  }),
  registerRuntimeConversationSchedulerProducer: schedulerMocks.register,
}));

const { admitRuntimeHeartbeatWake } = await import("./heartbeat-runner.js");

describe("heartbeat duplicate admission", () => {
  beforeEach(() => {
    schedulerMocks.admit.mockReset();
    schedulerMocks.waitForReceiptTerminal.mockReset();
  });

  it("resolves an accepted duplicate whose durable receipt is already terminal", async () => {
    schedulerMocks.admit.mockResolvedValue({
      accepted: true,
      receiptId: "receipt-terminal",
      durableAt: 1,
    });
    schedulerMocks.waitForReceiptTerminal.mockResolvedValue("delivered");

    const admission = await admitRuntimeHeartbeatWake({
      cfg: {},
      agentId: "main",
      sessionKey: "agent:main:discord:channel:ops",
      source: "exec-event",
      intent: "event",
      sourceGeneration: "exec-1:1:1",
      producerKind: "exec_completion",
    });

    expect(admission.accepted).toBe(true);
    if (!admission.accepted) {
      throw new Error("expected scheduler ownership");
    }
    await expect(admission.completion).resolves.toEqual({
      status: "skipped",
      reason: "duplicate-terminal",
    });
  });

  it.each([
    ["delivered", { status: "skipped", reason: "duplicate-terminal" }],
    ["failed", { status: "failed", reason: "duplicate-failed" }],
  ] as const)(
    "observes a duplicate running receipt until it becomes %s",
    async (state, expected) => {
      let resolveTerminal!: (state: "delivered" | "failed") => void;
      schedulerMocks.admit.mockResolvedValue({
        accepted: true,
        receiptId: `receipt-${state}`,
        durableAt: 1,
      });
      schedulerMocks.waitForReceiptTerminal.mockReturnValue(
        new Promise((resolve) => {
          resolveTerminal = resolve;
        }),
      );

      const admission = await admitRuntimeHeartbeatWake({
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:discord:channel:ops",
        source: "exec-event",
        intent: "event",
        sourceGeneration: `exec-${state}:1:1`,
        producerKind: "exec_completion",
      });
      if (!admission.accepted) {
        throw new Error("expected scheduler ownership");
      }
      let settled = false;
      void admission.completion.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      resolveTerminal(state);

      await expect(admission.completion).resolves.toEqual(expected);
    },
  );
});
