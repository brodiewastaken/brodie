---
summary: "How OpenClaw durably admits, orders, and recovers conversational work"
read_when:
  - Debugging delayed, duplicated, or missing conversation turns
  - Configuring route-specific human debounce
title: "Conversation Scheduler"
---

# Conversation scheduler

The conversation scheduler is the single durable admission point for work that can start or
continue an agent conversation. Human channel input, background completions, cron and heartbeat
turns, subagent outcomes, operator work, and recovery events all use the same session lane.

An accepted receipt means the event is committed to the shared OpenClaw SQLite state database. It
does not mean a model run or delivery has completed. The receipt settles only after the scheduler
records a terminal outcome and transcript evidence.

## Ordering and concurrency

The canonical conversation route supplies both the session key and queue lane key. One lane holds
at most one active reservation, while unrelated lanes can run concurrently. Reservations are
committed before dispatch begins, so two idle admissions cannot both start work.

Human input takes priority over ordinary background backlog after its debounce closes. Human input
that arrives during a tool-using turn can be injected at the next completed tool boundary. If no
boundary remains, the scheduler keeps one ordered batch for the immediate next turn.

## Human inbound envelope

Every human batch renders one queue-engine wrapper, one conversation metadata block, one ordered
inbound block per source event, and the exact delivery fact below between metadata and the first
inbound:

```text
[📨 DELIVERY-REMINDER]: the room only sees what you pass in 'visibleMessages' via the message tool, so don't yap in there
```

The reminder applies to every human-inbound queue-engine envelope across models and providers. It is
not added to session-reset prompts, which already carry their own explicit delivery instruction. The
first byte of model-visible text is always `[📋 QUEUE ENGINE]:`. Generic timestamp, media-note,
thread, system-event, provenance, hook, steering, and recovery decorations are either represented in
the typed envelope or moved behind it. Media descriptors and derived understanding appear once in
the envelope; legacy `[media attached: ...]` prompt notes are not generated for typed batches.
Non-image files carry a literal replacement marker plus their managed path, stable content hash,
source identity, derived-untrusted understanding, and the host-authorized media roots to the active
context engine. This lets lossless-claw externalize the exact file once without trusting an
unconfined path or requiring a second prompt representation. Still images remain native provider
image blocks.

One scheduler batch becomes one provider user-role item. Unique active-goal, structured-history, and
runtime additions are appended inside that same item after the envelope instead of becoming a second
`openclaw.runtime-context` user item. The per-turn model-input snapshot shown to operators records
that same single item. When media staging persists the canonical image-bearing turn before the
harness builds its ephemeral prompt, the final pre-conversion boundary removes only the exact
text-only copy and retains the canonical native image blocks. Adapter debounce never synthesizes
several Discord or Slack source messages into one source: the scheduler retains the original message
IDs, bodies, timestamps, and ordering, then renders the plural envelope itself.

## Debounce

Built-in text debounce is zero for direct and exact two-member conversations, and 4200 milliseconds
for other groups, channels, and threads. Media debounce is 6900 milliseconds everywhere. Once a
pending human batch contains media, its media timing remains sticky while meaningful human traffic
continues.

Configuration resolves in this order:

1. exact channel, account, conversation, and thread route
2. channel and conversation class
3. global conversation class
4. built-in defaults

Text and media timing are independent. Changes are read when an event is admitted, so a runtime
config reload affects new admissions without rewriting accepted rows.

## Durability and recovery

Every accepted event records normalized JSON payload metadata, arrival sequence, ready time,
lifecycle state, dispatch and run correlations, transcript evidence, and callback settlement. The
scheduler refuses cyclic values, class instances, `undefined`, and other non-JSON input before it
claims ownership.

Interrupted active rows are not blindly replayed after restart. They become visible reconciliation
work until runtime and transcript evidence determine the prior outcome. Failed human work remains
with its receipts and joins the next meaningful human inbound as one recovery batch whose first line
identifies it as failed-run recovery rather than a new idle arrival. Typed media that finishes
resolving after provider dispatch remains attached to the original scheduler turn metadata and does
not create a replay-only second user row. Automatic model or delivery retry is intentionally
disabled.

Read-only snapshots expose lane counts, timing, producer kinds, failures, correlations, callback
state, and storage health without including private message bodies.

See [canonical conversation sessions](/concepts/canonical-conversation-sessions) for route and key
construction.

## v2026.7.1 absorption

This boundary retains the release's shared SQLite state owner, transaction and schema migration
machinery, channel ingress adapters, and existing run and transcript execution paths. The residual
fork layer adds the durable event journal, lane coordinator, producer registry, debounce policy,
receipt settlement, and restart reconciliation. Native adapters keep ownership when durable
admission fails, while accepted work proceeds through the release's existing run owners rather than
duplicating them inside the scheduler.
