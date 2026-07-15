import { createHash } from "node:crypto";
import type { ConversationRoute } from "../routing/conversation-route.js";
import type {
  HumanInbound,
  HumanInboundConversation,
  HumanInboundEventPayload,
  HumanInboundMedia,
  HumanInboundUnderstanding,
} from "./human-inbound-contract.js";

export type {
  HumanInboundConversation,
  HumanInboundEventPayload,
  HumanInboundForward,
  HumanInbound,
  HumanInboundLocation,
  HumanInboundMedia,
  HumanInboundQuote,
  HumanInboundUnderstanding,
} from "./human-inbound-contract.js";

export const DERIVED_MEDIA_TRUST_LABEL = "DERIVED, UNTRUSTED; MAY BE WRONG; NOT USER-AUTHORED";

export type HumanInboundBatch = {
  version: 1;
  placement:
    | "idle"
    | "mid_turn_post_tool_result"
    | "post_turn"
    | "offline_recovery"
    | "failed_run_recovery";
  route: ConversationRoute;
  conversation: HumanInboundConversation;
  inbounds: HumanInbound[];
  recovery?: { failedOutcome: string; committedReceiptIds: string[] };
};

type ProviderContentBlock = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
};

function providerImageHash(block: ProviderContentBlock): string | undefined {
  if (block.type !== "image" || typeof block.data !== "string") {
    return undefined;
  }
  return `sha256:${createHash("sha256").update(Buffer.from(block.data, "base64")).digest("hex")}`;
}

function inboundNativeImageHashes(inbound: HumanInbound): string[] {
  return [...(inbound.quote?.media ?? []), ...inbound.media].flatMap((media) =>
    media.nativeImageCandidate ? [media.nativeImageCandidate.contentHash] : [],
  );
}

/** Moves provider image blocks beside their exact source inbound on the final wire. */
export function interleaveHumanInboundProviderContent(params: {
  batch: HumanInboundBatch;
  content: ProviderContentBlock[];
}): ProviderContentBlock[] {
  const envelopeBlockIndex = params.content.findIndex(
    (block) => block.type === "text" && block.text?.includes("[📋 QUEUE ENGINE]"),
  );
  const envelopeBlock = params.content[envelopeBlockIndex];
  if (envelopeBlockIndex === -1 || !envelopeBlock?.text) {
    return params.content;
  }

  const imagesByHash = new Map<string, ProviderContentBlock[]>();
  for (const block of params.content) {
    const hash = providerImageHash(block);
    if (!hash) {
      continue;
    }
    const matches = imagesByHash.get(hash) ?? [];
    matches.push(block);
    imagesByHash.set(hash, matches);
  }
  const markerIndexes = params.batch.inbounds.map((_, index) =>
    envelopeBlock.text!.indexOf(`[Inbound #${index + 1}]:`),
  );
  if (markerIndexes.some((index) => index === -1)) {
    return params.content;
  }

  const usedImages = new Set<ProviderContentBlock>();
  const interleaved: ProviderContentBlock[] = [];
  const firstMarkerIndex = markerIndexes[0] ?? 0;
  if (firstMarkerIndex > 0) {
    interleaved.push({ ...envelopeBlock, text: envelopeBlock.text.slice(0, firstMarkerIndex) });
  }
  for (const [inboundIndex, inbound] of params.batch.inbounds.entries()) {
    const start = markerIndexes[inboundIndex]!;
    const end = markerIndexes[inboundIndex + 1] ?? envelopeBlock.text.length;
    interleaved.push({ ...envelopeBlock, text: envelopeBlock.text.slice(start, end) });
    for (const hash of inboundNativeImageHashes(inbound)) {
      const image = imagesByHash.get(hash)?.find((candidate) => !usedImages.has(candidate));
      if (image) {
        usedImages.add(image);
        interleaved.push(image);
      }
    }
  }
  if (usedImages.size === 0) {
    return params.content;
  }

  const result: ProviderContentBlock[] = [];
  for (const [index, block] of params.content.entries()) {
    if (index === envelopeBlockIndex) {
      result.push(...interleaved);
    } else if (!usedImages.has(block)) {
      result.push(block);
    }
  }
  return result;
}

