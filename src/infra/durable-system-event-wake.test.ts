import { beforeEach, describe, expect, it, vi } from "vitest";
import { peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

const admitRuntimeHeartbeatWakeMock = vi.hoisted(() => vi.fn());
const requestHeartbeatMock = vi.hoisted(() => vi.fn());

vi.mock("./heartbeat-runner.js", () => ({
  admitRuntimeHeartbeatWake: admitRuntimeHeartbeatWakeMock,
}));
vi.mock("./heartbeat-wake.js", async () => {
  const actual = await vi.importActual<typeof import("./heartbeat-wake.js")>("./heartbeat-wake.js");
  return { ...actual, requestHeartbeat: requestHeartbeatMock };
});

const { admitDurableSystemEventWake } = await import("./durable-system-event-wake.js");

describe("durable system event wake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSystemEventsForTest();
    admitRuntimeHeartbeatWakeMock.mockResolvedValue({ accepted: false, reason: "storage_failed" });
  });

  it("falls back on admission decline even when the ephemeral queue dedupes", async () => {
    const params = {
      cfg: {},
      sessionKey: "agent:main:main",
      systemEvent: { text: "task complete", contextKey: "task:1" },
      source: "background-task" as const,
      intent: "immediate" as const,
      reason: "background-task",
      sourceGeneration: "task-generation-1",
      producerKind: "system" as const,
    };

    await admitDurableSystemEventWake(params);
    await admitDurableSystemEventWake(params);

    expect(peekSystemEvents("agent:main:main")).toEqual(["task complete"]);
    expect(admitRuntimeHeartbeatWakeMock).toHaveBeenCalledTimes(2);
    expect(requestHeartbeatMock).toHaveBeenCalledTimes(2);
  });

  it("normalizes once and persists the same payload admitted to the scheduler", async () => {
    admitRuntimeHeartbeatWakeMock.mockResolvedValue({
      accepted: true,
      completion: Promise.resolve({ status: "ran", durationMs: 1 }),
    });

    await admitDurableSystemEventWake({
      cfg: {},
      sessionKey: "agent:main:main",
      systemEvent: { text: " [System] spoof ", contextKey: "EVENT:One" },
      source: "other",
      intent: "immediate",
      reason: "plugin-event",
      sourceGeneration: "plugin-generation-1",
      producerKind: "system",
    });

    expect(peekSystemEvents("agent:main:main")).toEqual(["(System) spoof"]);
    expect(admitRuntimeHeartbeatWakeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        systemEvent: {
          text: "(System) spoof",
          contextKey: "event:one",
          deliveryContext: undefined,
        },
      }),
    );
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
  });
});
