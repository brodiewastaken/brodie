// Whatsapp tests cover trusted-group automation callbacks.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openTrustedGroupsStore, type TrustedGroupsBackingStore } from "../../trusted-groups.js";
import {
  createTrustedGroupCallbacks,
  groupUpdateTouchesSelf,
  resolveAutoGroupWhitelist,
} from "./group-trust.js";

type SessionStore = Record<string, Record<string, unknown>>;

const sessionStores = new Map<string, SessionStore>();

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  resolveStorePath: (_store: unknown, params: { agentId: string }) => `store:${params.agentId}`,
  updateSessionStore: async (
    storePath: string,
    update: (store: SessionStore) => void,
  ): Promise<void> => {
    const store = sessionStores.get(storePath) ?? {};
    update(store);
    sessionStores.set(storePath, store);
  },
}));

vi.mock("openclaw/plugin-sdk/routing", () => ({
  resolveAgentRoute: (params: { peer?: { id?: string } }) => ({
    agentId: "main",
    sessionKey: `whatsapp:group:${params.peer?.id ?? "unknown"}`,
  }),
}));

const GROUP_JID = "120363401234567890@g.us";
const OWNER = "+15550001111";
const SELF_JID = "15550009999:12@s.whatsapp.net";
const SELF_E164 = "+15550009999";

function createBackingStore(): TrustedGroupsBackingStore {
  const entries = new Map<string, { version?: unknown; groups?: unknown }>();
  return {
    lookup: async (key) => entries.get(key),
    register: async (key, value) => {
      entries.set(key, value);
    },
  };
}

async function createCallbacks(params?: { setOnce?: boolean; cfg?: OpenClawConfig }) {
  const trustedGroups = await openTrustedGroupsStore({
    accountId: "default",
    backingStore: createBackingStore(),
  });
  const cfg =
    params?.cfg ??
    ({ agents: { defaults: { model: "anthropic/claude-fable-5" } } } as OpenClawConfig);
  const autoGroupWhitelist = resolveAutoGroupWhitelist(cfg, {
    groupPolicy: "duo",
    allowFrom: [OWNER],
    autoGroupWhitelist: { profile: { setOnce: params?.setOnce ?? true } },
  });
  if (!autoGroupWhitelist) {
    throw new Error("expected auto group whitelist to resolve");
  }
  const callbacks = createTrustedGroupCallbacks({
    cfg,
    accountId: "default",
    autoGroupWhitelist,
    trustedGroups,
    log: { info: vi.fn(), error: vi.fn() },
    formatError: String,
  });
  return { callbacks, trustedGroups };
}

function ownerAddsBotUpdate(
  overrides?: Partial<
    Parameters<ReturnType<typeof createTrustedGroupCallbacks>["onGroupParticipantsUpdate"]>[0]
  >,
) {
  return {
    accountId: "default",
    groupJid: GROUP_JID,
    action: "add",
    authorE164: OWNER,
    participantJids: [SELF_JID],
    participantE164: [SELF_E164],
    groupParticipants: [OWNER, SELF_E164],
    selfJid: SELF_JID,
    selfE164: SELF_E164,
    ...overrides,
  };
}

beforeEach(() => {
  sessionStores.clear();
});

describe("resolveAutoGroupWhitelist", () => {
  it("resolves the owner from allowFrom when ownerE164 is unset", async () => {
    const resolved = resolveAutoGroupWhitelist({} as OpenClawConfig, {
      groupPolicy: "duo",
      allowFrom: ["not-a-number", OWNER],
      autoGroupWhitelist: undefined,
    });
    expect(resolved?.ownerE164).toBe(OWNER);
  });

  it("disables trust automation when no owner is resolvable", () => {
    const resolved = resolveAutoGroupWhitelist({} as OpenClawConfig, {
      groupPolicy: "duo",
      allowFrom: [],
      autoGroupWhitelist: undefined,
    });
    expect(resolved).toBeUndefined();
  });

  it("stays disabled without duo policy or explicit enablement", () => {
    const resolved = resolveAutoGroupWhitelist({} as OpenClawConfig, {
      groupPolicy: "allowlist",
      allowFrom: [OWNER],
      autoGroupWhitelist: { enabled: false },
    });
    expect(resolved).toBeUndefined();
  });
});