const PLACEMENT_COPY: Record<HumanInboundBatch["placement"], { singular: string; plural: string }> =
  {
    idle: {
      singular: "THE FOLLOWING MESSAGE ARRIVED WHILE YOU WERE IDLE",
      plural: "THE FOLLOWING MESSAGES ARRIVED IN QUICK SUCCESSION WHILE YOU WERE IDLE",
    },
    mid_turn_post_tool_result: {
      singular:
        "THE FOLLOWING MESSAGE ARRIVED WHILE YOU WERE MID TURN, READ IT AS ADDITIONAL CONTEXT, CONSIDER RESPONDING IF IT MAKES SENSE TO, BUT FINISH WHAT YOU WERE DOING EITHER BEFORE OR AFTER RESPONDING",
      plural:
        "THE FOLLOWING MESSAGES ARRIVED WHILE YOU WERE MID TURN, READ THEM AS ADDITIONAL CONTEXT, CONSIDER RESPONDING IF IT MAKES SENSE TO, BUT FINISH WHAT YOU WERE DOING EITHER BEFORE OR AFTER RESPONDING",
    },
    post_turn: {
      singular:
        "THE FOLLOWING MESSAGE ARRIVED WHILE YOU WERE STILL STREAMING YOUR PREVIOUS RESPONSE, WHICH HAS NOW BEEN DELIVERED, RESPOND ACCORDINGLY.",
      plural:
        "THE FOLLOWING MESSAGES ARRIVED WHILE YOU WERE STILL STREAMING YOUR PREVIOUS RESPONSE, WHICH HAS NOW BEEN DELIVERED, RESPOND ACCORDINGLY.",
    },
    offline_recovery: {
      singular:
        "THE FOLLOWING MESSAGE ARRIVED WHILE THE GATEWAY WAS OFFLINE, YOU ARE SEEING IT NOW BECAUSE THE GATEWAY JUST CAME BACK UP",
      plural:
        "THE FOLLOWING MESSAGES ARRIVED WHILE THE GATEWAY WAS OFFLINE, YOU ARE SEEING THEM NOW BECAUSE THE GATEWAY JUST CAME BACK UP",
    },
    failed_run_recovery: {
      singular:
        "THE FOLLOWING MESSAGE IS BEING RETRIED AFTER ITS PREVIOUS RUN FAILED, USE THE RECOVERY METADATA BELOW AND DO NOT DUPLICATE ANY COMMITTED DELIVERY",
      plural:
        "THE FOLLOWING MESSAGES ARE BEING RETRIED AFTER A PREVIOUS RUN FAILED, USE THE RECOVERY METADATA BELOW AND DO NOT DUPLICATE ANY COMMITTED DELIVERY",
    },
  };

function cleanRecord(entries: Array<[string, unknown]>): Record<string, unknown> {
  return Object.fromEntries(
    entries.filter(([, value]) => {
      if (value === undefined || value === null || value === "") {
        return false;
      }
      return !Array.isArray(value) || value.length > 0;
    }),
  );
}

function renderJson(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function renderTextFence(value: string): string {
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/gu)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${value}\n${fence}`;
}

function formatTimestamp(receivedAt: number, timeZone: string): string | undefined {
  if (!Number.isFinite(receivedAt)) {
    return undefined;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(receivedAt));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const offset = get("timeZoneName");
  const zoneLabel =
    timeZone === "Asia/Tokyo"
      ? `JST (${offset ?? "GMT+9"})`
      : `${timeZone}${offset ? ` (${offset})` : ""}`;
  return `${get("weekday")}, ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${get("dayPeriod")} ${zoneLabel}`;
}

function humanSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return undefined;
  }
  if (bytes < 1_000) {
    return `${Math.floor(bytes)}B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = "B";
  for (const candidate of units) {
    value /= 1_000;
    unit = candidate;
    if (value < 1_000) {
      break;
    }
  }
  return `${Number(value.toFixed(value >= 10 ? 0 : 1))}${unit}`;
}

