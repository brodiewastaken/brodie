---
name: identity-bootstrap
description: "Inject all root workspace markdown files as bootstrap context in priority order"
metadata:
  {
    "openclaw":
      {
        "emoji": "🪞",
        "events": ["agent:bootstrap"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Identity Bootstrap Hook

Loads every root-level `*.md` file in the workspace back into `Project Context` during
`agent:bootstrap`, after stock session filters and the bootstrap snapshot cache have run.
Freshly read content wins over cache-stale entries, so an edit to `SOUL.md` is visible on
the very next run of a long-lived session.

## Why

Use this when the workspace root holds the agent's identity files (SOUL.md, IDENTITY.md,
USER.md, plus any extra files like STYLE.md or PRIVACY.md) and every session —
including sub-agent sessions — should boot with the complete, freshly read set in a
stable priority order.

## Scope: every session kind, by design

When enabled, the hook re-injects the full root markdown set into **every**
`agent:bootstrap` — main, sub-agent, cron, and heartbeat sessions alike — deliberately
overriding the per-session allowlist filters (upstream restricts sub-agents to
`AGENTS.md`+`TOOLS.md` and crons to a five-file list). That is the product contract:
every session of the agent boots with its identity files. This includes lightweight
(`contextMode: "lightweight"`) runs, whose emptied bootstrap set the hook re-fills. Be
aware of the token cost this adds to frequent cron/heartbeat runs. The two post-hook
filters still apply: stale root `BOOTSTRAP.md` stays excluded once workspace setup is
complete, and `HEARTBEAT.md` stays excluded from non-heartbeat runs when heartbeat
prompt guidance is disabled.

## Configuration

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "identity-bootstrap": {
          "enabled": true
        }
      }
    }
  }
}
```

The hook is strictly opt-in: it stays inert unless `enabled` is exactly `true`.

## Options

- `order` (string[]): bootstrap filenames in priority order. Files not listed sort after,
  case-insensitive alphabetical. Default (soul-first): `SOUL.md`, `IDENTITY.md`, `USER.md`,
  `MEMORY.md`, `AGENTS.md`, `TOOLS.md`, `STYLE.md`, `PRIVACY.md`.

The same order is applied when the system prompt renders `Project Context`, so bootstrap
order and prompt order cannot diverge.

Reads are boundary-safe: only regular files directly in the workspace root are considered,
symlinks that escape the workspace are skipped, and files larger than 2 MB are skipped.
