// Tool-result context guard tests cover live replay truncation, mid-turn
// prechecks, and context-engine loop hooks for oversized tool outputs.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it, vi } from "vitest";
import type { ContextEngine, ContextEngineRuntimeSettings } from "../../context-engine/types.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  CONTEXT_LIMIT_TRUNCATION_NOTICE,
  formatContextLimitTruncationNotice,
} from "./context-truncation-notice.js";
import { MidTurnPrecheckSignal } from "./run/midturn-precheck.js";
import {
  dedupeContextEngineQueueMediaMessages,
  installContextEngineLoopHook,
  installToolResultContextGuard,
  markTranscriptPromptText,
  postprocessContextEngineMessages,
  PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
  restoreContextEngineImageBlocks,
} from "./tool-result-context-guard.js";

function makeUser(text: string): AgentMessage {
  return castAgentMessage({
    role: "user",
    content: text,
    timestamp: Date.now(),
  });
}

function makeUserWithImage(
  text: string,
  image: { data?: string; mimeType?: string } = {},
): AgentMessage {
  return castAgentMessage({
    role: "user",
    content: [
      { type: "text", text },
      {
        type: "image",
        data: image.data ?? "base64-image",
        mimeType: image.mimeType ?? "image/jpeg",
      },
    ],
    timestamp: Date.now(),
  });
}

function makeUserBlocks(blocks: Array<{ type: "text"; text: string }>): AgentMessage {
  return castAgentMessage({
    role: "user",
    content: blocks,
    timestamp: Date.now(),
  });
}

function withQueueBatchIdentity(
  message: AgentMessage,
  params: { routeKey?: string; sourceMessageIds: string[]; nativeImageCount: number },
): AgentMessage {
  return castAgentMessage({
    ...(message as unknown as Record<string, unknown>),
    __openclaw: {
      queueBatchIdentity: {
        version: 1,
        routeKey: params.routeKey ?? "whatsapp:work:15550001111",
        sourceMessageIds: params.sourceMessageIds,
        nativeImageCount: params.nativeImageCount,
      },
    },
  });
}

function makeToolResult(id: string, text: string, toolName = "grep"): AgentMessage {
  return castAgentMessage({
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  });
}

function makeAssistant(text: string, extras: Record<string, unknown> = {}): AgentMessage {
  return castAgentMessage({
    role: "assistant",
    content: text,
    timestamp: Date.now(),
    ...extras,
  });
}

function makeReadToolResult(id: string, text: string): AgentMessage {
  return makeToolResult(id, text, "read");
}

function makeLegacyToolResult(id: string, text: string): AgentMessage {
  return castAgentMessage({
    role: "tool",
    tool_call_id: id,
    tool_name: "read",
    content: text,
  });
}

function makeToolResultWithDetails(id: string, text: string, detailText: string): AgentMessage {
  // details can be much larger than replay content; guards should drop them
  // only when rewriting the visible tool result.
  return castAgentMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    details: {
      truncation: {
        truncated: true,
        outputLines: 100,
        content: detailText,
      },
    },
    isError: false,
    timestamp: Date.now(),
  });
}

function getToolResultText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const block = content.find(
    (entry) => entry && typeof entry === "object" && (entry as { type?: string }).type === "text",
  ) as { text?: string } | undefined;
  return typeof block?.text === "string" ? block.text : "";
}

function makeGuardableAgent(
  transformContext?: (
    messages: AgentMessage[],
    signal: AbortSignal,
  ) => AgentMessage[] | Promise<AgentMessage[]>,
) {
  return { transformContext };
}

async function applyGuardToContext(
  agent: { transformContext?: (messages: AgentMessage[], signal: AbortSignal) => unknown },
  contextForNextCall: AgentMessage[],
  contextWindowTokens = 1_000,
) {
  installToolResultContextGuard({
    agent,
    contextWindowTokens,
  });
  return await agent.transformContext?.(contextForNextCall, new AbortController().signal);
}

async function applyMidTurnPrecheckGuardToContext(
  agent: { transformContext?: (messages: AgentMessage[], signal: AbortSignal) => unknown },
  contextForNextCall: AgentMessage[],
  options: {
    contextWindowTokens?: number;
    contextTokenBudget?: number;
    reserveTokens?: number;
    toolResultMaxChars?: number;
    prePromptMessageCount?: number;
    systemPrompt?: string;
    authoritativePromptTokens?: number;
  } = {},
) {
  // Mid-turn precheck simulates a new tool result being appended after the
  // original prompt fence; it raises structured signals instead of mutating history.
  const contextWindowTokens = options.contextWindowTokens ?? options.contextTokenBudget ?? 20_000;
  installToolResultContextGuard({
    agent,
    contextWindowTokens,
    contextEngineOwnsAssembly: options.authoritativePromptTokens !== undefined,
    midTurnPrecheck: {
      enabled: true,
      contextTokenBudget: options.contextTokenBudget ?? contextWindowTokens,
      reserveTokens: () => options.reserveTokens ?? 10_000,
      toolResultMaxChars: options.toolResultMaxChars,
      getSystemPrompt: () => options.systemPrompt,
      ...(options.authoritativePromptTokens !== undefined
        ? {
            getAuthoritativePromptTokens: () => options.authoritativePromptTokens as number,
          }
        : {}),
      ...(options.prePromptMessageCount !== undefined
        ? { getPrePromptMessageCount: () => options.prePromptMessageCount as number }
        : {}),
    },
  });
  return await agent.transformContext?.(contextForNextCall, new AbortController().signal);
}

function expectOpenClawTruncation(text: string): void {
  expect(text).toContain(CONTEXT_LIMIT_TRUNCATION_NOTICE);
  expect(text).toMatch(
    /\[\.\.\. \d+ more characters truncated; rerun with narrower args if needed\]$/,
  );
  expect(text).not.toContain("[compacted: tool output removed to free context]");
  expect(text).not.toContain("[compacted: tool output trimmed to free context]");
  expect(text).not.toContain("[truncated: output exceeded context limit]");
}

function mockCallArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex = 0,
  argIndex = 0,
): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex + 1}`);
  }
  return call[argIndex];
}

function recordMockArg(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  callIndex = 0,
  argIndex = 0,
): Record<string, unknown> {
  const arg = mockCallArg(mock, callIndex, argIndex);
  if (!arg || typeof arg !== "object") {
    throw new Error("expected mock argument record");
  }
  return arg as Record<string, unknown>;
}

describe("formatContextLimitTruncationNotice", () => {
  it("formats truncation wording with a count", () => {
    expect(formatContextLimitTruncationNotice(123)).toBe(
      "[... 123 more characters truncated; rerun with narrower args if needed]",
    );
  });
});

describe("restoreContextEngineImageBlocks", () => {
  it("reattaches native user images externalized by a context engine", () => {
    const source = makeUserWithImage(
      "[media attached: /home/nova/.openclaw/media/inbound/ba81107d.jpg (image/jpeg)]\nnova: [media attached: media://inbound/ba81107d.jpg (image/jpeg)]",
      { data: "native-image-bytes" },
    );
    const assembled = makeUser(
      "nova: [User image: ba81107d.jpg (image/jpeg, 101,293 bytes) | LCM file: file_da899f6826fc4650]",
    );

    const restored = restoreContextEngineImageBlocks({
      sourceMessages: [source],
      assembledMessages: [assembled],
    });

    expect(restored.restoredCount).toBe(1);
    expect(restored.messages[0]).not.toBe(assembled);
    expect((restored.messages[0] as { content?: unknown }).content).toEqual([
      {
        type: "text",
        text: "nova: [User image: ba81107d.jpg (image/jpeg, 101,293 bytes) | LCM file: file_da899f6826fc4650]",
      },
      { type: "image", data: "native-image-bytes", mimeType: "image/jpeg" },
    ]);
  });

  it("restores numbered media-attached references without LCM markers", () => {
    const source = makeUserWithImage(
      "[media attached 1/2: media://inbound/pair-a.jpg (image/jpeg)]",
      { data: "pair-a-bytes" },
    );
    const assembled = makeUser("[media attached 1/2: pair-a.jpg (image/jpeg)]");

    const restored = restoreContextEngineImageBlocks({
      sourceMessages: [source],
      assembledMessages: [assembled],
    });

    expect(restored.restoredCount).toBe(1);
  });

  it("keeps already-native assembled image messages unchanged", () => {
    const source = makeUserWithImage("[media attached: media://inbound/photo.jpg]");
    const assembled = makeUserWithImage(
      "[User image: photo.jpg (image/jpeg, 123 bytes) | LCM file: file_da899f6826fc4650]",
      { data: "already-native" },
    );

    const assembledMessages = [assembled];
    const restored = restoreContextEngineImageBlocks({
      sourceMessages: [source],
      assembledMessages,
    });

    expect(restored.restoredCount).toBe(0);
    expect(restored.messages).toBe(assembledMessages);
    expect(restored.messages[0]).toBe(assembled);
  });

  it("reattaches a single native image when Lossless uses a generic upload label", () => {
    const source = makeUserWithImage("nova: please inspect the uploaded image", {
      data: "uploaded-image-bytes",
    });
    const assembled = makeUser(
      "nova: [User image: user-image.png (image/png, 68 bytes) | LCM file: file_da899f6826fc4650]",
    );

    const restored = restoreContextEngineImageBlocks({
      sourceMessages: [source],
      assembledMessages: [assembled],
    });

    expect(restored.restoredCount).toBe(1);
    expect((restored.messages[0] as { content?: unknown }).content).toEqual([
      {
        type: "text",
        text: "nova: [User image: user-image.png (image/png, 68 bytes) | LCM file: file_da899f6826fc4650]",
      },
      { type: "image", data: "uploaded-image-bytes", mimeType: "image/jpeg" },
    ]);
  });

  it("does not guess between two unmatched source image messages", () => {
    const sourceA = makeUserWithImage("nova: first upload", { data: "first-bytes" });
    const sourceB = makeUserWithImage("nova: second upload", { data: "second-bytes" });
    const assembled = makeUser(
      "nova: [User image: user-image.png (image/png, 68 bytes) | LCM file: file_da899f6826fc4650]",
    );

    const assembledMessages = [assembled];
    const restored = restoreContextEngineImageBlocks({
      sourceMessages: [sourceA, sourceB],
      assembledMessages,
    });

    expect(restored.restoredCount).toBe(0);
    expect(restored.messages).toBe(assembledMessages);
  });

  it("uses exact typed queue identity before same-filename tokens when batches reorder", () => {
    const firstIdentity = { sourceMessageIds: ["QUEUE_FIRST"], nativeImageCount: 1 };
    const secondIdentity = { sourceMessageIds: ["QUEUE_SECOND"], nativeImageCount: 1 };
    const firstSource = withQueueBatchIdentity(
      makeUserWithImage("[media attached: media://inbound/shared-name.jpg]", {
        data: "first-native-bytes",
      }),
      firstIdentity,
    );
    const secondSource = withQueueBatchIdentity(
      makeUserWithImage("[media attached: media://inbound/shared-name.jpg]", {
        data: "second-native-bytes",
      }),
      secondIdentity,
    );
    const secondAssembled = withQueueBatchIdentity(
      makeUser(
        "[User image: shared-name.jpg (image/jpeg, 123 bytes) | LCM file: file_2222222222222222]",
      ),
      secondIdentity,
    );
    const firstAssembled = withQueueBatchIdentity(
      makeUser(
        "[User image: shared-name.jpg (image/jpeg, 123 bytes) | LCM file: file_1111111111111111]",
      ),
      firstIdentity,
    );

    const restored = restoreContextEngineImageBlocks({
      sourceMessages: [firstSource, secondSource],
      assembledMessages: [secondAssembled, firstAssembled],
    });

    expect(restored.restoredCount).toBe(2);
    expect((restored.messages[0] as { content?: unknown }).content).toEqual([
      {
        type: "text",
        text: "[User image: shared-name.jpg (image/jpeg, 123 bytes) | LCM file: file_2222222222222222]",
      },
      { type: "image", data: "second-native-bytes", mimeType: "image/jpeg" },
    ]);
    expect((restored.messages[1] as { content?: unknown }).content).toEqual([
      {
        type: "text",
        text: "[User image: shared-name.jpg (image/jpeg, 123 bytes) | LCM file: file_1111111111111111]",
      },
      { type: "image", data: "first-native-bytes", mimeType: "image/jpeg" },
    ]);
  });

  it("does not use filename-token fallback across conflicting typed queue identities", () => {
    const source = withQueueBatchIdentity(
      makeUserWithImage("[media attached: media://inbound/shared-name.jpg]", {
        data: "wrong-native-bytes",
      }),
      { sourceMessageIds: ["QUEUE_SOURCE"], nativeImageCount: 1 },
    );
    const assembled = withQueueBatchIdentity(
      makeUser(
        "[User image: shared-name.jpg (image/jpeg, 123 bytes) | LCM file: file_3333333333333333]",
      ),
      { sourceMessageIds: ["QUEUE_OTHER"], nativeImageCount: 1 },
    );
    const assembledMessages = [assembled];

    const restored = restoreContextEngineImageBlocks({
      sourceMessages: [source],
      assembledMessages,
    });

    expect(restored.restoredCount).toBe(0);
    expect(restored.messages).toBe(assembledMessages);
  });

  it("does not attach source images to unrelated assembled image references", () => {
    const source = makeUserWithImage("[media attached: media://inbound/source.jpg]");
    const assembled = makeUser(
      "[User image: other.jpg (image/jpeg, 123 bytes) | LCM file: file_da899f6826fc4650]",
    );

    const assembledMessages = [assembled];
    const restored = restoreContextEngineImageBlocks({
      sourceMessages: [source],
      assembledMessages,
    });

    expect(restored.restoredCount).toBe(0);
    expect(restored.messages).toBe(assembledMessages);
    expect(restored.messages[0]).toBe(assembled);
  });

  it("caps context-engine native image restoration to the configured input budget", () => {
    const sourceMessages = Array.from({ length: 12 }, (_, index) =>
      makeUserWithImage(`[media attached: media://inbound/photo-${index}.jpg]`, {
        data: `native-image-${index}`,
      }),
    );
    const assembledMessages = Array.from({ length: 12 }, (_, index) =>
      makeUser(
        `[User image: photo-${index}.jpg (image/jpeg, 123 bytes) | LCM file: file_${String(index).padStart(16, "0")}]`,
      ),
    );

    const restored = restoreContextEngineImageBlocks({
      sourceMessages,
      assembledMessages,
      maxInputCount: 9,
    });

    expect(restored.restoredCount).toBe(9);
    expect(restored.messages[9]).toBe(assembledMessages[9]);
    expect(restored.messages[10]).toBe(assembledMessages[10]);
    expect(restored.messages[11]).toBe(assembledMessages[11]);
  });

  it("defaults to a 42-image native restore ceiling", () => {
    const sourceMessages = Array.from({ length: 43 }, (_, index) =>
      makeUserWithImage(`[media attached: media://inbound/cap-${index}.jpg]`, {
        data: `cap-image-${index}`,
      }),
    );
    const assembledMessages = Array.from({ length: 43 }, (_, index) =>
      makeUser(
        `[User image: cap-${index}.jpg (image/jpeg, 123 bytes) | LCM file: file_${String(index).padStart(16, "0")}]`,
      ),
    );

    const restored = restoreContextEngineImageBlocks({
      sourceMessages,
      assembledMessages,
    });

    expect(restored.restoredCount).toBe(42);
    expect(restored.messages[42]).toBe(assembledMessages[42]);
  });

  it("only restores from source messages inside the pre-prompt window", () => {
    const historicalSource = makeUserWithImage("[media attached: media://inbound/history.jpg]", {
      data: "history-native-image",
    });
    const currentPromptSource = makeUserWithImage("[media attached: media://inbound/current.jpg]", {
      data: "current-native-image",
    });
    const historicalAssembled = makeUser(
      "[User image: history.jpg (image/jpeg, 123 bytes) | LCM file: file_da899f6826fc4650]",
    );
    const currentPromptAssembled = makeUser(
      "[User image: current.jpg (image/jpeg, 123 bytes) | LCM file: file_da899f6826fc4651]",
    );

    const restored = restoreContextEngineImageBlocks({
      sourceMessages: [historicalSource, currentPromptSource],
      assembledMessages: [historicalAssembled, currentPromptAssembled],
      sourceMessageLimit: 1,
    });

    expect(restored.restoredCount).toBe(1);
    expect((restored.messages[0] as { content?: unknown }).content).toEqual([
      {
        type: "text",
        text: "[User image: history.jpg (image/jpeg, 123 bytes) | LCM file: file_da899f6826fc4650]",
      },
      { type: "image", data: "history-native-image", mimeType: "image/jpeg" },
    ]);
    expect(restored.messages[1]).toBe(currentPromptAssembled);
  });

  it("leaves LCM image refs as text when native restoration is disabled", () => {
    const source = makeUserWithImage("[media attached: media://inbound/photo.jpg]");
    const assembled = makeUser(
      "[User image: photo.jpg (image/jpeg, 123 bytes) | LCM file: file_da899f6826fc4650]",
    );

    const restored = restoreContextEngineImageBlocks({
      sourceMessages: [source],
      assembledMessages: [assembled],
      maxInputCount: 0,
    });

    expect(restored.restoredCount).toBe(0);
    expect(restored.messages[0]).toBe(assembled);
  });
});

