import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { logLaneDequeue, logLaneEnqueue } from "./diagnostic-runtime.js";

function flushDiagnosticEvents(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("diagnostic runtime lane correlation", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    setDiagnosticsEnabledForProcess(true);
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("keeps scheduler receipt, run, producer, and wait timing on lane events", async () => {
    const events: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((event) => events.push(event));

    logLaneEnqueue("lane:room", 2, {
      sessionKey: "agent:main:conversation:test:default:channel:room",
      receiptId: "receipt-2",
      producerKind: "human_message",
      admissionDelayMs: 83_500,
    });
    logLaneDequeue("lane:room", 84_000, 0, {
      sessionKey: "agent:main:conversation:test:default:channel:room",
      runId: "attempt-2",
      producerKind: "human_message",
      receiptCount: 2,
    });
    await flushDiagnosticEvents();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "queue.lane.enqueue",
        lane: "lane:room",
        queueSize: 2,
        receiptId: "receipt-2",
        producerKind: "human_message",
        admissionDelayMs: 83_500,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "queue.lane.dequeue",
        lane: "lane:room",
        queueSize: 0,
        waitMs: 84_000,
        runId: "attempt-2",
        producerKind: "human_message",
        receiptCount: 2,
      }),
    );
  });
});
