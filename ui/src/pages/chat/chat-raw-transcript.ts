import { html, nothing, type TemplateResult } from "lit";
import { handleMarkdownCodeBlockCopy } from "../../components/markdown.ts";
import { t } from "../../i18n/index.ts";
import type { RealtimeTalkConversationEntry } from "./realtime-talk-conversation.ts";

type UnknownRecord = Record<string, unknown>;
const MAX_HIGHLIGHT_TOOL_ARGUMENT_CHARS = 64 * 1024;

export type RawTranscriptFullMessageResult = {
  ok?: boolean;
  message?: unknown;
  seq?: number;
  unavailableReason?: "not_found" | "oversized" | "not_visible";
};

export type LoadRawTranscriptFullMessage = (
  seq: number,
  expectedSha256?: string,
) => Promise<RawTranscriptFullMessageResult | null | undefined>;

export type RawTranscriptOptions = {
  loadFullMessage?: LoadRawTranscriptFullMessage;
  onScroll?: (event: Event) => void;
  onContextMenu?: (event: MouseEvent) => void;
  loading?: boolean;
  stream?: string | null;
  canAbort?: boolean;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
};

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    const record = asRecord(value);
    return readString(record?.text ?? record?.content ?? record?.message);
  }
  const parts = value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      const record = asRecord(entry);
      return readString(record?.text ?? record?.content ?? record?.message);
    })
    .filter((entry): entry is string => entry !== undefined);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function readSourceRecord(record: UnknownRecord): UnknownRecord | undefined {
  const direct = asRecord(
    record.openclawSourceMessage ?? record.sourceMessage ?? record.authoredMessage,
  );
  const metadata = asRecord(record["__openclaw"]);
  const nested = asRecord(metadata?.sourceMessage ?? metadata?.authoredMessage ?? metadata?.source);
  return direct ?? nested;
}

type AuthoredInboundMessage = {
  sender: string;
  senderId?: string;
  messageId?: string;
  timestamp?: string;
  channel?: string;
  text: string;
  quoteCount: number;
  mediaCount: number;
};

type CapturedModelInputItem =
  | {
      kind: "current-user";
      content: string;
    }
  | {
      kind: "runtime-context";
      placement: "tail";
      content: string;
    };

function readCapturedModelInputItems(
  metadata: UnknownRecord | undefined,
): CapturedModelInputItem[] {
  const snapshot = asRecord(metadata?.modelInput);
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.items)) {
    return [];
  }
  const items: CapturedModelInputItem[] = [];
  for (const value of snapshot.items) {
    const item = asRecord(value);
    const content = readString(item?.content);
    if (!item || !content || item.role !== "user") {
      continue;
    }
    if (item.kind === "current-user") {
      items.push({ kind: "current-user", content });
      continue;
    }
    if (item.kind === "runtime-context" && item.placement === "tail") {
      items.push({ kind: "runtime-context", placement: "tail", content });
    }
  }
  return items;
}

function readAuthoredInboundMessages(record: UnknownRecord): AuthoredInboundMessage[] {
  const metadata = asRecord(record["__openclaw"]);
  const batch = asRecord(metadata?.humanInboundBatch);
  const conversation = asRecord(batch?.conversation);
  const inbounds = Array.isArray(batch?.inbounds) ? batch.inbounds : [];
  const authored = inbounds.flatMap((value) => {
    const inbound = asRecord(value);
    const sender = asRecord(inbound?.sender);
    if (!inbound) {
      return [];
    }
    const text = typeof inbound.authoredBody === "string" ? inbound.authoredBody : "";
    return [
      {
        sender:
          readString(sender?.label ?? sender?.displayName ?? sender?.username ?? sender?.id) ??
          "unknown sender",
        senderId: readString(sender?.id),
        messageId: readString(inbound.messageId),
        timestamp: readString(inbound.timestamp),
        channel: readString(conversation?.channel),
        text,
        quoteCount: inbound.quote ? 1 : 0,
        mediaCount: Array.isArray(inbound.media) ? inbound.media.length : 0,
      },
    ];
  });
  if (authored.length > 0) {
    return authored;
  }
  const source = readSourceRecord(record);
  const text = readText(source);
  if (!text) {
    return [];
  }
  const sender = asRecord(source?.sender);
  const sourceSender =
    readString(
      source?.senderLabel ??
        source?.senderName ??
        sender?.label ??
        sender?.displayName ??
        sender?.username ??
        source?.senderId ??
        sender?.id,
    ) ?? "unknown sender";
  return [
    {
      sender: sourceSender,
      senderId: readString(source?.senderId ?? sender?.id),
      messageId: readString(source?.messageId ?? source?.id),
      timestamp: readString(source?.timestamp),
      channel: readString(source?.channel),
      text,
      quoteCount: source?.quote ? 1 : 0,
      mediaCount: Array.isArray(source?.media) ? source.media.length : 0,
    },
  ];
}

