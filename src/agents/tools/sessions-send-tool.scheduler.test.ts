import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConversationRoute } from "../../routing/conversation-route.js";
import type {
  ScheduledEvent,
  SchedulerDispatchBatch,
  SchedulerDispatchResult,
} from "../../scheduler/conversation-scheduler.js";

const runtime = vi.hoisted(() => ({
  admit: vi.fn(),
  callGateway: vi.fn(),
  settle: vi.fn(),
  waitForReceiptTerminal: vi.fn(),
  registration: undefined as
    | {
        dispatch: (batch: SchedulerDispatchBatch) => Promise<SchedulerDispatchResult>;
      }
    | undefined,
  unregister: vi.fn(),
  resolveActiveEmbeddedRunSessionId: vi.fn(),
  queueEmbeddedAgentMessageWithOutcomeAsync: vi.fn(),
  waitForEmbeddedAgentRunEnd: vi.fn(),
  resolveActiveEmbeddedRunCorrelationId: vi.fn(),
}));

vi.mock("../embedded-agent-runner/runs.js", () => ({
  resolveActiveEmbeddedRunSessionId: runtime.resolveActiveEmbeddedRunSessionId,
  queueEmbeddedAgentMessageWithOutcomeAsync: runtime.queueEmbeddedAgentMessageWithOutcomeAsync,
  waitForEmbeddedAgentRunEnd: runtime.waitForEmbeddedAgentRunEnd,
  resolveActiveEmbeddedRunCorrelationId: runtime.resolveActiveEmbeddedRunCorrelationId,
  formatEmbeddedAgentQueueFailureSummary: vi.fn(() => undefined),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: runtime.callGateway,
}));

vi.mock("../../scheduler/runtime-conversation-scheduler.js", () => ({
  getRuntimeConversationScheduler: () => ({
    admit: runtime.admit,
    settle: runtime.settle,
    waitForReceiptTerminal: runtime.waitForReceiptTerminal,
  }),
  registerRuntimeConversationSchedulerProducer: (registration: typeof runtime.registration) => {
    runtime.registration = registration;
    return runtime.unregister;
  },
}));

import {
  ensureSessionsSendSchedulerProducerRegistered,
  sessionsSendSchedulerTesting,
  startSessionsSendThroughScheduler,
} from "./sessions-send-tool.scheduler.js";

const targetRoute = resolveConversationRoute({
  cfg: {},
  channel: "discord",
  accountId: "default",
  peer: { kind: "channel", id: "target-room" },
});

function sendParams() {
  return {
    message: "[Inter-session message]\nhello",
    sessionKey: targetRoute.sessionKey,
    idempotencyKey: "idempotency-1",
    deliver: false,
    sourceReplyDeliveryMode: "message_tool_only",
    channel: "internal",
    lane: "nested",
    extraSystemPrompt: "Agent-to-agent message context",
    inputProvenance: {
      kind: "inter_session",
      sourceSessionKey: undefined,
      sourceChannel: "discord",
      sourceTool: "sessions_send",
    },
  };
}

function batchFor(event: ScheduledEvent): {
  batch: SchedulerDispatchBatch;
  correlations: string[];
  starts: string[];
  terminals: Array<{ outcome: string; evidence: string }>;
} {
  const correlations: string[] = [];
  const starts: string[] = [];
  const terminals: Array<{ outcome: string; evidence: string }> = [];
  return {
    batch: {
      attemptId: "attempt-1",
      placement: "idle",
      events: [{ ...event, receiptId: "receipt-1", sequence: 1 }],
      recordRunCorrelationId: (runId) => correlations.push(runId),
      recordRunStarted: (evidence) => starts.push(evidence),
      recordRunTerminalOutcome: (outcome, evidence) => terminals.push({ outcome, evidence }),
    },
    correlations,
    starts,
    terminals,
  };
}

function requireRegistration() {
  if (!runtime.registration) {
    throw new Error("sessions_send scheduler producer was not registered");
  }
  return runtime.registration;
}

