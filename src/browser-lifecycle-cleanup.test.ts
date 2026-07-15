// Tests browser tab preservation across conversational lifecycle ends.
import { describe, expect, it, vi } from "vitest";

const closeTrackedBrowserTabsForSessions = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("./plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions,
}));

const { cleanupBrowserSessionsForLifecycleEnd } = await import("./browser-lifecycle-cleanup.js");

describe("cleanupBrowserSessionsForLifecycleEnd", () => {
  it("never closes tabs for ordinary session lifecycle operations", async () => {
    const onWarn = vi.fn();
    const onError = vi.fn();

    await expect(
      cleanupBrowserSessionsForLifecycleEnd({
        sessionKeys: ["", "  session-a  ", "session-a", "session-b"],
        onWarn,
        onError,
      }),
    ).resolves.toBeUndefined();

    expect(closeTrackedBrowserTabsForSessions).not.toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
