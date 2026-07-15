---
summary: "How brodie resolves model, speed, journal, and native-image policy once per run"
read_when:
  - Changing model selection, aliases, subagent or cron policy
  - Debugging provider fallback, Fast mode, or native-image restoration
title: "Unified Run Policy"
---

# Unified run policy

brodie resolves one immutable run policy before reset assembly or provider dispatch. retries retain
that policy and change only the active provider/model attempt.

The policy fixes reasoning to High and text verbosity to low. It also records the selected primary,
ordered fallbacks, Fast mode, authentication profile, startup-journal mode, native-image ceiling,
and the source of every field.

## Brain catalog

The strict brodie brain resolver contains Opus 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 5, Fable 5,
Sol, Terra, and Luna. Canonical provider/model ids win before aliases. Singular `alias` and plural
`aliases` values are trimmed, compared case-insensitively, and rejected when two models claim the
same normalized alias. The rolling `opus` alias names Opus 5; pinned older generations use
`opus48`, `opus47`, and `opus46`.

This strict catalog governs brodie's default, fallback, reset, cron, and child policy. Provider-owned
opt-in catalogs such as [Fireworks](/providers/fireworks) and [xAI](/providers/xai) remain selectable
through their plugin runtimes without becoming implicit defaults. Specialist providers for media,
speech, search, embeddings, reranking, and realtime features also remain available.

## Cron and child policy

Cron `agentTurn.fastMode` accepts explicit `true` or `false`; omission inherits. The former
`"auto"` payload is invalid and is not persisted. A cron child inherits its cron parent's explicit
Fast value before ordinary subagent defaults, while an explicit spawn override remains strongest.
Each fallback keeps its own configured Fast value. An Opus 5 primary can therefore run with Fast
OFF while its Sol fallback runs with Fast ON.

## Images and provider evidence

`maxNativeImages` resolves from the selected model, then the global agent default, then 42. Zero
keeps all images externalized. Invalid numeric values fail configuration validation.

Raw provider-byte capture is opt-in, correlated by run/model-call metadata, secret-redacted, split
into UTC daily files, and pruned to a bounded 48-hour default. Capture failures never alter provider
traffic.

## Opus 5 backport

OpenClaw `v2026.7.1` already supplies native Sonnet 5 metadata, adaptive thinking, image input, and
the current embedded Anthropic transport. brodie backports the upstream Opus 5 direct-Anthropic
contract: 1,000,000 input tokens, 128,000 output tokens, adaptive thinking at High by default,
default sampling, no assistant prefill, and no unsupported Priority Tier field. The immutable
nine-brain resolver owns Opus 5 plus candidate-specific fallback Fast policy.
