import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { relocateCronSessionEntryInStore } from "./session-lifecycle.js";

describe("cron session lifecycle", () => {
  it("moves one stable generation to a collision-proof run key", () => {
    const stableKey = "agent:main:cron:daily";
    const store: Record<string, SessionEntry> = {
      [stableKey]: {
        sessionId: "session-1",
        updatedAt: 10,
        lifecycleRevision: "revision-1",
        sessionFile: "/tmp/session-1.jsonl",
      },
    };

    const result = relocateCronSessionEntryInStore({
      store,
      stableKey,
      nowMs: 20,
      idempotencyId: "archive-1",
      expectedSessionId: "session-1",
      expectedLifecycleRevision: "revision-1",
    });

    expect(store[stableKey]).toBeUndefined();
    expect(result.archivedKey).toBe("agent:main:cron:daily:run:session-1");
    expect(store[result.archivedKey]).toMatchObject({
      sessionId: "session-1",
      sessionFile: "/tmp/session-1.jsonl",
      archivedAt: 20,
      cronArchiveReceipt: { idempotencyId: "archive-1" },
    });

    expect(
      relocateCronSessionEntryInStore({
        store,
        stableKey,
        nowMs: 30,
        idempotencyId: "archive-1",
        expectedSessionId: "session-1",
        expectedLifecycleRevision: "revision-1",
      }),
    ).toMatchObject({ archivedKey: result.archivedKey, relocated: false });
  });

  it("archives over the hidden exact-run alias owned by the same generation", () => {
    const stableKey = "agent:main:cron:daily";
    const archivedKey = `${stableKey}:run:session-1`;
    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 10,
      lifecycleRevision: "revision-1",
      sessionFile: "/tmp/session-1.jsonl",
      totalTokens: 42,
    };
    const store: Record<string, SessionEntry> = {
      [stableKey]: entry,
      [archivedKey]: structuredClone(entry),
    };

    const result = relocateCronSessionEntryInStore({
      store,
      stableKey,
      nowMs: 20,
      idempotencyId: "archive-alias",
      expectedSessionId: "session-1",
      expectedLifecycleRevision: "revision-1",
    });

    expect(result).toMatchObject({ archivedKey, relocated: true });
    expect(store[stableKey]).toBeUndefined();
    expect(store[archivedKey]).toMatchObject({
      sessionId: "session-1",
      sessionFile: "/tmp/session-1.jsonl",
      totalTokens: 42,
      archivedAt: 20,
      cronArchiveReceipt: { idempotencyId: "archive-alias" },
    });
  });

  it("archives a compacted generation through its immutable exact-run key", () => {
    const stableKey = "agent:main:cron:daily";
    const runSessionKey = `${stableKey}:run:session-before-compaction`;
    const entry: SessionEntry = {
      sessionId: "session-after-compaction",
      cronRunSessionKey: runSessionKey,
      updatedAt: 10,
      lifecycleRevision: "revision-1",
      sessionFile: "/tmp/session-after-compaction.jsonl",
    };
    const store: Record<string, SessionEntry> = {
      [stableKey]: entry,
      [runSessionKey]: structuredClone(entry),
    };

    const result = relocateCronSessionEntryInStore({
      store,
      stableKey,
      nowMs: 20,
      idempotencyId: "archive-compacted",
      expectedSessionId: "session-after-compaction",
      expectedLifecycleRevision: "revision-1",
    });

    expect(result.archivedKey).toBe(runSessionKey);
    expect(store[stableKey]).toBeUndefined();
    expect(store[runSessionKey]).toMatchObject({
      sessionId: "session-after-compaction",
      cronRunSessionKey: runSessionKey,
      archivedAt: 20,
      cronArchiveReceipt: {
        archivedKey: runSessionKey,
        idempotencyId: "archive-compacted",
      },
    });
    expect(store[`${stableKey}:run:session-after-compaction`]).toBeUndefined();

    expect(
      relocateCronSessionEntryInStore({
        store,
        stableKey,
        nowMs: 30,
        idempotencyId: "archive-compacted",
        expectedSessionId: "session-after-compaction",
        expectedLifecycleRevision: "revision-1",
      }),
    ).toMatchObject({ archivedKey: runSessionKey, relocated: false });
  });

  it("fails closed when the generation changes or the destination collides", () => {
    const stableKey = "agent:main:cron:daily";
    const makeStore = (): Record<string, SessionEntry> => ({
      [stableKey]: { sessionId: "session-2", updatedAt: 10 },
    });
    expect(() =>
      relocateCronSessionEntryInStore({
        store: makeStore(),
        stableKey,
        nowMs: 20,
        idempotencyId: "archive-2",
        expectedSessionId: "session-1",
      }),
    ).toThrow("changed before archive");

    const store = makeStore();
    store[`${stableKey}:run:session-2`] = { sessionId: "other", updatedAt: 10 };
    expect(() =>
      relocateCronSessionEntryInStore({
        store,
        stableKey,
        nowMs: 20,
        idempotencyId: "archive-2",
      }),
    ).toThrow("destination already exists");
  });
});
