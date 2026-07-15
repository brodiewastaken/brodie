// Session archive sweep: TTL/targets/protection/fail-closed/throttle/rename.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveCronStore } from "openclaw/plugin-sdk/cron-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SESSION_ARCHIVE_TTL_MS,
  createSessionArchiveService,
  resetSessionArchiveSweepThrottleForTests,
  resolveCronSweepProtection,
  resolveGeneratedSessionStorePaths,
  resolveSessionArchiveConfig,
  sweepGeneratedSessions,
  SESSION_ARCHIVE_TARGETS,
  type SessionArchiveConfig,
  type SweepProtection,
} from "./index.js";

const NOW = Date.parse("2026-06-02T12:00:00.000Z");
const OLD = NOW - 70 * 60_000;
const RECENT = NOW - 2 * 60_000;

const EMPTY_PROTECTION: SweepProtection = {
  activeSessionKeys: new Set<string>(),
  activeSessionKeyPrefixes: [],
  activeSessionIds: new Set<string>(),
};

function archiveConfig(overrides: Partial<SessionArchiveConfig> = {}): SessionArchiveConfig {
  return {
    enabled: true,
    retentionMs: 69 * 60_000,
    targets: [...SESSION_ARCHIVE_TARGETS],
    isolatedKeyPrefixes: ["isolated-note-"],
    archiveTranscripts: true,
    intervalMs: 60_000,
    disabledReasons: [],
    ...overrides,
  };
}

function makeEntry(
  sessionId: string,
  updatedAt: number | undefined = OLD,
  extra: Record<string, unknown> = {},
) {
  return { sessionId, ...(updatedAt !== undefined ? { updatedAt } : {}), ...extra };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf-8");
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
}

function createLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function cronJob(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: NOW - 10_000,
    updatedAtMs: NOW - 10_000,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "tick" },
    state: {},
    ...overrides,
  };
}

