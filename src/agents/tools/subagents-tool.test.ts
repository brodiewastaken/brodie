// Subagents tool tests cover requester-scoped listing guidance and numeric
// status-window validation.
import { describe, expect, it } from "vitest";
import { createSubagentsTool } from "./subagents-tool.js";

describe("subagents tool", () => {
  it("describes push-based completion without a polling primitive", () => {
    const tool = createSubagentsTool();

    expect(tool.description).toBe(
      "List active and recent subagents for on-demand status and debugging. Completion is push-based; do not poll wait loops.",
    );
  });

  it.each([0, 1.5])("rejects invalid recentMinutes value %s", async (recentMinutes) => {
    const tool = createSubagentsTool();

    await expect(
      tool.execute("call-1", {
        action: "list",
        recentMinutes,
      }),
    ).rejects.toThrow("recentMinutes must be a positive integer");
  });
});
