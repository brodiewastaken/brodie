// Whatsapp tests cover trusted-groups store and profile behavior.
import { describe, expect, it } from "vitest";
import {
  TRUSTED_GROUP_POLICY_VERSION,
  openTrustedGroupsStore,
  resolveTrustedGroupProfile,
  type TrustedGroupsBackingStore,
} from "./trusted-groups.js";

function createBackingStore(seed?: Record<string, unknown>) {
  const entries = new Map<string, { version?: unknown; groups?: unknown }>(
    Object.entries(seed ?? {}) as Array<[string, { version?: unknown; groups?: unknown }]>,
  );
  const backingStore: TrustedGroupsBackingStore = {
    lookup: async (key) => entries.get(key),
    register: async (key, value) => {
      entries.set(key, value);
    },
  };
  return { backingStore, entries };
}

describe("trusted WhatsApp group profiles", () => {
  it("defaults trusted-group profiles to the configured primary model", () => {
    const profile = resolveTrustedGroupProfile({
      defaultModelConfig: { primary: "anthropic/claude-fable-5" },
      profile: {},
    });

    expect(profile).toEqual({
      provider: "anthropic",
      model: "claude-fable-5",
      thinkingLevel: "high",
      groupActivation: "always",
      setOnce: true,
    });
  });

  it("lets explicit trusted-group profile fields override the configured primary model", () => {
    const profile = resolveTrustedGroupProfile({
      defaultModelConfig: "anthropic/claude-fable-5",
      profile: {
        provider: "openai",
        model: "gpt-5.5",
        thinkingLevel: "xhigh",
        groupActivation: "mention",
        setOnce: false,
      },
    });

    expect(profile).toEqual({
      provider: "openai",
      model: "gpt-5.5",
      thinkingLevel: "xhigh",
      groupActivation: "mention",
      setOnce: false,
    });
  });

  it("pins no model when neither profile nor agents.defaults.model provide one", () => {
    const profile = resolveTrustedGroupProfile({});

    expect(profile.provider).toBeUndefined();
    expect(profile.model).toBeUndefined();
    expect(profile).toMatchObject({
      thinkingLevel: "high",
      groupActivation: "always",
      setOnce: true,
    });
  });

  it("pins no model on a malformed default model ref", () => {
    const profile = resolveTrustedGroupProfile({ defaultModelConfig: "not-a-provider-ref" });

    expect(profile.provider).toBeUndefined();
    expect(profile.model).toBeUndefined();
  });
});

describe("trusted WhatsApp groups store", () => {
  it("resets trusted groups when the store policy version changes", async () => {
    const { backingStore, entries } = createBackingStore({
      "account:default": {
        version: TRUSTED_GROUP_POLICY_VERSION - 1,
        groups: ["123@g.us"],
      },
    });

    const store = await openTrustedGroupsStore({ accountId: "default", backingStore });

    expect(store.policyReset).toBe(true);
    expect(store.isTrusted("123@g.us")).toBe(false);
    expect(entries.get("account:default")).toEqual({
      version: TRUSTED_GROUP_POLICY_VERSION,
      groups: [],
    });
  });

  it("adds, checks, and removes trusted groups with persisted state", async () => {
    const { backingStore, entries } = createBackingStore();
    const store = await openTrustedGroupsStore({ accountId: "default", backingStore });
    expect(store.policyReset).toBe(false);

    expect(await store.add("123@G.US")).toBe(true);
    expect(store.isTrusted("123@g.us")).toBe(true);
    expect(await store.add("123@g.us")).toBe(false);
    expect(entries.get("account:default")).toEqual({
      version: TRUSTED_GROUP_POLICY_VERSION,
      groups: ["123@g.us"],
    });

    expect(await store.remove("123@g.us")).toBe(true);
    expect(store.isTrusted("123@g.us")).toBe(false);
    expect(entries.get("account:default")).toEqual({
      version: TRUSTED_GROUP_POLICY_VERSION,
      groups: [],
    });
  });

  it("rejects non-group JIDs and keeps stored groups normalized and sorted", async () => {
    const { backingStore, entries } = createBackingStore();
    const store = await openTrustedGroupsStore({ accountId: "work", backingStore });

    expect(await store.add("+15551234567")).toBe(false);
    expect(await store.add("")).toBe(false);
    expect(await store.add("zzz@g.us")).toBe(true);
    expect(await store.add("AAA@G.US")).toBe(true);
    expect(store.listTrustedGroups()).toEqual(["aaa@g.us", "zzz@g.us"]);
    expect(entries.get("account:work")).toEqual({
      version: TRUSTED_GROUP_POLICY_VERSION,
      groups: ["aaa@g.us", "zzz@g.us"],
    });
  });

  it("reloads persisted trust for the same account", async () => {
    const { backingStore } = createBackingStore();
    const first = await openTrustedGroupsStore({ accountId: "default", backingStore });
    await first.add("123@g.us");

    const second = await openTrustedGroupsStore({ accountId: "default", backingStore });
    expect(second.policyReset).toBe(false);
    expect(second.isTrusted("123@g.us")).toBe(true);
  });
});
