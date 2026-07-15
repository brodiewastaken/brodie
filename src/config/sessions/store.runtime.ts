// Runtime facade for session store mutation helpers.
export {
  applySessionEntryLifecycleMutation,
  deleteSessionEntryLifecycle,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
export {
  applySessionStoreEntryPatch,
  cleanupSessionLifecycleArtifacts,
  updateSessionStore,
  updateSessionStoreEntry,
} from "./store.js";
export type {
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
} from "./store.js";
export type {
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleResult,
  SessionLifecycleArchivedTranscript,
  SessionLifecycleStoreTarget,
} from "./session-accessor.js";
