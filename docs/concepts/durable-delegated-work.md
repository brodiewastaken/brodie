---
summary: "How OpenClaw persists delegated work and routes child completion"
read_when:
  - You want to understand sub-agent ownership or restart recovery
  - You are debugging nested child completion delivery
title: "Durable delegated work"
---

# Durable delegated work

Every native sub-agent is a durable task record in its agent's SQLite state database. The record is written before execution starts and keeps the stable task identity, current run identity, immediate controller route, original human-facing source route, context mode, lifecycle state, attachments, and completion receipt.

## Controller ownership

Each child reports to exactly one immediate controller. A nested child returns its result to its parent sub-agent, while the root source route is inherited unchanged through the graph. Only the root conversation agent may use the message tool to communicate with the human source. Child output is structured controller input, never direct channel output.

## Completion and waiting

Controllers do not poll and there is no `sessions_yield` tool. A controller with live descendants may end its turn naturally. When a child reaches a terminal state, OpenClaw creates one stable completion event and durably admits it to the controller's scheduler lane before waking the controller. Duplicate hooks reuse the same scheduler receipt.

Delivery remains pending until the controller handoff records transcript evidence. Cleanup starts only after that evidence and terminal hooks settle, so managed attachments cannot disappear before the controller consumes the result.

## Restart recovery

On restart, OpenClaw reconciles nonterminal rows against live runtime and transcript evidence. It reattaches only when durable identity proves the original work still exists. Otherwise it records one structured interruption and routes that result to the immediate controller. It does not blindly restart work whose external side effects are unknown.

Timeout, explicit kill, provider failure, and lost-runtime interruption remain distinct outcomes. `/stop` cancels the controller's descendant tree, while `/new` and `/reset` rotate the root transcript without discarding the original source route carried by outstanding tasks.

## v2026.7.1 absorption

This boundary retains the release's SQLite sub-agent registry, lifecycle reconciliation, nested
spawn limits, detached-task runtime, and completion retry machinery. The residual fork layer writes
the task identity before child dispatch, records immediate-controller and root-source edges, admits
one stable completion event through the conversation scheduler, and treats the parent-agent turn as
the only completion handoff. Legacy `sessions_yield` state remains readable for old transcripts, but
the tool is no longer exposed and child output never falls back to direct channel delivery.