describe("dedupeContextEngineQueueMediaMessages", () => {
  // Queue-engine v2 batch prompt shape: materializeQueueBatch's
  // "[Conversation Metadata]:" header plus per-inbound "Message Metadata:"
  // fenced JSON blocks carrying the typed envelope messageId.
  const queueImageEnvelope = `[NEW MESSAGES ARRIVED WHILE YOU WERE IDLE]

[Conversation Metadata]:
\`\`\`json
{
 "channel": "whatsapp",
 "session_key": "agent:main:whatsapp:dm:15550001111"
}
\`\`\`

[Inbound #1]: [nova (+15550001111)]
Message Metadata:
\`\`\`json
{
 "sender": "nova (+15550001111)",
 "message_id": "3AB46D9053D465055217",
 "has_media": true
}
\`\`\`
Message Media:
\`\`\`json
{
 "kind": "image",
 "type": "image/jpeg",
 "source_message_id": "3AB46D9053D465055217",
 "media_reference": "media://inbound/user-image.jpg",
 "media_local_path": "/home/nova/.openclaw/media/inbound/user-image.jpg"
}
\`\`\`
Message Body: [EMPTY]`;
  const queueIdentity = {
    sourceMessageIds: ["3AB46D9053D465055217"],
    nativeImageCount: 1,
  };

  it("keeps the rich LCM image carrier and drops the duplicate plain queue envelope", () => {
    const plain = withQueueBatchIdentity(makeUser(queueImageEnvelope), queueIdentity);
    const rich = withQueueBatchIdentity(
      makeUserBlocks([
        { type: "text", text: queueImageEnvelope },
        {
          type: "text",
          text: "[User image: user-image.jpg (image/jpeg, 165,311 bytes) | LCM file: file_100ae5228546430e]",
        },
      ]),
      queueIdentity,
    );
    const assistant = makeAssistant("saw it twice");

    const deduped = dedupeContextEngineQueueMediaMessages({
      messages: [plain, rich, assistant],
    });

    expect(deduped.removedCount).toBe(1);
    expect(deduped.messages).toEqual([rich, assistant]);
  });

  it("prefers a full two-image native copy over a partial one-image copy", () => {
    const identity = { sourceMessageIds: ["MULTI_IMAGE"], nativeImageCount: 2 };
    const partial = withQueueBatchIdentity(
      makeUserWithImage("queued two images", { data: "first-image" }),
      identity,
    );
    const full = withQueueBatchIdentity(
      castAgentMessage({
        role: "user",
        content: [
          { type: "text", text: "queued two images" },
          { type: "image", data: "first-image", mimeType: "image/jpeg" },
          { type: "image", data: "second-image", mimeType: "image/jpeg" },
        ],
        timestamp: Date.now(),
      }),
      identity,
    );

    const deduped = dedupeContextEngineQueueMediaMessages({ messages: [partial, full] });

    expect(deduped.removedCount).toBe(1);
    expect(deduped.messages).toEqual([full]);
  });

  it.each([
    {
      label: "audio",
      body: "queued audio\n\nAudio Transcription:\n```text\nhello\n```",
    },
    {
      label: "video",
      body: "queued video\n\nVideo Description:\n```text\na red car moves\n```",
    },
  ])("reattaches typed identity to metadata-dropping $label clones before dedupe", ({ body }) => {
    const source = withQueueBatchIdentity(makeUser(body), {
      sourceMessageIds: ["MEDIA_SOURCE"],
      nativeImageCount: 0,
    });
    const cloneWithoutHostMetadata = (): AgentMessage => {
      const { __openclaw: _hostMetadata, ...clone } = source as unknown as Record<string, unknown>;
      return castAgentMessage({ ...clone });
    };

    const postprocessed = postprocessContextEngineMessages({
      sourceMessages: [source],
      assembledMessages: [cloneWithoutHostMetadata(), cloneWithoutHostMetadata()],
    });

    expect(postprocessed.removedCount).toBe(1);
    expect(postprocessed.messages).toHaveLength(1);
    expect(
      (postprocessed.messages[0] as unknown as { __openclaw?: unknown })["__openclaw"],
    ).toEqual({
      queueBatchIdentity: {
        version: 1,
        routeKey: "whatsapp:work:15550001111",
        sourceMessageIds: ["MEDIA_SOURCE"],
        nativeImageCount: 0,
      },
    });
  });

  it("reattaches the typed human inbound manifest to an exact Lossless clone", () => {
    const humanInboundBatch = {
      version: 1,
      placement: "idle",
      route: {
        channel: "whatsapp",
        accountId: "brodie",
        conversationKind: "group",
        conversationId: "room",
        sessionKey: "agent:main:conversation:whatsapp:brodie:group:room",
        queueLaneKey: "whatsapp:brodie:group:room",
        transcriptOwner: {
          agentId: "main",
          sessionKey: "agent:main:conversation:whatsapp:brodie:group:room",
        },
      },
      conversation: {
        channel: "whatsapp",
        conversationType: "group",
        sessionKey: "agent:main:conversation:whatsapp:brodie:group:room",
      },
      inbounds: [],
    } as const;
    const source = castAgentMessage({
      ...makeUser("[📋 QUEUE ENGINE]: [MESSAGE]"),
      __openclaw: { humanInboundBatch },
    });
    const { __openclaw: _metadata, ...clone } = source as unknown as Record<string, unknown>;

    const postprocessed = postprocessContextEngineMessages({
      sourceMessages: [source],
      assembledMessages: [castAgentMessage(clone)],
    });

    expect(
      (postprocessed.messages[0] as unknown as { __openclaw?: unknown })["__openclaw"],
    ).toEqual({ humanInboundBatch });
  });

  it("caps duplicated LCM image carriers to the queue image descriptor count", () => {
    const plain = withQueueBatchIdentity(makeUser(queueImageEnvelope), queueIdentity);
    const rich = withQueueBatchIdentity(
      makeUserBlocks([
        { type: "text", text: queueImageEnvelope },
        {
          type: "text",
          text: "[User image: user-image.jpg (image/jpeg, 165,311 bytes) | LCM file: file_100ae5228546430e]",
        },
        {
          type: "text",
          text: "[User image: user-image.jpg (image/jpeg, 165,311 bytes) | LCM file: file_bbd8dca1f1fc4148]",
        },
      ]),
      queueIdentity,
    );

    const assistant = makeAssistant("between");
    const deduped = dedupeContextEngineQueueMediaMessages({
      messages: [plain, assistant, rich],
    });

    expect(deduped.removedCount).toBe(2);
    expect(deduped.messages).toHaveLength(2);
    const content = (deduped.messages[0] as { content: Array<{ text?: string }> }).content;
    expect(content.map((block) => block.text).join("\n")).toContain("file_100ae5228546430e");
    expect(content.map((block) => block.text).join("\n")).not.toContain("file_bbd8dca1f1fc4148");
    expect(deduped.messages[1]).toBe(assistant);
  });

  it("keeps the plain envelope when it is the only copy", () => {
    const plain = withQueueBatchIdentity(makeUser(queueImageEnvelope), queueIdentity);
    const messages = [plain];

    const deduped = dedupeContextEngineQueueMediaMessages({ messages });

    expect(deduped.removedCount).toBe(0);
    expect(deduped.messages).toBe(messages);
    expect(deduped.messages).toEqual([plain]);
  });

  it("does not collapse quote messages that only share a quoted message id", () => {
    const first = makeUser(`[Conversation Metadata]:
\`\`\`json
{ "channel": "whatsapp" }
\`\`\`

[Inbound #1]: [nova]
Message Metadata:
\`\`\`json
{ "message_id": "CURRENT_ONE" }
\`\`\`
Quote Replied Message:
\`\`\`json
{ "message_id": "QUOTED_SHARED" }
\`\`\`
Message Body:
\`\`\`\`text
one
\`\`\`\``);
    const second = makeUser(`[Conversation Metadata]:
\`\`\`json
{ "channel": "whatsapp" }
\`\`\`

[Inbound #1]: [nova]
Message Metadata:
\`\`\`json
{ "message_id": "CURRENT_TWO" }
\`\`\`
Quote Replied Message:
\`\`\`json
{ "message_id": "QUOTED_SHARED" }
\`\`\`
Message Body:
\`\`\`\`text
two
\`\`\`\``);

    const deduped = dedupeContextEngineQueueMediaMessages({
      messages: [
        withQueueBatchIdentity(first, {
          sourceMessageIds: ["CURRENT_ONE"],
          nativeImageCount: 0,
        }),
        withQueueBatchIdentity(second, {
          sourceMessageIds: ["CURRENT_TWO"],
          nativeImageCount: 0,
        }),
      ],
    });

    expect(deduped.removedCount).toBe(0);
    expect(deduped.messages).toHaveLength(2);
  });

  it("does not merge batches whose envelope id sets differ", () => {
    const single = makeUser(queueImageEnvelope);
    const superset = makeUserBlocks([
      { type: "text", text: queueImageEnvelope },
      {
        type: "text",
        text: `[Inbound #2]: [aria]
Message Metadata:
\`\`\`json
{ "message_id": "3AB46D9053D465055218" }
\`\`\``,
      },
      {
        type: "text",
        text: "[User image: user-image.jpg (image/jpeg, 165,311 bytes) | LCM file: file_100ae5228546430e]",
      },
    ]);

    const typedSingle = withQueueBatchIdentity(single, queueIdentity);
    const typedSuperset = withQueueBatchIdentity(superset, {
      sourceMessageIds: ["3AB46D9053D465055217", "3AB46D9053D465055218"],
      nativeImageCount: 1,
    });
    const deduped = dedupeContextEngineQueueMediaMessages({
      messages: [typedSingle, typedSuperset],
    });

    expect(deduped.removedCount).toBe(0);
    expect(deduped.messages).toEqual([typedSingle, typedSuperset]);
  });

  it("uses typed image counts to remove zero-descriptor LCM lines from string content", () => {
    const stray = withQueueBatchIdentity(
      makeUser("[User image: stray.jpg (image/jpeg, 1 byte) | LCM file: file_100ae5228546430e]"),
      { sourceMessageIds: ["NO_MEDIA"], nativeImageCount: 0 },
    );

    const deduped = dedupeContextEngineQueueMediaMessages({ messages: [stray] });

    expect(deduped.removedCount).toBe(1);
    expect((deduped.messages[0] as { content?: unknown }).content).toBe("");
  });

  it("prefers media-understanding output over a plain copy", () => {
    const identity = { sourceMessageIds: ["AUDIO_ONE"], nativeImageCount: 0 };
    const plain = withQueueBatchIdentity(makeUser("queued audio"), identity);
    const understood = withQueueBatchIdentity(
      makeUser("queued audio\n\nAudio Transcription:\n```text\nhello\n```"),
      identity,
    );

    const deduped = dedupeContextEngineQueueMediaMessages({ messages: [plain, understood] });

    expect(deduped.messages).toEqual([understood]);
  });
});

