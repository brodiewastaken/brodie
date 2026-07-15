---
summary: "How the Control UI exposes exact transcript, runtime, scheduler, and delivery state"
read_when:
  - Debugging conversational actions, transcript projection, or scheduler recovery
  - Configuring single-operator Control UI security flags
title: "Exact Operator State"
---

# Exact operator state

The Control UI has one chronological, human-readable raw event timeline over the persisted
transcript sequence. There is no standard projection, mode toggle, browser preference, or gateway
mode default that can disagree with transcript truth.

## Transcript timeline

The timeline preserves persisted text, blocks, metadata, tool payloads, and order while rendering
typed inbound sources, persisted inbound envelopes, captured current-turn text input, thinking,
actions, tools, results, and receipts as distinct readable cards. For new typed channel turns, the
user row stores one queue-first current-user item as operator-only metadata. It has no duplicate
timestamp prefix, legacy media note, or separate `openclaw.runtime-context` tail item. Unique
structured history, active-goal context, and other current-turn additions stay in the same user item
after the canonical envelope. The snapshot exposes those hidden additions, but it is not a serialized
provider request: system input, replay history, tool schemas, image bytes, and provider-specific
transforms remain owned by their existing surfaces. The snapshot does not re-enter replay context.
Older rows created before this capture was added show only their persisted inbound envelope instead
of reconstructing or guessing hidden input. Inbound envelopes, text-input
snapshots, calls, results, and exact persisted rows are collapsed by default. History pages use the
absolute transcript `seq` as their cursor, and older pages prepend without replacing the live tail.
Oversized rows are represented by typed deferred references and loaded by sequence in fixed
UTF-8-safe chunks with an end-to-end SHA-256 check. No row or aggregate display ceiling substitutes
or truncates content.

The transcript configuration is:

```json5
{
  gateway: {
    controlUi: {
      transcript: {
        pageSize: 100,
      },
    },
  },
}
```

## Fixed status ownership

`/status` and `session_status` use fixed core-owned sections for the resolved model and run policy,
conversation scheduler lanes and storage, tasks, subagents, media and context, session and transcript
usage, and provider subscription usage. Plugins do not add arbitrary sections. The scheduler probe
has a bounded timeout and cancellation boundary, and failures render as unavailable instead of
blocking the status response.

## Independent single-operator flags

These flags default to the safe behavior and do not imply one another:

```json5
{
  gateway: {
    controlUi: {
      security: {
        redactInjectedMessages: true,
        assistantMediaAnyLocalPath: false,
        allowMainSessionDelete: false,
      },
    },
  },
}
```

Setting `redactInjectedMessages` to `false` preserves literal injected assistant text in the raw
transcript while log and tool-summary redaction remains enabled. `assistantMediaAnyLocalPath` lets
an authenticated client read any gateway-readable regular file through the assistant-media route;
authentication, tickets, symlink rejection, and file-type checks remain. `allowMainSessionDelete`
permits only the canonical main key. The bare `main` alias is always rejected.

## Browser and session behavior

Full-page screenshots return as structured browser tool results and are never outbound media until
the model explicitly attaches them through a conversational action. Full-page capture rejects
element/ref clipping with a typed error. Session reset, deletion, and teardown close no browser tabs;
explicit close and the independent idle/max-tab sweeper still reclaim them.

The normal session list shows active canonical sessions only. Archived cutover sessions have no
browser in this surface. Session keys stay opaque, are percent-encoded as query data, and URI-shaped
keys are rejected before storage lookup.

## v2026.7.1 absorption

This boundary retains the release's gateway protocol, authenticated Control UI transport, chat
history readers, browser driver contracts, status collectors, and session lifecycle operations. The
residual fork layer adds one semantic raw transcript timeline, one sequence namespace, lazy exact row
retrieval, fixed brodie status ownership, explicit single-operator security flags, and opaque
canonical session-list behavior. The release's authorization and persisted transcript remain
authoritative; the operator renderer never becomes a second history store.
