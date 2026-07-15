// Whatsapp plugin module implements group activation behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveWhatsAppInboundPolicy } from "../../inbound-policy.js";
import { normalizeGroupActivation } from "./group-activation.runtime.js";

/** Resolves group activation from the one canonical account-aware session. */
export async function resolveGroupActivationFor(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  agentId: string;
  sessionKey: string;
  conversationId: string;
}) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const sessionScope = { storePath, agentId: params.agentId };
  const scopedEntry = getSessionEntry({ ...sessionScope, sessionKey: params.sessionKey });
  const activation = scopedEntry?.groupActivation;
  const requireMention = resolveWhatsAppInboundPolicy({
    cfg: params.cfg,
    accountId: params.accountId,
  }).resolveConversationRequireMention(params.conversationId);
  const defaultActivation = !requireMention ? "always" : "mention";
  return normalizeGroupActivation(activation) ?? defaultActivation;
}
