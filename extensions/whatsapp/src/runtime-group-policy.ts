// Whatsapp plugin module implements runtime group policy behavior.
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import type { WhatsAppAccountConfig } from "./account-types.js";

export type WhatsAppRuntimeGroupPolicy = NonNullable<WhatsAppAccountConfig["groupPolicy"]>;
export type OpenWhatsAppGroupPolicy = Exclude<WhatsAppRuntimeGroupPolicy, "duo">;

// "duo" is a WhatsApp-only policy value; core/open-provider consumers see it
// as "allowlist" (fail-closed on empty allowlists). Duo semantics live in the
// plugin's trusted-group enforcement.
export function toOpenWhatsAppGroupPolicy(policy: undefined): undefined;
export function toOpenWhatsAppGroupPolicy(
  policy: WhatsAppRuntimeGroupPolicy,
): OpenWhatsAppGroupPolicy;
export function toOpenWhatsAppGroupPolicy(
  policy: WhatsAppRuntimeGroupPolicy | undefined,
): OpenWhatsAppGroupPolicy | undefined;
export function toOpenWhatsAppGroupPolicy(
  policy: WhatsAppRuntimeGroupPolicy | undefined,
): OpenWhatsAppGroupPolicy | undefined {
  return policy === "duo" ? "allowlist" : policy;
}

export function resolveWhatsAppRuntimeGroupPolicy(params: {
  providerConfigPresent: boolean;
  groupPolicy?: WhatsAppRuntimeGroupPolicy;
  defaultGroupPolicy?: OpenWhatsAppGroupPolicy;
}): {
  groupPolicy: WhatsAppRuntimeGroupPolicy;
  providerMissingFallbackApplied: boolean;
} {
  // Duo is an explicit config value, never an implicit default.
  if (params.groupPolicy === "duo") {
    return {
      groupPolicy: "duo",
      providerMissingFallbackApplied: false,
    };
  }
  return resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.groupPolicy,
    defaultGroupPolicy: params.defaultGroupPolicy,
  });
}
