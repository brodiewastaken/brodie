// Whatsapp tests cover runtime group policy behavior.
import { describe, expect, it } from "vitest";
import {
  resolveWhatsAppRuntimeGroupPolicy,
  toOpenWhatsAppGroupPolicy,
} from "./runtime-group-policy.js";

describe("resolveWhatsAppRuntimeGroupPolicy", () => {
  it("keeps configured duo as the runtime policy", () => {
    expect(
      resolveWhatsAppRuntimeGroupPolicy({
        providerConfigPresent: true,
        groupPolicy: "duo",
      }),
    ).toEqual({
      groupPolicy: "duo",
      providerMissingFallbackApplied: false,
    });
  });

  it("does not default configured providers to duo", () => {
    expect(
      resolveWhatsAppRuntimeGroupPolicy({
        providerConfigPresent: true,
        defaultGroupPolicy: "allowlist",
      }),
    ).toEqual({
      groupPolicy: "allowlist",
      providerMissingFallbackApplied: false,
    });
  });

  it("falls back closed when the provider config is missing", () => {
    expect(
      resolveWhatsAppRuntimeGroupPolicy({
        providerConfigPresent: false,
      }),
    ).toEqual({
      groupPolicy: "allowlist",
      providerMissingFallbackApplied: true,
    });
  });

  it("downcasts duo only at stock-facing seams", () => {
    expect(toOpenWhatsAppGroupPolicy("duo")).toBe("allowlist");
    expect(toOpenWhatsAppGroupPolicy("open")).toBe("open");
    expect(toOpenWhatsAppGroupPolicy("disabled")).toBe("disabled");
    expect(toOpenWhatsAppGroupPolicy(undefined)).toBeUndefined();
  });
});