function conversationMetadata(conversation: HumanInboundConversation): Record<string, unknown> {
  return cleanRecord([
    ["channel", conversation.channel],
    ["conversation_type", conversation.conversationType],
    ["conversation_name", conversation.conversationName],
    ["conversation_label", conversation.conversationLabel],
    [
      "conversation_members",
      conversation.conversationMembers
        ?.map((member) => `${member.brodie ? "(brodie) " : ""}${member.label}`)
        .join(", "),
    ],
    ["session_key", conversation.sessionKey],
    ["guild_name", conversation.guild?.name],
    ["guild_id", conversation.guild?.id],
    ["channel_name", conversation.nativeChannel?.name],
    ["channel_id", conversation.nativeChannel?.id],
    ["parent_channel_name", conversation.parentChannel?.name],
    ["parent_channel_id", conversation.parentChannel?.id],
    ["thread_name", conversation.thread?.name],
    ["thread_id", conversation.thread?.id],
    ["topic_name", conversation.topic?.name],
    ["topic_id", conversation.topic?.id],
    ["chat_id", conversation.chatId],
  ]);
}

function messageMetadata(inbound: HumanInbound): Record<string, unknown> {
  return cleanRecord([
    ["sender", inbound.sender.label],
    ["sender_id", inbound.sender.id],
    ["sender_username", inbound.sender.username],
    ["message_id", inbound.messageId],
    ["timestamp", inbound.timestamp],
    ["inbound_event_kind", inbound.inboundEventKind],
    ["was_mentioned", inbound.wasMentioned],
    ["has_quote_reply_context", inbound.quote ? true : undefined],
    ["has_forwarded_context", inbound.forward ? true : undefined],
    ["has_location", inbound.location ? true : undefined],
    ["has_media", inbound.media.length > 0 ? true : undefined],
    ["event_type", inbound.eventType],
    ["reaction", inbound.reaction],
    ["quote_position", inbound.quotePosition],
    ["member_role_ids", inbound.sender.memberRoleIds],
  ]);
}

function quoteMetadata(quote: NonNullable<HumanInbound["quote"]>): Record<string, unknown> {
  return cleanRecord([
    ["sender", quote.sender],
    ["sender_id", quote.senderId],
    ["message_id", quote.messageId],
    ["timestamp", quote.timestamp],
    ["body", quote.body],
    ["quote_text", quote.quoteText],
    ["has_media", quote.media && quote.media.length > 0 ? true : undefined],
  ]);
}

function forwardMetadata(forward: NonNullable<HumanInbound["forward"]>): Record<string, unknown> {
  return cleanRecord([
    ["forwarded_from", forward.forwardedFrom],
    ["forwarded_from_id", forward.forwardedFromId],
    ["forwarded_from_username", forward.forwardedFromUsername],
    ["forwarded_at", forward.forwardedAt],
  ]);
}

function locationMetadata(
  location: NonNullable<HumanInbound["location"]>,
): Record<string, unknown> {
  return cleanRecord([
    ["latitude", location.latitude],
    ["longitude", location.longitude],
    ["accuracy_m", location.accuracyM],
    ["name", location.name],
    ["address", location.address],
    ["caption", location.caption],
  ]);
}

function mediaMetadata(media: HumanInboundMedia): Record<string, unknown> {
  return cleanRecord([
    ["kind", media.kind],
    ["type", media.mimeType],
    ["size", humanSize(media.sizeBytes)],
    ["source_message_id", media.sourceMessageId],
    ["source_index", media.sourceIndex],
    ["media_reference", media.mediaRef],
    ["media_local_path", media.managedLocalPath],
    ["file_name", media.fileName],
    ["caption", media.caption],
    ["external_file_marker", media.externalFileMarker],
    [
      "native_image_input",
      media.nativeImageCandidate
        ? "provider_image_block"
        : media.nativeImageOmission
          ? `omitted_${media.nativeImageOmission.reason}`
          : undefined,
    ],
  ]);
}

