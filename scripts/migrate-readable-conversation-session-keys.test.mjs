import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  migrateReadableConversationSessionKeys,
  readableKeyFromLegacy,
} from "./migrate-readable-conversation-session-keys.mjs";

const oldKey = "agent:main:conversation-v1:8:whatsapp|6:brodie|5:group|8:room/one|-";
const newKey = "agent:main:conversation:whatsapp:brodie:group:room%2Fone";

void test("converts the private legacy encoding to the readable contract", () => {
  assert.equal(readableKeyFromLegacy(oldKey), newKey);
});

void test("migrates active references, preserves archived keys, and converges", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brodie-readable-session-"));
  const storePath = path.join(root, "sessions.json");
  const transcriptPath = path.join(root, "session.jsonl");
  const databasePath = path.join(root, "state.sqlite");
  const journalPath = path.join(root, "migration.json");
  fs.writeFileSync(
    storePath,
    `${JSON.stringify(
      {
        [oldKey]: {
          sessionId: "active",
          sessionFile: transcriptPath,
          systemPromptReport: { sessionKey: oldKey },
        },
        "agent:main:subagent:child": {
          sessionId: "child",
          spawnedBy: oldKey,
        },
        [`${oldKey}:archived`]: { sessionId: "archived", archivedAt: 1 },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "message",
      message: {
        content: [{ type: "text", text: oldKey }],
        details: { sessionKey: oldKey },
        __openclaw: { queueBatchIdentity: { routeKey: oldKey } },
      },
    })}\n`,
  );
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE conversation_scheduler_events (
      session_key TEXT NOT NULL,
      route_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      failure_json TEXT
    );
  `);
  db.prepare(
    "INSERT INTO conversation_scheduler_events(session_key, route_json, payload_json, failure_json) VALUES (?, ?, ?, ?)",
  ).run(
    oldKey,
    JSON.stringify({ sessionKey: oldKey, transcriptOwner: { sessionKey: oldKey } }),
    JSON.stringify({ conversation: { sessionKey: oldKey }, body: oldKey }),
    null,
  );
  db.close();

  const first = migrateReadableConversationSessionKeys({
    databasePath,
    journalPath,
    storePaths: [storePath],
  });
  assert.equal(first.activeKeys, 1);
  assert.equal(first.archivedKeys, 1);
  const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(store[oldKey], undefined);
  assert.equal(store[newKey].systemPromptReport.sessionKey, newKey);
  assert.equal(store["agent:main:subagent:child"].spawnedBy, newKey);
  assert.ok(store[`${oldKey}:archived`]);
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf8").trim());
  assert.equal(transcript.message.details.sessionKey, newKey);
  assert.equal(transcript.message["__openclaw"].queueBatchIdentity.routeKey, newKey);
  assert.equal(transcript.message.content[0].text, oldKey);
  const migratedDb = new DatabaseSync(databasePath);
  const row = migratedDb.prepare("SELECT * FROM conversation_scheduler_events").get();
  migratedDb.close();
  assert.equal(row.session_key, newKey);
  assert.equal(JSON.parse(row.route_json).sessionKey, newKey);
  assert.equal(JSON.parse(row.payload_json).conversation.sessionKey, newKey);
  assert.equal(JSON.parse(row.payload_json).body, oldKey);

  const second = migrateReadableConversationSessionKeys({
    databasePath,
    journalPath,
    storePaths: [storePath],
  });
  assert.equal(second.exactUpdates, 0);
  assert.equal(second.jsonUpdates, 0);
  assert.equal(second.transcriptRows, 0);
});
