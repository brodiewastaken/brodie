// Whatsapp plugin module implements the trusted-groups store and profile resolution.
import { getOptionalWhatsAppRuntime } from "./runtime.js";

// Version 2 matches the final shipped fork semantics. A mismatched record is
// wiped, not migrated: trust must be re-earned after a policy-semantics change.
export const TRUSTED_GROUP_POLICY_VERSION = 2;
const TRUSTED_GROUPS_NAMESPACE = "trusted-groups";
const TRUSTED_GROUPS_MAX_ACCOUNTS = 128;

type TrustedGroupsRecord = {
  version?: unknown;
  groups?: unknown;
};

/** Narrow persistence seam over the SQLite-backed plugin state store. */
export type TrustedGroupsBackingStore = {
  lookup: (key: string) => Promise<TrustedGroupsRecord | undefined>;
  register: (key: string, value: TrustedGroupsRecord) => Promise<void>;
};

export type TrustedGroupProfile = {
  provider?: string;
  model?: string;
  thinkingLevel: string;
  groupActivation: "mention" | "always";
  setOnce: boolean;
};

type TrustedGroupProfileInput = {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  groupActivation?: "mention" | "always";
  setOnce?: boolean;
};

function normalizeGroupJid(raw: string | null | undefined): string | null {
  const normalized = raw?.trim().toLowerCase() ?? "";
  if (!normalized || !normalized.endsWith("@g.us")) {
    return null;
  }
  return normalized;
}

function normalizeGroupList(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) {
    return new Set<string>();
  }
  const normalized = raw
    .map((entry) => (typeof entry === "string" ? normalizeGroupJid(entry) : null))
    .filter((entry): entry is string => entry !== null);
  return new Set(normalized);
}

function resolvePrimaryModelRef(modelConfig: unknown): string | null {
  if (typeof modelConfig === "string") {
    return modelConfig.trim() || null;
  }
  if (!modelConfig || typeof modelConfig !== "object") {
    return null;
  }
  const primary = (modelConfig as { primary?: unknown }).primary;
  return typeof primary === "string" && primary.trim().length > 0 ? primary.trim() : null;
}

function splitProviderModelRef(modelRef: string): { provider: string; model: string } | undefined {
  const slashIndex = modelRef.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= modelRef.length - 1) {
    return undefined;
  }
  const provider = modelRef.slice(0, slashIndex).trim();
  const model = modelRef.slice(slashIndex + 1).trim();
  return provider && model ? { provider, model } : undefined;
}

/**
 * Resolve the pinned session profile applied when a group becomes trusted.
 * Model/provider come from the configured profile, else derive from
 * `agents.defaults.model`; with neither, no model is pinned (no hardcoded
 * model fallback in product code).
 */
export function resolveTrustedGroupProfile(params: {
  defaultModelConfig?: unknown;
  profile?: TrustedGroupProfileInput;
}): TrustedGroupProfile {
  const configuredModelRef = resolvePrimaryModelRef(params.defaultModelConfig);
  const derived = configuredModelRef ? splitProviderModelRef(configuredModelRef) : undefined;
  const provider = params.profile?.provider?.trim() || derived?.provider;
  const model = params.profile?.model?.trim() || derived?.model;
  return {
    // A model pin needs both halves; a lone provider/model would produce a
    // malformed session override.
    ...(provider && model ? { provider, model } : {}),
    thinkingLevel: params.profile?.thinkingLevel?.trim() || "high",
    groupActivation: params.profile?.groupActivation ?? "always",
    setOnce: params.profile?.setOnce ?? true,
  };
}

export type TrustedGroupsStore = {
  policyReset: boolean;
  isTrusted: (groupJid: string) => boolean;
  listTrustedGroups: () => string[];
  add: (groupJid: string) => Promise<boolean>;
  remove: (groupJid: string) => Promise<boolean>;
};

// No in-memory fallback: silently volatile trust state in the fail-closed
// privacy flagship would drop every grant on restart with zero diagnostics.
function requireDefaultBackingStore(): TrustedGroupsBackingStore {
  const store = getOptionalWhatsAppRuntime()?.state.openKeyedStore<TrustedGroupsRecord>({
    namespace: TRUSTED_GROUPS_NAMESPACE,
    maxEntries: TRUSTED_GROUPS_MAX_ACCOUNTS,
  });
  if (!store) {
    throw new Error(
      "WhatsApp trusted-groups store requires the plugin runtime (persistent SQLite state). " +
        "Start the gateway so the WhatsApp plugin runtime is initialized; trust state must never be held in memory only.",
    );
  }
  return store;
}

/**
 * Open the per-account trusted-groups store. State persists in the shared
 * plugin-state SQLite store; a version mismatch resets trust (persisted).
 */
export async function openTrustedGroupsStore(params: {
  accountId: string;
  backingStore?: TrustedGroupsBackingStore;
}): Promise<TrustedGroupsStore> {
  const backingStore = params.backingStore ?? requireDefaultBackingStore();
  const key = `account:${params.accountId}`;
  const record = await backingStore.lookup(key);
  const version =
    typeof record?.version === "number" && Number.isFinite(record.version) ? record.version : 0;
  const policyReset = record !== undefined && version !== TRUSTED_GROUP_POLICY_VERSION;
  const trustedGroups =
    record === undefined || policyReset ? new Set<string>() : normalizeGroupList(record.groups);
  const persist = async () => {
    await backingStore.register(key, {
      version: TRUSTED_GROUP_POLICY_VERSION,
      groups: Array.from(trustedGroups).toSorted((a, b) => a.localeCompare(b)),
    });
  };
  if (policyReset) {
    await persist();
  }
  return {
    policyReset,
    isTrusted: (groupJid) => {
      const normalized = normalizeGroupJid(groupJid);
      return normalized !== null && trustedGroups.has(normalized);
    },
    listTrustedGroups: () => Array.from(trustedGroups).toSorted((a, b) => a.localeCompare(b)),
    add: async (groupJid) => {
      const normalized = normalizeGroupJid(groupJid);
      if (!normalized || trustedGroups.has(normalized)) {
        return false;
      }
      trustedGroups.add(normalized);
      await persist();
      return true;
    },
    remove: async (groupJid) => {
      const normalized = normalizeGroupJid(groupJid);
      if (!normalized || !trustedGroups.has(normalized)) {
        return false;
      }
      trustedGroups.delete(normalized);
      await persist();
      return true;
    },
  };
}