describe("installToolResultContextGuard", () => {
  it("passes through unchanged context when under the per-tool and total budget", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeUser("hello"), makeToolResult("call_ok", "small output")];

    const transformed = await applyGuardToContext(agent, contextForNextCall);

    expect(transformed).toBe(contextForNextCall);
  });

  it("does not preemptively overflow large non-tool context that is still under the high-water mark", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeUser("u".repeat(3_200))];

    const transformed = await applyGuardToContext(agent, contextForNextCall);

    expect(transformed).toBe(contextForNextCall);
  });

  it("returns a cloned guarded context so original oversized tool output stays visible", async () => {
    // Provider replay gets a truncated clone; callers retain full live output
    // for UI, transcript, and later persisted truncation decisions.
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeToolResult("call_big", "z".repeat(5_000))];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];

    expect(transformed).not.toBe(contextForNextCall);
    const newResultText = getToolResultText(transformed[0]);
    expect(newResultText.length).toBeLessThan(5_000);
    expectOpenClawTruncation(newResultText);
    expect(getToolResultText(contextForNextCall[0])).toBe("z".repeat(5_000));
  });

  it("wraps an existing transformContext and guards the transformed output", async () => {
    const agent = makeGuardableAgent((messages) =>
      messages.map((msg) =>
        castAgentMessage({
          ...(msg as unknown as Record<string, unknown>),
        }),
      ),
    );
    const contextForNextCall = [makeToolResult("call_big", "x".repeat(5_000))];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];

    expect(transformed).not.toBe(contextForNextCall);
    expectOpenClawTruncation(getToolResultText(transformed[0]));
  });

  it("handles legacy role=tool string outputs with truncation wording", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeLegacyToolResult("call_big", "y".repeat(5_000))];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];
    const newResultText = getToolResultText(transformed[0]);

    expect(typeof (transformed[0] as { content?: unknown }).content).toBe("string");
    expectOpenClawTruncation(newResultText);
  });

  it("drops oversized tool-result details when truncating once", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeToolResultWithDetails("call_big", "x".repeat(900), "d".repeat(8_000)),
    ];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];
    const result = transformed[0] as { details?: unknown };
    const newResultText = getToolResultText(transformed[0]);

    expectOpenClawTruncation(newResultText);
    expect(result.details).toBeUndefined();
    const originalDetails = (contextForNextCall[0] as { details?: { truncation?: unknown } })
      .details;
    expect(originalDetails?.truncation).toEqual({
      truncated: true,
      outputLines: 100,
      content: "d".repeat(8_000),
    });
  });

  it("throws a preemptive overflow when total context still exceeds the high-water mark", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("u".repeat(50_000)),
      makeToolResult("call_big", "x".repeat(5_000)),
    ];

    await expect(applyGuardToContext(agent, contextForNextCall)).rejects.toThrow(
      PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
    );
    expect(getToolResultText(contextForNextCall[1])).toBe("x".repeat(5_000));
  });

  it("never lets the char high-water terminate an engine-owned turn when precheck is disabled", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("u".repeat(50_000)),
      makeToolResult("call_big", "x".repeat(5_000)),
    ];
    installToolResultContextGuard({
      agent,
      contextWindowTokens: 1_000,
      contextEngineOwnsAssembly: true,
    });

    await expect(
      agent.transformContext?.(contextForNextCall, new AbortController().signal),
    ).resolves.toBeInstanceOf(Array);
  });

  it("throws instead of rewriting older tool results under aggregate pressure", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("u".repeat(50_000)),
      makeToolResult("call_1", "a".repeat(500)),
      makeToolResult("call_2", "b".repeat(500)),
      makeToolResult("call_3", "c".repeat(500)),
    ];

    await expect(applyGuardToContext(agent, contextForNextCall)).rejects.toThrow(
      PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
    );
    expect(getToolResultText(contextForNextCall[1])).toBe("a".repeat(500));
    expect(getToolResultText(contextForNextCall[2])).toBe("b".repeat(500));
    expect(getToolResultText(contextForNextCall[3])).toBe("c".repeat(500));
  });

  it("does not special-case the latest read result before throwing under aggregate pressure", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("u".repeat(50_000)),
      makeToolResult("call_old", "x".repeat(400)),
      makeReadToolResult("call_new", "y".repeat(500)),
    ];

    await expect(applyGuardToContext(agent, contextForNextCall)).rejects.toThrow(
      PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE,
    );
    expect(getToolResultText(contextForNextCall[1])).toBe("x".repeat(400));
    expect(getToolResultText(contextForNextCall[2])).toBe("y".repeat(500));
  });

  it("supports model-window-specific truncation for large but otherwise valid tool results", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeToolResult("call_big", "q".repeat(95_000))];

    const transformed = (await applyGuardToContext(
      agent,
      contextForNextCall,
      100_000,
    )) as AgentMessage[];

    expectOpenClawTruncation(getToolResultText(transformed[0]));
  });

  it("raises a structured mid-turn precheck signal after a new tool result overflows", async () => {
    // The signal carries route metadata so the run loop can compact/truncate
    // without guessing from a generic overflow error.
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("prompt already in history"),
      makeToolResult("call_big", "x".repeat(80_000)),
    ];

    try {
      await applyMidTurnPrecheckGuardToContext(agent, contextForNextCall, {
        contextWindowTokens: 200_000,
        contextTokenBudget: 20_000,
        reserveTokens: 12_000,
        toolResultMaxChars: 16_000,
        prePromptMessageCount: 1,
      });
      throw new Error("expected mid-turn precheck signal");
    } catch (err) {
      expect(err).toBeInstanceOf(MidTurnPrecheckSignal);
      const signal = err as MidTurnPrecheckSignal;
      expect(signal.name).toBe("MidTurnPrecheckSignal");
      expect(signal.request.route).toBe("compact_then_truncate");
      expect(typeof signal.request.overflowTokens).toBe("number");
      expect(typeof signal.request.toolResultReducibleChars).toBe("number");
    }
  });

  it("keeps a fitting engine-assembled prompt alive when the char estimate is pessimistic", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("u".repeat(300_000)),
      makeToolResult("call_big", "x".repeat(60_000)),
    ];

    const transformed = await applyMidTurnPrecheckGuardToContext(agent, contextForNextCall, {
      contextWindowTokens: 272_000,
      contextTokenBudget: 272_000,
      reserveTokens: 42_000,
      toolResultMaxChars: 69_000,
      prePromptMessageCount: 1,
      systemPrompt: "s".repeat(380_000),
      authoritativePromptTokens: 55_000,
    });

    expect(transformed).toBe(contextForNextCall);
  });

  it("does not run mid-turn precheck when no new tool result was appended", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [makeUser("u".repeat(80_000))];

    const transformed = await applyMidTurnPrecheckGuardToContext(agent, contextForNextCall, {
      contextWindowTokens: 200_000,
      contextTokenBudget: 20_000,
      reserveTokens: 12_000,
      prePromptMessageCount: 0,
    });

    expect(transformed).toBe(contextForNextCall);
  });

  it("uses compact_only route when mid-turn overflow is not reducible by tool truncation", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("u".repeat(80_000)),
      makeToolResult("call_small", "small output"),
    ];

    try {
      await applyMidTurnPrecheckGuardToContext(agent, contextForNextCall, {
        contextWindowTokens: 200_000,
        contextTokenBudget: 20_000,
        reserveTokens: 12_000,
        prePromptMessageCount: 1,
      });
      throw new Error("expected mid-turn precheck signal");
    } catch (err) {
      expect(err).toBeInstanceOf(MidTurnPrecheckSignal);
      expect((err as MidTurnPrecheckSignal).request.route).toBe("compact_only");
    }
  });
  it("does not count tool-result details toward the context budget", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeToolResultWithDetails("call_small_text", "x".repeat(100), "d".repeat(50_000)),
      makeToolResultWithDetails("call_another", "y".repeat(120), "e".repeat(80_000)),
    ];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];

    expect(transformed).toBe(contextForNextCall);
    expect(getToolResultText(transformed[0])).toBe("x".repeat(100));
    expect(getToolResultText(transformed[1])).toBe("y".repeat(120));
    expect((contextForNextCall[0] as { details?: unknown }).details).toBeDefined();
    expect((contextForNextCall[1] as { details?: unknown }).details).toBeDefined();
  });

  it("ignores large tool-result details when deciding preemptive overflow", async () => {
    const agent = makeGuardableAgent();
    const contextForNextCall = [
      makeUser("small user prompt"),
      makeToolResultWithDetails("call_1", "a".repeat(50), "d".repeat(30_000)),
      makeToolResultWithDetails("call_2", "b".repeat(50), "d".repeat(30_000)),
      makeToolResultWithDetails("call_3", "c".repeat(50), "d".repeat(30_000)),
      makeToolResultWithDetails("call_4", "e".repeat(50), "d".repeat(30_000)),
    ];

    const transformed = (await applyGuardToContext(agent, contextForNextCall)) as AgentMessage[];

    expect(transformed).toBe(contextForNextCall);
  });
});

