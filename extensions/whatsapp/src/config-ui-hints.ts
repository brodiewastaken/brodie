// Whatsapp helper module supports config ui hints behavior.
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/core";

export const whatsAppChannelConfigUiHints = {
  "": {
    label: "WhatsApp",
    help: "WhatsApp channel provider configuration for access policy and message batching behavior. Use this section to tune responsiveness and direct-message routing safety for WhatsApp chats.",
  },
  dmPolicy: {
    label: "WhatsApp DM Policy",
    help: 'Direct message access control ("pairing" recommended). "open" requires channels.whatsapp.allowFrom=["*"].',
  },
  selfChatMode: {
    label: "WhatsApp Self-Phone Mode",
    help: "Same-phone setup (bot uses your personal WhatsApp number).",
  },
  debounceMs: {
    label: "WhatsApp Message Debounce (ms)",
    help: "Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable).",
  },
  configWrites: {
    label: "WhatsApp Config Writes",
    help: "Allow WhatsApp to write config in response to channel events/commands (default: true).",
  },
  "actions.calls": {
    label: "WhatsApp Voice Calls",
    help: "Expose the experimental requester-bound WhatsApp voice-call tool. Default: false. Requires a separately paired MeowCaller CLI.",
  },
  mentionPatterns: {
    label: "WhatsApp Mention Pattern Policy",
    help: "Scopes configured groupChat mentionPatterns to selected WhatsApp conversation IDs such as 123@g.us.",
  },
  "mentionPatterns.mode": {
    label: "WhatsApp Mention Pattern Mode",
    help: '"allow" enables configured regex mention patterns unless denyIn matches; "deny" disables them unless allowIn matches.',
  },
  "mentionPatterns.allowIn": {
    label: "WhatsApp Mention Pattern Allowlist",
    help: "WhatsApp conversation IDs where configured regex mention patterns are enabled when mode is deny.",
  },
  "mentionPatterns.denyIn": {
    label: "WhatsApp Mention Pattern Denylist",
    help: "WhatsApp conversation IDs where configured regex mention patterns are disabled.",
  },
  gifAutoConvert: {
    label: "WhatsApp GIF Auto-Convert",
    help: "Convert outbound GIFs to MP4 (gifPlayback) so WhatsApp renders a looping GIF bubble instead of a document. Conversion failures fail the send with a typed error.",
  },
  "gifAutoConvert.enabled": {
    label: "WhatsApp GIF Auto-Convert Enabled",
    help: "Enable GIF to MP4 auto-convert before sending (default: true).",
  },
  "gifAutoConvert.timeoutMs": {
    label: "WhatsApp GIF Convert Timeout (ms)",
    help: "ffmpeg timeout in milliseconds for a single GIF conversion (default: 8000).",
  },
  "gifAutoConvert.maxOutputBytes": {
    label: "WhatsApp GIF Convert Max Output Bytes",
    help: "Maximum converted MP4 size in bytes; larger outputs fail the send (default: 12000000).",
  },
  autoGroupWhitelist: {
    label: "WhatsApp Auto Group Whitelist",
    help: 'Owner-driven trusted-group automation. With groupPolicy "duo" (or enabled=true) only trusted groups are processed; the owner adding the bot to a group trusts it, removal revokes trust.',
  },
  "autoGroupWhitelist.enabled": {
    label: "WhatsApp Auto Group Whitelist Enabled",
    help: 'Enable trusted-group enforcement and owner trust automation without setting groupPolicy "duo".',
  },
  "autoGroupWhitelist.ownerE164": {
    label: "WhatsApp Trusted-Group Owner (E.164)",
    help: "Owner phone number (e.g. +15551234567) allowed to trust groups. Falls back to the first allowFrom entry.",
  },
  "autoGroupWhitelist.profile": {
    label: "WhatsApp Trusted-Group Session Profile",
    help: "Session profile pinned onto a group session when the group becomes trusted (model/provider derive from agents.defaults.model when omitted).",
  },
  groupRoster: {
    label: "WhatsApp Group Roster",
    help: "Group member roster rendering and workspace contacts-registry enrichment for group message context.",
  },
  "groupRoster.selfNote": {
    label: "WhatsApp Roster Self Note",
    help: "Note rendered next to the agent's own roster entry (default: none).",
  },
  "groupRoster.missingPersonFileNote": {
    label: "WhatsApp Roster Missing Person-File Note",
    help: "Note template rendered for members without a person file; {contactsPath} expands to the contacts registry path. Rendered at most once per person per day.",
  },
  "groupRoster.workspaceContacts.peopleDir": {
    label: "WhatsApp Roster People Dir",
    help: 'People directory relative to the agent workspace (default: "memory/people").',
  },
  "groupRoster.workspaceContacts.contactsFile": {
    label: "WhatsApp Roster Contacts File",
    help: 'Contacts registry file name inside the people dir (default: "_contacts.json").',
  },
  media: {
    label: "WhatsApp Media Robustness",
    help: "Inbound/outbound media handling: iOS Live Photo motion-component filtering and failed-media warning text.",
  },
  "media.livePhotoPairWindowMs": {
    label: "WhatsApp Live Photo Pair Window (ms)",
    help: "Window to pair a bare video component with its still image before delivering it (default: 3000).",
  },
  "media.livePhotoFilter": {
    label: "WhatsApp Live Photo Filter",
    help: "Drop iOS Live Photo motion components instead of delivering them as videos (default: true).",
  },
  "media.failedMediaWarning": {
    label: "WhatsApp Failed Media Warning",
    help: "Warning line sent when an outbound media item fails to deliver.",
  },
  sendListenerWaitMs: {
    label: "WhatsApp Send Listener Wait (ms)",
    help: "Max wait for outbound sends to acquire the account listener while the socket reconnects (default: 5000).",
  },
  diagnostics: {
    label: "WhatsApp Diagnostics",
    help: "Debug capture settings for unrecognized inbound payloads.",
  },
  "diagnostics.unrecognizedPayloadCapture": {
    label: "WhatsApp Unrecognized Payload Capture",
    help: "Persist inbound messages with no extractable content as JSON debug captures under the logs dir (default: false).",
  },
  "diagnostics.captureRetentionHours": {
    label: "WhatsApp Capture Retention (hours)",
    help: "Delete diagnostic captures older than this many hours (default: 48).",
  },
} satisfies Record<string, ChannelConfigUiHint>;
