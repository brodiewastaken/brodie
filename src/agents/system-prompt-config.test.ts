// System prompt config tests cover config-to-prompt parameter resolution through
// the canonical agent prompt facade.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildConfiguredAgentSystemPrompt,
  resolveAgentSystemPromptConfig,
} from "./system-prompt-config.js";

vi.mock("../tts/tts.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
}));

describe("resolveAgentSystemPromptConfig", () => {
  it("defaults sub-agent delegation mode to suggest", () => {
    expect(resolveAgentSystemPromptConfig({ config: {} }).subagentDelegationMode).toBe("suggest");
  });

  it("inherits default sub-agent delegation mode", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            delegationMode: "prefer",
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveAgentSystemPromptConfig({ config, agentId: "main" }).subagentDelegationMode).toBe(
      "prefer",
    );
  });

  it("lets per-agent sub-agent delegation mode override defaults", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            delegationMode: "suggest",
          },
        },
        list: [
          {
            id: "coordinator",
            subagents: {
              delegationMode: "prefer",
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    expect(
      resolveAgentSystemPromptConfig({ config, agentId: "coordinator" }).subagentDelegationMode,
    ).toBe("prefer");
  });
});

describe("buildConfiguredAgentSystemPrompt", () => {
  it("applies config-backed prompt parameters through the canonical facade", () => {
    const prompt = buildConfiguredAgentSystemPrompt({
      config: {
        agents: {
          defaults: {
            subagents: {
              delegationMode: "prefer",
            },
          },
        },
      },
      agentId: "main",
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents"],
    });

    expect(prompt).toContain("## Sub-Agent Delegation");
    expect(prompt).toContain("Mode: prefer");
  });

  it("opens the prompt with the identity-bootstrap identity line and drops the default assistant line", () => {
    const base = { agentId: "main", workspaceDir: "/tmp/openclaw", toolNames: ["read"] };
    const configured = buildConfiguredAgentSystemPrompt({
      ...base,
      config: {
        hooks: {
          internal: {
            entries: { "identity-bootstrap": { enabled: true, identityLine: "YOU ARE BRODIE." } },
          },
        },
      },
    });
    expect(configured.startsWith("YOU ARE BRODIE.\n")).toBe(true);
    expect(configured).not.toContain("You are a personal assistant running inside OpenClaw.");

    const stock = buildConfiguredAgentSystemPrompt({ ...base, config: {} });
    expect(stock.startsWith("You are a personal assistant running inside OpenClaw.\n")).toBe(true);
  });
});
