import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sessions from "../config/sessions.js";
import {
  recoverOrphanedSubagentSessions,
  scheduleOrphanRecovery,
} from "./subagent-orphan-recovery.js";
import * as subagentRegistrySteerRuntime from "./subagent-registry-steer-runtime.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({ session: { store: undefined } })),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({})),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveStorePath: vi.fn(() => "/tmp/test-sessions.json"),
  updateSessionStore: vi.fn(async () => {}),
}));

vi.mock("./subagent-registry-steer-runtime.js", () => ({
  finalizeInterruptedSubagentRun: vi.fn(async () => 1),
}));

const CHILD_SESSION_KEY = "agent:main:subagent:test-session-1";

function createRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: CHILD_SESSION_KEY,
    requesterSessionKey: "agent:main:quietchat:direct:requester",
    requesterDisplayKey: "main",
    task: "side-effecting delegated task",
    cleanup: "delete",
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 55_000,
    ...overrides,
  };
}

function activeRuns(...runs: SubagentRunRecord[]) {
  return new Map(runs.map((run) => [run.runId, run] satisfies [string, SubagentRunRecord]));
}

function mockStore(
  overrides: Partial<NonNullable<ReturnType<typeof sessions.loadSessionStore>[string]>> = {},
) {
  vi.mocked(sessions.loadSessionStore).mockReturnValue({
    [CHILD_SESSION_KEY]: {
      sessionId: "session-abc",
      updatedAt: Date.now(),
      abortedLastRun: true,
      ...overrides,
    },
  });
}

function requireUpdateCallback() {
  const call = vi.mocked(sessions.updateSessionStore).mock.calls[0];
  if (!call || typeof call[1] !== "function") {
    throw new Error("expected session-store update callback");
  }
  return call[1];
}

