/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionArchiveRosterResult } from "../../lib/sessions/index.ts";
import "./sessions-page.ts";

type SessionsPageHarness = HTMLElement & {
  context: ApplicationContext;
  result: SessionsListResult | null;
  error: string | null;
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  selectedKeys: Set<string>;
  archiveAllPending: boolean;
  archiveAllSummary: string | null;
  loadSessions: () => Promise<void>;
  archiveAll: () => Promise<void>;
};

function sessionsResult(sessions: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function createPage(context: ApplicationContext): SessionsPageHarness {
  const page = document.createElement("openclaw-sessions-page") as SessionsPageHarness;
  page.context = context;
  return page;
}

function createContext(params: {
  listResult: SessionsListResult;
  archiveResult?: SessionArchiveRosterResult;
}) {
  const listAllUnarchived = vi.fn(async () => params.listResult);
  const list = vi.fn();
  const archiveRoster = vi.fn(async () => params.archiveResult ?? { archived: [], skipped: [] });
  const context = {
    sessions: {
      state: { result: null, loading: false, error: null },
      list,
      listAllUnarchived,
      archiveRoster,
    },
    gateway: {
      snapshot: { client: {}, connected: true, hello: null, sessionKey: "agent:main:main" },
      setSessionKey: vi.fn(),
    },
    agentSelection: { state: { selectedId: "main" } },
    agents: { state: { agentsList: null } },
    agentIdentity: { get: vi.fn(() => undefined), ensure: vi.fn(async () => undefined) },
  } as unknown as ApplicationContext;
  return { context, list, listAllUnarchived, archiveRoster };
}

describe("sessions page", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to every unarchived global and unknown session without active or limit filters", async () => {
    const result = sessionsResult([
      { key: "agent:main:conversation:test:default:direct:one", kind: "direct", updatedAt: 1 },
    ]);
    const { context, list, listAllUnarchived } = createContext({ listResult: result });
    const page = createPage(context);

    await page.loadSessions();

    expect(page.activeMinutes).toBe("");
    expect(page.limit).toBe("");
    expect(page.includeGlobal).toBe(true);
    expect(page.includeUnknown).toBe(true);
    expect(page.result).toEqual(result);
    expect(listAllUnarchived).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
  });

  it("archives the complete roster and reports every protected and error skip", async () => {
    const rows: GatewaySessionRow[] = [
      { key: "agent:main:conversation:test:default:direct:ready", kind: "direct", updatedAt: 4 },
      {
        key: "agent:main:conversation:test:default:direct:active",
        kind: "direct",
        updatedAt: 3,
        hasActiveRun: true,
      },
      { key: "global", kind: "global", updatedAt: 2 },
      { key: "agent:main:conversation:test:default:direct:broken", kind: "direct", updatedAt: 1 },
    ];
    const archiveResult: SessionArchiveRosterResult = {
      archived: [rows[0].key],
      skipped: [
        { key: rows[1].key, kind: "protected", reason: "Session has an active run." },
        { key: rows[2].key, kind: "protected", reason: "Main and global sessions are protected." },
        { key: rows[3].key, kind: "error", reason: "patch transport failed" },
      ],
    };
    const result = sessionsResult(rows);
    const { context, archiveRoster } = createContext({ listResult: result, archiveResult });
    const page = createPage(context);
    page.result = result;
    page.selectedKeys = new Set(rows.map((row) => row.key));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await page.archiveAll();

    expect(confirm).toHaveBeenCalledWith(
      "Archive 2 eligible sessions?\n\nProtected and active sessions will be skipped.",
    );
    expect(archiveRoster).toHaveBeenCalledWith(rows);
    expect(page.result?.sessions.map((row) => row.key)).toEqual(
      rows.slice(1).map((row) => row.key),
    );
    expect(page.selectedKeys).toEqual(new Set(rows.slice(1).map((row) => row.key)));
    expect(page.archiveAllPending).toBe(false);
    expect(page.archiveAllSummary).toBe(
      "Archived 1 session. Protected skips (2): agent:main:conversation:test:default:direct:active: Session has an active run.; global: Main and global sessions are protected. Errors: 1.",
    );
    expect(page.error).toBe(
      "Archive errors: agent:main:conversation:test:default:direct:broken: patch transport failed",
    );
  });

  it("archives the authoritative full roster even when the visible result is filtered", async () => {
    const fullRoster: GatewaySessionRow[] = Array.from({ length: 1_000 }, (_value, index) => ({
      key: `agent:main:conversation:test:default:direct:${index}`,
      kind: "direct",
      updatedAt: 1_000 - index,
    }));
    const archiveResult: SessionArchiveRosterResult = {
      archived: fullRoster.map((row) => row.key),
      skipped: [],
    };
    const { context, listAllUnarchived, archiveRoster } = createContext({
      listResult: sessionsResult(fullRoster),
      archiveResult,
    });
    const page = createPage(context);
    page.result = sessionsResult([fullRoster[0]!]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    await page.archiveAll();

    expect(listAllUnarchived).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(
      "Archive 1000 eligible sessions?\n\nProtected and active sessions will be skipped.",
    );
    expect(archiveRoster).toHaveBeenCalledWith(fullRoster);
    expect(page.result?.sessions).toEqual([]);
  });
});
