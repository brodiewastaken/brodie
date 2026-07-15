// Whatsapp plugin module implements active listener behavior.
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveDefaultWhatsAppAccountId } from "./account-ids.js";
import { getRegisteredWhatsAppConnectionController } from "./connection-controller-registry.js";
import type { ActiveWebListener } from "./inbound/types.js";

export type { ActiveWebListener, ActiveWebSendOptions } from "./inbound/types.js";

export const DEFAULT_ACTIVE_WEB_LISTENER_WAIT_MS = 5_000;

export type ActiveWebListenerTerminalState = "stopped" | "logged-out" | "conflict";

type ActiveWebListenerPhase =
  | "ready"
  | "inactive"
  | "reconnecting"
  | ActiveWebListenerTerminalState;

type ActiveWebListenerWaiter = {
  resolve: (listener: ActiveWebListener) => void;
  reject: (error: Error) => void;
};

// Per-account listener phase entries. During socket handoff the phase masks
// the (stale) registry listener and parks outbound sends as waiters until the
// replacement listener registers or the phase turns terminal.
type ActiveWebListenerEntry = {
  listener: ActiveWebListener | null;
  phase: ActiveWebListenerPhase;
  waiters: Set<ActiveWebListenerWaiter>;
};

const activeListenerEntries = new Map<string, ActiveWebListenerEntry>();

type AccountParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
};

export function resolveWebAccountId(params: AccountParams): string {
  return (params.accountId ?? "").trim() || resolveDefaultWhatsAppAccountId(params.cfg);
}

function getAccountEntryId(accountId?: string | null): string {
  return (accountId ?? "").trim() || "default";
}

function buildNoActiveWebListenerError(accountId: string, detail?: string): Error {
  const reason = detail ? ` ${detail}` : "";
  return new Error(
    `No active WhatsApp Web listener (account: ${accountId}).${reason} Start the gateway, then link WhatsApp with: ${formatCliCommand(`openclaw channels login --channel whatsapp --account ${accountId}`)}.`,
  );
}

function getEntry(accountId?: string | null): ActiveWebListenerEntry | null {
  return activeListenerEntries.get(getAccountEntryId(accountId)) ?? null;
}

function getOrCreateEntry(accountId?: string | null): ActiveWebListenerEntry {
  const id = getAccountEntryId(accountId);
  const existing = activeListenerEntries.get(id);
  if (existing) {
    return existing;
  }
  const entry: ActiveWebListenerEntry = {
    listener: null,
    phase: "inactive",
    waiters: new Set(),
  };
  activeListenerEntries.set(id, entry);
  return entry;
}

function isMaskedByHandoff(entry: ActiveWebListenerEntry | null): boolean {
  return (
    entry?.phase === "reconnecting" ||
    entry?.phase === "logged-out" ||
    entry?.phase === "conflict" ||
    entry?.phase === "stopped"
  );
}

function lookupActiveWebListener(accountId: string): ActiveWebListener | null {
  const entry = getEntry(accountId);
  // Registry lookups prefer the connection controller's live listener; the
  // phase entry only masks it during handoff or after terminal transitions.
  if (isMaskedByHandoff(entry)) {
    return null;
  }
  return (
    getRegisteredWhatsAppConnectionController(accountId)?.getActiveListener() ??
    entry?.listener ??
    null
  );
}

function resolveWaiters(entry: ActiveWebListenerEntry, listener: ActiveWebListener): void {
  for (const waiter of entry.waiters) {
    waiter.resolve(listener);
  }
  entry.waiters.clear();
}

function rejectWaiters(entry: ActiveWebListenerEntry, accountId: string, detail?: string): void {
  const error = buildNoActiveWebListenerError(accountId, detail);
  for (const waiter of entry.waiters) {
    waiter.reject(error);
  }
  entry.waiters.clear();
}

/**
 * Acquire the account listener with a bounded wait: a send that lands
 * mid-reconnect parks until the replacement listener registers instead of
 * failing with "no active listener". Terminal phases reject immediately.
 */
