// Reuses manifest metadata within an active plugin snapshot lifecycle.
import os from "node:os";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import { getCurrentPluginMetadataSnapshotState } from "./current-plugin-metadata-state.js";
import {
  resolveOpenClawPluginManifestMetadataSnapshot,
  type PluginManifestMetadataSnapshot,
} from "./manifest-metadata-scan.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";

const MAX_SCOPE_MEMOS = 8;
const scopeMemos = new Map<string, PluginManifestMetadataSnapshot>();
const SCOPE_ENV_KEYS = [
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_HOME",
  "HOME",
  "USERPROFILE",
  "PREFIX",
  "ANDROID_DATA",
  "OPENCLAW_TEST_FAST",
  "VITEST",
  "NODE_ENV",
  "VITEST_WORKER_ID",
  "VITEST_POOL_ID",
] as const;

registerPluginMetadataProcessMemoLifecycleClear(() => scopeMemos.clear());

/** Keeps standalone discovery fresh and active gateway lookups free of repeated disk scans. */
export function getPluginManifestMetadataSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): PluginManifestMetadataSnapshot {
  if (!getCurrentPluginMetadataSnapshotState().snapshot) {
    return resolveOpenClawPluginManifestMetadataSnapshot(env);
  }

  // Directory resolution is already process-cached, including test overrides. The
  // remaining scope inputs select the state index and relative/source roots without I/O.
  const scopeKey = JSON.stringify([
    resolveBundledPluginsDir(env),
    process.argv[1],
    process.cwd(),
    os.homedir(),
    os.tmpdir(),
    ...SCOPE_ENV_KEYS.map((key) => env[key]),
  ]);
  let snapshot = scopeMemos.get(scopeKey);
  if (snapshot) {
    scopeMemos.delete(scopeKey);
  } else {
    snapshot = resolveOpenClawPluginManifestMetadataSnapshot(env);
    if (scopeMemos.size >= MAX_SCOPE_MEMOS) {
      const oldestKey = scopeMemos.keys().next().value;
      if (oldestKey !== undefined) {
        scopeMemos.delete(oldestKey);
      }
    }
  }
  scopeMemos.set(scopeKey, snapshot);
  return { key: snapshot.key, records: snapshot.records.slice() };
}