function renderMedia(params: {
  media: HumanInboundMedia[];
  label?: string;
  nextUnderstandingIndex: () => number;
}): string[] {
  const { media } = params;
  if (media.length === 0) {
    return [];
  }
  const blocks = [params.label ?? "Message Media:", renderJson(media.map(mediaMetadata))];
  for (const entry of media) {
    if (entry.nativeImageCandidate) {
      blocks.push(
        "Native Image Input:",
        renderJson({
          source_message_id: entry.sourceMessageId,
          source_index: entry.sourceIndex,
          media_reference: entry.mediaRef,
          content_hash: entry.nativeImageCandidate.contentHash,
          status: "attached_as_next_provider_content_block",
        }),
      );
    } else if (entry.nativeImageOmission) {
      blocks.push(
        "Native Image Omission:",
        renderJson({
          source_message_id: entry.sourceMessageId,
          source_index: entry.sourceIndex,
          media_reference: entry.mediaRef,
          reason: entry.nativeImageOmission.reason,
        }),
      );
    }
    for (const understanding of entry.understanding) {
      blocks.push(
        `Media Understanding #${params.nextUnderstandingIndex()} (${DERIVED_MEDIA_TRUST_LABEL}):`,
        renderJson(
          cleanRecord([
            ["kind", understanding.kind],
            ["source_message_id", entry.sourceMessageId],
            ["source_index", entry.sourceIndex],
            ["provider", understanding.provider],
            ["model", understanding.model],
            ["trust", understanding.trust],
          ]),
        ),
        "Derived Output:",
        renderTextFence(understanding.text),
      );
    }
  }
  return blocks;
}

export function materializeHumanInboundBatch(params: {
  route: ConversationRoute;
  placement: HumanInboundBatch["placement"];
  payloads: HumanInboundEventPayload[];
  recovery?: HumanInboundBatch["recovery"];
  timeZone?: string;
}): HumanInboundBatch {
  const first = params.payloads[0];
  if (!first) {
    throw new Error("human inbound batch requires at least one source event");
  }
  for (const payload of params.payloads) {
    if (
      payload.sessionKey !== params.route.sessionKey ||
      payload.conversation.sessionKey !== params.route.sessionKey ||
      payload.channel !== first.channel ||
      payload.accountId !== first.accountId ||
      payload.conversationId !== first.conversationId
    ) {
      throw new Error("human inbound batch crossed a conversation boundary");
    }
  }
  return {
    version: 1,
    placement: params.placement,
    route: params.route,
    conversation: first.conversation,
    inbounds: params.payloads.map((payload) => ({
      sourceEventId: payload.messageId,
      sender: {
        label:
          payload.sender.name ??
          payload.sender.displayName ??
          payload.sender.username ??
          payload.sender.id,
        id: payload.sender.id,
        ...(payload.sender.username ? { username: payload.sender.username } : {}),
        ...(payload.sender.displayName ? { displayName: payload.sender.displayName } : {}),
        ...(payload.sender.nativeId ? { nativeId: payload.sender.nativeId } : {}),
        ...(payload.sender.roles ? { memberRoleIds: payload.sender.roles } : {}),
        ...(payload.sender.bot !== undefined ? { bot: payload.sender.bot } : {}),
      },
      messageId: payload.messageId,
      timestamp: formatTimestamp(payload.receivedAt, params.timeZone ?? "Asia/Tokyo"),
      ...(payload.inboundEventKind ? { inboundEventKind: payload.inboundEventKind } : {}),
      ...(payload.eventType ? { eventType: payload.eventType } : {}),
      ...(payload.reaction !== undefined ? { reaction: payload.reaction } : {}),
      ...(payload.quotePosition !== undefined ? { quotePosition: payload.quotePosition } : {}),
      ...(payload.wasMentioned !== undefined ? { wasMentioned: payload.wasMentioned } : {}),
      ...(payload.body !== undefined ? { authoredBody: payload.body } : {}),
      ...(payload.bodyForAgent !== undefined ? { bodyForAgent: payload.bodyForAgent } : {}),
      ...(payload.quote ? { quote: payload.quote } : {}),
      ...(payload.forward ? { forward: payload.forward } : {}),
      ...(payload.location ? { location: payload.location } : {}),
      media: payload.media,
      nativeMetadata: payload.nativeMetadata,
    })),
    ...(params.recovery ? { recovery: params.recovery } : {}),
  };
}

