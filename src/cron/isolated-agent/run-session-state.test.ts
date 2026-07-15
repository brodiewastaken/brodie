// Run session state tests cover persisted session state for isolated cron agents.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../../config/sessions.js";
import { mergeSessionEntry } from "../../config/sessions/types.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  adoptCronRunSessionMetadata,
  createPersistCronSessionEntry,
  resolveCronLifecycleRevisionIdentity,
  type MutableCronSession,
} from "./run-session-state.js";

function makeSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "run-session-id",
    updatedAt: 1000,
    systemSent: true,
    ...overrides,
  };
}

function makeCronSession(entry = makeSessionEntry()): MutableCronSession {
  return {
    storePath: "/tmp/sessions.json",
    store: {},
    sessionEntry: entry,
    systemSent: true,
    isNewSession: true,
    previousSessionId: undefined,
  } as MutableCronSession;
}

type TestUpdateSessionStore = (
  storePath: string,
  update: (store: Record<string, SessionEntry>) => void,
) => Promise<void>;

function adaptUpdateSessionStore(updateSessionStore: TestUpdateSessionStore) {
  return async (params: {
    storePath: string;
    upserts: Array<{
      sessionKey: string;
      buildEntry: (context: {
        currentEntry?: SessionEntry;
        sessionKey: string;
      }) => SessionEntry | null | undefined;
    }>;
  }) => {
    await updateSessionStore(params.storePath, (store) => {
      const nextStore = { ...store };
      for (const upsert of params.upserts) {
        const nextEntry = upsert.buildEntry({
          currentEntry: nextStore[upsert.sessionKey],
          sessionKey: upsert.sessionKey,
        });
        if (nextEntry) {
          nextStore[upsert.sessionKey] = nextEntry;
        }
      }
      for (const key of Object.keys(store)) {
        delete store[key];
      }
      Object.assign(store, nextStore);
    });
  };
}

