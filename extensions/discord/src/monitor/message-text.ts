// Discord plugin module implements message text behavior.
import { ComponentType } from "discord-api-types/v10";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Message } from "../internal/discord.js";
import {
  formatDiscordSnapshotAuthor,
  normalizeDiscordMessageSnapshots,
  resolveDiscordMessageSnapshots,
  resolveDiscordMessageStickers,
  resolveDiscordReferencedForwardMessage,
  resolveDiscordSnapshotStickers,
  type DiscordSnapshotMessage,
} from "./message-forwarded.js";
import { buildDiscordMediaPlaceholder } from "./message-media.js";

export function resolveDiscordEmbedText(
  embed?: { title?: string | null; description?: string | null } | null,
): string {
  const title = normalizeOptionalString(embed?.title) ?? "";
  const description = normalizeOptionalString(embed?.description) ?? "";
  if (title && description) {
    return `${title}\n${description}`;
  }
  return title || description || "";
}

export function resolveDiscordMessageText(
  message: Message,
  options?: { fallbackText?: string; includeForwarded?: boolean },
): string {
  const embedText = resolveDiscordEmbedText(
    (message.embeds?.[0] as { title?: string | null; description?: string | null } | undefined) ??
      null,
  );
  const componentText = extractDiscordComponentsV2Text(resolveDiscordMessageComponents(message));
  const rawText =
    normalizeOptionalString(message.content) ||
    buildDiscordMediaPlaceholder({
      attachments: message.attachments ?? undefined,
      stickers: resolveDiscordMessageStickers(message),
    }) ||
    embedText ||
    componentText ||
    normalizeOptionalString(options?.fallbackText) ||
    "";
  const baseText = resolveDiscordMentions(rawText, message);
  if (!options?.includeForwarded) {
    return baseText;
  }
  const forwardedText = resolveDiscordForwardedMessagesText(message);
  if (!forwardedText) {
    return baseText;
  }
  if (!baseText) {
    return forwardedText;
  }
  return `${baseText}\n${forwardedText}`;
}

function resolveDiscordMentions(text: string, message: Message): string {
  if (!text.includes("<")) {
    return text;
  }
  const mentions = message.mentionedUsers ?? [];
  if (!Array.isArray(mentions) || mentions.length === 0) {
    return text;
  }
  let out = text;
  for (const user of mentions) {
    const username = user.username?.trim();
    if (!username) {
      continue;
    }
    out = out.replace(new RegExp(`<@!?${user.id}>`, "g"), `@${username} [${user.id}]`);
  }
  return out;
}

export async function resolveDiscordInboundMessageText(
  message: Message,
  options?: {
    fallbackText?: string;
    includeForwarded?: boolean;
    resolveChannelName?: (channelId: string) => Promise<string | null | undefined>;
  },
): Promise<string> {
  const text = resolveDiscordMessageText(message, options);
  if (!text.includes("<#") || !options?.resolveChannelName) {
    return text;
  }

  const channelIds = new Set<string>();
  for (const match of text.matchAll(/#[^#[\]\n]+? \[<#(\d+)>\]|<#(\d+)>/gu)) {
    const channelId = match[1] ?? match[2];
    if (channelId) {
      channelIds.add(channelId);
    }
  }
  if (channelIds.size === 0) {
    return text;
  }

  const names = new Map<string, string>();
  const { results } = await runTasksWithConcurrency({
    tasks: [...channelIds].map((channelId) => async () => {
      try {
        const name = (await options.resolveChannelName?.(channelId))?.trim();
        return { channelId, name };
      } catch {
        // Native ids remain visible when Discord cannot resolve a channel name.
        return { channelId, name: undefined };
      }
    }),
    limit: 4,
  });
  for (const result of results) {
    if (result?.name) {
      names.set(result.channelId, result.name);
    }
  }
  return text.replace(
    /#[^#[\]\n]+? \[<#(\d+)>\]|<#(\d+)>/gu,
    (token, canonicalId: string | undefined, rawId: string | undefined) => {
      const channelId = canonicalId ?? rawId;
      if (!channelId) {
        return token;
      }
      const name = names.get(channelId);
      return name ? `#${name} [<#${channelId}>]` : `<#${channelId}>`;
    },
  );
}

function resolveDiscordForwardedMessagesText(message: Message): string {
  const snapshots = resolveDiscordMessageSnapshots(message);
  if (snapshots.length > 0) {
    return resolveDiscordForwardedMessagesTextFromSnapshots(snapshots);
  }
  const referencedForward = resolveDiscordReferencedForwardMessage(message);
  if (!referencedForward) {
    return "";
  }
  const referencedText = resolveDiscordMessageText(referencedForward);
  if (!referencedText) {
    return "";
  }
  const authorLabel = formatDiscordSnapshotAuthor(referencedForward.author);
  const heading = authorLabel ? `[Forwarded message from ${authorLabel}]` : "[Forwarded message]";
  return `${heading}\n${referencedText}`;
}

function resolveDiscordMessageComponents(message: Message): unknown {
  const components = (message as { components?: unknown }).components;
  if (components !== undefined) {
    return components;
  }
  try {
    return (message as { rawData?: { components?: unknown } }).rawData?.components;
  } catch {
    return undefined;
  }
}

function extractDiscordComponentsV2Text(components: unknown): string {
  const parts: string[] = [];
  collectDiscordTextDisplayContent(components, parts);
  return parts.join("\n");
}

function collectDiscordTextDisplayContent(value: unknown, parts: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDiscordTextDisplayContent(entry, parts);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const component = value as {
    type?: unknown;
    content?: unknown;
    components?: unknown;
    component?: unknown;
  };
  if (component.type === ComponentType.TextDisplay) {
    const content = normalizeOptionalString(component.content);
    if (content) {
      parts.push(content);
    }
  }
  collectDiscordTextDisplayContent(component.components, parts);
  collectDiscordTextDisplayContent(component.component, parts);
}

export function resolveDiscordForwardedMessagesTextFromSnapshots(snapshots: unknown): string {
  const forwardedBlocks = normalizeDiscordMessageSnapshots(snapshots)
    .map((snapshot) => buildDiscordForwardedMessageBlock(snapshot.message))
    .filter((entry): entry is string => Boolean(entry));
  if (forwardedBlocks.length === 0) {
    return "";
  }
  return forwardedBlocks.join("\n\n");
}

function buildDiscordForwardedMessageBlock(
  snapshotMessage: DiscordSnapshotMessage | null | undefined,
): string | null {
  if (!snapshotMessage) {
    return null;
  }
  const text = resolveDiscordSnapshotMessageText(snapshotMessage);
  if (!text) {
    return null;
  }
  const authorLabel = formatDiscordSnapshotAuthor(snapshotMessage.author);
  const heading = authorLabel ? `[Forwarded message from ${authorLabel}]` : "[Forwarded message]";
  return `${heading}\n${text}`;
}

function resolveDiscordSnapshotMessageText(snapshot: DiscordSnapshotMessage): string {
  const content = normalizeOptionalString(snapshot.content) ?? "";
  const attachmentText = buildDiscordMediaPlaceholder({
    attachments: snapshot.attachments ?? undefined,
    stickers: resolveDiscordSnapshotStickers(snapshot),
  });
  const embedText = resolveDiscordEmbedText(snapshot.embeds?.[0]);
  const componentText = extractDiscordComponentsV2Text(snapshot.components);
  return content || attachmentText || embedText || componentText || "";
}
