import { createHash } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";

type WorkspaceSetupStateDatabase = Pick<OpenClawStateKyselyDatabase, "workspace_setup_state">;

export type WorkspaceSetupStateRecord = {
  version: 1;
  bootstrapSeededAt?: string;
  setupCompletedAt?: string;
};

function workspaceKey(workspacePath: string): string {
  return createHash("sha256").update(path.resolve(workspacePath)).digest("hex");
}

function readWorkspaceSetupStateRow(db: DatabaseSync, resolvedPath: string) {
  const stateDb = getNodeSqliteKysely<WorkspaceSetupStateDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("workspace_setup_state")
      .select(["version", "bootstrap_seeded_at", "setup_completed_at", "updated_at"])
      .where("workspace_key", "=", workspaceKey(resolvedPath)),
  );
}

function recordFromWorkspaceSetupStateRow(
  row: ReturnType<typeof readWorkspaceSetupStateRow>,
): WorkspaceSetupStateRecord | null {
  if (!row) {
    return null;
  }
  return {
    version: 1,
    ...(row.bootstrap_seeded_at ? { bootstrapSeededAt: row.bootstrap_seeded_at } : {}),
    ...(row.setup_completed_at ? { setupCompletedAt: row.setup_completed_at } : {}),
  };
}

function readRecordFromDatabase(
  db: DatabaseSync,
  resolvedPath: string,
): WorkspaceSetupStateRecord | null {
  return recordFromWorkspaceSetupStateRow(readWorkspaceSetupStateRow(db, resolvedPath));
}

function laterTimestamp(left?: string, right?: string): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left >= right ? left : right;
}

export function mergeWorkspaceSetupStateRecords(
  existing: WorkspaceSetupStateRecord | null,
  incoming: WorkspaceSetupStateRecord,
): WorkspaceSetupStateRecord {
  const bootstrapSeededAt = laterTimestamp(existing?.bootstrapSeededAt, incoming.bootstrapSeededAt);
  const setupCompletedAt = laterTimestamp(existing?.setupCompletedAt, incoming.setupCompletedAt);
  return {
    version: 1,
    ...(bootstrapSeededAt ? { bootstrapSeededAt } : {}),
    ...(setupCompletedAt ? { setupCompletedAt } : {}),
  };
}

export function readWorkspaceSetupStateRecord(
  workspacePath: string,
): WorkspaceSetupStateRecord | null {
  const resolvedPath = path.resolve(workspacePath);
  return readRecordFromDatabase(openOpenClawStateDatabase().db, resolvedPath);
}

export function writeWorkspaceSetupStateRecord(
  workspacePath: string,
  state: WorkspaceSetupStateRecord,
): WorkspaceSetupStateRecord {
  const resolvedPath = path.resolve(workspacePath);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const existingRow = readWorkspaceSetupStateRow(db, resolvedPath);
    const expected = mergeWorkspaceSetupStateRecords(
      recordFromWorkspaceSetupStateRow(existingRow),
      state,
    );
    const update = {
      workspace_path: resolvedPath,
      version: Math.max(existingRow?.version ?? 0, state.version),
      bootstrap_seeded_at: expected.bootstrapSeededAt ?? null,
      setup_completed_at: expected.setupCompletedAt ?? null,
      updated_at: Math.max(existingRow?.updated_at ?? 0, Date.now()),
    };
    const stateDb = getNodeSqliteKysely<WorkspaceSetupStateDatabase>(db);
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("workspace_setup_state")
        .values({
          workspace_key: workspaceKey(resolvedPath),
          ...update,
        })
        .onConflict((conflict) => conflict.column("workspace_key").doUpdateSet(update)),
    );
    const persisted = readRecordFromDatabase(db, resolvedPath);
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify(expected)) {
      throw new Error(`Failed to verify workspace setup state for ${resolvedPath}`);
    }
    return persisted;
  });
}

export function deleteWorkspaceSetupStateRecord(workspacePath: string): void {
  const database = openOpenClawStateDatabase();
  const stateDb = getNodeSqliteKysely<WorkspaceSetupStateDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    stateDb
      .deleteFrom("workspace_setup_state")
      .where("workspace_key", "=", workspaceKey(path.resolve(workspacePath))),
  );
}
