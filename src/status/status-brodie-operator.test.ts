import { describe, expect, it, vi } from "vitest";
import {
  formatRunPolicyStatusLine,
  formatSchedulerStatusLine,
  runBoundedStatusProbe,
} from "./status-brodie-operator.js";

describe("fixed brodie operator status", () => {
  it("formats the resolved run policy without exposing auth", () => {
    const line = formatRunPolicyStatusLine({
      primary: { provider: "openai", model: "gpt-5.6-sol" },
      fallbacks: [{ provider: "anthropic", model: "claude-opus-4-8" }],
      reasoning: "high",
      fastMode: true,
      textVerbosity: "low",
      authProfileId: "private-profile",
      startupJournals: "paths",
      maxNativeImages: 4,
      source: {
        model: "configured",
        reasoning: "default",
        fastMode: "model",
        textVerbosity: "default",
        auth: "explicit",
        startupJournals: "model",
        maxNativeImages: "configured",
      },
    });
    expect(line).toContain("openai/gpt-5.6-sol");
    expect(line).toContain("1 fallback");
    expect(line).not.toContain("private-profile");
  });

  it("formats scheduler ownership, backlog, failures, recovery, and storage", () => {
    expect(
      formatSchedulerStatusLine({
        status: "available",
        value: {
          storageHealthy: false,
          lanes: [
            {
              queueLaneKey: "private-lane",
              sessionKey: "private-session",
              pendingCount: 2,
              producerKinds: ["human_message"],
              failureCount: 1,
              callbackPendingCount: 1,
              dispatchAttemptIds: [],
              runCorrelationIds: [],
            },
          ],
        },
      }),
    ).toBe("🪢 Scheduler: 1 lane · 2 pending · 1 failed · 1 recovery · storage error");
  });

  it("contains rejected, timed-out, and late probes", async () => {
    await expect(
      runBoundedStatusProbe({
        timeoutMs: 20,
        probe: async () => await Promise.reject(new Error("no")),
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "rejected" });

    let resolveLate: ((value: string) => void) | undefined;
    const late = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });
    const timed = await runBoundedStatusProbe({ timeoutMs: 5, probe: async () => await late });
    expect(timed).toEqual({ status: "unavailable", reason: "timeout" });
    resolveLate?.("late");
    await vi.waitFor(() => expect(resolveLate).toBeDefined());
  });
});
