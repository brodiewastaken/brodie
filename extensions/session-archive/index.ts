// Session archive plugin entrypoint: TTL-archives generated sessions (cron,
// subagent, isolated) in the background without waking any agent.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createSessionArchiveService, resolveSessionArchiveConfig } from "./src/index.js";

export default definePluginEntry({
  id: "session-archive",
  name: "Session Archive",
  description:
    "Background TTL sweep that archives generated sessions (cron, subagent, isolated) and renames their transcripts into upstream-recognized archive artifacts.",
  register(api) {
    const config = resolveSessionArchiveConfig(api.pluginConfig);
    if (!config.enabled || config.retentionMs === null) {
      // Fail CLOSED: invalid retention/targets never fall back to defaults —
      // an archive sweep on guessed config deletes sessions. Disabled costs
      // nothing: no service, no timers, no store reads.
      for (const reason of config.disabledReasons) {
        api.logger.warn(`session-archive: INERT — ${reason}`);
      }
      return;
    }
    api.registerService(createSessionArchiveService(config));
  },
});
