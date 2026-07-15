import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildMessageToolSystemPrompt } from "./message-tool-system-prompt.js";

function promptHash(actions?: readonly ("reply" | "send" | "react" | "silence")[]): string {
  return createHash("sha256")
    .update(buildMessageToolSystemPrompt({ allowedConversationalActions: actions }))
    .digest("hex");
}

describe("buildMessageToolSystemPrompt", () => {
  it.each([
    ["all actions", undefined, "3768b76784cfdf8d03644f99b048d65cbb1214d3f22e7ac2373e24250a52b3c2"],
    [
      "reply only",
      ["reply"] as const,
      "f99bbf8d5583086ab88a64bbed4aefb8066fbc76b0afaea3e141d4f7fd9de3e2",
    ],
    [
      "reply, react, and silence",
      ["reply", "react", "silence"] as const,
      "ca954a98aa9b0c97a4ae6b7eb13b5be774c7c0605b43ab257eff86a9b7b061ff",
    ],
  ])("keeps the locked %s prompt copy byte-exact", (_name, actions, expected) => {
    expect(promptHash(actions)).toBe(expected);
  });
});
