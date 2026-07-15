// Continuation policy persistence tests exercise the public isolated cron path
// against a real private session store and auth-profile writer.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import { saveAuthProfileStore } from "../../agents/auth-profiles/store.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  loadSessionStore,
  applySessionEntryLifecycleMutation,
} from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { applySessionsPatchToStore } from "../../gateway/sessions-patch.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import {
  applySessionEntryLifecycleMutationMock,
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  resolveAgentDirMock,
  resolveAllowedModelRefMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resolveSessionAuthProfileOverrideMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("isolated cron continuation policy persistence", () => {
  let previousFastTestEnv: string | undefined;
  let previousStateDir: string | undefined;
  let tempRoot: string;

  beforeEach(async () => {
    previousFastTestEnv = clearFastTestEnv();
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    resetRunCronIsolatedAgentTurnHarness();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-policy-"));
    process.env.OPENCLAW_STATE_DIR = tempRoot;
  });

  afterEach(async () => {
    restoreFastTestEnv(previousFastTestEnv);
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("persists policy at row birth before auth rotation and keeps later model resets authoritative", async () => {
    const jobId = "cron-policy-auth";
    const stableKey = `agent:default:cron:${jobId}`;
    const sessionId = "cron-policy-session";
    const runKey = `${stableKey}:run:${sessionId}`;
    const agentDir = path.join(tempRoot, "agents", "default", "agent");
    const storePath = path.join(tempRoot, "agents", "default", "sessions", "sessions.json");
    const profileId = "openai:test@example.invalid";
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [profileId]: { type: "api_key", provider: "openai", key: "sk-test-only" },
        },
        order: { openai: [profileId] },
      },
      agentDir,
    );

    const cronSession = makeCronSession({
      storePath,
      store: {},
      sessionEntry: makeCronSessionEntry({
        sessionId,
        lifecycleRevision: "test-lifecycle-revision",
      }),
      isNewSession: true,
    });
    resolveCronSessionMock.mockReturnValue(cronSession);
    resolveAgentDirMock.mockReturnValue(agentDir);
    resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-5.4" });
    resolveAllowedModelRefMock.mockReturnValue({ ref: { provider: "openai", model: "gpt-5.4" } });
    let firstRowsObserved = false;
    applySessionEntryLifecycleMutationMock.mockImplementation(async (mutation) => {
      await applySessionEntryLifecycleMutation(mutation);
      if (!firstRowsObserved) {
        const firstStoredRows = loadSessionStore(storePath);
        expect(firstStoredRows[stableKey]?.cronRunContinuationPolicy).toMatchObject({
          provider: "openai",
          model: "gpt-5.4",
          thinking: "high",
          fastMode: false,
          fallbacks: [],
        });
        expect(firstStoredRows[runKey]?.cronRunContinuationPolicy).toEqual(
          firstStoredRows[stableKey]?.cronRunContinuationPolicy,
        );
        expect(firstStoredRows[stableKey]?.authProfileOverride).toBeUndefined();
        expect(firstStoredRows[runKey]?.authProfileOverride).toBeUndefined();
        firstRowsObserved = true;
      }
    });
    resolveSessionAuthProfileOverrideMock.mockImplementation(async (params) => {
      expect(firstRowsObserved).toBe(true);
      return await resolveSessionAuthProfileOverride(params);
    });
    runWithModelFallbackMock.mockImplementation(async ({ provider, model, run }) => ({
      result: await run(provider, model),
      provider,
      model,
      attempts: [],
    }));
    runEmbeddedAgentMock.mockImplementationOnce(async () => {
      const storedBeforeInference = loadSessionStore(storePath);
      expect(storedBeforeInference[stableKey]?.cronRunContinuationPolicy).toMatchObject({
        provider: "openai",
        model: "gpt-5.4",
        thinking: "high",
        fastMode: false,
        fallbacks: [],
      });
      expect(storedBeforeInference[runKey]?.cronRunContinuationPolicy).toEqual(
        storedBeforeInference[stableKey]?.cronRunContinuationPolicy,
      );
      expect(storedBeforeInference[stableKey]?.authProfileOverride).toBe(profileId);
      return {
        payloads: [{ text: "done" }],
        meta: {
          agentMeta: {
            provider: "openai",
            model: "gpt-5.4",
            usage: { input: 1, output: 1 },
          },
        },
      };
    });

    const cfg = {
      auth: {
        profiles: {
          [profileId]: { provider: "openai", mode: "api_key" },
        },
        order: { openai: [profileId] },
      },
    };
    const result = await runCronIsolatedAgentTurn({
      cfg,
      deps: {} as never,
      job: {
        id: jobId,
        name: "Continuation Policy Auth",
        enabled: false,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        delivery: { mode: "none" },
        payload: {
          kind: "agentTurn",
          message: "run task",
          model: "openai/gpt-5.4",
          thinking: "high",
          fastMode: false,
          fallbacks: [],
        },
        state: {},
      },
      message: "run task",
      sessionKey: `cron:${jobId}`,
    });

    if (result.status !== "ok") {
      throw new Error(String(result.error));
    }
    expect(result).toMatchObject({ status: "ok" });
    expect(firstRowsObserved).toBe(true);
    const storedAfterRun = loadSessionStore(storePath);
    const originalRunEntry = structuredClone(storedAfterRun[runKey]);
    expect(storedAfterRun[stableKey]?.cronRunContinuationPolicy).toBeDefined();
    expect(originalRunEntry?.cronRunContinuationPolicy).toBeDefined();

    const switched = await replaceSessionEntry(
      { storePath, sessionKey: runKey },
      (() => {
        const entry = structuredClone(originalRunEntry) as SessionEntry;
        applyModelOverrideToSessionEntry({
          entry,
          selection: { provider: "anthropic", model: "claude-sonnet-4-6" },
          markLiveSwitchPending: true,
        });
        return entry;
      })(),
    );
    expect(switched?.cronRunContinuationPolicy).toBeUndefined();
    expect(loadSessionStore(storePath)[stableKey]?.cronRunContinuationPolicy).toBeDefined();

    await replaceSessionEntry({ storePath, sessionKey: runKey }, originalRunEntry as SessionEntry);
    const resetStore = loadSessionStore(storePath);
    const reset = await applySessionsPatchToStore({
      cfg,
      store: resetStore,
      storeKey: runKey,
      patch: { key: runKey, model: null },
    });
    expect(reset.ok).toBe(true);
    if (!reset.ok) {
      throw new Error(reset.error.message);
    }
    await replaceSessionEntry({ storePath, sessionKey: runKey }, reset.entry);
    expect(loadSessionStore(storePath)[runKey]?.cronRunContinuationPolicy).toBeUndefined();
    expect(loadSessionStore(storePath)[stableKey]?.cronRunContinuationPolicy).toBeDefined();
  });
});
