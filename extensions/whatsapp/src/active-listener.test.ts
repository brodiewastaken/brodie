// Whatsapp tests cover active listener plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireActiveWebListener,
  getActiveWebListener,
  markActiveWebListenerReconnecting,
  markActiveWebListenerTerminal,
  resetActiveWebListenersForTests,
  resolveWebAccountId,
  setActiveWebListener,
} from "./active-listener.js";

const registryMocks = vi.hoisted(() => ({
  getRegisteredWhatsAppConnectionController: vi.fn(),
}));

vi.mock("./connection-controller-registry.js", () => ({
  getRegisteredWhatsAppConnectionController:
    registryMocks.getRegisteredWhatsAppConnectionController,
}));

const WHATSAPP_ACTIVE_LISTENER_TEST_CFG = {
  channels: { whatsapp: { accounts: { work: { enabled: true } }, defaultAccount: "work" } },
};

function makeListener() {
  return {
    sendMessage: vi.fn(async () => ({ messageId: "msg-1" })),
    sendPoll: vi.fn(async () => ({ messageId: "poll-1" })),
    sendReaction: vi.fn(async () => {}),
    sendComposingTo: vi.fn(async () => {}),
  } as unknown as import("./active-listener.js").ActiveWebListener;
}

beforeEach(() => {
  registryMocks.getRegisteredWhatsAppConnectionController.mockReset();
  registryMocks.getRegisteredWhatsAppConnectionController.mockReturnValue(null);
  resetActiveWebListenersForTests();
});

describe("active WhatsApp listener view", () => {
  it("reads controller-backed state", () => {
    const listener = makeListener();
    registryMocks.getRegisteredWhatsAppConnectionController.mockImplementation(
      (accountId: string) =>
        accountId === "work"
          ? {
              getActiveListener: () => listener,
            }
          : null,
    );

    expect(getActiveWebListener("work")).toBe(listener);
  });

  it("resolves the configured default account when accountId is omitted", () => {
    const listener = makeListener();
    registryMocks.getRegisteredWhatsAppConnectionController.mockImplementation(
      (accountId: string) =>
        accountId === "work"
          ? {
              getActiveListener: () => listener,
            }
          : null,
    );

    expect(resolveWebAccountId({ cfg: WHATSAPP_ACTIVE_LISTENER_TEST_CFG })).toBe("work");
    expect(getActiveWebListener("work")).toBe(listener);
  });

  it("returns null when the controller has no active listener for the account", () => {
    registryMocks.getRegisteredWhatsAppConnectionController.mockReturnValue(null);

    expect(getActiveWebListener("work")).toBeNull();
  });
});

describe("active WhatsApp listener phase machine", () => {
  it("clears the published listener via setActiveWebListener(null)", () => {
    const listener = makeListener();

    setActiveWebListener("work", listener);
    expect(getActiveWebListener("work")).toBe(listener);

    setActiveWebListener("work", null);
    expect(getActiveWebListener("work")).toBeNull();
  });

  it("masks the registry listener while reconnecting", () => {
    const listener = makeListener();
    registryMocks.getRegisteredWhatsAppConnectionController.mockImplementation(() => ({
      getActiveListener: () => listener,
    }));

    expect(getActiveWebListener("work")).toBe(listener);
    markActiveWebListenerReconnecting("work");
    expect(getActiveWebListener("work")).toBeNull();
  });

  it("does not let a stale listener teardown mask a newer listener", () => {
    const stale = makeListener();
    const fresh = makeListener();

    setActiveWebListener("work", stale);
    setActiveWebListener("work", fresh);

    expect(markActiveWebListenerReconnecting("work", stale)).toBe(false);
    expect(getActiveWebListener("work")).toBe(fresh);
  });

  it("resolves a waiting acquisition when the replacement listener registers", async () => {
    markActiveWebListenerReconnecting("work");
    const listener = makeListener();

    const pending = acquireActiveWebListener(
      { cfg: WHATSAPP_ACTIVE_LISTENER_TEST_CFG, accountId: "work" },
      { waitMs: 1_000 },
    );
    await Promise.resolve();
    setActiveWebListener("work", listener);

    await expect(pending).resolves.toEqual({
      accountId: "work",
      listener,
    });
  });

  it("rejects waiting acquisitions when the listener enters a terminal state", async () => {
    markActiveWebListenerReconnecting("work");
    const pending = acquireActiveWebListener(
      { cfg: WHATSAPP_ACTIVE_LISTENER_TEST_CFG, accountId: "work" },
      { waitMs: 1_000 },
    );
    await Promise.resolve();
    markActiveWebListenerTerminal("work", "conflict");

    await expect(pending).rejects.toThrow(/session conflict/i);
  });

  it("rejects immediately in a terminal phase and with waitMs 0", async () => {
    markActiveWebListenerTerminal("work", "logged-out");
    await expect(
      acquireActiveWebListener(
        { cfg: WHATSAPP_ACTIVE_LISTENER_TEST_CFG, accountId: "work" },
        { waitMs: 1_000 },
      ),
    ).rejects.toThrow(/logged out/i);

    resetActiveWebListenersForTests();
    await expect(
      acquireActiveWebListener({ cfg: WHATSAPP_ACTIVE_LISTENER_TEST_CFG, accountId: "work" }),
    ).rejects.toThrow(/No active WhatsApp Web listener/);
  });

  it("times out a bounded wait when no listener arrives", async () => {
    markActiveWebListenerReconnecting("work");
    await expect(
      acquireActiveWebListener(
        { cfg: WHATSAPP_ACTIVE_LISTENER_TEST_CFG, accountId: "work" },
        { waitMs: 10 },
      ),
    ).rejects.toThrow(/Timed out waiting 10ms/);
  });
});
