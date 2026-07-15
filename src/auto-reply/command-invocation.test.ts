import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_UNAUTHORIZED_COMMAND_ENVELOPE,
  resolvePrefixedCommandCandidate,
  resolveTextCommandInvocation,
} from "./command-invocation.js";

const cfg = {
  commands: { invocation: { name: "brodie", stopPhrases: ["hold up"] } },
} as OpenClawConfig;

function invoke(
  text: string,
  overrides: Partial<Parameters<typeof resolveTextCommandInvocation>[0]> = {},
) {
  return resolveTextCommandInvocation({
    cfg,
    text,
    authorized: true,
    conversationKind: "direct",
    ...overrides,
  });
}

describe("resolveTextCommandInvocation", () => {
  it("allows authorized bare commands only in direct and proven two-member conversations", () => {
    expect(invoke("/status")).toMatchObject({ kind: "command", body: "/status" });
    expect(invoke("/status", { conversationKind: "group", memberCount: 2 })).toMatchObject({
      kind: "command",
      body: "/status",
    });
    expect(invoke("/status", { conversationKind: "group", memberCount: 3 })).toMatchObject({
      kind: "text",
    });
    expect(invoke("/status", { conversationKind: "channel" })).toMatchObject({ kind: "text" });
  });

  it("accepts the operator-name prefix in larger conversations and preserves the full trigger", () => {
    expect(invoke("brodie /new keep the model", { conversationKind: "channel" })).toEqual({
      kind: "command",
      body: "/new keep the model",
      triggerBody: "brodie /new keep the model",
      viaNamePrefix: true,
    });
  });

  it("accepts an authorized slash command addressed by native mention metadata", () => {
    expect(
      invoke("/new", {
        authorized: true,
        addressed: true,
        conversationKind: "group",
        memberCount: undefined,
      }),
    ).toEqual({
      kind: "command",
      body: "/new",
      triggerBody: "/new",
      viaNamePrefix: false,
    });
  });

  it("keeps unauthorized addressed command-shaped text conversational", () => {
    const result = invoke("brodie /reset", {
      conversationKind: "channel",
      authorized: false,
      addressed: true,
    });
    expect(result).toEqual({
      kind: "text",
      body: `${DEFAULT_UNAUTHORIZED_COMMAND_ENVELOPE}\nbrodie /reset`,
      triggerBody: "brodie /reset",
    });
  });

  it("maps exact built-in and configured stop language to /stop", () => {
    expect(invoke("interrupt")).toMatchObject({ kind: "command", body: "/stop" });
    expect(invoke("hold up")).toMatchObject({ kind: "command", body: "/stop" });
    expect(invoke("please interrupt")).toEqual({
      kind: "text",
      body: "please interrupt",
      triggerBody: "please interrupt",
    });
  });

  it("keeps native commands bare and rejects /abort as a command alias", () => {
    expect(invoke("/status", { native: true, conversationKind: "channel" })).toMatchObject({
      kind: "command",
      body: "/status",
    });
    expect(invoke("/abort")).toMatchObject({ kind: "text" });
  });
});

describe("resolvePrefixedCommandCandidate", () => {
  it("lets early ingress detection see the slash command after the operator name", () => {
    expect(resolvePrefixedCommandCandidate({ cfg, text: "brodie /status" })).toBe("/status");
    expect(resolvePrefixedCommandCandidate({ cfg, text: "other /status" })).toBe("other /status");
  });
});
