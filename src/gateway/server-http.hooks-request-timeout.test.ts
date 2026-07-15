/**
 * Tests timeout behavior for gateway HTTP hook request handling.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createHookRequest,
  createHooksHandler,
  createResponse,
} from "./server-http.test-harness.js";

const { readJsonBodyMock } = vi.hoisted(() => ({
  readJsonBodyMock: vi.fn(),
}));

vi.mock("./hooks.js", async () => {
  const actual = await vi.importActual<typeof import("./hooks.js")>("./hooks.js");
  return {
    ...actual,
    readJsonBody: readJsonBodyMock,
  };
});

function expectRetryAfterHeader(setHeader: ReturnType<typeof vi.fn>): void {
  const retryAfterCall = setHeader.mock.calls.find(([name]) => name === "Retry-After");
  if (!retryAfterCall) {
    throw new Error("Expected Retry-After header call");
  }
  const retryAfterValue = retryAfterCall[1];
  expect(typeof retryAfterValue).toBe("string");
  expect(Number.parseInt(String(retryAfterValue), 10)).toBeGreaterThan(0);
}

describe("createHooksRequestHandler timeout status mapping", () => {
  beforeEach(() => {
    readJsonBodyMock.mockClear();
  });

  test("returns 408 for request body timeout", async () => {
    readJsonBodyMock.mockResolvedValue({ ok: false, error: "request body timeout" });
    const dispatchWakeHook = vi.fn();
    const dispatchAgentHook = vi.fn(async () => "run-1");
    const handler = createHooksHandler({ dispatchWakeHook, dispatchAgentHook });
    const req = createHookRequest();
    const { res, end } = createResponse();

    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(408);
    expect(end).toHaveBeenCalledWith(JSON.stringify({ ok: false, error: "request body timeout" }));
    expect(dispatchWakeHook).not.toHaveBeenCalled();
    expect(dispatchAgentHook).not.toHaveBeenCalled();
  });

  test("keeps direct wake source generation stable across idempotent retries", async () => {
    readJsonBodyMock.mockResolvedValue({
      ok: true,
      value: { text: "wake up", mode: "now" },
    });
    const dispatchWakeHook = vi.fn();
    const handler = createHooksHandler({ dispatchWakeHook });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const req = createHookRequest({ headers: { "idempotency-key": "wake-1" } });
      const { res } = createResponse();
      await handler(req, res);
    }

    expect(dispatchWakeHook).toHaveBeenCalledTimes(2);
    const firstGeneration = dispatchWakeHook.mock.calls[0]?.[0]?.sourceGeneration;
    const secondGeneration = dispatchWakeHook.mock.calls[1]?.[0]?.sourceGeneration;
    expect(firstGeneration).toMatch(/^[a-f0-9]{64}$/);
    expect(secondGeneration).toBe(firstGeneration);
  });

  test("uses a fresh direct wake source generation without an idempotency key", async () => {
    readJsonBodyMock.mockResolvedValue({
      ok: true,
      value: { text: "wake up", mode: "now" },
    });
    const dispatchWakeHook = vi.fn();
    const handler = createHooksHandler({ dispatchWakeHook });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const req = createHookRequest();
      const { res } = createResponse();
      await handler(req, res);
    }

    const firstGeneration = dispatchWakeHook.mock.calls[0]?.[0]?.sourceGeneration;
    const secondGeneration = dispatchWakeHook.mock.calls[1]?.[0]?.sourceGeneration;
    expect(firstGeneration).toMatch(/^[a-f0-9-]{36}$/);
    expect(secondGeneration).not.toBe(firstGeneration);
  });

  test("does not acknowledge an agent hook before durable admission commits", async () => {
    readJsonBodyMock.mockResolvedValue({
      ok: true,
      value: { message: "do it", name: "durable hook" },
    });
    let resolveDispatch!: (runId: string) => void;
    const dispatchAgentHook = vi.fn(
      async () =>
        await new Promise<string>((resolve) => {
          resolveDispatch = resolve;
        }),
    );
    const handler = createHooksHandler({ dispatchAgentHook });
    const req = createHookRequest({ url: "/hooks/agent" });
    const { res, end } = createResponse();
    const handled = handler(req, res);

    await vi.waitFor(() => expect(dispatchAgentHook).toHaveBeenCalledOnce());
    expect(end).not.toHaveBeenCalled();

    resolveDispatch("run-durable-1");
    await handled;

    expect(end).toHaveBeenCalledWith(JSON.stringify({ ok: true, runId: "run-durable-1" }));
  });

  test("rebuilds the same scoped agent source generation after handler restart", async () => {
    readJsonBodyMock.mockResolvedValue({
      ok: true,
      value: { message: "do it", name: "durable hook" },
    });
    const firstDispatch = vi.fn(
      async (_value: { sourceGeneration: string; sessionKey: string }) => "run-1",
    );
    const restartedDispatch = vi.fn(
      async (_value: { sourceGeneration: string; sessionKey: string }) => "run-1",
    );
    const headers = { "idempotency-key": "hook-restart-1" };

    const firstHandler = createHooksHandler({ dispatchAgentHook: firstDispatch });
    await firstHandler(createHookRequest({ url: "/hooks/agent", headers }), createResponse().res);
    const restartedHandler = createHooksHandler({ dispatchAgentHook: restartedDispatch });
    await restartedHandler(
      createHookRequest({ url: "/hooks/agent", headers }),
      createResponse().res,
    );

    const firstGeneration = firstDispatch.mock.calls[0]?.[0]?.sourceGeneration;
    const restartedGeneration = restartedDispatch.mock.calls[0]?.[0]?.sourceGeneration;
    expect(firstGeneration).toMatch(/^[a-f0-9]{64}$/);
    expect(restartedGeneration).toBe(firstGeneration);
    expect(firstDispatch.mock.calls[0]?.[0]?.sessionKey).toBe(`hook:${firstGeneration}`);
    expect(restartedDispatch.mock.calls[0]?.[0]?.sessionKey).toBe(`hook:${firstGeneration}`);
  });

  test("shares hook auth rate-limit bucket across ipv4 and ipv4-mapped ipv6 forms", async () => {
    const handler = createHooksHandler({ bindHost: "127.0.0.1" });

    for (let i = 0; i < 20; i++) {
      const req = createHookRequest({
        authorization: "Bearer wrong",
        remoteAddress: "1.2.3.4",
      });
      const { res } = createResponse();
      const handled = await handler(req, res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
    }

    const mappedReq = createHookRequest({
      authorization: "Bearer wrong",
      remoteAddress: "::ffff:1.2.3.4",
    });
    const { res: mappedRes, setHeader } = createResponse();
    const handled = await handler(mappedReq, mappedRes);

    expect(handled).toBe(true);
    expect(mappedRes.statusCode).toBe(429);
    expectRetryAfterHeader(setHeader);
  });

  test("uses trusted proxy forwarded client ip for hook auth throttling", async () => {
    const handler = createHooksHandler({
      getClientIpConfig: () => ({ trustedProxies: ["10.0.0.1"] }),
    });

    for (let i = 0; i < 20; i++) {
      const req = createHookRequest({
        authorization: "Bearer wrong",
        remoteAddress: "10.0.0.1",
        headers: { "x-forwarded-for": "1.2.3.4" },
      });
      const { res } = createResponse();
      const handled = await handler(req, res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
    }

    const forwardedReq = createHookRequest({
      authorization: "Bearer wrong",
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" },
    });
    const { res: forwardedRes, setHeader } = createResponse();
    const handled = await handler(forwardedReq, forwardedRes);

    expect(handled).toBe(true);
    expect(forwardedRes.statusCode).toBe(429);
    expectRetryAfterHeader(setHeader);
  });

  test.each(["0.0.0.0", "::"])(
    "returns unhandled when bindHost=%s sees a non-hook request URL",
    async (bindHost) => {
      const handler = createHooksHandler({ bindHost });
      const req = createHookRequest({ url: "/" });
      const { res, end } = createResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(false);
      expect(end).not.toHaveBeenCalled();
    },
  );
});
