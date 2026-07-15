import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveConversationRoute } from "openclaw/plugin-sdk/routing";
import { saveSessionStore, type SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGroupActivationFor } from "./group-activation.js";

const conversationId = "123@g.us";
const accountId = "work";
const canonicalSessionKey = resolveConversationRoute({
  cfg: {},
  channel: "whatsapp",
  accountId,
  peer: { kind: "group", id: conversationId },
}).sessionKey;

async function makeSessionStore(entries: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-"));
  const storePath = path.join(dir, "sessions.json");
  await saveSessionStore(storePath, entries as Record<string, SessionEntry>, {
    skipMaintenance: true,
  });
  return { storePath, cleanup: async () => await fs.rm(dir, { recursive: true, force: true }) };
}

describe("resolveGroupActivationFor", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("reads activation from the canonical account-aware session", async () => {
    const { storePath, cleanup } = await makeSessionStore({
      [canonicalSessionKey]: { groupActivation: "always", sessionId: "canonical-session" },
    });
    cleanups.push(cleanup);

    await expect(
      resolveGroupActivationFor({
        cfg: { session: { store: storePath } },
        accountId,
        agentId: "main",
        sessionKey: canonicalSessionKey,
        conversationId,
      }),
    ).resolves.toBe("always");
  });

  it("never falls back to an account-less sibling key", async () => {
    const { storePath, cleanup } = await makeSessionStore({
      "agent:main:whatsapp:group:123@g.us": { groupActivation: "always" },
    });
    cleanups.push(cleanup);

    await expect(
      resolveGroupActivationFor({
        cfg: {
          channels: { whatsapp: { groups: { "*": { requireMention: true } } } },
          session: { store: storePath },
        },
        accountId,
        agentId: "main",
        sessionKey: canonicalSessionKey,
        conversationId,
      }),
    ).resolves.toBe("mention");
  });
});