describe("subagent restart reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("never replays an aborted task without durable live-runtime proof", async () => {
    mockStore();

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns(createRun()),
    });

    expect(result).toMatchObject({
      recovered: 0,
      failed: 0,
      skipped: 1,
      failedRuns: [
        {
          runId: "run-1",
          childSessionKey: CHILD_SESSION_KEY,
        },
      ],
    });
    expect(result.failedRuns[0]?.error).toContain("automatic replay is unsafe");
    expect(sessions.updateSessionStore).toHaveBeenCalledOnce();

    const persisted: ReturnType<typeof sessions.loadSessionStore> = {
      [CHILD_SESSION_KEY]: {
        sessionId: "session-abc",
        updatedAt: 0,
        abortedLastRun: true,
      },
    };
    await requireUpdateCallback()(persisted);
    const entry = persisted[CHILD_SESSION_KEY];
    expect(entry?.abortedLastRun).toBe(false);
    expect(entry?.subagentRecovery?.wedgedReason).toContain("automatic replay is unsafe");
  });

  it("does not classify a non-aborted or already-terminal run as interrupted", async () => {
    vi.mocked(sessions.loadSessionStore).mockReturnValue({
      [CHILD_SESSION_KEY]: {
        sessionId: "session-abc",
        updatedAt: Date.now(),
        abortedLastRun: false,
      },
    });
    const notAborted = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns(createRun()),
    });
    expect(notAborted).toMatchObject({ recovered: 0, failed: 0, skipped: 1, failedRuns: [] });

    mockStore();
    const ended = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns(createRun({ endedAt: Date.now() - 1_000 })),
    });
    expect(ended).toMatchObject({ recovered: 0, failed: 0, skipped: 1, failedRuns: [] });
  });

  it("reclassifies legacy restart timeouts as one structured interruption", async () => {
    mockStore();
    const run = createRun({
      endedAt: Date.now() - 1_000,
      outcome: { status: "timeout" },
    });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns(run),
    });

    expect(result.failedRuns).toHaveLength(1);
    expect(run.endedAt).toBeUndefined();
    expect(run.execution?.status).toBe("interrupted");
    expect(run.execution?.interruptionReason).toBe("gateway-restart");
  });

  it("selects only the latest generation when a child session has no persisted marker", async () => {
    mockStore();
    const runs = activeRuns(
      createRun({ runId: "run-old", generation: 1 }),
      createRun({ runId: "run-new", generation: 2 }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => runs,
    });

    expect(result.failedRuns).toMatchObject([
      { runId: "run-new", childSessionKey: CHILD_SESSION_KEY },
    ]);
    expect(result.skipped).toBe(2);
  });

  it("selects only the exact persisted interruption marker when a child session was reused", async () => {
    mockStore({
      abortedLastRun: false,
      subagentRecovery: {
        automaticAttempts: 1,
        lastAttemptAt: Date.now() - 1_000,
        lastRunId: "run-old",
        wedgedAt: Date.now() - 1_000,
        wedgedReason:
          "durable runtime proof is unavailable after the gateway restart; automatic replay is unsafe",
      },
    });
    const runs = activeRuns(
      createRun({ runId: "run-old", generation: 1 }),
      createRun({ runId: "run-new", generation: 2 }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => runs,
    });

    expect(result.failedRuns).toMatchObject([
      { runId: "run-old", childSessionKey: CHILD_SESSION_KEY },
    ]);
    expect(result.skipped).toBe(2);
  });

  it("ignores an ended interruption marker when a newer aborted generation reused the session", async () => {
    mockStore({
      abortedLastRun: true,
      subagentRecovery: {
        automaticAttempts: 1,
        lastAttemptAt: Date.now() - 1_000,
        lastRunId: "run-old",
        wedgedAt: Date.now() - 1_000,
        wedgedReason:
          "durable runtime proof is unavailable after the gateway restart; automatic replay is unsafe",
      },
    });
    const runs = activeRuns(
      createRun({ runId: "run-old", generation: 1, endedAt: Date.now() - 500 }),
      createRun({ runId: "run-new", generation: 2 }),
    );

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => runs,
    });

    expect(result.failedRuns).toMatchObject([
      { runId: "run-new", childSessionKey: CHILD_SESSION_KEY },
    ]);
  });

  it("does not reclassify an older terminal timeout for a newer aborted generation", async () => {
    mockStore({ abortedLastRun: true });
    const oldRun = createRun({
      runId: "run-old-timeout",
      generation: 1,
      endedAt: Date.now() - 1_000,
      outcome: { status: "timeout" },
    });
    const newRun = createRun({ runId: "run-new-aborted", generation: 2 });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns(oldRun, newRun),
    });

    expect(result.failedRuns).toMatchObject([
      { runId: "run-new-aborted", childSessionKey: CHILD_SESSION_KEY },
    ]);
    expect(oldRun).toMatchObject({
      endedAt: expect.any(Number),
      outcome: { status: "timeout" },
    });
  });

  it("settles an unfinished marker and the latest aborted generation exactly once", async () => {
    mockStore({
      abortedLastRun: true,
      subagentRecovery: {
        automaticAttempts: 1,
        lastAttemptAt: Date.now() - 1_000,
        lastRunId: "run-old",
        wedgedAt: Date.now() - 1_000,
        wedgedReason:
          "durable runtime proof is unavailable after the gateway restart; automatic replay is unsafe",
      },
    });
    const runs = activeRuns(
      createRun({ runId: "run-old", generation: 1 }),
      createRun({ runId: "run-new", generation: 2 }),
    );

    scheduleOrphanRecovery({
      getActiveRuns: () => runs,
      delayMs: 1,
      maxRetries: 1,
    });
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).toHaveBeenCalledTimes(2);
    });

    expect(
      vi
        .mocked(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun)
        .mock.calls.map(([params]) => params.runId)
        .filter((runId): runId is string => typeof runId === "string")
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["run-new", "run-old"]);
  });

  it("retries finalization from a persisted interruption marker after a crash", async () => {
    mockStore({
      abortedLastRun: false,
      subagentRecovery: {
        automaticAttempts: 2,
        lastAttemptAt: Date.now() - 1_000,
        lastRunId: "run-1",
        wedgedAt: Date.now() - 1_000,
        wedgedReason:
          "durable runtime proof is unavailable after the gateway restart; automatic replay is unsafe",
      },
    });

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns(createRun()),
    });

    expect(result.failedRuns).toMatchObject([
      { runId: "run-1", childSessionKey: CHILD_SESSION_KEY },
    ]);
  });

  it("reports storage failure without replaying the task", async () => {
    mockStore();
    vi.mocked(sessions.updateSessionStore).mockRejectedValue(new Error("state unavailable"));

    const result = await recoverOrphanedSubagentSessions({
      getActiveRuns: () => activeRuns(createRun()),
    });

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failedRuns[0]?.error).toContain("state unavailable");
  });

  it("finalizes the interrupted run once with explicit safe-retry guidance", async () => {
    mockStore();

    scheduleOrphanRecovery({
      getActiveRuns: () => activeRuns(createRun()),
      delayMs: 1,
      maxRetries: 3,
    });
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).toHaveBeenCalledOnce();
    });
    const call = vi.mocked(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).mock
      .calls[0];
    expect(call?.[0]).toMatchObject({
      runId: "run-1",
      childSessionKey: CHILD_SESSION_KEY,
    });
    expect(call?.[0].error).toContain("Automatic replay was not attempted");
    expect(call?.[0].error).toContain("Review known side effects before retrying");
  });

  it("keeps retrying persisted interruption finalization after one retry cycle is exhausted", async () => {
    mockStore();
    vi.mocked(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun)
      .mockRejectedValueOnce(new Error("registry unavailable"))
      .mockRejectedValueOnce(new Error("registry still unavailable"))
      .mockResolvedValueOnce(1);

    scheduleOrphanRecovery({
      getActiveRuns: () => activeRuns(createRun()),
      delayMs: 1,
      maxRetries: 1,
    });
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(2);
    await vi.waitFor(() => {
      expect(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).toHaveBeenCalledTimes(2);
    });
    await vi.advanceTimersByTimeAsync(2);
    await vi.waitFor(() => {
      expect(subagentRegistrySteerRuntime.finalizeInterruptedSubagentRun).toHaveBeenCalledTimes(3);
    });
  });
});
