import type { RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSessionsRoute } from "./route.ts";

function sessionsResult(): SessionsListResult {
  return {
    ts: 1,
    path: "(multiple)",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [
      { key: "agent:main:conversation:test:default:direct:one", kind: "direct", updatedAt: 1 },
    ],
  };
}

describe("sessions route", () => {
  it("loads the complete unarchived roster by default", async () => {
    const result = sessionsResult();
    const listAllUnarchived = vi.fn(async () => result);
    const list = vi.fn();
    const context = {
      sessions: { list, listAllUnarchived },
      runtimeConfig: { ensureLoaded: vi.fn(async () => undefined) },
      gateway: { snapshot: { client: null, connected: true } },
    } as unknown as ApplicationContext;

    await expect(
      loadSessionsRoute(context, { search: "", hash: "" } as RouteLocation),
    ).resolves.toMatchObject({ result, error: null, showArchived: false });
    expect(listAllUnarchived).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
  });

  it("keeps a session deep link scoped to its exact key", async () => {
    const result = sessionsResult();
    const listAllUnarchived = vi.fn();
    const list = vi.fn(async () => result);
    const context = {
      sessions: { list, listAllUnarchived },
      runtimeConfig: { ensureLoaded: vi.fn(async () => undefined) },
      gateway: { snapshot: { client: null, connected: true } },
    } as unknown as ApplicationContext;
    const key = "agent:main:conversation:test:default:direct:one";

    await loadSessionsRoute(context, {
      search: `?session=${encodeURIComponent(key)}`,
      hash: "",
    } as RouteLocation);

    expect(list).toHaveBeenCalledWith({
      activeMinutes: 0,
      limit: 50,
      search: key,
      includeGlobal: true,
      includeUnknown: true,
      showArchived: false,
      agentId: "main",
    });
    expect(listAllUnarchived).not.toHaveBeenCalled();
  });
});
