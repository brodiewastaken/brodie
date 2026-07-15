// Whatsapp plugin module implements owner-driven trusted-group automation callbacks.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { applyModelOverrideToSessionEntry } from "openclaw/plugin-sdk/model-session-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveStorePath, updateSessionStore } from "openclaw/plugin-sdk/session-store-runtime";
import type { ResolvedWhatsAppAccount } from "../../accounts.js";
import { normalizeE164 } from "../../text-runtime.js";
import {
  resolveTrustedGroupProfile,
  type TrustedGroupProfile,
  type TrustedGroupsStore,
} from "../../trusted-groups.js";

export type ResolvedAutoGroupWhitelist = {
  ownerE164: string;
  profile: TrustedGroupProfile;
};

function normalizeComparableJid(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase().replace(/:\d+@/, "@");
}

// normalizeE164 is loose (garbage becomes "+"); owner/self trust comparisons
// need a real phone number or trust could match on empty identities.
function normalizePhoneE164(raw: string | null | undefined): string | null {
  const normalized = normalizeE164(raw ?? "");
  return /^\+\d{5,}$/.test(normalized) ? normalized : null;
}

// Trust automation runs when groupPolicy is "duo" or autoGroupWhitelist is
// enabled AND an owner is resolvable (configured ownerE164, else the first
// normalizable allowFrom entry). No owner means no automation — under duo
// that fail-closes every group (access control drops untrusted groups).
export function resolveAutoGroupWhitelist(
  cfg: OpenClawConfig,
  account: Pick<ResolvedWhatsAppAccount, "autoGroupWhitelist" | "groupPolicy" | "allowFrom">,
): ResolvedAutoGroupWhitelist | undefined {
  const auto = account.autoGroupWhitelist;
  const duoModeEnabled = account.groupPolicy === "duo";
  if (!duoModeEnabled && auto?.enabled !== true) {
    return undefined;
  }
  const ownerFromConfig = normalizePhoneE164(auto?.ownerE164);
  const ownerFromAllowlist = (account.allowFrom ?? [])
    .map((entry) => normalizePhoneE164(entry))
    .find((entry): entry is string => Boolean(entry));
  const ownerE164 = ownerFromConfig ?? ownerFromAllowlist;
  if (!ownerE164) {
    return undefined;
  }
  return {
    ownerE164,
    profile: resolveTrustedGroupProfile({
      defaultModelConfig: cfg.agents?.defaults?.model,
      profile: auto?.profile,
    }),
  };
}

export async function applyTrustedGroupSessionProfile(params: {
  cfg: OpenClawConfig;
  accountId: string;
  groupJid: string;
  profile: TrustedGroupProfile;
  transition: boolean;
}) {
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "whatsapp",
    accountId: params.accountId,
    peer: { kind: "group", id: params.groupJid },
  });
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: route.agentId,
  });
  await updateSessionStore(storePath, (store) => {
    const existing = store[route.sessionKey];
    const entry = { ...existing } as NonNullable<typeof existing>;
    let updated = false;
    // Manual session overrides always win: the pinned profile only fills
    // fields that are still unset, so a /model or thinking-level change made
    // in the group session is never clobbered by re-applied trust profiles.
    const hasManualModelOverride = Boolean(entry.modelOverride || entry.providerOverride);
    if (params.profile.provider && params.profile.model && !hasManualModelOverride) {
      const { updated: modelUpdated } = applyModelOverrideToSessionEntry({
        entry,
        selection: {
          provider: params.profile.provider,
          model: params.profile.model,
        },
        selectionSource: "auto",
      });
      if (modelUpdated) {
        updated = true;
      }
    }
    if (!entry.thinkingLevel) {
      entry.thinkingLevel = params.profile.thinkingLevel;
      updated = true;
    }
    if (!entry.groupActivation) {
      entry.groupActivation = params.profile.groupActivation;
      updated = true;
    }
    // Force the group system intro on the trust transition only; re-applied
    // profiles must not re-trigger the intro in an already-active room.
    if (params.transition && entry.groupActivationNeedsSystemIntro !== true) {
      entry.groupActivationNeedsSystemIntro = true;
      updated = true;
    }
    if (updated) {
      entry.updatedAt = Date.now();
      store[route.sessionKey] = entry;
    }
  });
}

export function groupUpdateTouchesSelf(update: {
  participantE164: string[];
  participantJids: string[];
  selfE164?: string | null;
  selfJid?: string | null;
}): boolean {
  const selfE164 = normalizePhoneE164(update.selfE164);
  const selfJid = normalizeComparableJid(update.selfJid);
  const participantHasSelfE164 =
    selfE164 != null && update.participantE164.some((entry) => normalizeE164(entry) === selfE164);
  const participantHasSelfJid =
    selfJid.length > 0 &&
    update.participantJids.some((entry) => normalizeComparableJid(entry) === selfJid);
  return participantHasSelfE164 || participantHasSelfJid;
}

