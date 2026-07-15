// Identity bootstrap hook re-injects all root workspace markdown files, in
// priority order, after stock session filters and the bootstrap snapshot cache.
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildBootstrapOrderIndex,
  compareBootstrapNamesByOrder,
  IDENTITY_BOOTSTRAP_HOOK_KEY,
  resolveIdentityBootstrapOrder,
} from "../../../agents/identity-bootstrap-order.js";
import {
  readWorkspaceFileWithGuards,
  type WorkspaceBootstrapFile,
} from "../../../agents/workspace.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { isAgentBootstrapEvent, type HookHandler } from "../../hooks.js";

const ROOT_MARKDOWN_EXTENSION = ".md";
const log = createSubsystemLogger(IDENTITY_BOOTSTRAP_HOOK_KEY);

function isRootMarkdownFileName(fileName: string): boolean {
  return (
    fileName.length > ROOT_MARKDOWN_EXTENSION.length &&
    fileName.endsWith(ROOT_MARKDOWN_EXTENSION) &&
    fileName !== "BOOTSTRAP.md" &&
    fileName !== "HEARTBEAT.md"
  );
}

function bootstrapPathKey(workspaceDir: string, filePath: string): string {
  const resolvedPath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspaceDir, filePath);
  return path.normalize(path.relative(workspaceDir, resolvedPath));
}

async function loadRootMarkdownFiles(workspaceDir: string): Promise<WorkspaceBootstrapFile[]> {
  const entries = await fs.readdir(workspaceDir, { withFileTypes: true });
  const files: WorkspaceBootstrapFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }
    if (!isRootMarkdownFileName(entry.name)) {
      continue;
    }
    const filePath = path.join(workspaceDir, entry.name);
    // Boundary-guarded, identity-cached read: symlinks escaping the workspace
    // and oversized files are skipped without aborting the other files, and
    // unchanged files reuse the workspace file cache instead of re-reading.
    const loaded = await readWorkspaceFileWithGuards({ filePath, workspaceDir });
    if (!loaded.ok) {
      log.debug("skipped root markdown bootstrap candidate", {
        path: filePath,
        reason: loaded.reason,
      });
      continue;
    }
    files.push({
      name: entry.name,
      path: filePath,
      content: loaded.content,
      missing: false,
    });
  }
  return files;
}

function mergeBootstrapFiles(params: {
  workspaceDir: string;
  currentFiles: WorkspaceBootstrapFile[];
  rootFiles: WorkspaceBootstrapFile[];
  orderIndex: Map<string, number>;
}): WorkspaceBootstrapFile[] {
  const merged = new Map<string, WorkspaceBootstrapFile>();
  // Entries without a usable path (malformed output from an earlier hook) pass
  // through untouched so sanitizeBootstrapFiles can still warn and drop them.
  const unkeyed: WorkspaceBootstrapFile[] = [];
  for (const file of params.currentFiles) {
    if (!file.path) {
      unkeyed.push(file);
      continue;
    }
    merged.set(bootstrapPathKey(params.workspaceDir, file.path), file);
  }
  // Freshly read root files overwrite cache-stale entries by path key so an
  // edit to SOUL.md is visible on the next run of a long-lived session.
  for (const file of params.rootFiles) {
    merged.set(bootstrapPathKey(params.workspaceDir, file.path), file);
  }
  const sorted = [...merged.values()].toSorted((left, right) =>
    compareBootstrapNamesByOrder(params.orderIndex, left.name, right.name),
  );
  return [...sorted, ...unkeyed];
}

const identityBootstrapHook: HookHandler = async (event) => {
  if (!isAgentBootstrapEvent(event)) {
    return;
  }

  const context = event.context;
  // Strict opt-in: resolves undefined unless the hook entry's enabled === true.
  const order = resolveIdentityBootstrapOrder(context.cfg);
  if (!order) {
    return;
  }

  try {
    const rootFiles = await loadRootMarkdownFiles(context.workspaceDir);
    if (rootFiles.length === 0) {
      return;
    }
    // Product contract (docs/internal/brodie/DECISIONS.md): every session
    // kind — subagent, cron, heartbeat — boots with the full root markdown
    // set; the merge deliberately overrides per-session allowlist filters.
    context.bootstrapFiles = mergeBootstrapFiles({
      workspaceDir: context.workspaceDir,
      currentFiles: context.bootstrapFiles,
      rootFiles,
      orderIndex: buildBootstrapOrderIndex(order),
    });
  } catch (err) {
    log.warn(`failed: ${String(err)}`);
  }
};

export default identityBootstrapHook;
