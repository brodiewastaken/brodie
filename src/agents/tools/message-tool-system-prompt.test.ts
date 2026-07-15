import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildMessageToolSystemPrompt } from "./message-tool-system-prompt.js";

function promptHash(actions?: readonly ("reply" | "send" | "react" | "silence")[]): string {
  return createHash("sha256")
    .update(buildMessageToolSystemPrompt({ allowedConversationalActions: actions }))
    .digest("hex");
}

describe("buildMessageToolSystemPrompt", () => {
  it("makes cross-route Slack handoffs and silence fields explicit", () => {
    const prompt = buildMessageToolSystemPrompt({});

    expect(prompt).toContain("one visibleMessages item");
    expect(prompt).toContain("separate message tool calls");
    expect(prompt).toContain("silence always ends the turn, so omit endTurn");
  });

  it.each([
    ["all actions", undefined, "a26efb42a06161b135579e1ef4276a776481ccf68340ba2c1cf014c9a3145122"],
    [
      "reply only",
      ["reply"] as const,
      "f99bbf8d5583086ab88a64bbed4aefb8066fbc76b0afaea3e141d4f7fd9de3e2",
    ],
    [
      "reply, react, and silence",
      ["reply", "react", "silence"] as const,
      "a3017f53d60c6a0e7c29066e9d339a6ec4123760b5a49bb98a99f2907955d2d2",
    ],
  ])("keeps the locked %s prompt copy byte-exact", (_name, actions, expected) => {
    expect(promptHash(actions)).toBe(expected);
  });
});
