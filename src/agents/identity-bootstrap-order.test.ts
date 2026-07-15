// Covers the shared identity-bootstrap ordering resolution used by both the
// bundled hook and the system prompt's Project Context sort.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_IDENTITY_BOOTSTRAP_ORDER,
  resolveIdentityBootstrapOrder,
} from "./identity-bootstrap-order.js";

function configWithHookEntry(entry: Record<string, unknown>): OpenClawConfig {
  return {
    hooks: {
      internal: {
        entries: {
          "identity-bootstrap": entry,
        },
      },
    },
  };
}

describe("resolveIdentityBootstrapOrder", () => {
  it("returns undefined unless the hook is explicitly enabled", () => {
    expect(resolveIdentityBootstrapOrder(undefined)).toBeUndefined();
    expect(resolveIdentityBootstrapOrder({})).toBeUndefined();
    expect(resolveIdentityBootstrapOrder(configWithHookEntry({}))).toBeUndefined();
    expect(resolveIdentityBootstrapOrder(configWithHookEntry({ enabled: false }))).toBeUndefined();
  });

  it("returns undefined when the hooks master switch is off", () => {
    // hooks.internal.enabled === false blocks all internal hook loading, so the
    // prompt-side ordering must stay on the upstream default too.
    const config: OpenClawConfig = {
      hooks: {
        internal: {
          enabled: false,
          entries: {
            "identity-bootstrap": { enabled: true },
          },
        },
      },
    };
    expect(resolveIdentityBootstrapOrder(config)).toBeUndefined();
  });

  it("returns the soul-first default order when enabled without a configured order", () => {
    expect(resolveIdentityBootstrapOrder(configWithHookEntry({ enabled: true }))).toEqual([
      ...DEFAULT_IDENTITY_BOOTSTRAP_ORDER,
    ]);
  });

  it("returns the configured order when enabled with one", () => {
    const config = configWithHookEntry({ enabled: true, order: ["USER.md", " AGENTS.md "] });
    expect(resolveIdentityBootstrapOrder(config)).toEqual(["USER.md", "AGENTS.md"]);
  });
});
