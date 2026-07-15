---
summary: "How OpenClaw validates, delivers, and records atomic conversational actions"
read_when:
  - Debugging visible replies, reactions, silence, quotes, or partial delivery
  - Adding a channel-specific message action
title: "Atomic Conversational Actions"
---

# Atomic conversational actions

When the message tool is available, it is the only boundary for model-authored conversational
output. Normal assistant prose remains private in the transcript. Native command replies remain
the only non-model exception.

Every channel exposes four strict core actions: `reply`, `send`, `react`, and `silence`. A channel
may add native read, moderation, poll, thread, upload, or administrative actions. Every action
requires nonblank `invisibleThinking`, while only core actions can record a terminal conversational
outcome.

The message-tool prompt is generated from the actions available for the current turn. It describes
only those actions and emits examples only for legal branches. `invisibleThinking` is provider-neutral
private deliberation: it holds the decision about whether this moment needs a response, what is worth
saying, and which action carries it. Provider-native thinking remains separate.

## Authored messages and routing

`reply` answers the current bound conversation and rejects explicit routing fields. `send` is only
for deliberate delivery to a different route and requires an explicit channel and target. `react`
either uses the authoritative inbound message or requires channel,
target, and message id together. `silence` needs no route and records deliberate silence without
sending anything.

The bound route and the current inbound message id are separate authority. A controller or announce
turn can use the exact typed route recovered from its canonical session for an ordinary `reply` even
when it has no live inbound message id. A reply-side `quoteReply` and an implicit current-message
reaction still require that inbound id. An explicit-route `send` keeps its independent exact-id quote
contract.

`visibleMessages` contains zero to nine authored messages. Blank entries reject the complete call,
and an empty array is valid only when media or rich content creates a message. Transports may split
one authored message into several platform bubbles. Delivery preserves authored order, applies rich
or media fields to the first authored message only, and applies `quoteReply` to the first actual
platform bubble only.

Chat-visible message and reaction fields reject em dash family characters before any delivery:
U+2013, U+2014, U+2015, U+2E3A, and U+2E3B. Plain hyphens and private `invisibleThinking` are not
filtered. Invalid action, route, and private-field errors are rewritten in the message tool before
generic schema validation so the model receives the legal action set and the exact route contract.

Legacy quote fields and directive syntax are not aliases. `replyTo`, `reply_to`, `[[SPLIT]]`,
`[[reply_to_current]]`, quote directives, and `NO_REPLY` are rejected as public fields or remain
literal text. Emoji-only text never becomes a reaction automatically.

## Delivery and outcomes

The action validates its complete static contract before the first send. Delivery then stops at the
first failed bubble, preserving receipts for every successful bubble and never replaying them
automatically. A partial or failed result keeps the model run alive even when `endTurn` was true.

Successful terminal sends record `sent`, successful terminal reactions record `reacted`, explicit
silence records `deliberate_silence`, and an otherwise unclassified natural provider stop records
`implicit_silence`. Terminal tool results wait for sibling calls from the same assistant batch so
their receipts settle before the run ends.

Committed `sent`, `reacted`, and `deliberate_silence` outcomes count as terminal trajectory progress
before deliverability classification. A reaction-only or deliberate-silence turn therefore settles
successfully instead of being retained as a failed batch and replayed with the next inbound event.

## v2026.7.1 absorption

This boundary retains the release's channel action registry, transport implementations, payload
safety normalization, embedded tool construction, and provider stop metadata. The residual fork
layer centralizes the strict core union, authored-message iteration, sparse quote projection,
receipts, and normal terminal outcomes. Channel adapters keep their native operations and do not
rebuild action semantics.

See [canonical conversation sessions](/concepts/canonical-conversation-sessions) for current route
ownership and [conversation scheduler](/concepts/conversation-scheduler) for durable admission and
outcome consumption.