function readToolArguments(block: UnknownRecord): unknown {
  const value = block.arguments ?? block.input ?? block.parameters ?? block.args;
  if (typeof value !== "string" || value.length > MAX_HIGHLIGHT_TOOL_ARGUMENT_CHARS) {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function prettyDisclosureValue(value: unknown): string {
  if (typeof value === "string") {
    try {
      return prettyJson(JSON.parse(value) as unknown);
    } catch {
      return value;
    }
  }
  return prettyJson(value);
}

function populateLazyJson(event: Event, value: unknown): void {
  const details = event.currentTarget;
  if (
    !(details instanceof HTMLDetailsElement) ||
    !details.open ||
    details.dataset.loaded === "true"
  ) {
    return;
  }
  const output = details.querySelector("pre");
  if (!output) {
    return;
  }
  output.textContent = prettyDisclosureValue(value);
  details.dataset.loaded = "true";
}

async function populateLazyFullRow(
  event: Event,
  seq: number,
  expectedSha256: string | undefined,
  loadFullMessage: LoadRawTranscriptFullMessage,
): Promise<void> {
  const details = event.currentTarget;
  if (
    !(details instanceof HTMLDetailsElement) ||
    !details.open ||
    details.dataset.loaded === "true" ||
    details.dataset.loading === "true"
  ) {
    return;
  }
  const output = details.querySelector("pre");
  if (!output) {
    return;
  }
  details.dataset.loading = "true";
  output.textContent = "loading full persisted row…";
  try {
    const result = await loadFullMessage(seq, expectedSha256);
    if (result?.ok && result.message !== undefined) {
      output.textContent = prettyDisclosureValue(result.message);
    } else {
      const reason = result?.unavailableReason ?? "not_found";
      output.textContent = `full persisted row unavailable (${reason})`;
    }
  } catch (error) {
    output.textContent = `failed to load full persisted row: ${
      error instanceof Error ? error.message : String(error)
    }`;
  } finally {
    delete details.dataset.loading;
    details.dataset.loaded = "true";
  }
}

function renderLazyJsonDetails(params: {
  className: string;
  summary: string;
  value: unknown;
}): TemplateResult {
  return html`
    <details
      class=${params.className}
      @toggle=${(event: Event) => populateLazyJson(event, params.value)}
    >
      <summary>${params.summary}</summary>
      <pre></pre>
    </details>
  `;
}

function isDeferredTranscriptRow(record: UnknownRecord): boolean {
  const metadata = asRecord(record["__openclaw"]);
  return asRecord(metadata?.deferredTranscriptRow)?.reason === "oversized";
}

function renderExactJson(
  record: UnknownRecord,
  seq: number,
  loadFullMessage?: LoadRawTranscriptFullMessage,
): TemplateResult {
  if (isDeferredTranscriptRow(record) && loadFullMessage) {
    const deferredRow = asRecord(asRecord(record["__openclaw"])?.deferredTranscriptRow);
    const expectedSha256 = readString(deferredRow?.sha256);
    return html`
      <details
        class="chat-raw-exact-json"
        data-full-row-seq=${seq}
        @toggle=${(event: Event) =>
          void populateLazyFullRow(event, seq, expectedSha256, loadFullMessage)}
      >
        <summary>${t("chat.transcript.exactPersistedRow")}</summary>
        <pre></pre>
      </details>
    `;
  }
  return renderLazyJsonDetails({
    className: "chat-raw-exact-json",
    summary: t("chat.transcript.exactPersistedRow"),
    value: record,
  });
}

function renderTextBlock(kind: string, label: string, text: string): TemplateResult {
  return html`
    <section class="chat-raw-block chat-raw-block--${kind}" data-block-kind=${kind}>
      <div class="chat-raw-block__label">${label}</div>
      <div class="chat-raw-block__text">${text}</div>
    </section>
  `;
}

function renderVisibleMessages(value: unknown): TemplateResult | typeof nothing {
  const messages = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const texts = messages
    .map((message) => readText(message))
    .filter((message): message is string => message !== undefined);
  if (texts.length === 0) {
    return nothing;
  }
  return html`${texts.map((text, index) =>
    renderTextBlock(
      "visible-message",
      texts.length === 1 ? "visible message" : `visible message ${index + 1}`,
      text,
    ),
  )}`;
}

function renderHumanInboundMedia(record: UnknownRecord): TemplateResult | typeof nothing {
  const metadata = asRecord(record["__openclaw"]);
  const batch = asRecord(metadata?.humanInboundBatch);
  const inbounds = Array.isArray(batch?.inbounds) ? batch.inbounds : [];
  const blocks: TemplateResult[] = [];
  const appendMedia = (mediaItems: unknown[], source: string[]) => {
    for (const mediaValue of mediaItems) {
      const media = asRecord(mediaValue);
      if (!media) {
        continue;
      }
      const nativeImage = asRecord(media.nativeImageCandidate);
      const nativeImageOmission = asRecord(media.nativeImageOmission);
      if (nativeImage) {
        const details = [
          source.length > 0 ? `source: ${source.join(" · ")}` : undefined,
          readString(media.mimeType),
          readString(media.mediaRef),
          readString(nativeImage.contentHash),
        ].filter((value): value is string => value !== undefined);
        blocks.push(renderTextBlock("native-image", "native image · attached", details.join("\n")));
      } else if (nativeImageOmission) {
        blocks.push(
          renderTextBlock(
            "native-image-omitted",
            "native image · omitted",
            [
              source.length > 0 ? `source: ${source.join(" · ")}` : undefined,
              readString(nativeImageOmission.reason),
              readString(media.mediaRef),
            ]
              .filter((value): value is string => value !== undefined)
              .join("\n"),
          ),
        );
      }
      const understandings = Array.isArray(media.understanding) ? media.understanding : [];
      for (const understandingValue of understandings) {
        const understanding = asRecord(understandingValue);
        const text = readString(understanding?.text);
        if (!understanding || !text) {
          continue;
        }
        const provider = [
          readString(understanding.provider),
          readString(understanding.model),
        ].filter((value): value is string => value !== undefined);
        const details = [
          provider.length > 0 ? provider.join(" / ") : undefined,
          source.length > 0 ? `source: ${source.join(" · ")}` : undefined,
          text,
        ].filter((value): value is string => value !== undefined);
        blocks.push(
          renderTextBlock(
            "derived-media",
            "derived · untrusted · may be wrong",
            details.join("\n"),
          ),
        );
      }
    }
  };
  for (const inboundValue of inbounds) {
    const inbound = asRecord(inboundValue);
    if (!inbound) {
      continue;
    }
    const sender = asRecord(inbound.sender);
    const source = [readString(sender?.label), readString(inbound.messageId)].filter(
      (value): value is string => value !== undefined,
    );
    const quote = asRecord(inbound.quote);
    if (quote) {
      appendMedia(
        Array.isArray(quote.media) ? quote.media : [],
        [readString(quote.sender), readString(quote.messageId)].filter(
          (value): value is string => value !== undefined,
        ),
      );
    }
    appendMedia(Array.isArray(inbound.media) ? inbound.media : [], source);
  }
  return blocks.length > 0 ? html`${blocks}` : nothing;
}

function renderToolCall(block: UnknownRecord): TemplateResult {
  const name = readString(block.name ?? block.toolName) ?? "tool";
  const args = readToolArguments(block);
  const action = asRecord(args);
  const actionName = readString(action?.action);
  const invisibleThinking = readString(action?.invisibleThinking);
  const legacyDecisionNote = readString(action?.decisionNote);
  return html`
    ${invisibleThinking
      ? renderTextBlock("invisible-thinking", "private thought", invisibleThinking)
      : nothing}
    ${legacyDecisionNote
      ? renderTextBlock("legacy-decision-note", "legacy action rationale", legacyDecisionNote)
      : nothing}
    ${renderVisibleMessages(action?.visibleMessages)}
    <section class="chat-raw-block chat-raw-block--tool" data-block-kind="tool-call">
      <div class="chat-raw-block__label">${t("chat.transcript.toolCall")}</div>
      <div class="chat-raw-tool__name">${actionName ? `${name} · ${actionName}` : name}</div>
      ${args === undefined
        ? nothing
        : renderLazyJsonDetails({
            className: "chat-raw-tool__payload",
            summary: t("chat.transcript.toolInput"),
            value: args,
          })}
    </section>
  `;
}

function renderAssistantContent(content: unknown): TemplateResult {
  if (typeof content === "string") {
    return html`${renderTextBlock("assistant-text", "assistant text", content)}`;
  }
  if (!Array.isArray(content)) {
    return html`${renderLazyJsonDetails({
      className: "chat-raw-block chat-raw-block--assistant",
      summary: "assistant event",
      value: content,
    })}`;
  }
  return html`${content.map((value) => {
    const block = asRecord(value);
    if (!block) {
      return renderTextBlock("assistant", "assistant event", String(value));
    }
    const type = readString(block.type)?.toLowerCase().replace(/[_-]/g, "") ?? "";
    if (type === "thinking" || type === "reasoning" || type === "redactedthinking") {
      const text = readString(block.thinking ?? block.reasoning ?? block.text ?? block.content);
      return text
        ? renderTextBlock("thinking", "model thinking", text)
        : renderTextBlock("thinking", "model thinking", "redacted");
    }
    if (type === "toolcall" || type === "tooluse" || type === "functioncall") {
      return renderToolCall(block);
    }
    if (type === "text" || type === "outputtext") {
      const text = readString(block.text ?? block.content);
      return text
        ? renderTextBlock("assistant-text", "assistant text", text)
        : renderLazyJsonDetails({
            className: "chat-raw-block chat-raw-block--assistant",
            summary: "assistant event",
            value: block,
          });
    }
    return renderLazyJsonDetails({
      className: "chat-raw-block chat-raw-block--assistant",
      summary: readString(block.type) ?? "assistant event",
      value: block,
    });
  })}`;
}

function renderInbound(record: UnknownRecord): TemplateResult {
  const authored = readAuthoredInboundMessages(record);
  const persistedInput = readText(record.content ?? record.text ?? record.message) ?? "";
  const metadata = asRecord(record["__openclaw"]);
  const modelInputItems = readCapturedModelInputItems(metadata);
  const batch = asRecord(metadata?.humanInboundBatch);
  const placement = readString(batch?.placement ?? metadata?.placement) ?? "conversation";
  const mediaCount = authored.reduce((total, inbound) => total + inbound.mediaCount, 0);
  const persistedSummary = [
    t("chat.transcript.persistedInboundEnvelope"),
    placement,
    `${authored.length} source${authored.length === 1 ? "" : "s"}`,
    authored.length > 0 ? authored.map((inbound) => inbound.sender).join(", ") : undefined,
    mediaCount > 0 ? `${mediaCount} media` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  return html`
    ${authored.map(
      ({
        sender,
        senderId,
        messageId,
        timestamp,
        channel,
        text,
        quoteCount,
        mediaCount: sourceMediaCount,
      }) => html`<section
        class="chat-raw-event__source"
        data-message-id=${messageId ?? ""}
        data-message-text=${text}
      >
        <div class="chat-raw-block__label">
          ${t("chat.transcript.authoredMessage")} · <span class="chat-sender-name">${sender}</span>
        </div>
        <div class="chat-raw-event__source-meta">
          ${[
            senderId ? `sender ${senderId}` : undefined,
            channel,
            timestamp,
            messageId ? `message ${messageId}` : undefined,
            quoteCount > 0 ? "quoted context" : undefined,
            sourceMediaCount > 0 ? `${sourceMediaCount} media` : undefined,
          ]
            .filter((value): value is string => value !== undefined)
            .join(" · ")}
        </div>
        <div class="chat-raw-block__text">${text}</div>
      </section>`,
    )}
    ${renderHumanInboundMedia(record)}
    <details class="chat-raw-event__persisted-input">
      <summary>${persistedSummary}</summary>
      <pre>${persistedInput}</pre>
    </details>
    ${modelInputItems.length > 0
      ? html`<details class="chat-raw-event__model-input">
          <summary>
            ${t("chat.transcript.capturedCurrentTurnTextInput", {
              count: String(modelInputItems.length),
            })}
          </summary>
          ${modelInputItems.map(
            (item) => html`<section class="chat-raw-event__model-input-item">
              <div class="chat-raw-block__label">
                ${item.kind === "runtime-context"
                  ? t("chat.transcript.runtimeContext")
                  : t("chat.transcript.currentUser")}
                ·
                ${item.kind === "runtime-context"
                  ? t("chat.transcript.tailUserItem")
                  : t("chat.transcript.userItem")}
              </div>
              <pre>${item.content}</pre>
            </section>`,
          )}
        </details>`
      : nothing}
  `;
}

function toolResultSummary(resultValue: unknown): string[] {
  const text = readText(resultValue);
  if (!text || text.length > MAX_HIGHLIGHT_TOOL_ARGUMENT_CHARS) {
    return [];
  }
  let parsed: UnknownRecord | undefined;
  try {
    parsed = asRecord(JSON.parse(text) as unknown);
  } catch {
    return [];
  }
  if (!parsed) {
    return [];
  }
  const authoredMessages = Array.isArray(parsed.authoredMessages) ? parsed.authoredMessages : [];
  const legacyBubbles = Array.isArray(parsed.bubbles) ? parsed.bubbles : [];
  const authoredReceipts = authoredMessages.flatMap((entry) => {
    const authored = asRecord(entry);
    return authored && Array.isArray(authored.bubbles) ? authored.bubbles : [];
  });
  const bubbles = authoredReceipts.length > 0 ? authoredReceipts : legacyBubbles;
  const bubbleRecords = bubbles.flatMap((entry) => {
    const bubble = asRecord(entry);
    return bubble ? [bubble] : [];
  });
  const receiptCount = bubbleRecords.filter((bubble) =>
    readString(bubble.messageId ?? bubble.id),
  ).length;
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];
  return [
    readString(parsed.status ?? parsed.outcome ?? parsed.conversationOutcome),
    authoredMessages.length > 0 ? `${authoredMessages.length} authored` : undefined,
    bubbles.length > 0 ? `${bubbles.length} bubble${bubbles.length === 1 ? "" : "s"}` : undefined,
    receiptCount > 0 ? `${receiptCount} receipt${receiptCount === 1 ? "" : "s"}` : undefined,
    parsed.reaction || parsed.status === "reacted" ? "reaction" : undefined,
    (parsed.quote ?? parsed.quoted ?? bubbleRecords.some((bubble) => bubble.quoted === true))
      ? "quoted"
      : undefined,
    warnings.length > 0
      ? `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`
      : undefined,
    parsed.error || parsed.failure ? "failed" : undefined,
  ].filter((entry): entry is string => entry !== undefined);
}

function renderToolResult(record: UnknownRecord): TemplateResult {
  const name = readString(record.toolName ?? record.name) ?? "tool";
  const value = record.content ?? record.result ?? record.output;
  const summary = toolResultSummary(value);
  return renderLazyJsonDetails({
    className: "chat-raw-block chat-raw-block--tool-result",
    summary: [t("chat.transcript.toolResult"), name, ...summary].join(" · "),
    value,
  });
}

function eventKind(record: UnknownRecord): "inbound" | "assistant" | "tool-result" | "event" {
  const role = readString(record.role)?.toLowerCase().replace(/[_-]/g, "");
  if (role === "user") {
    return "inbound";
  }
  if (role === "assistant") {
    return "assistant";
  }
  if (role === "tool" || role === "toolresult" || role === "function") {
    return "tool-result";
  }
  return "event";
}

function eventLabel(kind: ReturnType<typeof eventKind>): string {
  switch (kind) {
    case "inbound":
      return "inbound message";
    case "assistant":
      return "brodie";
    case "tool-result":
      return "tool result";
    default:
      return "runtime event";
  }
}

function renderRawEvent(
  message: unknown,
  index: number,
  loadFullMessage?: LoadRawTranscriptFullMessage,
): TemplateResult | typeof nothing {
  const record = asRecord(message);
  if (!record) {
    return nothing;
  }
  const metadata = asRecord(record["__openclaw"]);
  const seq = typeof metadata?.seq === "number" ? metadata.seq : index + 1;
  const kind = eventKind(record);
  const deferredRow = asRecord(metadata?.deferredTranscriptRow);
  const deferredByteLength =
    typeof deferredRow?.byteLength === "number" ? deferredRow.byteLength : "unknown";
  return html`
    <article class="chat-raw-event chat-raw-event--${kind}" data-event-kind=${kind} data-seq=${seq}>
      <header class="chat-raw-event__header">
        <span>${eventLabel(kind)}</span>
        <span class="chat-raw-event__seq">#${seq}</span>
      </header>
      <div class="chat-raw-event__body">
        ${deferredRow
          ? renderTextBlock(
              "deferred-row",
              "persisted event · load on demand",
              `${deferredByteLength} bytes`,
            )
          : kind === "inbound"
            ? renderInbound(record)
            : kind === "assistant"
              ? renderAssistantContent(record.content ?? record.text)
              : kind === "tool-result"
                ? renderToolResult(record)
                : renderLazyJsonDetails({
                    className: "chat-raw-block chat-raw-block--event",
                    summary: "runtime event",
                    value: record,
                  })}
      </div>
      ${renderExactJson(record, seq, loadFullMessage)}
    </article>
  `;
}

export function renderRawTranscript(
  messages: unknown[],
  options: RawTranscriptOptions = {},
): TemplateResult {
  const showLoading = options.loading === true && messages.length === 0 && options.stream == null;
  const stream = options.stream ?? null;
  return html`
    <div
      class="chat-thread chat-raw-transcript"
      data-testid="chat-raw-transcript"
      role="log"
      aria-live="polite"
      @scroll=${options.onScroll}
      @click=${handleMarkdownCodeBlockCopy}
      @contextmenu=${options.onContextMenu}
    >
      <div class="chat-thread-inner">
        ${showLoading
          ? html`<div class="chat-loading-skeleton" aria-label="Loading chat">
              <div class="skeleton skeleton-line skeleton-line--long"></div>
              <div class="skeleton skeleton-line skeleton-line--medium"></div>
              <div class="skeleton skeleton-line skeleton-line--short"></div>
            </div>`
          : nothing}
        ${messages.map((message, index) => renderRawEvent(message, index, options.loadFullMessage))}
        ${stream !== null && stream.length > 0
          ? html`<article class="chat-raw-event chat-raw-event--assistant chat-stream">
              <header class="chat-raw-event__header"><span>brodie · live</span></header>
              <div class="chat-raw-event__body">
                ${renderTextBlock("assistant-text", "assistant stream", stream)}
              </div>
            </article>`
          : stream === "" && !showLoading
            ? html`<div class="chat-reading-indicator" aria-label="Assistant is working"></div>`
            : nothing}
        ${(options.realtimeTalkConversation ?? []).length > 0
          ? html`<div class="agent-chat__voice-turns">
              ${(options.realtimeTalkConversation ?? []).map(
                (entry) => html`<div class="agent-chat__voice-turn" data-role=${entry.role}>
                  <strong>${entry.role === "user" ? "You" : "Val"}</strong> ${entry.text}
                </div>`,
              )}
            </div>`
          : nothing}
      </div>
    </div>
  `;
}
