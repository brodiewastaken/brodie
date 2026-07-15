---
summary: "Canonical conversation identity, command invocation, reset context, and transcript ownership"
title: "Canonical Conversation Sessions"
---

# Canonical conversation sessions

OpenClaw assigns one opaque session identity to each native conversation. The identity includes the routed agent, channel, bot account, conversation kind, native conversation id, and optional native thread id. A second bot account in the same room therefore owns a different session, while every producer targeting the same route converges on one queue lane and transcript.

The queue lane is a private length-prefixed UTF-8 encoding of the route fields. The session key is the readable, reversible `agent:<agentId>:conversation:<channel>:<accountId>:<kind>:<conversationId>[:thread:<threadId>]` identity. Dynamic dimensions use canonical UTF-8 percent encoding only when needed. Callers still treat the complete value as indivisible data. HTTP and UI routes percent-encode it, and gateway or store inputs reject URI-shaped values instead of interpreting them as links.

Channel ingress records original route metadata before dispatch. Session initialization also creates the canonical transcript header before publishing the session entry, so after-turn hooks and mirrors cannot observe a session whose transcript artifact does not exist yet. Synthetic replay keeps the original route and does not replace the persisted channel with an internal dispatcher name.

## operator commands

Text commands combine sender authority with conversation shape in one classifier:

- direct conversations and proven two-member operator plus agent groups accept bare slash commands
- larger groups, channels, and threads require the configured agent name before the slash command
- platform-native commands remain bare because the platform already scopes them to the bot
- command-shaped text that cannot execute becomes ordinary conversation under a trusted configurable envelope
- exact configured stop phrases resolve to `/stop`; `/abort` is not a command alias

`/stop` cancels the active run, queued work, and controlled descendant runs. `/new` rotates the canonical session while preserving user-selected runtime choices. `/reset` rotates the same route and returns runtime choices to configured defaults.

## reset context

Reset turns use one model-visible reset message. It contains the approved direct or group instruction plus exactly today's and yesterday's canonical journal paths in the configured timezone. Inline mode includes both complete files and marks missing files. If the complete inline block does not fit its preflight budget, the entire block switches once to paths mode instead of truncating content.

The identity bootstrap hook loads every safe root Markdown identity file from fresh disk in one configurable order. `BOOTSTRAP.md` and `HEARTBEAT.md` remain owned by the stock run-specific loader, so stale setup or heartbeat-only instructions are not promoted into every run.

## v2026.7.1 absorption

This boundary retains the release's channel ingress, route resolution, session-store lifecycle,
transcript rotation, and platform-native command handling. The residual fork layer adds one readable
conversation route shared by every producer, authority-aware text-command invocation, canonical
transcript materialization before publication, and the reset context and identity bootstrap
contracts. Channel adapters continue to own native identifiers and transport metadata instead of
rebuilding session identity locally.
