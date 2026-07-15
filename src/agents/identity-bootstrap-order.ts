/**
 * Shared bootstrap-file ordering for the identity-bootstrap bundled hook and
 * the system prompt's Project Context sort. Both surfaces must consume one
 * ordering: if they diverge, files re-sort differently at prompt render than
 * at bootstrap and priority files land out of order.
 */
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export const IDENTITY_BOOTSTRAP_HOOK_KEY = "identity-bootstrap";

/** Soul-first default order; unmapped root markdown sorts after, alphabetically. */
export const DEFAULT_IDENTITY_BOOTSTRAP_ORDER: readonly string[] = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "MEMORY.md",
  "AGENTS.md",
  "TOOLS.md",
  "STYLE.md",
  "PRIVACY.md",
];

/** Builds a rank map (lowercased filename → sort rank) from an ordered filename list. */
export function buildBootstrapOrderIndex(order: readonly string[]): Map<string, number> {
  return new Map(order.map((name, index) => [name.toLowerCase(), (index + 1) * 10]));
}

/**
 * Compares two bootstrap filenames by rank, then case-insensitive alphabetical,
 * then case-sensitive as the final tiebreak. Shared by the hook's file sort and
 * the system prompt's context sort so the two cannot drift.
 */
export function compareBootstrapNamesByOrder(
  orderIndex: ReadonlyMap<string, number>,
  leftName: string,
  rightName: string,
): number {
  const leftFolded = leftName.toLowerCase();
  const rightFolded = rightName.toLowerCase();
  const leftRank = orderIndex.get(leftFolded) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = orderIndex.get(rightFolded) ?? Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  const folded = leftFolded.localeCompare(rightFolded);
  if (folded !== 0) {
    return folded;
  }
  return leftName.localeCompare(rightName);
}

/**
 * Resolves the bootstrap file order injected by the identity-bootstrap hook.
 * Returns undefined while the hook cannot run — the hooks master switch is off
 * (`hooks.internal.enabled === false` blocks all internal hook loading, see
 * src/hooks/configured.ts) or the entry is not explicitly enabled — so
 * upstream's default Project Context order keeps applying.
 */
export function resolveIdentityBootstrapOrder(config?: OpenClawConfig): string[] | undefined {
  const internal = config?.hooks?.internal;
  if (internal?.enabled === false) {
    return undefined;
  }
  const entry = internal?.entries?.[IDENTITY_BOOTSTRAP_HOOK_KEY];
  if (entry?.enabled !== true) {
    return undefined;
  }
  const configured = normalizeTrimmedStringList(entry.order);
  return configured.length > 0 ? configured : [...DEFAULT_IDENTITY_BOOTSTRAP_ORDER];
}
