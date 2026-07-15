import { describe, expect, it } from "vitest";
import type { ConversationRoute } from "../routing/conversation-route.js";
import type { SchedulerDispatchBatch } from "./conversation-scheduler.js";
import {
  beginRuntimeProducerDispatch,
  buildRuntimeProducerEvent,
  buildRuntimeProducerStartedEvidence,
  buildRuntimeProducerTerminalEvidence,
  completeRuntimeProducerDispatch,
  correlateRuntimeProducerDispatch,
  isRuntimeProducerStartedEvidence,
  readRuntimeProducerTerminalEvidence,
  resolveRuntimeProducerRoute,
} from "./runtime-producer-admission.js";

const route: ConversationRoute = {
  channel: "internal",
  accountId: "main",
  conversationKind: "direct",
  conversationId: "agent:main:cron:job-1",
  sessionKey: "agent:main:cron:job-1",
  queueLaneKey: "internal:main:agent:main:cron:job-1",
  transcriptOwner: { agentId: "main", sessionKey: "agent:main:cron:job-1" },
};

function batch() {
  const correlations: string[] = [];
  const starts: string[] = [];
  const terminals: Array<{ outcome: string; evidence: string }> = [];
  const value: SchedulerDispatchBatch = {
    attemptId: "attempt-1",
    placement: "idle",
    events: [
      {
        ...buildRuntimeProducerEvent({
          id: "cron:job-1:slot-1",
          route,
          producerKind: "cron",
          payload: { jobId: "job-1" },
        }),
        receiptId: "receipt-1",
        sequence: 1,
      },
    ],
    recordRunCorrelationId: (runId) => correlations.push(runId),
    recordRunStarted: (evidence) => starts.push(evidence),
    recordRunTerminalOutcome: (outcome, evidence) => terminals.push({ outcome, evidence }),
  };
  return { value, correlations, starts, terminals };
}

describe("runtime producer admission", () => {
  it("keeps non-canonical sources on their exact internal session lane", () => {
    expect(
      resolveRuntimeProducerRoute({ sessionKey: "agent:main:cron:job-1", agentId: "main" }),
    ).toMatchObject({
      channel: "internal",
      accountId: "main",
      conversationId: "agent:main:cron:job-1",
      sessionKey: "agent:main:cron:job-1",
      transcriptOwner: { agentId: "main", sessionKey: "agent:main:cron:job-1" },
    });
  });

  it("persists start and exact completion evidence around external work", () => {
    const fixture = batch();
    const runCorrelationId = beginRuntimeProducerDispatch(fixture.value);
    const result = completeRuntimeProducerDispatch({
      batch: fixture.value,
      runCorrelationId,
    });
    const event = fixture.value.events[0]!;
    const startedEvidence = buildRuntimeProducerStartedEvidence({
      producerKind: "cron",
      sessionKey: route.sessionKey,
      runCorrelationId,
    });
    const terminalEvidence = buildRuntimeProducerTerminalEvidence({
      producerKind: "cron",
      sessionKey: route.sessionKey,
      runCorrelationId,
      outcome: "completed",
    });

    expect(fixture.correlations).toEqual(["attempt-1"]);
    expect(fixture.starts).toEqual([startedEvidence]);
    expect(fixture.terminals).toEqual([{ outcome: "completed", evidence: terminalEvidence }]);
    expect(result).toEqual({
      outcome: "completed",
      transcriptEvidence: terminalEvidence,
      runCorrelationId: "attempt-1",
    });
    expect(
      isRuntimeProducerStartedEvidence({
        batchEvent: event,
        runCorrelationId,
        transcriptEvidence: startedEvidence,
      }),
    ).toBe(true);
    expect(
      readRuntimeProducerTerminalEvidence({
        batchEvent: event,
        runCorrelationId,
        transcriptEvidence: terminalEvidence,
      }),
    ).toBe("completed");
  });

  it("rejects evidence bound to another source session or run", () => {
    const fixture = batch();
    const event = fixture.value.events[0]!;
    const evidence = buildRuntimeProducerTerminalEvidence({
      producerKind: "cron",
      sessionKey: `${route.sessionKey}:other`,
      runCorrelationId: "attempt-1",
      outcome: "completed",
    });
    expect(
      readRuntimeProducerTerminalEvidence({
        batchEvent: event,
        runCorrelationId: "attempt-1",
        transcriptEvidence: evidence,
      }),
    ).toBeUndefined();
  });

  it("rejects a batch that mixes producer or session ownership", () => {
    const fixture = batch();
    fixture.value.events = [
      ...fixture.value.events,
      {
        ...fixture.value.events[0]!,
        id: "hook:job-1:slot-1",
        producerKind: "hook",
        receiptId: "receipt-2",
        sequence: 2,
      },
    ];

    expect(() => beginRuntimeProducerDispatch(fixture.value)).toThrow(
      "runtime producer dispatch cannot mix producer or session ownership",
    );
  });

  it("rebinds pending evidence to the exact external run", () => {
    const fixture = batch();

    expect(correlateRuntimeProducerDispatch(fixture.value, "external-run-1")).toBe(
      "external-run-1",
    );
    expect(fixture.correlations).toEqual(["external-run-1"]);
    expect(fixture.starts).toEqual([
      buildRuntimeProducerStartedEvidence({
        producerKind: "cron",
        sessionKey: route.sessionKey,
        runCorrelationId: "external-run-1",
      }),
    ]);
  });
});
