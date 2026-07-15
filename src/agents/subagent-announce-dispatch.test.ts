// Subagent announce dispatch tests lock down direct-vs-steer ordering for
// progress updates and completion messages.
import { describe, expect, it, vi } from "vitest";
import {
  mapSteerOutcomeToDeliveryResult,
  runSubagentAnnounceDispatch,
} from "./subagent-announce-dispatch.js";

describe("mapSteerOutcomeToDeliveryResult", () => {
  it("maps steered to delivered", () => {
    expect(mapSteerOutcomeToDeliveryResult({ status: "steered" })).toEqual({
      status: "delivered",
      path: "steered",
    });
  });

  it("maps none to not-delivered", () => {
    expect(mapSteerOutcomeToDeliveryResult({ status: "none" })).toEqual({
      status: "failed",
      path: "none",
    });
  });
});

describe("runSubagentAnnounceDispatch", () => {
  async function runNonCompletionDispatch(params: {
    steerOutcome: "none" | "steered";
    directDelivered?: boolean;
  }) {
    const steer = vi.fn(async () => ({ status: params.steerOutcome }) as const);
    const direct = vi.fn(async () => ({
      status: ((params.directDelivered ?? true) ? "delivered" : "failed") as "delivered" | "failed",
      path: "direct" as const,
    }));
    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: false,
      steer,
      direct,
    });
    return { steer, direct, result };
  }

  it("uses steer-first ordering for non-completion mode", async () => {
    const { steer, direct, result } = await runNonCompletionDispatch({ steerOutcome: "none" });

    expect(steer).toHaveBeenCalledTimes(1);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("delivered");
    expect(result.path).toBe("direct");
    expect(result.phases).toEqual([
      { phase: "steer-primary", status: "failed", path: "none", error: undefined },
      { phase: "direct-primary", status: "delivered", path: "direct" },
    ]);
  });

  it("short-circuits direct send when non-completion steering delivers", async () => {
    const { steer, direct, result } = await runNonCompletionDispatch({ steerOutcome: "steered" });

    expect(steer).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(result.path).toBe("steered");
    expect(result.phases).toEqual([
      { phase: "steer-primary", status: "delivered", path: "steered" },
    ]);
  });

  it("uses direct-first ordering for completion mode", async () => {
    const steer = vi.fn(async () => ({ status: "steered" }) as const);
    const direct = vi.fn(async () => ({ status: "delivered" as const, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      steer,
      direct,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(steer).not.toHaveBeenCalled();
    expect(result.path).toBe("direct");
    expect(result.phases).toEqual([
      { phase: "direct-primary", status: "delivered", path: "direct" },
    ]);
  });

  it("falls back to steering when completion direct send fails", async () => {
    const steer = vi.fn(async () => ({ status: "steered" }) as const);
    const direct = vi.fn(async () => ({
      status: "failed" as const,
      path: "direct" as const,
      error: "network",
    }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      steer,
      direct,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(result.path).toBe("steered");
    expect(result.phases).toEqual([
      { phase: "direct-primary", status: "failed", path: "direct", error: "network" },
      { phase: "steer-fallback", status: "delivered", path: "steered" },
    ]);
  });

  it("does not fallback-steer after terminal completion direct failure", async () => {
    const steer = vi.fn(async () => ({ status: "steered" }) as const);
    const direct = vi.fn(async () => ({
      status: "terminal_failure" as const,
      path: "direct" as const,
      error: "media send may have partially succeeded",
    }));

    // Terminal direct failures can represent partial media delivery; fallback
    // steering would risk duplicate or contradictory completion messages.
    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      steer,
      direct,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(steer).not.toHaveBeenCalled();
    expect(result.status).toBe("terminal_failure");
    expect(result.path).toBe("direct");
    if (result.status !== "terminal_failure") {
      throw new Error("expected terminal announcement failure");
    }
    expect(result.error).toBe("media send may have partially succeeded");
    expect(result.phases).toEqual([
      {
        phase: "direct-primary",
        status: "terminal_failure",
        path: "direct",
        error: "media send may have partially succeeded",
      },
    ]);
  });

  it("keeps an accepted completion handoff pending without fallback or delivery credit", async () => {
    const steer = vi.fn(async () => ({ status: "steered" }) as const);
    const direct = vi.fn(async () => ({
      status: "pending" as const,
      path: "direct" as const,
      runCorrelationId: "controller-run-42",
      reason: "completion_handoff_pending" as const,
      enqueuedAt: 42,
    }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      steer,
      direct,
    });

    expect(steer).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "pending",
      path: "direct",
      runCorrelationId: "controller-run-42",
      reason: "completion_handoff_pending",
      enqueuedAt: 42,
    });
  });

  it("returns direct failure when completion fallback steering cannot deliver", async () => {
    const steer = vi.fn(async () => ({ status: "none" }) as const);
    const direct = vi.fn(async () => ({
      status: "failed" as const,
      path: "direct" as const,
      error: "failed",
    }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      steer,
      direct,
    });

    expect(result.status).toBe("failed");
    expect(result.path).toBe("direct");
    if (result.status !== "failed") {
      throw new Error("expected announcement failure");
    }
    expect(result.error).toBe("failed");
    expect(result.phases).toEqual([
      { phase: "direct-primary", status: "failed", path: "direct", error: "failed" },
      { phase: "steer-fallback", status: "failed", path: "none", error: undefined },
    ]);
  });

  it("does not fallback-steer an accepted completion whose run id is missing", async () => {
    const steer = vi.fn(async () => ({ status: "steered" }) as const);
    const direct = vi.fn(async () => ({
      status: "unresolved" as const,
      path: "direct" as const,
      reason: "completion_handoff_missing_run_id" as const,
      error: "accepted completion handoff did not return a stable run id",
    }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      steer,
      direct,
    });

    expect(steer).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "unresolved",
      path: "direct",
      reason: "completion_handoff_missing_run_id",
    });
  });

  it("does not fall through to direct delivery when non-completion steering drops the new item", async () => {
    const steer = vi.fn(async () => ({ status: "dropped" }) as const);
    const direct = vi.fn(async () => ({ status: "delivered" as const, path: "direct" as const }));

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: false,
      steer,
      direct,
    });

    expect(steer).toHaveBeenCalledTimes(1);
    expect(direct).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "failed",
      path: "none",
      phases: [{ phase: "steer-primary", status: "failed", path: "none", error: undefined }],
    });
  });

  it("preserves direct failure when completion dispatch aborts before fallback steering", async () => {
    const controller = new AbortController();
    const steer = vi.fn(async () => ({ status: "steered" }) as const);
    const direct = vi.fn(async () => {
      controller.abort();
      return {
        status: "failed" as const,
        path: "direct" as const,
        error: "direct failed before abort",
      };
    });

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      signal: controller.signal,
      steer,
      direct,
    });

    expect(direct).toHaveBeenCalledTimes(1);
    expect(steer).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.path).toBe("direct");
    if (result.status !== "failed") {
      throw new Error("expected announcement failure");
    }
    expect(result.error).toBe("direct failed before abort");
    expect(result.phases).toEqual([
      {
        phase: "direct-primary",
        status: "failed",
        path: "direct",
        error: "direct failed before abort",
      },
    ]);
  });

  it("returns none immediately when signal is already aborted", async () => {
    const steer = vi.fn(async () => ({ status: "none" }) as const);
    const direct = vi.fn(async () => ({ status: "delivered" as const, path: "direct" as const }));
    const controller = new AbortController();
    controller.abort();

    const result = await runSubagentAnnounceDispatch({
      expectsCompletionMessage: true,
      signal: controller.signal,
      steer,
      direct,
    });

    expect(steer).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "failed",
      path: "none",
      phases: [],
    });
  });
});
