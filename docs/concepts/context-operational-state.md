---
summary: "How context, media, workspace setup, memory collections, and generated sessions keep one durable owner"
read_when:
  - Changing context-engine assembly, media persistence, or native-image restoration
  - Migrating workspace setup state or configuring generated-session retention
  - Debugging QMD collection identity or duplicate media context
title: "Context and Operational State"
---

# Context and operational state

OpenClaw keeps each operational state family behind one authoritative owner. Queue metadata pairs
assembled turns without parsing prompt text, context engines own non-native file persistence, SQLite
owns workspace setup state, QMD honors explicit collection names, and the session archive targets
generated sessions only.

## Typed queue identity and native images

Every admitted conversational batch can carry a typed identity containing its route, ordered source
message ids, and native-image count. Collect mode merges identities only when every source is typed
and belongs to the same route. Context assembly uses that metadata to restore images after an engine
mutation, collapse duplicate representations, and reject cross-batch attachment.

Still images remain native provider blocks through queueing, compaction, retry, fallback, and
transcript reconstruction. The effective ceiling comes from the selected model's `maxNativeImages`,
then the global agent default, then 42. A value of zero keeps all images externalized.

## External files

Audio, video, documents, archives, GIFs, and other provider-unsupported inputs are handed to the
configured context engine as typed external files. Each record includes a stable managed reference,
conversation-scoped idempotency key, source indexes, safe metadata, and any media-understanding
output. Supporting engines persist a file once and replace its provisional marker. Engines without
external-file support leave the marker and diagnostic state intact.

Prompt text never grants file authority. Managed media references and allowed local roots remain the
only filesystem boundary, and provider-unsupported media cannot be rediscovered as prompt images.

## Workspace setup state

The shared SQLite state database is the sole steady-state owner of workspace setup. On startup, an
idempotent migration reads the root `openclaw-workspace-state.json` and legacy
`.openclaw/workspace-state.json`, prefers the canonical root format, normalizes legacy timestamps,
and refuses to downgrade a newer database row.

The migration writes transactionally, reads the normalized row back, and deletes only a source file
proven imported. Malformed or unreadable files remain in place with a warning. Runtime reads and
writes never recreate either JSON file.

## QMD collection identity

An explicit `memory.qmd.sessions.name` remains literal and stable, including when another configured
path would otherwise collide. Automatic suffixes apply only to generated names. Reindex, query, and
doctor surfaces therefore address the same remote collection without exposing credentials.

## Generated-session archive

The bundled `session-archive` plugin applies TTL retention only to configured generated-session
classes: cron, subagent, and isolated or one-shot sessions. Human direct, group, channel, thread,
main, and global sessions are never selected by TTL.

Invalid TTL or target configuration fails closed. Active runs, live subagents, protected cron
bindings, and unsafe transcript paths remain untouched. Store updates use the session-store runtime
seam, while transcript renames use the normal session artifact lifecycle so indexes observe them.

An isolated cron generation keeps its OpenClaw `sessionId` in the stable scheduling row from the
first persistence write. Until its transcript exists, the row omits only transcript and
provider-owned resume handles. Metadata-only writes such as auth-profile selection therefore cannot
invent a second identity, and the completed row resolves the same transcript and usage that the cron
run reported.

Retained isolated runs also persist a hidden exact-run alias at
`agent:<agentId>:cron:<jobId>:run:<sessionId>`. Cron history can therefore open the same transcript
after the stable slot advances, while the Sessions roster still shows only the stable row. That
exact key is frozen before compaction can rotate transcript metadata, so archive still replaces the
one owned alias instead of creating a second row. Stable and exact rows are committed together
through the session accessor. The cron run-session reaper takes the same lifecycle lock as work
admission, rechecks ownership under that lock, and fails closed for admitted generations through
descendant settlement. It removes expired aliases without archiving a transcript still referenced
by the stable row.

## v2026.7.1 absorption

OpenClaw `v2026.7.1` already owns the context-engine lifecycle, managed inbound media store, session
artifact naming, session-store updates, and shared SQLite state database. This layer keeps those
owners and adds typed queue identity, one-time external-file handoff, verified JSON-to-SQLite
migration, explicit QMD session naming, and fail-closed generated-session retention. It does not add
a second queue, media store, workspace-state writer, transcript pruner, or prompt-text parser.