type MockedEngine = ContextEngine & {
  afterTurn: ReturnType<typeof vi.fn<NonNullable<ContextEngine["afterTurn"]>>>;
  assemble: ReturnType<typeof vi.fn<ContextEngine["assemble"]>>;
  ingest: ReturnType<typeof vi.fn<ContextEngine["ingest"]>>;
  ingestBatch?: ReturnType<typeof vi.fn<NonNullable<ContextEngine["ingestBatch"]>>>;
};

function makeMockEngine(
  overrides: {
    assemble?: (
      params: Parameters<ContextEngine["assemble"]>[0],
    ) => Promise<{ messages: AgentMessage[]; estimatedTokens: number }>;
    afterTurn?: (params: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) => Promise<void>;
    omitAfterTurn?: boolean;
    ingest?: (params: Parameters<ContextEngine["ingest"]>[0]) => Promise<{ ingested: boolean }>;
    ingestBatch?: (
      params: Parameters<NonNullable<ContextEngine["ingestBatch"]>>[0],
    ) => Promise<{ ingestedCount: number }>;
    omitIngestBatch?: boolean;
  } = {},
): MockedEngine {
  // Mock engines default to owning compaction and echoing inputs, letting each
  // test opt into assembly/ingest failures without building a real engine.
  const defaultAfterTurn = vi.fn<NonNullable<ContextEngine["afterTurn"]>>(async () => {});
  const defaultAssemble = vi.fn<ContextEngine["assemble"]>(
    async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
      messages: params.messages,
      estimatedTokens: 0,
    }),
  );
  const defaultIngest = vi.fn<ContextEngine["ingest"]>(async () => ({ ingested: true }));
  const defaultIngestBatch = vi.fn<NonNullable<ContextEngine["ingestBatch"]>>(
    async (params: Parameters<NonNullable<ContextEngine["ingestBatch"]>>[0]) => ({
      ingestedCount: params.messages.length,
    }),
  );
  const afterTurn = overrides.omitAfterTurn
    ? undefined
    : overrides.afterTurn
      ? vi.fn<NonNullable<ContextEngine["afterTurn"]>>(overrides.afterTurn)
      : defaultAfterTurn;
  const assemble = overrides.assemble
    ? vi.fn<ContextEngine["assemble"]>(overrides.assemble)
    : defaultAssemble;
  const ingest = overrides.ingest
    ? vi.fn<ContextEngine["ingest"]>(overrides.ingest)
    : defaultIngest;
  const ingestBatch = overrides.omitIngestBatch
    ? undefined
    : overrides.ingestBatch
      ? vi.fn<NonNullable<ContextEngine["ingestBatch"]>>(overrides.ingestBatch)
      : defaultIngestBatch;
  const engine = {
    info: {
      id: "test-engine",
      name: "Test Engine",
      version: "0.0.1",
      ownsCompaction: true,
    },
    ingest,
    assemble,
    ...(ingestBatch ? { ingestBatch } : {}),
    ...(afterTurn ? { afterTurn } : {}),
  } as unknown as MockedEngine;
  return engine;
}

async function callTransform(
  agent: { transformContext?: (messages: AgentMessage[], signal: AbortSignal) => unknown },
  messages: AgentMessage[],
) {
  return await agent.transformContext?.(messages, new AbortController().signal);
}

