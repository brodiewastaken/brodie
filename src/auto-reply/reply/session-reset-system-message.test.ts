import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildSessionResetSystemMessage } from "./session-reset-system-message.js";

const roots: string[] = [];
const cfg = {
  agents: {
    defaults: { userTimezone: "Asia/Tokyo" },
    list: [{ id: "main", identity: { name: "brodie" } }],
  },
} as OpenClawConfig;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reset-message-"));
  roots.push(root);
  return root;
}

describe("buildSessionResetSystemMessage", () => {
  it("renders the approved DM copy, full trigger tail, and canonical paths", async () => {
    const root = await workspace();
    const prompt = await buildSessionResetSystemMessage({
      cfg,
      agentId: "main",
      sessionCtx: {
        SenderName: "Abhay",
        Surface: "WhatsApp",
        ConversationLabel: "direct chat",
      },
      workspaceDir: root,
      isGroupChat: false,
      triggerCommand: "brodie /new keep the model",
      journalMode: "paths",
      nowMs: Date.parse("2026-07-15T03:00:00+09:00"),
    });
    expect(prompt).toContain("Abhay just sent `brodie /new keep the model`");
    expect(prompt).toContain("today: memory/journal/2026-07/2026-07-15.md");
    expect(prompt).toContain("yesterday: memory/journal/2026-07/2026-07-14.md");
    expect(prompt).not.toContain("[missing]");
  });

  it("includes complete canonical journals inline and marks missing files", async () => {
    const root = await workspace();
    const month = path.join(root, "memory", "journal", "2026-07");
    await fs.mkdir(month, { recursive: true });
    await fs.writeFile(path.join(month, "2026-07-15.md"), "complete today\n");
    const prompt = await buildSessionResetSystemMessage({
      cfg,
      agentId: "main",
      sessionCtx: {},
      workspaceDir: root,
      isGroupChat: false,
      triggerCommand: "/new",
      journalMode: "inline",
      nowMs: Date.parse("2026-07-15T03:00:00+09:00"),
    });
    expect(prompt).toContain("mode: inline");
    expect(prompt).toContain("complete today\n");
    expect(prompt).toContain("path: memory/journal/2026-07/2026-07-14.md\n[missing]");
  });

  it("switches the whole journal block to paths mode instead of truncating", async () => {
    const root = await workspace();
    let reason = "";
    const prompt = await buildSessionResetSystemMessage({
      cfg,
      agentId: "main",
      sessionCtx: {},
      workspaceDir: root,
      isGroupChat: false,
      triggerCommand: "/new",
      journalMode: "inline",
      maxInlineJournalChars: 1,
      onInlineOverflow: (value) => {
        reason = value;
      },
      nowMs: Date.parse("2026-07-15T03:00:00+09:00"),
    });
    expect(prompt).toContain("mode: paths");
    expect(prompt).not.toContain("[missing]");
    expect(reason).toContain("complete inline journal block");
  });

  it("renders the full group roster without a cap", async () => {
    const root = await workspace();
    const members = Array.from({ length: 40 }, (_, index) => `member-${index + 1}`);
    const prompt = await buildSessionResetSystemMessage({
      cfg,
      agentId: "main",
      sessionCtx: { GroupMembers: members.join(",") },
      workspaceDir: root,
      isGroupChat: true,
      triggerCommand: "brodie /reset",
      journalMode: "paths",
    });
    expect(prompt).toContain("- member-1");
    expect(prompt).toContain("- member-40");
  });
});