describe("session-archive sweep", () => {
  let roots: string[] = [];

  beforeEach(() => {
    resetSessionArchiveSweepThrottleForTests();
    roots = [];
  });

  afterEach(async () => {
    resetSessionArchiveSweepThrottleForTests();
    await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function tempRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-archive-"));
    roots.push(root);
    return root;
  }

  it("archives stale generated sessions without touching active or normal sessions", async () => {
    const root = await tempRoot();
    const storePath = path.join(root, "sessions.json");
    await writeJson(storePath, {
      "agent:nova:cron:old-job:run:1": makeEntry("old-cron", OLD, {
        sessionFile: "old-cron.jsonl",
      }),
      "agent:nova:cron:protected-job:run:1": makeEntry("protected-cron", OLD),
      "agent:nova:cron:recent-job:run:1": makeEntry("recent-cron", RECENT),
      "agent:nova:subagent:running": makeEntry("running-subagent", OLD, { status: "running" }),
      "agent:nova:subagent:old": makeEntry("old-subagent", OLD),
      "agent:nova:isolated": makeEntry("old-isolated", OLD, {
        acp: { mode: "oneshot", state: "idle" },
      }),
      "agent:nova:isolated-note-7": makeEntry("old-note", OLD),
      "agent:nova:direct:alice": makeEntry("normal", OLD),
    });
    for (const sessionId of [
      "old-cron",
      "old-subagent",
      "old-isolated",
      "old-note",
      "protected-cron",
      "normal",
    ]) {
      await fs.writeFile(path.join(root, `${sessionId}.jsonl`), `${sessionId}\n`, "utf-8");
    }

    const result = await sweepGeneratedSessions({
      storePath,
      config: archiveConfig(),
      protection: {
        ...EMPTY_PROTECTION,
        activeSessionKeyPrefixes: ["agent:nova:cron:protected-job"],
      },
      nowMs: NOW,
      force: true,
      logger: createLogger(),
    });

    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(4);
    expect(result.prunedByTarget).toEqual({ cron: 1, subagent: 1, isolated: 2 });
    expect(result.skippedActive).toBe(2);

    const persisted = await readJson<Record<string, unknown>>(storePath);
    expect(persisted["agent:nova:cron:old-job:run:1"]).toMatchObject({ archivedAt: NOW });
    expect(persisted["agent:nova:subagent:old"]).toBeUndefined();
    expect(persisted["agent:nova:isolated"]).toBeUndefined();
    expect(persisted["agent:nova:isolated-note-7"]).toBeUndefined();
    expect(persisted["agent:nova:cron:protected-job:run:1"]).toBeDefined();
    expect(persisted["agent:nova:cron:recent-job:run:1"]).toBeDefined();
    expect(persisted["agent:nova:subagent:running"]).toBeDefined();
    expect(persisted["agent:nova:direct:alice"]).toBeDefined();

    const files = await fs.readdir(root);
    expect(files).toContain("protected-cron.jsonl");
    expect(files).toContain("normal.jsonl");
    expect(files).toContain("old-cron.jsonl");
    for (const archived of ["old-subagent", "old-isolated", "old-note"]) {
      expect(files.filter((file) => file.startsWith(`${archived}.jsonl.deleted.`))).toHaveLength(1);
    }
  });

  it("relocates a stale stable cron generation and preserves its transcript", async () => {
    const root = await tempRoot();
    const storePath = path.join(root, "sessions.json");
    await writeJson(storePath, {
      "agent:nova:cron:daily": makeEntry("cron-generation", OLD, {
        sessionFile: "cron-generation.jsonl",
      }),
    });
    await fs.writeFile(path.join(root, "cron-generation.jsonl"), "history\n", "utf-8");

    await sweepGeneratedSessions({
      storePath,
      config: archiveConfig(),
      protection: EMPTY_PROTECTION,
      nowMs: NOW,
      force: true,
    });

    const persisted = await readJson<Record<string, unknown>>(storePath);
    expect(persisted["agent:nova:cron:daily"]).toBeUndefined();
    expect(persisted["agent:nova:cron:daily:run:cron-generation"]).toMatchObject({
      sessionId: "cron-generation",
      archivedAt: NOW,
    });
    expect(await fs.readFile(path.join(root, "cron-generation.jsonl"), "utf-8")).toBe("history\n");
  });

  it("never archives main sessions and segment-terminates isolated prefixes", async () => {
    const root = await tempRoot();
    const storePath = path.join(root, "sessions.json");
    await writeJson(storePath, {
      // A hostile/typo prefix list must not swallow namespaces.
      "agent:nova:main": makeEntry("main-session", OLD),
      main: makeEntry("legacy-main", OLD),
      "agent:nova:discord:dm:123": makeEntry("dm-session", OLD),
      "agent:nova:maintenance:job": makeEntry("maintenance", OLD),
      // Explicit-separator prefixes still match as written.
      "agent:nova:isolated-note-1": makeEntry("note", OLD),
    });

    const result = await sweepGeneratedSessions({
      storePath,
      config: archiveConfig({ isolatedKeyPrefixes: ["main", "d", "isolated-note-"] }),
      protection: EMPTY_PROTECTION,
      nowMs: NOW,
      force: true,
    });

    expect(result.pruned).toBe(1);
    const persisted = await readJson<Record<string, unknown>>(storePath);
    expect(persisted["agent:nova:main"]).toBeDefined();
    expect(persisted.main).toBeDefined();
    expect(persisted["agent:nova:discord:dm:123"]).toBeDefined();
    expect(persisted["agent:nova:maintenance:job"]).toBeDefined();
    expect(persisted["agent:nova:isolated-note-1"]).toBeUndefined();
  });

  it("skips entries without a finite updatedAt (legacy stores on first boot)", async () => {
    const root = await tempRoot();
    const storePath = path.join(root, "sessions.json");
    await writeJson(storePath, {
      // No updatedAt at all (explicit `undefined` would hit the default arg).
      "agent:nova:subagent:no-age": { sessionId: "no-age" },
      "agent:nova:subagent:zero-age": makeEntry("zero-age", 0),
      "agent:nova:subagent:old": makeEntry("old", OLD),
    });
    const result = await sweepGeneratedSessions({
      storePath,
      config: archiveConfig(),
      protection: EMPTY_PROTECTION,
      nowMs: NOW,
      force: true,
    });
    expect(result.pruned).toBe(1);
    const persisted = await readJson<Record<string, unknown>>(storePath);
    expect(persisted["agent:nova:subagent:no-age"]).toBeDefined();
    expect(persisted["agent:nova:subagent:zero-age"]).toBeDefined();
    expect(persisted["agent:nova:subagent:old"]).toBeUndefined();
  });

  it("fails closed for cron-classified entries when the cron store is unreadable", async () => {
    const root = await tempRoot();
    const storePath = path.join(root, "sessions.json");
    await writeJson(storePath, {
      "agent:nova:cron:stale-job:run:1": makeEntry("stale-cron", OLD),
      "agent:nova:subagent:old": makeEntry("old-subagent", OLD),
    });
    const result = await sweepGeneratedSessions({
      storePath,
      config: archiveConfig(),
      protection: { ...EMPTY_PROTECTION, cronProtectionUnavailable: true },
      nowMs: NOW,
      force: true,
    });
    // Cron entries are skipped (no liveness signal); other targets sweep.
    expect(result.pruned).toBe(1);
    expect(result.skippedActive).toBe(1);
    const persisted = await readJson<Record<string, unknown>>(storePath);
    expect(persisted["agent:nova:cron:stale-job:run:1"]).toBeDefined();
    expect(persisted["agent:nova:subagent:old"]).toBeUndefined();
  });

  it("protects parked/waiting subagent parents fed from the registry keys", async () => {
    const root = await tempRoot();
    const storePath = path.join(root, "sessions.json");
    await writeJson(storePath, {
      "agent:nova:subagent:parked-parent": makeEntry("parked", OLD),
      "agent:nova:subagent:done": makeEntry("done", OLD),
    });
    const result = await sweepGeneratedSessions({
      storePath,
      config: archiveConfig(),
      protection: {
        ...EMPTY_PROTECTION,
        activeSessionKeys: new Set(["agent:nova:subagent:parked-parent"]),
      },
      nowMs: NOW,
      force: true,
    });
    expect(result.pruned).toBe(1);
    expect(result.skippedActive).toBe(1);
    const persisted = await readJson<Record<string, unknown>>(storePath);
    expect(persisted["agent:nova:subagent:parked-parent"]).toBeDefined();
    expect(persisted["agent:nova:subagent:done"]).toBeUndefined();
  });

  it("never renames the store itself or another session's live transcript", async () => {
    const root = await tempRoot();
    const storePath = path.join(root, "sessions.json");
    await writeJson(storePath, {
      // Corrupt sessionFile pointing at the store: must not rename it.
      "agent:nova:subagent:corrupt": makeEntry("corrupt", OLD, { sessionFile: "sessions.json" }),
      // sessionFile pointing at ANOTHER surviving session's live transcript.
      "agent:nova:subagent:foreign": makeEntry("foreign", OLD, { sessionFile: "victim.jsonl" }),
      "agent:nova:direct:victim": makeEntry("victim", NOW),
    });
    await fs.writeFile(path.join(root, "victim.jsonl"), "victim\n", "utf-8");

    const result = await sweepGeneratedSessions({
      storePath,
      config: archiveConfig(),
      protection: EMPTY_PROTECTION,
      nowMs: NOW,
      force: true,
    });
    expect(result.pruned).toBe(2);
    expect(fsSync.existsSync(storePath)).toBe(true);
    expect(fsSync.existsSync(path.join(root, "victim.jsonl"))).toBe(true);
    const files = await fs.readdir(root);
    expect(files.filter((file) => file.includes("sessions.json.deleted"))).toHaveLength(0);
    expect(files.filter((file) => file.startsWith("victim.jsonl.deleted."))).toHaveLength(0);
  });

  it("does not archive a transcript while a surviving entry references the same session id", async () => {
    const root = await tempRoot();
    const storePath = path.join(root, "sessions.json");
    await writeJson(storePath, {
      "agent:nova:subagent:old": makeEntry("shared-session", OLD),
      "agent:nova:direct:alice": makeEntry("Shared-Session", NOW),
    });
    await fs.writeFile(path.join(root, "shared-session.jsonl"), "shared\n", "utf-8");

    const result = await sweepGeneratedSessions({
      storePath,
      config: archiveConfig(),
      protection: EMPTY_PROTECTION,
      nowMs: NOW,
      force: true,
    });
    expect(result.pruned).toBe(1);
    // Case-folded reference match keeps the transcript in place.
    expect(fsSync.existsSync(path.join(root, "shared-session.jsonl"))).toBe(true);
  });

  it("throttles effective sweeps per store unless forced", async () => {
    const root = await tempRoot();
    const storePath = path.join(root, "sessions.json");
    await writeJson(storePath, { "agent:nova:subagent:old": makeEntry("first", OLD) });

    const first = await sweepGeneratedSessions({
      storePath,
      config: archiveConfig(),
      protection: EMPTY_PROTECTION,
      nowMs: NOW,
      force: true,
    });
    expect(first.pruned).toBe(1);

    await writeJson(storePath, { "agent:nova:subagent:next": makeEntry("second", OLD) });
    const throttled = await sweepGeneratedSessions({
      storePath,
      config: archiveConfig(),
      protection: EMPTY_PROTECTION,
      nowMs: NOW + 60_000,
      force: false,
    });
    expect(throttled.swept).toBe(false);
    expect(throttled.pruned).toBe(0);

    const later = await sweepGeneratedSessions({
      storePath,
      config: archiveConfig(),
      protection: EMPTY_PROTECTION,
      nowMs: NOW + 6 * 60_000,
      force: false,
    });
    expect(later.pruned).toBe(1);
  });

  it("treats a missing store as a successful empty sweep and null retention as inert", async () => {
    const root = await tempRoot();
    const missing = await sweepGeneratedSessions({
      storePath: path.join(root, "nope", "sessions.json"),
      config: archiveConfig(),
      protection: EMPTY_PROTECTION,
      nowMs: NOW,
      force: true,
    });
    expect(missing.swept).toBe(true);
    expect(missing.pruned).toBe(0);

    const storePath = path.join(root, "sessions.json");
    await writeJson(storePath, { "agent:nova:subagent:old": makeEntry("old", OLD) });
    const disabled = await sweepGeneratedSessions({
      storePath,
      config: archiveConfig({ retentionMs: null }),
      protection: EMPTY_PROTECTION,
      nowMs: NOW,
      force: true,
    });
    expect(disabled.swept).toBe(false);
    expect(
      (await readJson<Record<string, unknown>>(storePath))["agent:nova:subagent:old"],
    ).toBeDefined();
  });

  it("does not treat idle enabled cron configuration as live work", async () => {
    const root = await tempRoot();
    const cronStorePath = path.join(root, "cron", "jobs.json");
    // The 6.11 cron store is SQLite-backed and keyed by the store path.
    await saveCronStore(cronStorePath, {
      version: 1,
      jobs: [
        cronJob("idle-enabled-job"),
        cronJob("bound-job", { sessionTarget: "session:agent:nova:cron:custom-key" }),
        cronJob("disabled-job", { enabled: false }),
      ],
    } as never);
    const protection = await resolveCronSweepProtection({
      cronStorePath,
      agentIds: ["nova", "aria"],
    });
    expect(protection.unavailable).toBe(false);
    expect(protection.prefixes).toEqual([]);
    expect([...protection.keys]).toEqual([]);
  });

  it("derives per-agent store paths from the session.store template", () => {
    const paths = resolveGeneratedSessionStorePaths({
      config: { session: { store: "/tmp/state/{agentId}/sessions.json" } },
      agentIds: ["nova", "aria", "nova"],
    });
    expect(paths).toEqual(["/tmp/state/nova/sessions.json", "/tmp/state/aria/sessions.json"]);
  });
});

describe("resolveSessionArchiveConfig", () => {
  it("normalizes defaults", () => {
    const defaults = resolveSessionArchiveConfig(undefined);
    expect(defaults.enabled).toBe(true);
    expect(defaults.retentionMs).toBe(DEFAULT_SESSION_ARCHIVE_TTL_MS);
    expect(defaults.targets).toEqual([...SESSION_ARCHIVE_TARGETS]);
    expect(defaults.archiveTranscripts).toBe(true);
    expect(defaults.intervalMs).toBe(60_000);
    expect(defaults.disabledReasons).toEqual([]);

    const custom = resolveSessionArchiveConfig({
      ttl: "69m",
      targets: ["cron", "bogus", "cron"],
      isolatedKeyPrefixes: [" isolated-note- ", ""],
      intervalMs: 500,
    });
    expect(custom.retentionMs).toBe(69 * 60_000);
    expect(custom.targets).toEqual(["cron"]);
    expect(custom.isolatedKeyPrefixes).toEqual(["isolated-note-"]);
    // Below the 1s floor falls back to the default cadence.
    expect(custom.intervalMs).toBe(60_000);
  });

  it("fails CLOSED on invalid ttl, zero ttl, and all-invalid targets", () => {
    for (const ttl of ["not-a-duration", "0m", "-5m", 42 as unknown as string, ""]) {
      const config = resolveSessionArchiveConfig({ ttl });
      expect(config.retentionMs).toBeNull();
      expect(config.disabledReasons.length).toBeGreaterThan(0);
    }
    const badTargets = resolveSessionArchiveConfig({ targets: ["bogus", "nope"] });
    expect(badTargets.retentionMs).toBeNull();
    expect(badTargets.disabledReasons.length).toBeGreaterThan(0);

    expect(resolveSessionArchiveConfig({ enabled: false }).retentionMs).toBeNull();
  });
});

describe("createSessionArchiveService", () => {
  it("protects only exact cron sessions with nonterminal scheduler work", async () => {
    resetSessionArchiveSweepThrottleForTests();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-archive-state-"));
    try {
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const cronStorePath = path.join(stateDir, "cron", "jobs.json");
      const activeKey = "agent:main:cron:active";
      const idleKey = "agent:main:cron:idle";
      await saveCronStore(cronStorePath, { version: 1, jobs: [] } as never);
      await writeJson(storePath, {
        [activeKey]: makeEntry("active-session", OLD),
        [idleKey]: makeEntry("idle-session", OLD),
      });
      const service = createSessionArchiveService(archiveConfig(), {
        getConversationScheduler: () =>
          ({
            snapshot: async () => ({
              storageHealthy: true,
              lanes: [
                {
                  sessionKey: activeKey,
                  outstandingCount: 1,
                  producerKinds: ["cron"],
                },
                {
                  sessionKey: idleKey,
                  outstandingCount: 0,
                  producerKinds: ["cron"],
                },
              ],
            }),
          }) as never,
      });
      void service.start({
        config: { cron: { store: cronStorePath }, session: { store: storePath } },
        stateDir,
        logger: createLogger(),
      });

      await vi.waitFor(async () => {
        const persisted = await readJson<Record<string, unknown>>(storePath);
        expect(persisted[`${idleKey}:run:idle-session`]).toBeDefined();
      });
      const persisted = await readJson<Record<string, unknown>>(storePath);
      expect(persisted[activeKey]).toBeDefined();
      expect(persisted[idleKey]).toBeUndefined();
      service.stop();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("runs a forced initial sweep with registry-fed subagent protection", async () => {
    resetSessionArchiveSweepThrottleForTests();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-archive-state-"));
    try {
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const cronStorePath = path.join(stateDir, "cron", "jobs.json");
      await saveCronStore(cronStorePath, { version: 1, jobs: [] } as never);
      await writeJson(storePath, {
        "agent:nova:cron:possibly-active": makeEntry("cron", OLD),
        "agent:nova:subagent:old": makeEntry("old", OLD),
        "agent:nova:subagent:parked-parent": makeEntry("parked", OLD),
      });
      const service = createSessionArchiveService(archiveConfig(), {
        getConversationScheduler: () => undefined,
        readProtectedSubagentSessionKeys: () => ["agent:nova:subagent:parked-parent"],
      });
      const logger = createLogger();
      void service.start({
        config: {
          cron: { store: cronStorePath },
          session: { store: path.join(stateDir, "sessions", "sessions.json") },
        },
        stateDir,
        logger,
      });
      await vi.waitFor(async () => {
        const persisted = await readJson<Record<string, unknown>>(storePath);
        expect(persisted["agent:nova:subagent:old"]).toBeUndefined();
      });
      const persisted = await readJson<Record<string, unknown>>(storePath);
      expect(persisted["agent:nova:cron:possibly-active"]).toBeDefined();
      expect(persisted["agent:nova:subagent:parked-parent"]).toBeDefined();
      service.stop();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed for subagent sessions when registry protection cannot be read", async () => {
    resetSessionArchiveSweepThrottleForTests();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-archive-state-"));
    try {
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      await writeJson(storePath, {
        "agent:nova:subagent:possibly-active": makeEntry("possibly-active", OLD),
        "agent:nova:isolated-note-old": makeEntry("isolated-old", OLD),
      });
      const service = createSessionArchiveService(archiveConfig(), {
        readProtectedSubagentSessionKeys: () => {
          throw new Error("registry unavailable");
        },
      });
      const logger = createLogger();
      void service.start({
        config: { session: { store: path.join(stateDir, "sessions", "sessions.json") } },
        stateDir,
        logger,
      });

      await vi.waitFor(async () => {
        const persisted = await readJson<Record<string, unknown>>(storePath);
        expect(persisted["agent:nova:isolated-note-old"]).toBeUndefined();
      });
      const persisted = await readJson<Record<string, unknown>>(storePath);
      expect(persisted["agent:nova:subagent:possibly-active"]).toBeDefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("failing closed for subagent-classified sessions"),
      );
      service.stop();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("stays inert (with loud warnings) on disabled or fail-closed config", async () => {
    const logger = createLogger();
    const service = createSessionArchiveService(
      archiveConfig({
        retentionMs: null,
        disabledReasons: ['invalid ttl "banana" (must parse to > 0)'],
      }),
    );
    void service.start({ config: {}, stateDir: "/nonexistent", logger });
    service.stop();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("INERT"));
  });
});