describe("installContextEngineLoopHook", () => {
  const sessionId = "test-session-id";
  const sessionKey = "agent:main:subagent:test";
  const sessionFile = "/tmp/test-session.jsonl";
  const tokenBudget = 4096;
  const modelId = "test-model";

  it("reports the engine's assembled token estimate to the mid-turn guard", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine({
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 54_798.9 }),
    });
    const onAssembledTokenEstimate = vi.fn();
    const remove = installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
      onAssembledTokenEstimate,
    });

    const initial = [makeUser("prompt")];
    await callTransform(agent, initial);
    await callTransform(agent, [...initial, makeToolResult("call_estimate", "result")]);

    expect(onAssembledTokenEstimate).toHaveBeenCalledWith(54_798);
    remove();
  });

  function installHook(
    agent: ReturnType<typeof makeGuardableAgent>,
    engine: MockedEngine,
    prePromptCount?: number,
    getRuntimeContext?: (params: {
      messages: AgentMessage[];
      prePromptMessageCount: number;
    }) => Record<string, unknown> | undefined,
    onAfterTurnCheckpoint?: (messageCount: number) => void,
    isHeartbeat?: boolean,
  ): () => void {
    return installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
      ...(prePromptCount !== undefined ? { getPrePromptMessageCount: () => prePromptCount } : {}),
      ...(getRuntimeContext ? { getRuntimeContext } : {}),
      ...(onAfterTurnCheckpoint ? { onAfterTurnCheckpoint } : {}),
      ...(isHeartbeat !== undefined ? { isHeartbeat } : {}),
    });
  }

  function installOwnsCompactionHookWithGuard(
    agent: ReturnType<typeof makeGuardableAgent>,
    engine: MockedEngine,
    options: {
      prePromptCount?: number;
      contextWindowTokens?: number;
      contextTokenBudget?: number;
      reserveTokens?: number;
      toolResultMaxChars?: number;
    } = {},
  ): () => void {
    // Install engine assembly before the generic guard to prove owner compaction
    // can resolve pressure before fallback truncation checks run.
    const removeEngineHook = installHook(agent, engine, options.prePromptCount);
    const removeGuard = installToolResultContextGuard({
      agent,
      contextWindowTokens: options.contextWindowTokens ?? 200_000,
      contextEngineOwnsAssembly: true,
      midTurnPrecheck: {
        enabled: true,
        contextTokenBudget: options.contextTokenBudget ?? 20_000,
        reserveTokens: () => options.reserveTokens ?? 12_000,
        toolResultMaxChars: options.toolResultMaxChars,
        getSystemPrompt: () => "sys",
        ...(options.prePromptCount !== undefined
          ? { getPrePromptMessageCount: () => options.prePromptCount as number }
          : {}),
      },
    });
    return () => {
      removeGuard();
      removeEngineHook();
    };
  }

  async function callAfterInitialToolResult(
    agent: ReturnType<typeof makeGuardableAgent>,
    options: { includeSecondUser?: boolean; firstResultText?: string } = {},
  ): Promise<{ initial: AgentMessage[]; withNew: AgentMessage[]; transformed: unknown }> {
    const initial = [
      makeUser("first"),
      makeToolResult("call_1", options.firstResultText ?? "result"),
    ];
    await callTransform(agent, initial);

    const withNew =
      options.includeSecondUser === false
        ? [...initial, makeToolResult("call_2", "r2")]
        : [...initial, makeUser("second"), makeToolResult("call_2", "r2")];
    const transformed = await callTransform(agent, withNew);
    return { initial, withNew, transformed };
  }

  it("restores current-prompt image blocks after loop-hook assembly", async () => {
    const agent = makeGuardableAgent();
    const source = makeUserWithImage("[media attached: media://inbound/live-photo.jpg]", {
      data: "live-image-bytes",
    });
    const rewrittenView = [
      makeUser(
        "[User image: live-photo.jpg (image/jpeg, 101,293 bytes) | LCM file: file_da899f6826fc4650]",
      ),
    ];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: rewrittenView, estimatedTokens: 0 }),
    });
    const remove = installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
      maxImageInputCount: 50,
      getPrePromptMessageCount: () => 0,
    });

    const toolResult = makeToolResult("call_1", "ok");
    const transformed = (await callTransform(agent, [source, toolResult])) as AgentMessage[];

    expect((transformed[0] as { content?: unknown }).content).toEqual([
      {
        type: "text",
        text: "[User image: live-photo.jpg (image/jpeg, 101,293 bytes) | LCM file: file_da899f6826fc4650]",
      },
      { type: "image", data: "live-image-bytes", mimeType: "image/jpeg" },
    ]);
    remove();
  });

  it("restores current-prompt images when an engine mutates and returns its input array", async () => {
    const agent = makeGuardableAgent();
    const source = makeUserWithImage("[media attached: media://inbound/in-place.jpg]", {
      data: "in-place-image-bytes",
    });
    const engine = makeMockEngine({
      assemble: async ({ messages }) => {
        (messages[0] as unknown as { content: string }).content =
          "[User image: in-place.jpg (image/jpeg, 123 bytes) | LCM file: file_da899f6826fc4650]";
        return { messages, estimatedTokens: 0 };
      },
    });
    const remove = installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
      maxImageInputCount: 50,
      getPrePromptMessageCount: () => 0,
    });

    const transformed = (await callTransform(agent, [
      source,
      makeToolResult("call_in_place", "ok"),
    ])) as AgentMessage[];

    expect((transformed[0] as { content?: unknown }).content).toEqual([
      {
        type: "text",
        text: "[User image: in-place.jpg (image/jpeg, 123 bytes) | LCM file: file_da899f6826fc4650]",
      },
      { type: "image", data: "in-place-image-bytes", mimeType: "image/jpeg" },
    ]);
    remove();
  });

  it("leaves externalized image refs textual when the model lacks image input", async () => {
    const agent = makeGuardableAgent();
    const source = makeUserWithImage("[media attached: media://inbound/live-photo.jpg]", {
      data: "live-image-bytes",
    });
    const rewrittenView = [
      makeUser(
        "[User image: live-photo.jpg (image/jpeg, 101,293 bytes) | LCM file: file_da899f6826fc4650]",
      ),
    ];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: rewrittenView, estimatedTokens: 0 }),
    });
    const remove = installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
      maxImageInputCount: 0,
      getPrePromptMessageCount: () => 1,
    });

    const toolResult = makeToolResult("call_1", "ok");
    const transformed = await callTransform(agent, [source, toolResult]);

    expect(transformed).toBe(rewrittenView);
    remove();
  });

  it("returns early when the current messages match the pre-prompt baseline", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installHook(agent, engine, 2);

    const messages = [makeUser("first"), makeToolResult("call_1", "result")];
    const transformed = await callTransform(agent, messages);

    expect(transformed).toBe(messages);
    expect(engine.afterTurn).not.toHaveBeenCalled();
    expect(engine.assemble).not.toHaveBeenCalled();
  });

  it("uses the engine estimate instead of char pressure after ownsCompaction assembly", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installOwnsCompactionHookWithGuard(agent, engine, {
      prePromptCount: 1,
      contextWindowTokens: 200_000,
      contextTokenBudget: 20_000,
      reserveTokens: 12_000,
      toolResultMaxChars: 16_000,
    });

    const messages = [makeUser("first"), makeToolResult("call_1", "x".repeat(80_000))];

    await expect(callTransform(agent, messages)).resolves.toStrictEqual(messages);
    expect(engine.afterTurn).toHaveBeenCalledTimes(1);
    expect(engine.assemble).toHaveBeenCalledTimes(1);
  });

  it("lets ownsCompaction assembly resolve pressure before the generic guard checks", async () => {
    const agent = makeGuardableAgent();
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    installOwnsCompactionHookWithGuard(agent, engine, {
      prePromptCount: 1,
      contextWindowTokens: 200_000,
      contextTokenBudget: 20_000,
      reserveTokens: 12_000,
      toolResultMaxChars: 16_000,
    });

    const messages = [makeUser("first"), makeToolResult("call_1", "x".repeat(80_000))];
    const transformed = await callTransform(agent, messages);

    expect(transformed).toBe(compactedView);
    expect(engine.afterTurn).toHaveBeenCalledTimes(1);
    expect(engine.assemble).toHaveBeenCalledTimes(1);
  });

  it("processes the first call when messages already exceed the pre-prompt baseline", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installHook(agent, engine, 1);

    const messages = [makeUser("first"), makeToolResult("call_1", "result")];
    await callTransform(agent, messages);

    expect(engine.afterTurn).toHaveBeenCalledTimes(1);
    const afterTurnParams = recordMockArg(engine.afterTurn);
    expect(afterTurnParams?.prePromptMessageCount).toBe(1);
    expect(afterTurnParams?.messages).toBe(messages);
    expect(engine.assemble).toHaveBeenCalledTimes(1);
  });

  it("passes runtimeContext through loop-hook afterTurn calls", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    const externalFiles = [
      {
        marker: "[OpenClaw External File: external_file_1]",
        idempotencyKey: "external_file_1",
        attachmentIndex: 0,
        mediaRef: "media://inbound/clip.mp4",
      },
    ];
    installHook(agent, engine, 1, () => ({
      provider: "anthropic",
      modelId,
      externalFiles,
      promptCache: {
        retention: "short",
        lastCacheTouchAt: 123,
      },
    }));

    const messages = [makeUser("first"), makeToolResult("call_1", "result")];
    await callTransform(agent, messages);

    expect(engine.afterTurn).toHaveBeenCalledTimes(1);
    const afterTurnParams = recordMockArg(engine.afterTurn);
    expect(afterTurnParams?.prePromptMessageCount).toBe(1);
    expect(afterTurnParams?.runtimeContext).toEqual({
      provider: "anthropic",
      modelId,
      externalFiles,
      promptCache: {
        retention: "short",
        lastCacheTouchAt: 123,
      },
    });
    expect(recordMockArg(engine.assemble).runtimeContext).toEqual(afterTurnParams?.runtimeContext);
  });

  it("passes runtimeSettings through loop-hook afterTurn and assemble calls", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    const runtimeSettings = { schemaVersion: 1 } as ContextEngineRuntimeSettings;
    installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
      getPrePromptMessageCount: () => 1,
      runtimeSettings,
    });

    const messages = [makeUser("first"), makeToolResult("call_1", "result")];
    await callTransform(agent, messages);

    expect(recordMockArg(engine.afterTurn).runtimeSettings).toBe(runtimeSettings);
    expect(recordMockArg(engine.assemble).runtimeSettings).toBe(runtimeSettings);
  });

  it("passes loop messages and the prompt fence into the runtimeContext callback", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    const getRuntimeContext = vi.fn(() => ({ provider: "anthropic" }));
    installHook(agent, engine, 1, getRuntimeContext);

    const messages = [
      makeUser("first"),
      makeAssistant("tool use", { usage: { cacheRead: 40, total: 50 }, timestamp: 456 }),
      makeToolResult("call_1", "result"),
    ];
    await callTransform(agent, messages);

    expect(getRuntimeContext).toHaveBeenCalledWith({
      messages,
      prePromptMessageCount: 1,
    });
  });

  it("ingests the exact provider view for marked model prompts without leaking the marker", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installHook(agent, engine, 0);

    const modelPrompt = makeUser("model-only hook context\n\nvisible prompt");
    markTranscriptPromptText(modelPrompt, "visible prompt");
    const messages = [modelPrompt, makeToolResult("call_1", "result")];
    const transformed = await callTransform(agent, messages);

    const afterTurnMessage = (recordMockArg(engine.afterTurn).messages as AgentMessage[])[0];
    const assembleMessage = (recordMockArg(engine.assemble).messages as AgentMessage[])[0];
    const transformedMessage = (transformed as AgentMessage[])[0];

    // The hook only exists for assembly-authoritative engines, so ingest and
    // assembly must both see the provider text, never the transcript projection.
    expect(afterTurnMessage).toMatchObject({
      role: "user",
      content: "model-only hook context\n\nvisible prompt",
    });
    expect(JSON.stringify(afterTurnMessage)).not.toContain("__openclawTranscriptPromptText");
    expect(assembleMessage).toMatchObject({
      role: "user",
      content: "model-only hook context\n\nvisible prompt",
    });
    expect(JSON.stringify(assembleMessage)).not.toContain("__openclawTranscriptPromptText");
    expect(transformedMessage).toMatchObject({
      role: "user",
      content: "model-only hook context\n\nvisible prompt",
    });
    expect(JSON.stringify(transformedMessage)).not.toContain("__openclawTranscriptPromptText");
  });

  it("keeps marked model prompt content on the wire when assembly rebuilds from ingested state", async () => {
    const agent = makeGuardableAgent();
    // DB-authoritative engine: assemble() returns what afterTurn ingested,
    // ignoring the messages passed to assemble (the lossless-claw shape).
    let ingested: AgentMessage[] = [];
    const engine = makeMockEngine({
      afterTurn: async (params) => {
        ingested = params.messages.map((message) => structuredClone(message));
      },
      assemble: async () => ({ messages: ingested, estimatedTokens: 0 }),
    });
    installHook(agent, engine, 0);

    const modelPrompt = makeUser("model-only reset bootstrap\n\nbrodie /new");
    markTranscriptPromptText(modelPrompt, "brodie /new");
    const messages = [modelPrompt, makeToolResult("call_1", "result")];
    const transformed = await callTransform(agent, messages);

    const transformedMessage = (transformed as AgentMessage[])[0];
    expect(transformedMessage).toMatchObject({
      role: "user",
      content: "model-only reset bootstrap\n\nbrodie /new",
    });
    expect(JSON.stringify(transformed)).not.toContain("__openclawTranscriptPromptText");
  });

  it("calls afterTurn and assemble when new messages are appended after the first call", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installHook(agent, engine);

    const initial = [makeUser("first"), makeToolResult("call_1", "result")];
    await callTransform(agent, initial);

    const withNew = [...initial, makeUser("second"), makeToolResult("call_2", "r2")];
    await callTransform(agent, withNew);

    expect(engine.afterTurn).toHaveBeenCalledTimes(1);
    const afterTurnParams = recordMockArg(engine.afterTurn);
    expect(afterTurnParams?.prePromptMessageCount).toBe(2);
    expect(afterTurnParams?.messages).toBe(withNew);
    expect(engine.assemble).toHaveBeenCalledTimes(1);
  });

  it("advances the fence across multiple iterations", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installHook(agent, engine);

    const batch0 = [makeUser("h1"), makeToolResult("c1", "r1")];
    await callTransform(agent, batch0);

    const batch1 = [...batch0, makeUser("h2"), makeToolResult("c2", "r2")];
    await callTransform(agent, batch1);

    const batch2 = [...batch1, makeUser("h3"), makeToolResult("c3", "r3")];
    await callTransform(agent, batch2);

    expect(engine.afterTurn).toHaveBeenCalledTimes(2);
    expect(recordMockArg(engine.afterTurn).prePromptMessageCount).toBe(2);
    expect(recordMockArg(engine.afterTurn, 1).prePromptMessageCount).toBe(4);
  });

  it("reports the latest delivered afterTurn checkpoint", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    const onAfterTurnCheckpoint = vi.fn();
    installHook(agent, engine, undefined, undefined, onAfterTurnCheckpoint);

    const batch0 = [makeUser("h1"), makeToolResult("c1", "r1")];
    await callTransform(agent, batch0);

    const batch1 = [...batch0, makeUser("h2"), makeToolResult("c2", "r2")];
    await callTransform(agent, batch1);

    expect(onAfterTurnCheckpoint).toHaveBeenCalledTimes(1);
    expect(onAfterTurnCheckpoint).toHaveBeenCalledWith(batch1.length);
  });

  it("skips afterTurn and assemble when messages have not changed", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installHook(agent, engine);

    const messages = [makeUser("first"), makeToolResult("call_1", "result")];
    await callTransform(agent, messages);
    await callTransform(agent, messages);
    await callTransform(agent, messages);

    expect(engine.afterTurn).not.toHaveBeenCalled();
    expect(engine.assemble).not.toHaveBeenCalled();
  });

  it("returns the assembled view when its length differs from the source", async () => {
    const agent = makeGuardableAgent();
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    installHook(agent, engine);

    const { transformed } = await callAfterInitialToolResult(agent, {
      includeSecondUser: false,
      firstResultText: "r",
    });

    expect(transformed).toBe(compactedView);
  });

  it("repairs tool-result pairing in ownsCompaction assembled loop views", async () => {
    const agent = makeGuardableAgent();
    const assembledView = [makeUser("compacted"), makeToolResult("call_orphan", "stale")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: assembledView, estimatedTokens: 0 }),
    });
    installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
      repairAssembledMessages: sanitizeToolUseResultPairing,
    });

    const { transformed } = await callAfterInitialToolResult(agent, {
      includeSecondUser: false,
      firstResultText: "r",
    });

    expect(transformed).toEqual([expect.objectContaining({ role: "user", content: "compacted" })]);
    expect((transformed as AgentMessage[]).some((message) => message.role === "toolResult")).toBe(
      false,
    );
  });

  it("repairs disposable same-reference ownsCompaction assembled loop views", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installContextEngineLoopHook({
      agent,
      contextEngine: engine,
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      modelId,
      repairAssembledMessages: sanitizeToolUseResultPairing,
    });

    const { transformed, withNew } = await callAfterInitialToolResult(agent, {
      includeSecondUser: false,
      firstResultText: "r",
    });

    expect(recordMockArg(engine.assemble).messages).not.toBe(withNew);
    expect(recordMockArg(engine.assemble).messages).toEqual(withNew);
    expect(transformed).not.toBe(withNew);
    expect(transformed).toEqual([expect.objectContaining({ role: "user", content: "first" })]);
    expect((transformed as AgentMessage[]).some((message) => message.role === "toolResult")).toBe(
      false,
    );
  });

  it("clears an assembled view when the engine fails on a later source", async () => {
    const agent = makeGuardableAgent();
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    engine.assemble
      .mockResolvedValueOnce({ messages: compactedView, estimatedTokens: 0 })
      .mockRejectedValueOnce(new Error("assemble failed"))
      .mockImplementation(async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
        messages: params.messages,
        estimatedTokens: 0,
      }));
    installHook(agent, engine, 1);

    const firstSource = [makeUser("first"), makeToolResult("call_1", "r1")];
    expect(await callTransform(agent, firstSource)).toBe(compactedView);

    const secondSource = [...firstSource, makeToolResult("call_2", "r2")];
    expect(await callTransform(agent, secondSource)).toBe(secondSource);

    const retry = await callTransform(agent, secondSource);
    expect(retry).toStrictEqual(secondSource);
    expect(retry).not.toBe(secondSource);
    expect(retry).not.toBe(compactedView);
    expect(engine.assemble).toHaveBeenCalledTimes(3);
  });

  it("clears an assembled view when source history shrinks", async () => {
    const agent = makeGuardableAgent();
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    engine.assemble.mockResolvedValueOnce({ messages: compactedView, estimatedTokens: 0 });
    engine.assemble.mockImplementation(
      async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
        messages: params.messages,
        estimatedTokens: 0,
      }),
    );
    installHook(agent, engine, 1);

    const longSource = [
      makeUser("first"),
      makeToolResult("call_1", "r1"),
      makeToolResult("call_2", "r2"),
    ];
    expect(await callTransform(agent, longSource)).toBe(compactedView);

    const resetSource = [makeUser("reset")];
    const reset = await callTransform(agent, resetSource);
    expect(reset).toStrictEqual(resetSource);
  });

  it("clears an assembled view when source history resets at the same length", async () => {
    const agent = makeGuardableAgent();
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    engine.assemble.mockResolvedValueOnce({ messages: compactedView, estimatedTokens: 0 });
    engine.assemble.mockImplementation(
      async (params: Parameters<ContextEngine["assemble"]>[0]) => ({
        messages: params.messages,
        estimatedTokens: 0,
      }),
    );
    installHook(agent, engine, 1);

    const source = [
      makeUser("first"),
      makeToolResult("call_1", "r1"),
      makeToolResult("call_2", "r2"),
    ];
    expect(await callTransform(agent, source)).toBe(compactedView);

    const resetSource = [makeUser("reset"), makeToolResult("call_3", "r3"), makeUser("fresh")];
    const reset = await callTransform(agent, resetSource);
    expect(reset).toStrictEqual(resetSource);
    expect(reset).not.toBe(resetSource);
  });

  it("returns the assembled view when the engine rewrites content without changing count", async () => {
    const agent = makeGuardableAgent();
    const rewrittenView = [makeUser("rewritten-1"), makeUser("rewritten-2")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: rewrittenView, estimatedTokens: 0 }),
    });
    installHook(agent, engine);

    const { transformed } = await callAfterInitialToolResult(agent, {
      includeSecondUser: false,
      firstResultText: "r",
    });

    // Same count (2) but different array reference — engine's view should be used
    expect(transformed).toBe(rewrittenView);
  });

  it("returns an equivalent disposable view when the engine returns its input reference", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine();
    installHook(agent, engine);

    const { transformed, withNew } = await callAfterInitialToolResult(agent);

    expect(transformed).not.toBe(withNew);
    expect(transformed).toEqual(withNew);
  });

  it("does not mutate the source messages array", async () => {
    const agent = makeGuardableAgent();
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    installHook(agent, engine);

    const initial = [makeUser("first"), makeToolResult("call_1", "result")];
    await callTransform(agent, initial);

    const sourceMessages = [...initial, makeUser("second"), makeToolResult("call_2", "r2")];
    const sourceCopy = [...sourceMessages];
    await callTransform(agent, sourceMessages);

    expect(sourceMessages).toEqual(sourceCopy);
  });

  it("ingests new messages in batches when afterTurn is absent", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine({ omitAfterTurn: true });
    installHook(agent, engine, undefined, undefined, undefined, true);

    const batch0 = [makeUser("first"), makeToolResult("call_1", "r1")];
    await callTransform(agent, batch0);

    const batch1 = [...batch0, makeUser("second"), makeToolResult("call_2", "r2")];
    await callTransform(agent, batch1);

    const batch2 = [...batch1, makeUser("third"), makeToolResult("call_3", "r3")];
    await callTransform(agent, batch2);

    expect(engine.ingestBatch).toHaveBeenCalledTimes(2);
    const ingestBatch = engine.ingestBatch;
    if (!ingestBatch) {
      throw new Error("expected ingestBatch mock");
    }
    expect(recordMockArg(ingestBatch).messages).toEqual(batch1.slice(2));
    expect(recordMockArg(ingestBatch).isHeartbeat).toBe(true);
    expect(recordMockArg(ingestBatch, 1).messages).toEqual(batch2.slice(4));
    expect(recordMockArg(ingestBatch, 1).isHeartbeat).toBe(true);
    expect(engine.assemble).toHaveBeenCalledTimes(2);
  });

  it("falls back to per-message ingest when ingestBatch is absent", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine({ omitAfterTurn: true, omitIngestBatch: true });
    installHook(agent, engine, 1);

    const toolResult = makeToolResult("call_1", "r1");
    const messages = [makeUser("first"), toolResult];
    await callTransform(agent, messages);

    expect(engine.ingest).toHaveBeenCalledTimes(1);
    const ingestParams = recordMockArg(engine.ingest);
    expect(ingestParams?.sessionId).toBe(sessionId);
    expect(ingestParams?.sessionKey).toBe(sessionKey);
    expect(ingestParams?.message).toBe(toolResult);
    expect(ingestParams?.isHeartbeat).toBeUndefined();
    expect(engine.assemble).toHaveBeenCalledTimes(1);
  });

  it("passes heartbeat state through per-message ingest fallbacks", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine({ omitAfterTurn: true, omitIngestBatch: true });
    installHook(agent, engine, 1, undefined, undefined, true);

    const toolResult = makeToolResult("call_1", "r1");
    const messages = [makeUser("first"), toolResult];
    await callTransform(agent, messages);

    expect(engine.ingest).toHaveBeenCalledTimes(1);
    expect(recordMockArg(engine.ingest).isHeartbeat).toBe(true);
  });

  it("falls through to source messages when engine.afterTurn throws", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine({
      afterTurn: async () => {
        throw new Error("engine afterTurn boom");
      },
    });
    installHook(agent, engine);

    const { transformed, withNew } = await callAfterInitialToolResult(agent);

    expect(transformed).toBe(withNew);
  });

  it("falls through to uncorrupted source messages when engine mutates its input then throws", async () => {
    const agent = makeGuardableAgent();
    const engine = makeMockEngine({
      assemble: async ({ messages }) => {
        (messages[0] as unknown as { content: string }).content = "corrupted by engine";
        messages.splice(1);
        throw new Error("engine assemble boom");
      },
    });
    installHook(agent, engine);

    const { transformed, withNew } = await callAfterInitialToolResult(agent);

    expect(transformed).toBe(withNew);
    expect(withNew).toHaveLength(4);
    expect((withNew[0] as unknown as { content?: unknown }).content).toBe("first");
    expect(JSON.stringify(withNew)).not.toContain("corrupted by engine");
  });

  it("invokes any pre-existing transformContext before the engine sees messages", async () => {
    const upstream = vi.fn(async (messages: AgentMessage[]) => [...messages, makeUser("appended")]);
    const agent = makeGuardableAgent(upstream);
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    installHook(agent, engine);

    // First call: upstream runs (1 msg -> 2 msgs), fence set to 2, returns early
    await callTransform(agent, [makeUser("first")]);
    expect(upstream).toHaveBeenCalledTimes(1);

    // Second call: upstream runs (2 msgs -> 3 msgs), hasNewMessages = true, assemble fires
    const transformed = await callTransform(agent, [makeUser("first"), makeUser("second")]);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(transformed).toBe(compactedView);
  });

  it("restores the previous transformContext when the returned dispose is called", () => {
    const upstream = vi.fn(async (messages: AgentMessage[]) => messages);
    const agent = makeGuardableAgent(upstream);
    const engine = makeMockEngine();
    const dispose = installHook(agent, engine);

    dispose();

    expect(agent.transformContext).toBe(upstream);
  });

  it("returns the cached assembled view on unchanged iterations instead of raw source", async () => {
    const agent = makeGuardableAgent();
    const compactedView = [makeUser("compacted")];
    const engine = makeMockEngine({
      assemble: async () => ({ messages: compactedView, estimatedTokens: 0 }),
    });
    installHook(agent, engine);

    const { withNew, transformed: firstResult } = await callAfterInitialToolResult(agent, {
      includeSecondUser: false,
      firstResultText: "r",
    });
    expect(firstResult).toBe(compactedView);

    // Retry with same messages: should return cached assembled view, not raw
    const retryResult = await callTransform(agent, withNew);
    expect(retryResult).toBe(compactedView);
    expect(engine.assemble).toHaveBeenCalledTimes(1);
  });
});
