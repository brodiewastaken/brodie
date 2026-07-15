#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const JOURNAL_VERSION = 1;
const LEGACY_MARKER = ":conversation-v1:";
const REFERENCE_KEYS = new Set([
  "baseSessionKey",
  "childSessionKey",
  "controllerSessionKey",
  "ownerSessionKey",
  "parentSessionKey",
  "requesterSessionKey",
  "routeKey",
  "sessionKey",
  "session_key",
  "spawnedBy",
  "targetSessionKey",
  "usageFamilyKey",
]);

const EXACT_COLUMNS = {
  acp_replay_events: ["session_key"],
  acp_replay_sessions: ["session_key"],
  acp_sessions: ["session_key"],
  audit_events: ["session_key"],
  command_log_entries: ["session_key"],
  commitments: ["session_key"],
  conversation_scheduler_events: ["session_key"],
  cron_jobs: ["session_key", "session_target", "owner_session_key"],
  cron_run_logs: ["session_key"],
  current_conversation_bindings: ["target_session_key"],
  delivery_queue_entries: ["session_key", "target"],
  gateway_restart_sentinel: ["session_key"],
  managed_outgoing_image_records: ["session_key"],
  sandbox_registry_entries: ["session_key"],
  subagent_runs: [
    "child_session_key",
    "controller_session_key",
    "requester_session_key",
    "requester_display_key",
  ],
  task_runs: ["requester_session_key", "owner_key", "child_session_key"],
  tui_last_sessions: ["session_key"],
  voicewake_routing_config: ["default_target_session_key"],
  voicewake_routing_routes: ["target_session_key"],
};

const JSON_COLUMNS = {
  command_log_entries: ["entry_json"],
  commitments: ["record_json"],
  conversation_scheduler_events: ["route_json", "payload_json", "failure_json"],
  cron_jobs: ["job_json", "state_json", "payload_external_content_source_json"],
  cron_run_logs: ["entry_json"],
  current_conversation_bindings: ["metadata_json", "record_json"],
  delivery_queue_entries: ["entry_json"],
  flow_runs: ["requester_origin_json", "state_json", "wait_json"],
  gateway_restart_sentinel: ["continuation_json", "stats_json", "payload_json"],
  managed_outgoing_image_records: ["record_json"],
  sandbox_registry_entries: ["entry_json"],
  subagent_runs: ["requester_origin_json", "outcome_json", "payload_json"],
  task_delivery_state: ["requester_origin_json"],
};

function encodeSegment(value) {
  return [...Buffer.from(value, "utf8")]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return /^[A-Za-z0-9._~!$&'()*+,;=@-]$/u.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

function decodeLegacyLane(lane) {
  const bytes = Buffer.from(lane, "utf8");
  const values = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    if (bytes[cursor] === 45) {
      values.push(undefined);
      cursor += 1;
    } else {
      const lengthStart = cursor;
      while (cursor < bytes.length && bytes[cursor] >= 48 && bytes[cursor] <= 57) {
        cursor += 1;
      }
      if (cursor === lengthStart || bytes[cursor] !== 58) {
        return null;
      }
      const byteLength = Number(bytes.subarray(lengthStart, cursor).toString("ascii"));
      cursor += 1;
      const end = cursor + byteLength;
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || end > bytes.length) {
        return null;
      }
      values.push(bytes.subarray(cursor, end).toString("utf8"));
      cursor = end;
    }
    if (cursor === bytes.length) {
      break;
    }
    if (bytes[cursor] !== 124) {
      return null;
    }
    cursor += 1;
  }
  return values;
}

export function readableKeyFromLegacy(key) {
  const markerIndex = key.indexOf(LEGACY_MARKER);
  if (!key.startsWith("agent:") || markerIndex <= "agent:".length) {
    return null;
  }
  const agentId = key.slice("agent:".length, markerIndex);
  const values = decodeLegacyLane(key.slice(markerIndex + LEGACY_MARKER.length));
  if (!agentId || values?.length !== 5) {
    return null;
  }
  const [channel, accountId, kind, conversationId, threadId] = values;
  if (
    !channel ||
    !accountId ||
    !conversationId ||
    (kind !== "direct" && kind !== "group" && kind !== "channel")
  ) {
    return null;
  }
  return `agent:${[agentId, "conversation", channel, accountId, kind, conversationId]
    .map(encodeSegment)
    .join(":")}${threadId ? `:thread:${encodeSegment(threadId)}` : ""}`;
}

function parseJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.brodie-readable-${process.pid}.tmp`;
  const mode = fs.statSync(file).mode;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temporary, file);
}

function rewriteReferences(value, keyMap, parentKey) {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const rewritten = rewriteReferences(entry, keyMap, parentKey);
      changed ||= rewritten.changed;
      return rewritten.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (!value || typeof value !== "object") {
    const replacement =
      typeof value === "string" && parentKey && REFERENCE_KEYS.has(parentKey)
        ? keyMap.get(value)
        : undefined;
    return replacement ? { value: replacement, changed: true } : { value, changed: false };
  }
  let changed = false;
  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    const rewritten = rewriteReferences(entry, keyMap, key);
    changed ||= rewritten.changed;
    next[key] = rewritten.value;
  }
  return { value: changed ? next : value, changed };
}

function loadOrBuildMap({ journalPath, stores }) {
  if (fs.existsSync(journalPath)) {
    const journal = parseJsonFile(journalPath);
    if (
      journal.version !== JOURNAL_VERSION ||
      !journal.keyMap ||
      typeof journal.keyMap !== "object"
    ) {
      throw new Error("readable session-key migration journal is malformed or unsupported");
    }
    return new Map(Object.entries(journal.keyMap));
  }
  const keyMap = new Map();
  const occupied = new Set(stores.flatMap(({ data }) => Object.keys(data)));
  for (const { data } of stores) {
    for (const [key, entry] of Object.entries(data)) {
      if (!key.includes(LEGACY_MARKER) || entry?.archivedAt != null) {
        continue;
      }
      const readable = readableKeyFromLegacy(key);
      if (!readable) {
        throw new Error("active conversation-v1 key is malformed");
      }
      const prior = [...keyMap.values()].includes(readable);
      if (prior || (occupied.has(readable) && readable !== key)) {
        throw new Error("readable session-key migration collision");
      }
      keyMap.set(key, readable);
    }
  }
  return keyMap;
}

function tableColumns(db, table) {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) {
    return new Set();
  }
  return new Set(
    db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((row) => row.name),
  );
}

function rewriteDatabase(db, keyMap) {
  let exactUpdates = 0;
  let jsonUpdates = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [table, requestedColumns] of Object.entries(EXACT_COLUMNS)) {
      const columns = tableColumns(db, table);
      for (const column of requestedColumns) {
        if (!columns.has(column)) {
          continue;
        }
        const statement = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`);
        for (const [oldKey, newKey] of keyMap) {
          exactUpdates += Number(statement.run(newKey, oldKey).changes);
        }
      }
    }
    for (const [table, requestedColumns] of Object.entries(JSON_COLUMNS)) {
      const columns = tableColumns(db, table);
      for (const column of requestedColumns) {
        if (!columns.has(column)) {
          continue;
        }
        const rows = db
          .prepare(
            `SELECT rowid AS rowid, "${column}" AS value FROM "${table}" WHERE "${column}" LIKE '%:conversation-v1:%'`,
          )
          .all();
        const update = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`);
        for (const row of rows) {
          if (typeof row.value !== "string") {
            continue;
          }
          let parsed;
          try {
            parsed = JSON.parse(row.value);
          } catch {
            continue;
          }
          const rewritten = rewriteReferences(parsed, keyMap);
          if (rewritten.changed) {
            update.run(JSON.stringify(rewritten.value), row.rowid);
            jsonUpdates += 1;
          }
        }
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { exactUpdates, jsonUpdates };
}

function rewriteTranscript(file, keyMap) {
  const source = fs.readFileSync(file, "utf8");
  let changes = 0;
  const rewritten = source
    .split("\n")
    .map((line) => {
      if (!line.includes(LEGACY_MARKER)) {
        return line;
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return line;
      }
      const result = rewriteReferences(parsed, keyMap);
      if (!result.changed) {
        return line;
      }
      changes += 1;
      return JSON.stringify(result.value);
    })
    .join("\n");
  if (changes > 0) {
    const temporary = `${file}.brodie-readable-${process.pid}.tmp`;
    const mode = fs.statSync(file).mode;
    fs.writeFileSync(temporary, rewritten, { mode });
    fs.renameSync(temporary, file);
  }
  return changes;
}

function rewriteStore(data, keyMap) {
  let changes = 0;
  const next = {};
  const transcripts = new Set();
  for (const [key, entry] of Object.entries(data)) {
    const newKey = keyMap.get(key) ?? key;
    const rewritten =
      entry?.archivedAt == null
        ? rewriteReferences(entry, keyMap)
        : { value: entry, changed: false };
    if (newKey !== key || rewritten.changed) {
      changes += 1;
    }
    next[newKey] = rewritten.value;
    if (keyMap.has(key) && typeof entry?.sessionFile === "string") {
      transcripts.add(entry.sessionFile);
    }
  }
  return { data: next, changes, transcripts };
}

function countRemainingDatabaseReferences(db, keyMap) {
  let remaining = 0;
  for (const [table, requestedColumns] of Object.entries(EXACT_COLUMNS)) {
    const columns = tableColumns(db, table);
    for (const column of requestedColumns) {
      if (!columns.has(column)) {
        continue;
      }
      const statement = db.prepare(
        `SELECT count(*) AS count FROM "${table}" WHERE "${column}" = ?`,
      );
      for (const oldKey of keyMap.keys()) {
        remaining += Number(statement.get(oldKey).count);
      }
    }
  }
  for (const [table, requestedColumns] of Object.entries(JSON_COLUMNS)) {
    const columns = tableColumns(db, table);
    for (const column of requestedColumns) {
      if (!columns.has(column)) {
        continue;
      }
      const rows = db
        .prepare(
          `SELECT "${column}" AS value FROM "${table}" WHERE "${column}" LIKE '%:conversation-v1:%'`,
        )
        .all();
      for (const row of rows) {
        if (typeof row.value !== "string") {
          continue;
        }
        try {
          if (rewriteReferences(JSON.parse(row.value), keyMap).changed) {
            remaining += 1;
          }
        } catch {
          continue;
        }
      }
    }
  }
  return remaining;
}

function transcriptHasRemainingReferences(file, keyMap) {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .some((line) => {
      if (!line.includes(LEGACY_MARKER)) {
        return false;
      }
      try {
        return rewriteReferences(JSON.parse(line), keyMap).changed;
      } catch {
        return false;
      }
    });
}

export function migrateReadableConversationSessionKeys({
  databasePath,
  dryRun = false,
  journalPath,
  storePaths,
  transcriptRoot,
}) {
  const stores = storePaths.map((file) => ({ file, data: parseJsonFile(file) }));
  const keyMap = loadOrBuildMap({ journalPath, stores });
  const storePlans = stores.map(({ file, data }) => ({ file, ...rewriteStore(data, keyMap) }));
  const transcriptPaths = new Set(
    storePlans.flatMap((plan) =>
      [...plan.transcripts].map((file) =>
        transcriptRoot ? path.join(transcriptRoot, path.basename(file)) : file,
      ),
    ),
  );
  const summary = {
    activeKeys: keyMap.size,
    archivedKeys: stores.reduce(
      (count, { data }) =>
        count +
        Object.entries(data).filter(
          ([key, entry]) => key.includes(LEGACY_MARKER) && entry?.archivedAt != null,
        ).length,
      0,
    ),
    stores: storePlans.length,
    transcripts: transcriptPaths.size,
  };
  if (dryRun || keyMap.size === 0) {
    return { ...summary, exactUpdates: 0, jsonUpdates: 0, transcriptRows: 0 };
  }

  const journal = {
    version: JOURNAL_VERSION,
    status: "prepared",
    keyMap: Object.fromEntries(keyMap),
    storePaths,
    databasePath,
  };
  if (fs.existsSync(journalPath)) {
    const existing = parseJsonFile(journalPath);
    if (JSON.stringify(existing.keyMap) !== JSON.stringify(journal.keyMap)) {
      throw new Error("readable session-key migration journal map changed");
    }
  } else {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  }

  const db = new DatabaseSync(databasePath);
  let databaseChanges;
  try {
    databaseChanges = rewriteDatabase(db, keyMap);
  } finally {
    db.close();
  }
  for (const plan of storePlans) {
    if (plan.changes > 0) {
      writeJsonAtomic(plan.file, plan.data);
    }
  }
  let transcriptRows = 0;
  for (const transcriptPath of transcriptPaths) {
    transcriptRows += rewriteTranscript(transcriptPath, keyMap);
  }

  const verifyDb = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const remaining = countRemainingDatabaseReferences(verifyDb, keyMap);
    if (remaining !== 0) {
      throw new Error(`readable session-key migration left ${remaining} database reference(s)`);
    }
  } finally {
    verifyDb.close();
  }
  for (const storePath of storePaths) {
    const store = parseJsonFile(storePath);
    for (const [oldKey, newKey] of keyMap) {
      if (store[oldKey]?.archivedAt == null && store[oldKey] !== undefined) {
        throw new Error("readable session-key migration left an active legacy store key");
      }
      if (!store[newKey]) {
        throw new Error("readable session-key migration lost a target store key");
      }
    }
    for (const entry of Object.values(store)) {
      if (entry?.archivedAt == null && rewriteReferences(entry, keyMap).changed) {
        throw new Error("readable session-key migration left an active store reference");
      }
    }
  }
  for (const transcriptPath of transcriptPaths) {
    if (transcriptHasRemainingReferences(transcriptPath, keyMap)) {
      throw new Error("readable session-key migration left a transcript ownership reference");
    }
  }
  writeJsonAtomic(journalPath, { ...journal, status: "complete" });
  return { ...summary, ...databaseChanges, transcriptRows };
}

function parseArgs(argv) {
  const result = { storePaths: [], dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--store") {
      result.storePaths.push(path.resolve(argv[++index]));
    } else if (arg === "--database") {
      result.databasePath = path.resolve(argv[++index]);
    } else if (arg === "--journal") {
      result.journalPath = path.resolve(argv[++index]);
    } else if (arg === "--transcript-root") {
      result.transcriptRoot = path.resolve(argv[++index]);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!result.databasePath || !result.journalPath || result.storePaths.length === 0) {
    throw new Error(
      "usage: migrate-readable-conversation-session-keys --database <path> --store <path> [--store <path>] --journal <path> [--transcript-root <path>] [--dry-run]",
    );
  }
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = migrateReadableConversationSessionKeys(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
