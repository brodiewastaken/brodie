// Whatsapp plugin module implements inbound native mention projection.
import type { ResolvedGroupMemberContext } from "openclaw/plugin-sdk/reply-runtime";

const WHATSAPP_LID_RE = /@(lid|hosted\.lid)$/i;

function normalizeJid(value: string | undefined): string | undefined {
  return value?.trim().replace(/:\d+(?=@)/, "") || undefined;
}

function localPart(value: string | undefined): string | undefined {
  return normalizeJid(value)?.split("@", 1)[0] || undefined;
}

function identityDigits(value: string | undefined): string | undefined {
  const digits = value?.replace(/\D/g, "");
  return digits || undefined;
}

function matchesMentionTarget(member: ResolvedGroupMemberContext, mentionedJid: string): boolean {
  const normalizedTarget = normalizeJid(mentionedJid);
  if (!normalizedTarget) {
    return false;
  }
  if ([member.id, member.lid].some((value) => normalizeJid(value) === normalizedTarget)) {
    return true;
  }
  if (WHATSAPP_LID_RE.test(normalizedTarget)) {
    return false;
  }
  const targetDigits = identityDigits(localPart(normalizedTarget));
  return Boolean(targetDigits && identityDigits(member.e164) === targetDigits);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderMentionTarget(
  member: ResolvedGroupMemberContext,
  mentionedJid: string,
): string | undefined {
  const display = member.name?.trim();
  const e164 = member.e164?.trim();
  const lid = member.lid?.trim() || (WHATSAPP_LID_RE.test(mentionedJid) ? mentionedJid : undefined);
  if (!display || !e164 || !lid) {
    return undefined;
  }
  return `@${display} [${e164}][${lid}]`;
}

export function projectWhatsAppInboundMentions(params: {
  text: string;
  mentionedJids?: readonly string[];
  members?: readonly ResolvedGroupMemberContext[];
}): string {
  const mentionedJids = params.mentionedJids ?? [];
  const members = params.members ?? [];
  if (mentionedJids.length === 0 || members.length === 0) {
    return params.text;
  }

  let projected = params.text.replace(/[\u2066-\u2069]/g, "");
  for (const mentionedJid of mentionedJids) {
    const member = members.find((entry) => matchesMentionTarget(entry, mentionedJid));
    const replacement = member
      ? renderMentionTarget(member, normalizeJid(mentionedJid) ?? mentionedJid)
      : undefined;
    if (!member || !replacement) {
      continue;
    }
    const tokens = new Set(
      [localPart(mentionedJid), identityDigits(member.e164)].filter((value): value is string =>
        Boolean(value),
      ),
    );
    for (const token of tokens) {
      projected = projected.replace(
        new RegExp(`@\\+?${escapeRegExp(token)}(?![\\p{L}\\p{N}_.@-])`, "gu"),
        replacement,
      );
    }
  }
  return projected;
}