describe("sessions_send scheduler ownership", () => {
  beforeEach(() => {
    sessionsSendSchedulerTesting.reset();
    runtime.admit.mockReset();
    runtime.callGateway.mockReset();
    runtime.settle.mockReset();
    runtime.settle.mockResolvedValue(true);
    runtime.waitForReceiptTerminal.mockReset();
    runtime.registration = undefined;
    runtime.unregister.mockClear();
    runtime.resolveActiveEmbeddedRunSessionId.mockReset();
    runtime.queueEmbeddedAgentMessageWithOutcomeAsync.mockReset();
    runtime.waitForEmbeddedAgentRunEnd.mockReset();
    runtime.resolveActiveEmbeddedRunCorrelationId.mockReset();
  });

  afterEach(() => {
    sessionsSendSchedulerTesting.reset();
  });

  it("builds a stable restartable event on the exact target route", () => {
    const first = sessionsSendSchedulerTesting.buildSessionsSendEvent({
      runId: "run-1",
      sendParams: sendParams(),
      targetSessionKey: targetRoute.sessionKey,
      displayKey: "target display",
      deliveryTimeoutMs: 30_000,
      allowActiveRunQueueDelivery: true,
    });
    const second = sessionsSendSchedulerTesting.buildSessionsSendEvent({
      runId: "run-1",
      sendParams: sendParams(),
      targetSessionKey: targetRoute.sessionKey,
      displayKey: "target display",
      deliveryTimeoutMs: 30_000,
      allowActiveRunQueueDelivery: true,
    });

    expect(second.id).toBe(first.id);
    expect(first.route).toMatchObject({
      channel: "discord",
      accountId: "default",
      conversationId: "target-room",
      sessionKey: targetRoute.sessionKey,
      queueLaneKey: targetRoute.queueLaneKey,
    });
    expect(first.payload).toMatchObject({
      version: 1,
      runId: "run-1",
      targetSessionKey: targetRoute.sessionKey,
      displayKey: "target display",
      deliveryTimeoutMs: 30_000,
      allowActiveRunQueueDelivery: true,
      sendParams: {
        sessionKey: targetRoute.sessionKey,
        idempotencyKey: "idempotency-1",
        inputProvenance: {
          kind: "inter_session",
          sourceChannel: "discord",
          sourceTool: "sessions_send",
        },
      },
    });
    expect(JSON.stringify(first.payload)).not.toContain("undefined");
  });

  it("returns accepted ownership as pending until the exact run terminalizes", async () => {
    let resolveWait!: (value: { status: "ok" }) => void;
    const waitResult = new Promise<{ status: "ok" }>((resolve) => {
      resolveWait = resolve;
    });
    const gatewayCall = vi.fn(async (request: { method?: string }) =>
      request.method === "agent.wait" ? await waitResult : { runId: "agent-run-1" },
    );
    let fixture: ReturnType<typeof batchFor> | undefined;
    let dispatchPromise: Promise<SchedulerDispatchResult> | undefined;
    runtime.admit.mockImplementation(async (event: ScheduledEvent) => {
      fixture = batchFor(event);
      dispatchPromise = requireRegistration().dispatch(fixture.batch);
      return { accepted: true, receiptId: "receipt-1", durableAt: 10 };
    });

    const result = await startSessionsSendThroughScheduler({
      callGateway: gatewayCall as unknown as typeof import("../../gateway/call.js").callGateway,
      runId: "run-1",
      sendParams: sendParams(),
      targetSessionKey: targetRoute.sessionKey,
      displayKey: "target display",
      deliveryTimeoutMs: 30_000,
    });

    expect(result).toEqual({ ok: true, runId: "agent-run-1" });
    expect(gatewayCall).toHaveBeenNthCalledWith(1, {
      method: "agent",
      params: expect.objectContaining({
        sessionKey: targetRoute.sessionKey,
        idempotencyKey: "idempotency-1",
      }),
      timeoutMs: 10_000,
    });
    await expect(dispatchPromise).resolves.toEqual({
      outcome: "pending",
      runCorrelationId: "agent-run-1",
    });
    expect(fixture?.terminals).toEqual([]);
    expect(runtime.settle).not.toHaveBeenCalled();

    await vi.waitFor(() =>
      expect(gatewayCall.mock.calls.some(([request]) => request.method === "agent.wait")).toBe(
        true,
      ),
    );
    resolveWait({ status: "ok" });
    await vi.waitFor(() => expect(runtime.settle).toHaveBeenCalledTimes(1));
    expect(fixture?.terminals).toHaveLength(1);
    expect(runtime.settle).toHaveBeenCalledWith(
      "receipt-1",
      expect.objectContaining({
        outcome: "completed",
        runCorrelationId: "agent-run-1",
        transcriptEvidence: expect.stringContaining(":outcome:completed"),
      }),
    );
  });

  it("uses the native path once only when first admission declines", async () => {
    const gatewayCall = vi.fn(async () => ({ runId: "native-run" }));
    runtime.admit.mockResolvedValue({ accepted: false, reason: "storage_failed" });

    const result = await startSessionsSendThroughScheduler({
      callGateway: gatewayCall as unknown as typeof import("../../gateway/call.js").callGateway,
      runId: "run-1",
      sendParams: sendParams(),
      targetSessionKey: targetRoute.sessionKey,
      displayKey: "target display",
    });

    expect(result).toEqual({ ok: true, runId: "native-run" });
    expect(gatewayCall).toHaveBeenCalledTimes(1);
  });

  it.each(["delivered", "failed"] as const)(
    "settles an already-terminal duplicate receipt in state %s without redispatch",
    async (receiptState) => {
      const gatewayCall = vi.fn();
      runtime.admit.mockResolvedValue({ accepted: true, receiptId: "terminal", durableAt: 10 });
      runtime.waitForReceiptTerminal.mockResolvedValue(receiptState);

      const result = await startSessionsSendThroughScheduler({
        callGateway: gatewayCall as unknown as typeof import("../../gateway/call.js").callGateway,
        runId: "run-duplicate",
        sendParams: sendParams(),
        targetSessionKey: targetRoute.sessionKey,
        displayKey: "target display",
      });

      if (receiptState === "delivered") {
        expect(result).toEqual({ ok: true, runId: "run-duplicate", alreadyDelivered: true });
      } else {
        expect(result.ok).toBe(false);
        expect(result.ok ? undefined : result.result.details).toMatchObject({
          error: "duplicate sessions_send receipt is failed",
        });
      }
      expect(gatewayCall).not.toHaveBeenCalled();
    },
  );

  it("keeps concurrent duplicate waiters attached until one dispatch resolves them", async () => {
    const gatewayCall = vi.fn(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "ok" } : { runId: "agent-run-shared" },
    );
    let admitted = 0;
    runtime.admit.mockImplementation(async (event: ScheduledEvent) => {
      admitted += 1;
      if (admitted === 2) {
        queueMicrotask(() => void requireRegistration().dispatch(batchFor(event).batch));
      }
      return { accepted: true, receiptId: "receipt-shared", durableAt: 10 };
    });

    const params = {
      callGateway: gatewayCall as unknown as typeof import("../../gateway/call.js").callGateway,
      runId: "run-shared",
      sendParams: sendParams(),
      targetSessionKey: targetRoute.sessionKey,
      displayKey: "target display",
    };
    const first = startSessionsSendThroughScheduler(params);
    const second = startSessionsSendThroughScheduler(params);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, runId: "agent-run-shared" },
      { ok: true, runId: "agent-run-shared" },
    ]);
    expect(gatewayCall).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(runtime.settle).toHaveBeenCalledOnce());
  });

  it("does not retry natively after an accepted dispatch fails", async () => {
    const gatewayCall = vi.fn(async () => {
      throw new Error("agent dispatch failed");
    });
    runtime.admit.mockImplementation(async (event: ScheduledEvent) => {
      const fixture = batchFor(event);
      queueMicrotask(() => void requireRegistration().dispatch(fixture.batch));
      return { accepted: true, receiptId: "receipt-1", durableAt: 10 };
    });

    const result = await startSessionsSendThroughScheduler({
      callGateway: gatewayCall as unknown as typeof import("../../gateway/call.js").callGateway,
      runId: "run-1",
      sendParams: sendParams(),
      targetSessionKey: targetRoute.sessionKey,
      displayKey: "target display",
    });

    expect(result.ok).toBe(false);
    expect(gatewayCall).toHaveBeenCalledTimes(1);
  });

  it("keeps an injected active-run send pending until that exact embedded run ends", async () => {
    let resolveRunEnd!: (ended: boolean) => void;
    const runEnd = new Promise<boolean>((resolve) => {
      resolveRunEnd = resolve;
    });
    runtime.resolveActiveEmbeddedRunSessionId.mockReturnValue("embedded-session-1");
    runtime.queueEmbeddedAgentMessageWithOutcomeAsync.mockResolvedValue({ queued: true });
    runtime.waitForEmbeddedAgentRunEnd.mockReturnValue(runEnd);
    runtime.resolveActiveEmbeddedRunCorrelationId.mockReturnValue("embedded-run-1");
    const gatewayCall = vi.fn(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "ok" } : undefined,
    );
    let fixture: ReturnType<typeof batchFor> | undefined;
    runtime.admit.mockImplementation(async (event: ScheduledEvent) => {
      fixture = batchFor(event);
      queueMicrotask(() => void requireRegistration().dispatch(fixture!.batch));
      return { accepted: true, receiptId: "receipt-1", durableAt: 10 };
    });

    const result = await startSessionsSendThroughScheduler({
      callGateway: gatewayCall as unknown as typeof import("../../gateway/call.js").callGateway,
      runId: "run-1",
      sendParams: sendParams(),
      targetSessionKey: targetRoute.sessionKey,
      displayKey: "agent:main:cron:job-1:run:run-1",
      allowActiveRunQueueDelivery: true,
    });

    expect(result).toMatchObject({
      ok: true,
      runId: "run-1",
      activeRunQueue: true,
      activeRunQueueSessionId: "embedded-session-1",
      activeRunCorrelationId: "embedded-run-1",
    });
    await vi.waitFor(() =>
      expect(runtime.waitForEmbeddedAgentRunEnd).toHaveBeenCalledWith("embedded-session-1", 30_000),
    );
    expect(runtime.settle).not.toHaveBeenCalled();

    resolveRunEnd(true);
    await vi.waitFor(() => expect(runtime.settle).toHaveBeenCalledTimes(1));
    expect(fixture?.terminals).toHaveLength(1);
    expect(gatewayCall).toHaveBeenCalledWith({
      method: "agent.wait",
      params: { runId: "embedded-run-1", timeoutMs: 30_000 },
      timeoutMs: 32_000,
    });
  });

  it("settles an injected active-run send as failed when that exact run aborts", async () => {
    runtime.resolveActiveEmbeddedRunSessionId.mockReturnValue("embedded-session-failed");
    runtime.resolveActiveEmbeddedRunCorrelationId.mockReturnValue("embedded-run-failed");
    runtime.queueEmbeddedAgentMessageWithOutcomeAsync.mockResolvedValue({ queued: true });
    runtime.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);
    const gatewayCall = vi.fn(async (request: { method?: string }) =>
      request.method === "agent.wait"
        ? { status: "error", error: "active run aborted", endedAt: 20 }
        : undefined,
    );
    runtime.admit.mockImplementation(async (event: ScheduledEvent) => {
      const fixture = batchFor(event);
      queueMicrotask(() => void requireRegistration().dispatch(fixture.batch));
      return { accepted: true, receiptId: "receipt-1", durableAt: 10 };
    });

    const result = await startSessionsSendThroughScheduler({
      callGateway: gatewayCall as unknown as typeof import("../../gateway/call.js").callGateway,
      runId: "run-failed",
      sendParams: sendParams(),
      targetSessionKey: targetRoute.sessionKey,
      displayKey: "agent:main:cron:job-1:run:run-failed",
      allowActiveRunQueueDelivery: true,
    });

    expect(result).toMatchObject({ ok: true, activeRunQueue: true });
    await vi.waitFor(() => expect(runtime.settle).toHaveBeenCalledTimes(1));
    expect(runtime.settle).toHaveBeenCalledWith(
      "receipt-1",
      expect.objectContaining({
        outcome: "failed",
        failure: expect.objectContaining({ kind: "sessions_send_terminal_failed" }),
        runCorrelationId: "embedded-run-failed",
      }),
    );
  });

  it("settles an accepted send as failed when its exact run terminalizes with error", async () => {
    const gatewayCall = vi.fn(async (request: { method?: string }) =>
      request.method === "agent.wait"
        ? { status: "error", error: "target run failed", endedAt: 20 }
        : { runId: "agent-run-failed" },
    );
    let dispatchPromise: Promise<SchedulerDispatchResult> | undefined;
    runtime.admit.mockImplementation(async (event: ScheduledEvent) => {
      const fixture = batchFor(event);
      dispatchPromise = requireRegistration().dispatch(fixture.batch);
      return { accepted: true, receiptId: "receipt-1", durableAt: 10 };
    });

    const result = await startSessionsSendThroughScheduler({
      callGateway: gatewayCall as unknown as typeof import("../../gateway/call.js").callGateway,
      runId: "run-1",
      sendParams: sendParams(),
      targetSessionKey: targetRoute.sessionKey,
      displayKey: "target display",
    });

    expect(result).toEqual({ ok: true, runId: "agent-run-failed" });
    await expect(dispatchPromise).resolves.toEqual({
      outcome: "pending",
      runCorrelationId: "agent-run-failed",
    });
    await vi.waitFor(() => expect(runtime.settle).toHaveBeenCalledTimes(1));
    expect(runtime.settle).toHaveBeenCalledWith(
      "receipt-1",
      expect.objectContaining({
        outcome: "failed",
        failure: expect.objectContaining({ kind: "sessions_send_terminal_failed" }),
        runCorrelationId: "agent-run-failed",
      }),
    );
    expect(gatewayCall.mock.calls.filter(([request]) => request.method === "agent")).toHaveLength(
      1,
    );
  });

  it("reconstructs an orphaned accepted send from its persisted payload", async () => {
    runtime.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "agent.wait" ? { status: "ok" } : { runId: "rehydrated-run" },
    );
    ensureSessionsSendSchedulerProducerRegistered();
    const event = sessionsSendSchedulerTesting.buildSessionsSendEvent({
      runId: "run-1",
      sendParams: sendParams(),
      targetSessionKey: targetRoute.sessionKey,
      displayKey: "target display",
    });
    const fixture = batchFor(event);

    const dispatchResult = await requireRegistration().dispatch(fixture.batch);

    expect(runtime.callGateway).toHaveBeenNthCalledWith(1, {
      method: "agent",
      params: expect.objectContaining({
        sessionKey: targetRoute.sessionKey,
        idempotencyKey: "idempotency-1",
      }),
      timeoutMs: 10_000,
    });
    expect(fixture.correlations).toEqual(["attempt-1", "rehydrated-run"]);
    expect(fixture.starts).toHaveLength(2);
    expect(fixture.terminals).toEqual([]);
    expect(dispatchResult).toEqual({
      outcome: "pending",
      runCorrelationId: "rehydrated-run",
    });
    await vi.waitFor(() => expect(runtime.settle).toHaveBeenCalledTimes(1));
    expect(fixture.terminals).toHaveLength(1);
  });
});
