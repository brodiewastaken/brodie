// Subagent registry SQLite store tests cover whole-snapshot persistence and
// one-time import from the legacy JSON registry file.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function createRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-one",
    ownerAgentId: "main",
    childSessionKey: "agent:main:subagent:one",
    controllerSessionKey: "agent:main:main",
    controllerRoute: {
      channel: "internal",
      accountId: "main",
      conversationKind: "direct",
      conversationId: "agent:main:main",
      sessionKey: "agent:main:main",
      queueLaneKey: "internal:main:direct:agent:main:main",
      transcriptOwner: { agentId: "main", sessionKey: "agent:main:main" },
    },
    rootSourceRoute: {
      channel: "discord",
      accountId: "default",
      conversationKind: "channel",
      conversationId: "channel-one",
      sessionKey: "agent:main:discord:channel:channel-one",
      queueLaneKey: "discord:default:channel:channel-one",
      transcriptOwner: {
        agentId: "main",
        sessionKey: "agent:main:discord:channel:channel-one",
      },
    },
    descendantTaskRunIds: ["run-child"],
    completionEventId: "subagent:run-one:completion",
    schedulerReceiptId: "receipt-one",
    completionAdmittedAt: 265,
    controllerTranscriptEvidence: "direct:266",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "check sqlite persistence",
    cleanup: "keep",
    createdAt: 100,
    startedAt: 110,
    endedAt: 250,
    outcome: { status: "ok", startedAt: 110, endedAt: 250, elapsedMs: 140 },
    expectsCompletionMessage: true,
    completion: {
      required: true,
      resultText: "done",
      capturedAt: 260,
    },
    delivery: {
      status: "pending",
      createdAt: 270,
      lastAttemptAt: 280,
      attemptCount: 2,
      lastError: "retry later",
      payload: {
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        childSessionKey: "agent:main:subagent:one",
        childRunId: "run-one",
        task: "check sqlite persistence",
        startedAt: 110,
        endedAt: 250,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
      },
    },
    ...overrides,
  };
}

describe("subagent registry sqlite store", () => {
  let tempStateDir: string | null = null;

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-subagent-sqlite-"));
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      tempStateDir = null;
    }
  });

  async function withTempStateEnv<T>(fn: () => Promise<T>): Promise<T> {
    if (!tempStateDir) {
      throw new Error("expected temp state dir");
    }
    return await withEnvAsync({ OPENCLAW_STATE_DIR: tempStateDir }, fn);
  }

  it("persists subagent runs in the controller agent database", async () => {
    await withTempStateEnv(async () => {
      const run = createRun();

      saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));

      const restored = loadSubagentRegistryFromSqlite();
      expect(restored.get(run.runId)).toMatchObject({
        runId: run.runId,
        ownerAgentId: "main",
        childSessionKey: run.childSessionKey,
        requesterSessionKey: run.requesterSessionKey,
        task: run.task,
        endedAt: run.endedAt,
        outcome: run.outcome,
        completion: run.completion,
        delivery: run.delivery,
        controllerRoute: run.controllerRoute,
        rootSourceRoute: run.rootSourceRoute,
        descendantTaskRunIds: run.descendantTaskRunIds,
        completionEventId: run.completionEventId,
        schedulerReceiptId: run.schedulerReceiptId,
        controllerTranscriptEvidence: run.controllerTranscriptEvidence,
      });
      expect(await fs.stat(resolveOpenClawAgentSqlitePath({ agentId: "main" }))).toBeTruthy();
      await expect(fs.stat(path.join(tempStateDir!, "subagents", "runs.json"))).rejects.toThrow();
    });
  });

  it("uses save calls as whole-registry snapshots", async () => {
    await withTempStateEnv(async () => {
      const first = createRun({ runId: "run-one", childSessionKey: "agent:main:subagent:one" });
      const second = createRun({ runId: "run-two", childSessionKey: "agent:main:subagent:two" });

      saveSubagentRegistryToSqlite(
        new Map([
          [first.runId, first],
          [second.runId, second],
        ]),
      );
      saveSubagentRegistryToSqlite(new Map([[second.runId, second]]));

      expect([...loadSubagentRegistryFromSqlite().keys()]).toEqual(["run-two"]);
    });
  });

  it("imports the legacy json registry when sqlite has no runs", async () => {
    await withTempStateEnv(async () => {
      // Import deletes the JSON source after the first successful migration so
      // later loads treat SQLite as canonical state.
      const legacyRun = createRun({
        runId: "legacy-run",
        childSessionKey: "agent:main:subagent:legacy",
        task: "import legacy registry",
      });
      const registryPath = path.join(tempStateDir!, "subagents", "runs.json");
      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.writeFile(
        registryPath,
        `${JSON.stringify({ version: 2, runs: { [legacyRun.runId]: legacyRun } })}\n`,
        "utf8",
      );

      const imported = loadSubagentRegistryFromSqlite();

      expect(imported.get(legacyRun.runId)?.task).toBe("import legacy registry");
      await expect(fs.stat(registryPath)).rejects.toThrow();
      expect(loadSubagentRegistryFromSqlite().get(legacyRun.runId)?.task).toBe(
        "import legacy registry",
      );
      expect(
        openOpenClawAgentDatabase({ agentId: "main" })
          .db.prepare("SELECT COUNT(*) AS count FROM subagent_runs")
          .get(),
      ).toEqual({ count: 1 });
    });
  });

  it("imports shared sqlite rows into the controller agent database once", async () => {
    await withTempStateEnv(async () => {
      const legacyRun = createRun({
        runId: "shared-legacy-run",
        childSessionKey: "agent:main:subagent:shared-legacy",
      });
      openOpenClawStateDatabase()
        .db.prepare(
          `INSERT INTO subagent_runs (
             run_id, child_session_key, controller_session_key, requester_session_key,
             requester_display_key, task, cleanup, created_at, payload_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          legacyRun.runId,
          legacyRun.childSessionKey,
          legacyRun.controllerSessionKey ?? null,
          legacyRun.requesterSessionKey,
          legacyRun.requesterDisplayKey,
          legacyRun.task,
          legacyRun.cleanup,
          legacyRun.createdAt,
          JSON.stringify(legacyRun),
        );

      expect(loadSubagentRegistryFromSqlite().get(legacyRun.runId)).toMatchObject({
        runId: legacyRun.runId,
        ownerAgentId: "main",
      });
      expect(
        openOpenClawStateDatabase().db.prepare("SELECT COUNT(*) AS count FROM subagent_runs").get(),
      ).toEqual({ count: 0 });
      expect(
        openOpenClawAgentDatabase({ agentId: "main" })
          .db.prepare("SELECT COUNT(*) AS count FROM subagent_runs")
          .get(),
      ).toEqual({ count: 1 });
    });
  });
});
