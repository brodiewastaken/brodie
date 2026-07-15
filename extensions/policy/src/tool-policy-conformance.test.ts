import { describe, expect, it } from "vitest";
import { POLICY_TOOL_GROUPS } from "./tool-policy-conformance.js";

describe("POLICY_TOOL_GROUPS", () => {
  it("does not expand stale sessions_yield declarations", () => {
    expect(POLICY_TOOL_GROUPS["group:openclaw"]).not.toContain("sessions_yield");
    expect(POLICY_TOOL_GROUPS["group:sessions"]).not.toContain("sessions_yield");
  });
});