describe("createPersistCronSessionEntry", () => {
  it("persists isolated cron state under stable and exact run keys", async () => {
    const runSessionKey = "agent:main:cron:job:run:run-session-id";
    const cronSession = makeCronSession(
      makeSessionEntry({
        sessionFile: await createTranscriptFile(),
        status: "running",
        startedAt: 900,
        skillsSnapshot: {
          prompt: "old prompt",
          skills: [{ name: "memory" }],
        },
      }),
    );
    const updateSessionStore = vi.fn(
      async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
        const store: Record<string, SessionEntry> = {};
        update(store);
        expect(store["agent:main:cron:job"]).toBe(cronSession.sessionEntry);
        expect(store[runSessionKey]).toEqual(cronSession.sessionEntry);
        expect(store[runSessionKey]).not.toBe(cronSession.sessionEntry);
      },
    );

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:job",
      runSessionKey,
      applySessionEntryLifecycleMutation: adaptUpdateSessionStore(updateSessionStore),
    });

    await persist();

    expect(cronSession.store["agent:main:cron:job"]).toBe(cronSession.sessionEntry);
    expect(cronSession.store[runSessionKey]).toEqual(cronSession.sessionEntry);
  });

  it("retains cron identity without resume handles until the transcript exists", async () => {
    const runSessionKey = "agent:main:cron:shell-only:run:run-session-id";
    const missingTranscriptPath = path.join(
      os.tmpdir(),
      `openclaw-missing-cron-${crypto.randomUUID()}.jsonl`,
    );
    const cronSession = makeCronSession(
      makeSessionEntry({
        lifecycleRevision: "run-revision",
        sessionFile: missingTranscriptPath,
        label: "Cron: shell-only",
        status: "running",
      }),
    );
    const updateSessionStore = vi.fn(
      async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
        const store: Record<string, SessionEntry> = {};
        update(store);
        expect(store["agent:main:cron:shell-only"]).toEqual({
          sessionId: "run-session-id",
          cronRunSessionKey: runSessionKey,
          label: "Cron: shell-only",
          lifecycleRevision: "run-revision",
          status: "running",
          updatedAt: 1000,
          systemSent: true,
        });
        expect(store[runSessionKey]).toEqual(store["agent:main:cron:shell-only"]);
      },
    );

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:shell-only",
      runSessionKey,
      applySessionEntryLifecycleMutation: adaptUpdateSessionStore(updateSessionStore),
    });

    await persist();

    expect(cronSession.store["agent:main:cron:shell-only"]?.sessionId).toBe("run-session-id");
    expect(cronSession.store["agent:main:cron:shell-only"]?.sessionFile).toBeUndefined();
    expect(cronSession.store["agent:main:cron:shell-only"]?.lifecycleRevision).toBe("run-revision");
    expect(cronSession.store[runSessionKey]).toEqual(
      cronSession.store["agent:main:cron:shell-only"],
    );
    expect(cronSession.sessionEntry.sessionId).toBe("run-session-id");
    expect(cronSession.sessionEntry.sessionFile).toBe(missingTranscriptPath);
  });

  it("restores resumable cron fields once the transcript exists", async () => {
    const runSessionKey = "agent:main:cron:completed:run:run-session-id";
    const transcriptPath = await createTranscriptFile();
    const cronSession = makeCronSession(
      makeSessionEntry({
        sessionFile: transcriptPath,
        label: "Cron: completed",
      }),
    );

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:cron:completed",
      applySessionEntryLifecycleMutation: adaptUpdateSessionStore(
        vi.fn(async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
          const store: Record<string, SessionEntry> = {};
          update(store);
          expect(store["agent:main:cron:completed"]).toEqual({
            sessionId: "run-session-id",
            sessionFile: transcriptPath,
            label: "Cron: completed",
            updatedAt: 1000,
            systemSent: true,
            cronRunSessionKey: runSessionKey,
          });
          expect(store[runSessionKey]).toEqual(store["agent:main:cron:completed"]);
        }),
      ),
      runSessionKey,
    });

    await persist();

    expect(cronSession.store["agent:main:cron:completed"]).toEqual({
      sessionId: "run-session-id",
      sessionFile: transcriptPath,
      cronRunSessionKey: runSessionKey,
      label: "Cron: completed",
      updatedAt: 1000,
      systemSent: true,
    });
    expect(cronSession.store[runSessionKey]).toEqual(
      cronSession.store["agent:main:cron:completed"],
    );
  });

  it("preserves the run identity across a pre-transcript auth-profile patch", async () => {
    const sessionKey = "agent:main:cron:auth-profile";
    const runSessionKey = `${sessionKey}:run:run-session-id`;
    const dir = makeTempDir(cronSessionTempDirs, "openclaw-cron-auth-profile-");
    const transcriptPath = path.join(dir, "run-session-id.jsonl");
    const cronSession = {
      ...makeCronSession(
        makeSessionEntry({
          lifecycleRevision: "run-revision",
          sessionFile: transcriptPath,
          status: "running",
        }),
      ),
      lifecycleRevision: "run-revision",
    } as MutableCronSession;
    const persistedStore: Record<string, SessionEntry> = {};
    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: sessionKey,
      runSessionKey,
      applySessionEntryLifecycleMutation: adaptUpdateSessionStore(async (_storePath, update) => {
        update(persistedStore);
      }),
    });

    await persist();

    cronSession.sessionEntry.authProfileOverride = "openai:default";
    cronSession.sessionEntry.authProfileOverrideSource = "auto";
    persistedStore[sessionKey] = mergeSessionEntry(persistedStore[sessionKey], {
      authProfileOverride: "openai:default",
      authProfileOverrideSource: "auto",
      updatedAt: 1100,
    });
    cronSession.store[sessionKey] = persistedStore[sessionKey];

    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({ type: "session", id: "run-session-id" })}\n`,
    );
    cronSession.sessionEntry.status = "done";
    cronSession.sessionEntry.totalTokens = 42;

    await persist();

    expect(persistedStore[sessionKey]).toMatchObject({
      sessionId: "run-session-id",
      sessionFile: transcriptPath,
      authProfileOverride: "openai:default",
      authProfileOverrideSource: "auto",
      lifecycleRevision: "run-revision",
      status: "done",
      totalTokens: 42,
    });
    expect(cronSession.store[sessionKey]).toEqual(persistedStore[sessionKey]);
    expect(persistedStore[runSessionKey]).toEqual(persistedStore[sessionKey]);
    expect(cronSession.store[runSessionKey]).toEqual(persistedStore[sessionKey]);
  });

  it("does not overwrite an exact run key owned by another lifecycle", async () => {
    const sessionKey = "agent:main:cron:collision";
    const runSessionKey = `${sessionKey}:run:run-session-id`;
    const stableEntry = makeSessionEntry({ lifecycleRevision: "stable-before" });
    const cronSession = {
      ...makeCronSession(makeSessionEntry({ lifecycleRevision: "current-revision" })),
      initialSessionEntry: stableEntry,
      lifecycleRevision: "current-revision",
    } as MutableCronSession;
    const conflictingRunEntry = makeSessionEntry({ lifecycleRevision: "other-revision" });
    const store: Record<string, SessionEntry> = {
      [sessionKey]: stableEntry,
      [runSessionKey]: conflictingRunEntry,
    };
    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: sessionKey,
      runSessionKey,
      applySessionEntryLifecycleMutation: adaptUpdateSessionStore(async (_storePath, update) => {
        update(store);
      }),
    });

    await expect(persist()).rejects.toThrow(
      `Session "${runSessionKey}" changed while starting work. Retry.`,
    );
    expect(store[sessionKey]).toBe(stableEntry);
    expect(store[runSessionKey]).toBe(conflictingRunEntry);
  });

  it("keeps the exact run key bound to adopted transcript metadata", async () => {
    const sessionKey = "agent:main:cron:compacted";
    const runSessionKey = `${sessionKey}:run:run-session-id`;
    const transcriptPath = await createTranscriptFile("rotated-session-id");
    const cronSession = {
      ...makeCronSession(
        makeSessionEntry({
          lifecycleRevision: "run-revision",
          sessionFile: "/tmp/run-session-id.jsonl",
        }),
      ),
      lifecycleRevision: "run-revision",
    } as MutableCronSession;
    const changed = adoptCronRunSessionMetadata({
      entry: cronSession.sessionEntry,
      sessionKey,
      runMeta: {
        sessionId: "rotated-session-id",
        sessionFile: transcriptPath,
      },
    });
    const store: Record<string, SessionEntry> = {};
    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: sessionKey,
      runSessionKey,
      applySessionEntryLifecycleMutation: adaptUpdateSessionStore(async (_storePath, update) => {
        update(store);
      }),
    });

    expect(changed).toBe(true);
    await persist();

    expect(store[sessionKey]).toMatchObject({
      sessionId: "rotated-session-id",
      sessionFile: transcriptPath,
    });
    expect(store[runSessionKey]).toEqual(store[sessionKey]);
    expect(store[`${sessionKey}:run:rotated-session-id`]).toBeUndefined();
  });

  it("persists explicit session-bound cron state under the requested session key", async () => {
    const cronSession = makeCronSession();
    const updateSessionStore = vi.fn(
      async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
        const store: Record<string, SessionEntry> = {};
        update(store);
        expect(store["agent:main:session"]).toBe(cronSession.sessionEntry);
      },
    );

    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:session",
      applySessionEntryLifecycleMutation: adaptUpdateSessionStore(updateSessionStore),
    });

    await persist();

    expect(cronSession.store["agent:main:session"]).toBe(cronSession.sessionEntry);
  });

  it("does not let an older concurrent run reclaim a persisted lifecycle revision", async () => {
    const sessionKey = "agent:main:session";
    const initialSessionEntry = makeSessionEntry({ lifecycleRevision: "initial-revision" });
    const persistedStore: Record<string, SessionEntry> = {
      [sessionKey]: initialSessionEntry,
    };
    const makeConcurrentSession = (lifecycleRevision: string): MutableCronSession =>
      ({
        ...makeCronSession(
          makeSessionEntry({
            lifecycleRevision,
            label: lifecycleRevision,
          }),
        ),
        initialSessionEntry,
        lifecycleRevision,
      }) as MutableCronSession;
    const updateSessionStore = vi.fn(
      async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
        update(persistedStore);
      },
    );
    const olderSession = makeConcurrentSession("older-revision");
    const newerSession = makeConcurrentSession("newer-revision");
    const persistOlder = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession: olderSession,
      agentSessionKey: sessionKey,
      applySessionEntryLifecycleMutation: adaptUpdateSessionStore(updateSessionStore),
    });
    const persistNewer = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession: newerSession,
      agentSessionKey: sessionKey,
      applySessionEntryLifecycleMutation: adaptUpdateSessionStore(updateSessionStore),
    });

    await persistNewer();
    await expect(persistOlder()).rejects.toThrow(
      `Session "${sessionKey}" changed while starting work. Retry.`,
    );

    expect(persistedStore[sessionKey]).toStrictEqual(newerSession.sessionEntry);
    expect(olderSession.store[sessionKey]).toBeUndefined();
  });

  it("does not replace a lifecycle revision while its owner is admitted", async () => {
    const sessionKey = "agent:main:session";
    const storePath = "/tmp/sessions-active-lifecycle.json";
    const activeRevision = crypto.randomUUID();
    const nextRevision = crypto.randomUUID();
    const activeEntry = makeSessionEntry({ lifecycleRevision: activeRevision });
    const persistedStore: Record<string, SessionEntry> = { [sessionKey]: activeEntry };
    const nextSession = {
      ...makeCronSession(makeSessionEntry({ lifecycleRevision: nextRevision })),
      initialSessionEntry: activeEntry,
      lifecycleRevision: nextRevision,
      storePath,
    } as MutableCronSession;
    const persistNext = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession: nextSession,
      agentSessionKey: sessionKey,
      applySessionEntryLifecycleMutation: adaptUpdateSessionStore(async (_storePath, update) => {
        update(persistedStore);
      }),
    });
    const activeLease = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [resolveCronLifecycleRevisionIdentity(activeRevision)],
      assertAllowed: () => {},
    });

    try {
      await expect(persistNext()).rejects.toThrow(
        `Session "${sessionKey}" changed while starting work. Retry.`,
      );
      expect(persistedStore[sessionKey]).toBe(activeEntry);
    } finally {
      activeLease.release();
    }
    await expect(persistNext()).resolves.toBeUndefined();
    expect(persistedStore[sessionKey]).toStrictEqual(nextSession.sessionEntry);
  });

  it("claims an initial row after a concurrent pin and rename", async () => {
    const sessionKey = "agent:main:session";
    const lifecycleRevision = crypto.randomUUID();
    const initialSessionEntry = makeSessionEntry({ lifecycleRevision: "initial-revision" });
    const cronSession = {
      ...makeCronSession(
        makeSessionEntry({
          lifecycleRevision,
          status: "running",
        }),
      ),
      initialSessionEntry,
      lifecycleRevision,
    } as MutableCronSession;
    const persistedStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        ...initialSessionEntry,
        label: "Renamed before claim",
        pinnedAt: 2000,
        updatedAt: 2000,
      },
    };
    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: sessionKey,
      applySessionEntryLifecycleMutation: adaptUpdateSessionStore(async (_storePath, update) => {
        update(persistedStore);
      }),
    });

    await expect(persist()).resolves.toBeUndefined();
    expect(persistedStore[sessionKey]).toMatchObject({
      label: "Renamed before claim",
      lifecycleRevision,
      pinnedAt: 2000,
      status: "running",
      updatedAt: 2000,
    });
  });

  it.each([
    {
      name: "pin and rename",
      current: { label: "Renamed", pinnedAt: 2000, updatedAt: 2000 },
      expected: { label: "Renamed", pinnedAt: 2000, updatedAt: 2000 },
    },
    {
      name: "unpin and clear the label",
      current: { label: undefined, pinnedAt: undefined, updatedAt: 2000 },
      expected: { label: undefined, pinnedAt: undefined, updatedAt: 2000 },
    },
  ])("preserves a concurrent $name during cron persistence", async ({ current, expected }) => {
    const sessionKey = "agent:main:session";
    const lifecycleRevision = crypto.randomUUID();
    const runEntry = makeSessionEntry({
      lifecycleRevision,
      label: "Original",
      pinnedAt: 1000,
      status: "done",
    });
    const cronSession = {
      ...makeCronSession(runEntry),
      initialSessionEntry: { ...runEntry },
      lifecycleRevision,
    } as MutableCronSession;
    const persistedStore: Record<string, SessionEntry> = {
      [sessionKey]: {
        ...cronSession.sessionEntry,
        ...current,
      },
    };
    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: sessionKey,
      applySessionEntryLifecycleMutation: adaptUpdateSessionStore(async (_storePath, update) => {
        update(persistedStore);
      }),
    });

    await persist();

    expect(persistedStore[sessionKey]).toMatchObject({
      lifecycleRevision,
      status: "done",
      updatedAt: expected.updatedAt,
    });
    expect(persistedStore[sessionKey]?.label).toBe(expected.label);
    expect(persistedStore[sessionKey]?.pinnedAt).toBe(expected.pinnedAt);
    expect(cronSession.sessionEntry.label).toBe(expected.label);
    expect(cronSession.sessionEntry.pinnedAt).toBe(expected.pinnedAt);
    expect(cronSession.sessionEntry.updatedAt).toBe(expected.updatedAt);
  });

  it("does not restore session policy cleared while a cron run is active", async () => {
    const sessionKey = "agent:main:session";
    const lifecycleRevision = crypto.randomUUID();
    const initialSessionEntry = makeSessionEntry({
      lifecycleRevision,
      chatType: "direct",
      elevatedLevel: "full",
      inheritedToolAllow: ["exec"],
      sendPolicy: "allow",
    });
    const cronSession = {
      ...makeCronSession({
        ...initialSessionEntry,
        status: "done",
        totalTokens: 42,
      }),
      initialSessionEntry,
      lifecycleRevision,
    } as MutableCronSession;
    const currentEntry: SessionEntry = {
      ...initialSessionEntry,
      chatType: "group",
      sendPolicy: "deny",
      updatedAt: 2000,
    };
    delete currentEntry.elevatedLevel;
    delete currentEntry.inheritedToolAllow;
    const persistedStore: Record<string, SessionEntry> = { [sessionKey]: currentEntry };
    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: sessionKey,
      applySessionEntryLifecycleMutation: adaptUpdateSessionStore(async (_storePath, update) => {
        update(persistedStore);
      }),
    });

    await persist();

    expect(persistedStore[sessionKey]).toMatchObject({
      chatType: "group",
      sendPolicy: "deny",
      status: "done",
      totalTokens: 42,
      updatedAt: 2000,
    });
    expect(persistedStore[sessionKey]?.elevatedLevel).toBeUndefined();
    expect(persistedStore[sessionKey]?.inheritedToolAllow).toBeUndefined();
  });

  it("adopts rotated run transcript metadata before persisting session-bound cron state", async () => {
    const cronSession = makeCronSession(
      makeSessionEntry({
        sessionId: "bound-session",
        sessionFile: "/tmp/bound-session.jsonl",
      }),
    );
    const changed = adoptCronRunSessionMetadata({
      entry: cronSession.sessionEntry,
      sessionKey: "agent:main:telegram:direct:42",
      runMeta: {
        sessionId: "bound-session-rotated",
        sessionFile: "/tmp/bound-session-rotated.jsonl",
      },
    });
    const updateSessionStore = vi.fn(
      async (_storePath, update: (store: Record<string, SessionEntry>) => void) => {
        const store: Record<string, SessionEntry> = {};
        update(store);
        expect(store["agent:main:telegram:direct:42"]).toEqual({
          sessionId: "bound-session-rotated",
          sessionFile: "/tmp/bound-session-rotated.jsonl",
          usageFamilyKey: "agent:main:telegram:direct:42",
          usageFamilySessionIds: ["bound-session", "bound-session-rotated"],
          updatedAt: 1000,
          systemSent: true,
        });
      },
    );

    expect(changed).toBe(true);
    const persist = createPersistCronSessionEntry({
      isFastTestEnv: false,
      cronSession,
      agentSessionKey: "agent:main:telegram:direct:42",
      applySessionEntryLifecycleMutation: adaptUpdateSessionStore(updateSessionStore),
    });

    await persist();

    expect(cronSession.store["agent:main:telegram:direct:42"]).toEqual({
      sessionId: "bound-session-rotated",
      sessionFile: "/tmp/bound-session-rotated.jsonl",
      usageFamilyKey: "agent:main:telegram:direct:42",
      usageFamilySessionIds: ["bound-session", "bound-session-rotated"],
      updatedAt: 1000,
      systemSent: true,
    });
  });
});

const cronSessionTempDirs: string[] = [];

async function createTranscriptFile(sessionId = "run-session-id"): Promise<string> {
  const dir = makeTempDir(cronSessionTempDirs, "openclaw-cron-session-");
  const file = path.join(dir, "session.jsonl");
  await fs.writeFile(file, `${JSON.stringify({ type: "session", sessionId })}\n`);
  return file;
}

afterAll(() => {
  cleanupTempDirs(cronSessionTempDirs);
});
