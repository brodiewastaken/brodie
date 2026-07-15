// Whatsapp plugin module implements commands behavior.
export function stripMentionsForCommand(
  text: string,
  mentionRegexes: RegExp[],
  selfE164?: string | null,
  mentionedJids: readonly string[] = [],
) {
  // WhatsApp wraps rendered mention labels in Unicode isolate controls. Remove
  // those presentation-only marks before applying the configured mention
  // patterns so the command body matches the text the user visibly authored.
  let result = text.replace(/[\u2066-\u2069]/g, "");
  for (const re of mentionRegexes) {
    result = result.replace(re, " ");
  }
  for (const jid of mentionedJids) {
    const token = jid.split("@", 1)[0]?.replace(/:\d+$/, "");
    if (!token) {
      continue;
    }
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`@${escaped}(?=\\s|$)`, "g"), " ");
  }
  if (selfE164) {
    // `selfE164` is usually like "+1234"; strip down to digits so we can match "+?1234" safely.
    const digits = selfE164.replace(/\D/g, "");
    if (digits) {
      const pattern = new RegExp(`\\+?${digits}`, "g");
      result = result.replace(pattern, " ");
    }
  }
  return result.replace(/\s+/g, " ").trim();
}