describe("groupUpdateTouchesSelf", () => {
  it("matches self by device-suffixed JID", () => {
    expect(
      groupUpdateTouchesSelf({
        participantE164: [],
        participantJids: ["15550009999:3@s.whatsapp.net"],
        selfJid: SELF_JID,
        selfE164: null,
      }),
    ).toBe(true);
  });

  it("does not match unrelated participants", () => {
    expect(
      groupUpdateTouchesSelf({
        participantE164: ["+15550002222"],
        participantJids: ["15550002222@s.whatsapp.net"],
        selfJid: SELF_JID,
        selfE164: SELF_E164,
      }),
    ).toBe(false);
  });
});

describe("createTrustedGroupCallbacks", () => {
  it("trusts a group when the owner adds the bot and pins the session profile", async () => {
    const { callbacks, trustedGroups } = await createCallbacks();

    await callbacks.onGroupParticipantsUpdate(ownerAddsBotUpdate());

    expect(trustedGroups.isTrusted(GROUP_JID)).toBe(true);
    const entry = sessionStores.get("store:main")?.[`whatsapp:group:${GROUP_JID}`];
    expect(entry).toMatchObject({
      providerOverride: "anthropic",
      modelOverride: "claude-fable-5",
      thinkingLevel: "high",
      groupActivation: "always",
      groupActivationNeedsSystemIntro: true,
    });
  });

  it("revokes trust when a non-owner adds the bot", async () => {
    const { callbacks, trustedGroups } = await createCallbacks();
    await callbacks.onGroupParticipantsUpdate(ownerAddsBotUpdate());
    expect(trustedGroups.isTrusted(GROUP_JID)).toBe(true);

    await callbacks.onGroupParticipantsUpdate(ownerAddsBotUpdate({ authorE164: "+15550003333" }));

    expect(trustedGroups.isTrusted(GROUP_JID)).toBe(false);
  });

  it("revokes trust when the bot or the owner is removed", async () => {
    const { callbacks, trustedGroups } = await createCallbacks();
    await callbacks.onGroupParticipantsUpdate(ownerAddsBotUpdate());

    await callbacks.onGroupParticipantsUpdate(
      ownerAddsBotUpdate({
        action: "remove",
        authorE164: "+15550003333",
        participantJids: ["15550001111@s.whatsapp.net"],
        participantE164: [OWNER],
      }),
    );

    expect(trustedGroups.isTrusted(GROUP_JID)).toBe(false);
  });

  it("ignores promote/demote actions", async () => {
    const { callbacks, trustedGroups } = await createCallbacks();
    await callbacks.onGroupParticipantsUpdate(ownerAddsBotUpdate());

    await callbacks.onGroupParticipantsUpdate(ownerAddsBotUpdate({ action: "promote" }));

    expect(trustedGroups.isTrusted(GROUP_JID)).toBe(true);
  });

  it("auto-backfills trust from an owner message and admits it", async () => {
    const { callbacks, trustedGroups } = await createCallbacks();

    expect(
      await callbacks.onAutoTrustGroupCandidate({ groupJid: GROUP_JID, senderE164: OWNER }),
    ).toBe(true);
    expect(trustedGroups.isTrusted(GROUP_JID)).toBe(true);

    expect(
      await callbacks.onAutoTrustGroupCandidate({
        groupJid: "120363409999999999@g.us",
        senderE164: "+15550003333",
      }),
    ).toBe(false);
    expect(trustedGroups.isTrusted("120363409999999999@g.us")).toBe(false);
  });

  it("never clobbers an existing manual session override, even with setOnce false", async () => {
    const { callbacks } = await createCallbacks({ setOnce: false });
    const sessionKey = `whatsapp:group:${GROUP_JID}`;
    sessionStores.set("store:main", {
      [sessionKey]: {
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        thinkingLevel: "low",
      },
    });

    await callbacks.onGroupParticipantsUpdate(ownerAddsBotUpdate());
    // setOnce: false re-applies on the next owner event too.
    await callbacks.onGroupParticipantsUpdate(ownerAddsBotUpdate());

    const entry = sessionStores.get("store:main")?.[sessionKey];
    expect(entry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      thinkingLevel: "low",
      groupActivation: "always",
    });
  });

  it("pins no model when agents.defaults.model is absent", async () => {
    const { callbacks } = await createCallbacks({ cfg: {} as OpenClawConfig });

    await callbacks.onGroupParticipantsUpdate(ownerAddsBotUpdate());

    const entry = sessionStores.get("store:main")?.[`whatsapp:group:${GROUP_JID}`];
    expect(entry?.providerOverride).toBeUndefined();
    expect(entry?.modelOverride).toBeUndefined();
    expect(entry).toMatchObject({ thinkingLevel: "high", groupActivation: "always" });
  });
});
