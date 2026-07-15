// Preserves operator browser tabs across conversational session lifecycles.
import type { OpenClawConfig } from "./config/types.openclaw.js";

export async function cleanupBrowserSessionsForLifecycleEnd(params: {
  cfg?: OpenClawConfig;
  sessionKeys: string[];
  onWarn?: (message: string) => void;
  onError?: (error: unknown) => void;
}): Promise<void> {
  // Kept as a compatibility seam for callers that still dispatch lifecycle
  // cleanup. /new, /reset, deletion, cron completion, and subagent teardown
  // deliberately close no browser tabs. Explicit close and the browser
  // plugin's independent idle/max-tab sweeper remain the cleanup owners.
  void params;
}
