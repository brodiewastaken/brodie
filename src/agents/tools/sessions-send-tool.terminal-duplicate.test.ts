import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  start: vi.fn(),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => ({
      session: { scope: "per-sender", mainKey: "main" },
      tools: {
        agentToAgent: { enabled: true },
        sessions: { visibility: "all" },
      },
    }),
  };
});

vi.mock("./sessions-send-tool.scheduler.js", () => ({
  ensureSessionsSendSchedulerProducerRegistered: vi.fn(),
  resolveCronRunScopedFallbackSessionKey: vi.fn(),
  startSessionsSendThroughScheduler: mocks.start,
}));

vi.mock("./sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: vi.fn(),
}));

const { createSessionsSendTool } = await import("./sessions-send-tool.js");

describe("sessions_send terminal duplicate", () => {
  beforeEach(() => {
    mocks.callGateway.mockReset().mockImplementation(async (request: { method?: string }) => {
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: "agent:other:main", kind: "direct" }],
        };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      throw new Error(`unexpected gateway method ${request.method}`);
    });
    mocks.start.mockReset().mockResolvedValue({
      ok: true,
      runId: "already-delivered-run",
      alreadyDelivered: true,
    });
  });

  it("returns the durable terminal result without a fresh agent.wait", async () => {
    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "internal",
    });

    const result = await tool.execute("call-terminal-duplicate", {
      sessionKey: "agent:other:main",
      message: "do not replay",
      timeoutSeconds: 30,
    });

    expect(result.details).toMatchObject({
      runId: "already-delivered-run",
      status: "ok",
      alreadyDelivered: true,
      sessionKey: "agent:other:main",
    });
    expect(mocks.callGateway.mock.calls.some(([request]) => request.method === "agent.wait")).toBe(
      false,
    );
  });
});