type DerivedMediaOutput = {
  kind: HumanInboundUnderstanding["kind"];
  attachmentIndex: number;
  text: string;
  provider: string;
  model?: string;
};

type ManagedExternalFile = {
  marker?: string;
  attachmentIndex: number;
  mediaRef?: string;
  originalPath?: string;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  sourceMessageId?: string;
  sourceIndex?: number;
  contentHash?: string;
  mediaUnderstanding?: Array<{
    kind: string;
    text: string;
    provider?: string;
    model?: string;
  }>;
};

/** Enriches the typed batch without allowing derived text into authored fields. */
export function attachHumanInboundMediaUnderstanding(params: {
  batch: HumanInboundBatch;
  outputs: DerivedMediaOutput[];
  externalFiles?: ManagedExternalFile[];
}): HumanInboundBatch {
  const inbounds = params.batch.inbounds.map((inbound) => ({
    ...inbound,
    ...(inbound.quote?.media
      ? {
          quote: {
            ...inbound.quote,
            media: inbound.quote.media.map((media) => ({
              ...media,
              understanding: [...media.understanding],
            })),
          },
        }
      : {}),
    media: inbound.media.map((media) => ({
      ...media,
      understanding: [...media.understanding],
    })),
  }));
  const flattened = inbounds.flatMap((inbound) => [
    ...(inbound.quote?.media ?? []),
    ...inbound.media,
  ]);
  const append = (
    media: HumanInboundMedia,
    output: Omit<DerivedMediaOutput, "attachmentIndex">,
  ) => {
    if (
      media.understanding.some(
        (existing) =>
          existing.kind === output.kind &&
          existing.provider === output.provider &&
          existing.model === output.model &&
          existing.text === output.text,
      )
    ) {
      return;
    }
    media.understanding.push({
      kind: output.kind,
      text: output.text,
      provider: output.provider,
      ...(output.model ? { model: output.model } : {}),
      trust: "derived_untrusted",
    });
  };
  for (const output of params.outputs) {
    const media = flattened[output.attachmentIndex];
    if (media) {
      append(media, output);
    }
  }
  for (const file of params.externalFiles ?? []) {
    const media =
      flattened.find(
        (candidate) =>
          file.sourceMessageId !== undefined &&
          candidate.sourceMessageId === file.sourceMessageId &&
          candidate.sourceIndex === file.sourceIndex,
      ) ?? flattened[file.attachmentIndex];
    if (!media) {
      continue;
    }
    if (file.mediaRef) {
      media.mediaRef = file.mediaRef;
    }
    if (file.originalPath) {
      media.managedLocalPath = file.originalPath;
    }
    if (file.fileName) {
      media.fileName = file.fileName;
    }
    if (file.mimeType) {
      media.mimeType = file.mimeType;
    }
    if (file.byteSize !== undefined) {
      media.sizeBytes = file.byteSize;
    }
    if (file.marker) {
      media.externalFileMarker = file.marker;
    }
    for (const output of file.mediaUnderstanding ?? []) {
      if (
        output.kind === "image.description" ||
        output.kind === "audio.transcription" ||
        output.kind === "video.description" ||
        output.kind === "file.extraction"
      ) {
        append(media, {
          kind: output.kind,
          text: output.text,
          provider: output.provider ?? "openclaw",
          ...(output.model ? { model: output.model } : {}),
        });
      }
    }
  }
  return { ...params.batch, inbounds };
}