// A "duo room" is a group whose participant set normalizes to exactly
// {self, owner}. STRICT phone normalization only: a loose normalize would let
// allowFrom entries like "*" resolve the owner to "+" and match garbage.
export function isWhatsAppDuoRoomParticipants(params: {
  participants: readonly string[] | undefined;
  selfE164: string | null | undefined;
  ownerE164: string;
}): boolean {
  const selfE164 = normalizePhoneE164(params.selfE164);
  const ownerE164 = normalizePhoneE164(params.ownerE164);
  if (!selfE164 || !ownerE164) {
    return false;
  }
  const participants = params.participants ?? [];
  if (participants.length === 0) {
    return false;
  }
  const normalizedParticipants = new Set(
    participants
      .map((participant) => normalizePhoneE164(participant))
      .filter((participant): participant is string => Boolean(participant)),
  );
  return (
    normalizedParticipants.size === 2 &&
    normalizedParticipants.has(selfE164) &&
    normalizedParticipants.has(ownerE164)
  );
}

export type WhatsAppGroupParticipantsTrustUpdate = {
  accountId: string;
  groupJid: string;
  action: string;
  authorJid?: string;
  authorE164?: string;
  participantJids: string[];
  participantE164: string[];
  groupSubject?: string;
  groupParticipants?: string[];
  selfJid?: string | null;
  selfE164?: string | null;
};

export type TrustedGroupCallbacks = {
  isTrustedGroup: (params: { groupJid: string }) => boolean;
  onGroupParticipantsUpdate: (update: WhatsAppGroupParticipantsTrustUpdate) => Promise<void>;
  onAutoTrustGroupCandidate: (params: {
    groupJid: string;
    senderE164?: string | null;
  }) => Promise<boolean>;
};

export function createTrustedGroupCallbacks(params: {
  cfg: OpenClawConfig;
  accountId: string;
  autoGroupWhitelist: ResolvedAutoGroupWhitelist;
  trustedGroups: TrustedGroupsStore;
  log: { info: (message: string) => void; error: (message: string) => void };
  formatError: (err: unknown) => string;
}): TrustedGroupCallbacks {
  const { cfg, accountId, autoGroupWhitelist, trustedGroups, log } = params;

  const applyProfile = async (groupJid: string, transition: boolean) => {
    if (transition || !autoGroupWhitelist.profile.setOnce) {
      await applyTrustedGroupSessionProfile({
        cfg,
        accountId,
        groupJid,
        profile: autoGroupWhitelist.profile,
        transition,
      });
    }
  };

  return {
    isTrustedGroup: ({ groupJid }) => trustedGroups.isTrusted(groupJid),
    onGroupParticipantsUpdate: async (update) => {
      try {
        const action = update.action.trim().toLowerCase();
        if (action !== "add" && action !== "remove") {
          return;
        }
        const ownerE164 = autoGroupWhitelist.ownerE164;
        const authorE164 = normalizePhoneE164(update.authorE164);
        const ownerInParticipants = update.participantE164.some(
          (entry) => normalizeE164(entry) === ownerE164,
        );
        const touchesSelf = groupUpdateTouchesSelf(update);
        const ownerRemoved = action === "remove" && ownerInParticipants;

        if (action === "add" && touchesSelf) {
          // The update author is the proof of who performed the add. Group
          // metadata is NOT consulted: the fetch commonly fails right after
          // joining (reconnect cache drops participants) and must never route
          // the owner's own add into the revoke branch.
          if (authorE164 !== null && authorE164 === ownerE164) {
            const trustedNow = await trustedGroups.add(update.groupJid);
            if (trustedNow) {
              log.info(`Trusted WhatsApp group ${update.groupJid} (owner-added).`);
            }
            await applyProfile(update.groupJid, trustedNow);
          } else if (authorE164 !== null) {
            // Deliberate: a third party re-adding the bot never inherits
            // trust, even in a room where the owner is still a member.
            const revoked = await trustedGroups.remove(update.groupJid);
            if (revoked) {
              log.info(`Revoked trusted WhatsApp group ${update.groupJid} (non-owner add).`);
            }
          }
          // Unresolvable author: no proof either way — take no action.
          return;
        }

        if (action === "remove" && (touchesSelf || ownerRemoved)) {
          const revoked = await trustedGroups.remove(update.groupJid);
          if (revoked) {
            log.info(`Revoked trusted WhatsApp group ${update.groupJid} (owner/bot removed).`);
          }
        }
      } catch (err) {
        log.error(`Failed processing group participant update: ${params.formatError(err)}`);
      }
    },
    onAutoTrustGroupCandidate: async ({ groupJid, senderE164 }) => {
      try {
        const normalizedSender = normalizePhoneE164(senderE164);
        if (normalizedSender !== autoGroupWhitelist.ownerE164) {
          return false;
        }
        // Owner-message auto-backfill: participant events only fire for
        // changes after connect; pre-existing groups would stay dark under
        // duo without this grant path.
        const trustedNow = await trustedGroups.add(groupJid);
        if (trustedNow) {
          log.info(`Trusted WhatsApp group ${groupJid} (owner-message auto-backfill).`);
        }
        await applyProfile(groupJid, trustedNow);
        return trustedNow || trustedGroups.isTrusted(groupJid);
      } catch (err) {
        log.error(`Failed processing auto-trust candidate group: ${params.formatError(err)}`);
        return false;
      }
    },
  };
}
