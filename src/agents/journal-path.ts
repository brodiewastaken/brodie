/**
 * Canonical daily-journal layout: memory/journal/<YYYY-MM>/<YYYY-MM-DD[-slug]>.md.
 * Single owner of the layout so the session-memory writer and the
 * startup-context reader cannot silently drift apart.
 */
import path from "node:path";

/** Workspace-relative journal path (forward slashes) for a YYYY-MM-DD-prefixed filename. */
export function journalRelativePath(fileName: string): string {
  return `memory/journal/${fileName.slice(0, 7)}/${fileName}`;
}

/** Absolute journal month directory for a YYYY-MM-DD date stamp (or YYYY-MM month). */
export function journalMonthDir(workspaceDir: string, dateStamp: string): string {
  return path.join(workspaceDir, "memory", "journal", dateStamp.slice(0, 7));
}