export async function acquireActiveWebListener(
  params: AccountParams,
  options?: { waitMs?: number },
): Promise<{
  accountId: string;
  listener: ActiveWebListener;
}> {
  const id = resolveWebAccountId(params);
  const entry = getOrCreateEntry(id);
  const active = lookupActiveWebListener(id);
  if (active) {
    return { accountId: id, listener: active };
  }
  if (entry.phase === "logged-out") {
    throw buildNoActiveWebListenerError(id, "The linked session was logged out.");
  }
  if (entry.phase === "conflict") {
    throw buildNoActiveWebListenerError(id, "WhatsApp Web is in session conflict.");
  }
  if (entry.phase === "stopped") {
    throw buildNoActiveWebListenerError(id, "The listener is stopped.");
  }
  // Park only when recovery is plausible: mid-handoff, or a controller is
  // registered and still starting up. A CLI one-shot with no running channel
  // must fail immediately with the actionable message, not stall the wait.
  const recoveryPlausible =
    entry.phase === "reconnecting" || getRegisteredWhatsAppConnectionController(id) !== null;
  const waitMs = recoveryPlausible ? Math.max(0, options?.waitMs ?? 0) : 0;
  if (waitMs === 0) {
    throw buildNoActiveWebListenerError(id);
  }
  const timeoutError = buildNoActiveWebListenerError(
    id,
    `Timed out waiting ${waitMs}ms for the listener to reconnect.`,
  );
  let waiter: ActiveWebListenerWaiter;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<ActiveWebListener>((resolve, reject) => {
    waiter = { resolve, reject };
    entry.waiters.add(waiter);
    timeoutHandle = setTimeout(() => {
      entry.waiters.delete(waiter);
      reject(timeoutError);
    }, waitMs);
    timeoutHandle.unref?.();
  });
  try {
    const listener = await promise;
    return { accountId: id, listener };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

/**
 * Mark the account listener as mid-handoff. The expected-listener guard is
 * compare-and-swap: a slow old socket's teardown cannot mask a newer listener
 * that already took over.
 */
export function markActiveWebListenerReconnecting(
  accountId?: string | null,
  expectedListener?: ActiveWebListener | null,
): boolean {
  const id = getAccountEntryId(accountId);
  const entry = getOrCreateEntry(id);
  const current = lookupActiveWebListener(id);
  if (expectedListener && current && current !== expectedListener) {
    return false;
  }
  entry.listener = null;
  entry.phase = "reconnecting";
  return true;
}

export function markActiveWebListenerTerminal(
  accountId: string | null | undefined,
  phase: ActiveWebListenerTerminalState,
  expectedListener?: ActiveWebListener | null,
): boolean {
  const id = getAccountEntryId(accountId);
  const entry = getOrCreateEntry(id);
  const current = lookupActiveWebListener(id);
  if (expectedListener && current && current !== expectedListener) {
    return false;
  }
  entry.phase = phase;
  entry.listener = null;
  rejectWaiters(
    entry,
    id,
    phase === "logged-out"
      ? "The linked session was logged out."
      : phase === "conflict"
        ? "WhatsApp Web is in session conflict."
        : "The listener is stopped.",
  );
  return true;
}

export function setActiveWebListener(
  accountId: string | null | undefined,
  listener: ActiveWebListener | null,
): void {
  const id = getAccountEntryId(accountId);
  const entry = getOrCreateEntry(id);
  if (!listener) {
    entry.listener = null;
    if (entry.phase === "ready") {
      entry.phase = "inactive";
    }
    return;
  }
  entry.listener = listener;
  entry.phase = "ready";
  resolveWaiters(entry, listener);
}

export function getActiveWebListener(accountId?: string | null): ActiveWebListener | null {
  return lookupActiveWebListener(getAccountEntryId(accountId));
}

export function resetActiveWebListenersForTests(): void {
  for (const [accountId, entry] of activeListenerEntries) {
    rejectWaiters(entry, accountId, "The listener is stopped.");
  }
  activeListenerEntries.clear();
}
