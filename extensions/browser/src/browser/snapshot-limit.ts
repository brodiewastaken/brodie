import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { getRoleSnapshotStats, type RoleRefMap } from "./pw-role-snapshot.js";

const SNAPSHOT_TRUNCATION_MARKER = "\n\n[...TRUNCATED - page too large]";

function readGeneratedRef(line: string): string | undefined {
  const body = line.trimStart();
  if (!body.startsWith("- ")) {
    return undefined;
  }
  let cursor = 2;
  while (cursor < body.length && !/\s/u.test(body[cursor] ?? "")) {
    cursor += 1;
  }
  while (body[cursor] === " ") {
    cursor += 1;
  }
  if (body[cursor] === '"') {
    cursor += 1;
    let escaped = false;
    while (cursor < body.length) {
      const char = body[cursor];
      cursor += 1;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        break;
      }
    }
    while (body[cursor] === " ") {
      cursor += 1;
    }
  }
  if (!body.startsWith("[ref=", cursor)) {
    return undefined;
  }
  const end = body.indexOf("]", cursor + 5);
  if (end < 0) {
    return undefined;
  }
  const ref = body.slice(cursor + 5, end);
  return ref && !/\s/u.test(ref) ? ref : undefined;
}

/** Bound a model-facing snapshot while keeping its refs and stats consistent with visible text. */
export function limitAiSnapshot<
  T extends {
    snapshot: string;
    refs: RoleRefMap;
    stats?: { lines: number; chars: number; refs: number; interactive: number };
    truncated?: boolean;
  },
>(snapshot: T, maxChars: number | undefined): T {
  if (!maxChars || snapshot.snapshot.length <= maxChars) {
    return snapshot;
  }
  const text = `${truncateUtf16Safe(snapshot.snapshot, maxChars)}${SNAPSHOT_TRUNCATION_MARKER}`;
  const visibleRefIds = new Set(
    text
      .split("\n")
      .map(readGeneratedRef)
      .filter((ref): ref is string => ref !== undefined),
  );
  const refs = Object.fromEntries(
    Object.entries(snapshot.refs).filter(([ref]) => visibleRefIds.has(ref)),
  );
  return {
    ...snapshot,
    snapshot: text,
    refs,
    ...(snapshot.stats ? { stats: getRoleSnapshotStats(text, refs) } : {}),
    truncated: true,
  };
}

/** Bound an ARIA snapshot to the largest prefix of complete nodes within the character budget. */
export function limitAriaSnapshot<T>(
  nodes: T[],
  maxChars: number | undefined,
): { nodes: T[]; truncated?: boolean } {
  if (!maxChars || JSON.stringify(nodes).length <= maxChars) {
    return { nodes };
  }
  let low = 0;
  let high = nodes.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (JSON.stringify(nodes.slice(0, midpoint)).length <= maxChars) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  return { nodes: nodes.slice(0, low), truncated: true };
}