export function attachHumanInboundNativeImageInputs(params: {
  batch: HumanInboundBatch;
  inputs: Array<{
    attachmentIndex: number;
    sourceMessageId?: string;
    sourceIndex?: number;
    contentHash: string;
  }>;
  omissions?: Array<{
    attachmentIndex: number;
    sourceMessageId?: string;
    sourceIndex?: number;
    reason: "policy_ceiling" | "model_not_image_capable";
  }>;
}): HumanInboundBatch {
  const inbounds = params.batch.inbounds.map((inbound) => ({
    ...inbound,
    ...(inbound.quote?.media
      ? {
          quote: {
            ...inbound.quote,
            media: inbound.quote.media.map((media) => ({ ...media })),
          },
        }
      : {}),
    media: inbound.media.map((media) => ({ ...media })),
  }));
  const flattened = inbounds.flatMap((inbound) => [
    ...(inbound.quote?.media ?? []),
    ...inbound.media,
  ]);
  const resolveMedia = (identity: {
    attachmentIndex: number;
    sourceMessageId?: string;
    sourceIndex?: number;
  }) =>
    (identity.sourceMessageId !== undefined && identity.sourceIndex !== undefined
      ? flattened.find(
          (media) =>
            media.sourceMessageId === identity.sourceMessageId &&
            media.sourceIndex === identity.sourceIndex,
        )
      : undefined) ?? flattened[identity.attachmentIndex];
  for (const input of params.inputs) {
    const media = resolveMedia(input);
    if (media?.kind === "image") {
      media.nativeImageCandidate = { contentHash: input.contentHash };
      delete media.nativeImageOmission;
    }
  }
  for (const omission of params.omissions ?? []) {
    const media = resolveMedia(omission);
    if (media?.kind === "image") {
      delete media.nativeImageCandidate;
      media.nativeImageOmission = { reason: omission.reason };
    }
  }
  return { ...params.batch, inbounds };
}

export function renderHumanInboundBatch(batch: HumanInboundBatch): string {
  const copy = PLACEMENT_COPY[batch.placement];
  const lines = [
    `[📋 QUEUE ENGINE]: [${batch.inbounds.length === 1 ? copy.singular : copy.plural}]`,
    "",
    "[Conversation Metadata]:",
    renderJson(conversationMetadata(batch.conversation)),
    "[📨 DELIVERY-REMINDER]: the room only sees what you pass in 'visibleMessages' via the message tool, so don't yap in there",
  ];
  if (batch.recovery) {
    lines.push(
      "",
      "[Failed Run Recovery]:",
      renderJson({
        failed_outcome: batch.recovery.failedOutcome,
        committed_receipt_ids: batch.recovery.committedReceiptIds,
      }),
    );
  }
  for (const [index, inbound] of batch.inbounds.entries()) {
    let understandingIndex = 0;
    const nextUnderstandingIndex = () => (understandingIndex += 1);
    lines.push("", `[Inbound #${index + 1}]: [${inbound.sender.label}]`);
    if (inbound.inboundEventKind === "room_event") {
      lines.push("[ROOM EVENT]");
      if (inbound.wasMentioned === false) {
        lines.push("[NOT MENTIONED]");
      }
    }
    lines.push("Message Metadata:", renderJson(messageMetadata(inbound)));
    if (inbound.quote) {
      lines.push("Quote Replied Message:", renderJson(quoteMetadata(inbound.quote)));
      if (inbound.quote.media) {
        lines.push(
          ...renderMedia({
            media: inbound.quote.media,
            label: "Quoted Message Media:",
            nextUnderstandingIndex,
          }),
        );
      }
    }
    if (inbound.forward) {
      lines.push("Forwarded Message Metadata:", renderJson(forwardMetadata(inbound.forward)));
    }
    if (inbound.location) {
      lines.push("Location:", renderJson(locationMetadata(inbound.location)));
    }
    lines.push(...renderMedia({ media: inbound.media, nextUnderstandingIndex }));
    if (inbound.bodyForAgent === undefined || inbound.bodyForAgent.length === 0) {
      if (inbound.eventType === "sticker") {
        lines.push("Message Body:", renderTextFence("[sent a sticker]"));
      } else if (inbound.eventType === "deleted") {
        lines.push("Message Body:", renderTextFence("[message was deleted]"));
      } else if (inbound.eventType !== "reaction") {
        lines.push("Message Body: [EMPTY]");
      }
    } else {
      lines.push("Message Body:", renderTextFence(inbound.bodyForAgent));
    }
  }
  return lines.join("\n");
}
