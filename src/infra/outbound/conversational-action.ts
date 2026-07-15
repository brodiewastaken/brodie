import { Type, type TSchema } from "typebox";

export const CORE_CONVERSATIONAL_ACTIONS = ["reply", "send", "react", "silence"] as const;

export type CoreConversationalAction = (typeof CORE_CONVERSATIONAL_ACTIONS)[number];

export type ConversationalOutcome = "sent" | "reacted" | "deliberate_silence" | "implicit_silence";

export function resolveConversationalOutcome(params: {
  recorded?: ConversationalOutcome;
  stopReason?: string;
  aborted: boolean;
  timedOut: boolean;
  promptError: unknown;
}): ConversationalOutcome | undefined {
  if (params.recorded) {
    return params.recorded;
  }
  if (
    params.stopReason === "stop" &&
    !params.aborted &&
    !params.timedOut &&
    params.promptError == null
  ) {
    return "implicit_silence";
  }
  return undefined;
}

export type ConversationalBubbleReceipt = {
  bubbleIndex: number;
  channel: string;
  target: string;
  messageId: string;
  quoted: boolean;
};

export type ConversationalAuthoredReceipt = {
  authoredIndex: number;
  status: "sent" | "partial_failed" | "failed";
  bubbles: ConversationalBubbleReceipt[];
};

export type ConversationalActionReceipt = {
  status: "sent" | "partial_failed" | "failed";
  authoredMessages: ConversationalAuthoredReceipt[];
  failure?: { authoredIndex: number; bubbleIndex: number; message: string };
  warnings?: string[];
};

export type ConversationalDispatchInput = {
  action: "send" | "react";
  params: Record<string, unknown>;
  authoredIndex: number;
};

export type ConversationalDispatchResult =
  | {
      ok: true;
      bubbles: Array<{ channel: string; target: string; messageId: string }>;
      warnings?: string[];
      suppressed?: { reason: string; message: string };
    }
  | {
      ok: false;
      bubbles: Array<{ channel: string; target: string; messageId: string }>;
      error: string;
      warnings?: string[];
    };

export type ConversationalActionResult = {
  payload: Record<string, unknown> | ConversationalActionReceipt;
  terminate: boolean;
  outcome?: ConversationalOutcome;
};

export type CurrentReplyTarget = {
  channel: string;
  target: string;
  // Controller turns can retain exact route authority without a live inbound message.
  // Message-bound actions must guard this field before dispatch.
  messageId?: string;
  accountId?: string;
};

export type ConversationalActionContext = {
  currentReplyTarget?: CurrentReplyTarget;
  allowedMessageFields: ReadonlySet<string>;
  allowedReactionFields: ReadonlySet<string>;
  hasMessageContent: (params: Record<string, unknown>) => boolean;
  dispatch: (input: ConversationalDispatchInput) => Promise<ConversationalDispatchResult>;
  sanitizeVisibleMessage?: (value: string) => {
    text: string;
    suppression?: { reason: string; message: string };
  };
  validateQuote?: (params: {
    channel: string;
    target: string;
    quoteReply: string;
  }) => Promise<void>;
  recordOutcome?: (outcome: ConversationalOutcome) => void;
};

export type ConversationalActionSchemaOptions = {
  actions: ReadonlySet<string>;
  sendFields: Record<string, TSchema>;
  reactionFields: Record<string, TSchema>;
  channelTargetSchema: TSchema;
};

const LEGACY_QUOTE_FIELDS = new Set(["replyTo", "reply_to", "replyToId", "reply_to_id"]);
const EM_DASH_FAMILY_PATTERN = /[\u2013-\u2015\u2e3a\u2e3b]/u;
const EM_DASH_FAMILY_ERROR =
  "visible message text contains an em dash family character (—). rewrite the sentence without it; do not substitute a spaced hyphen. this ban is physics, not style.";
const CORE_CONTROL_FIELDS = new Set([
  "action",
  "invisibleThinking",
  "visibleMessages",
  "visibleReaction",
  "endTurn",
  "quoteReply",
  "channel",
  "target",
  "messageId",
  "accountId",
  "remove",
]);

export interface ConversationalAction {
  buildSchemas(options: ConversationalActionSchemaOptions): TSchema[];
  execute(
    input: unknown,
    context: ConversationalActionContext,
  ): Promise<ConversationalActionResult>;
}

class AtomicConversationalAction implements ConversationalAction {
  buildSchemas(options: ConversationalActionSchemaOptions): TSchema[] {
    const schemas: TSchema[] = [];
    const authoredFields = {
      invisibleThinking: Type.String({ minLength: 1 }),
      visibleMessages: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 9 })),
      endTurn: Type.Boolean(),
    };
    const sendFields = { ...options.sendFields };
    for (const retiredOrOwnedField of ["message", "replyTo", "quoteText", "threadId"]) {
      delete sendFields[retiredOrOwnedField];
    }
    if (options.actions.has("reply")) {
      schemas.push(
        Type.Object(
          {
            action: Type.Literal("reply"),
            ...authoredFields,
            quoteReply: Type.Optional(Type.String({ minLength: 1 })),
            ...sendFields,
          },
          { additionalProperties: false },
        ),
      );
    }
    if (options.actions.has("send")) {
      schemas.push(
        Type.Object(
          {
            action: Type.Literal("send"),
            channel: Type.String({ minLength: 1 }),
            target: options.channelTargetSchema,
            accountId: Type.Optional(Type.String({ minLength: 1 })),
            ...authoredFields,
            quoteReply: Type.Optional(Type.String({ minLength: 1 })),
            ...sendFields,
          },
          { additionalProperties: false },
        ),
      );
    }
    if (options.actions.has("react")) {
      schemas.push(
        Type.Object(
          {
            action: Type.Literal("react"),
            invisibleThinking: Type.String({ minLength: 1 }),
            visibleReaction: Type.String({ minLength: 1 }),
            endTurn: Type.Boolean(),
            channel: Type.Optional(Type.String({ minLength: 1 })),
            target: Type.Optional(options.channelTargetSchema),
            messageId: Type.Optional(Type.String({ minLength: 1 })),
            accountId: Type.Optional(Type.String({ minLength: 1 })),
            remove: Type.Optional(Type.Boolean()),
            ...options.reactionFields,
          },
          { additionalProperties: false },
        ),
      );
    }
    if (options.actions.has("silence")) {
      schemas.push(
        Type.Object(
          {
            action: Type.Literal("silence"),
            invisibleThinking: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
      );
    }
    return schemas;
  }

  async execute(
    input: unknown,
    context: ConversationalActionContext,
  ): Promise<ConversationalActionResult> {
    const params = readRecord(input);
    const action = readAction(params.action);
    requireInvisibleThinking(params.invisibleThinking);
    rejectLegacyQuoteFields(params);

    if (action === "silence") {
      assertOnlyFields(params, new Set(["action", "invisibleThinking"]), action);
      context.recordOutcome?.("deliberate_silence");
      return {
        payload: { status: "silent", outcome: "deliberate_silence" },
        terminate: true,
        outcome: "deliberate_silence",
      };
    }

    if (action === "react") {
      return await this.executeReaction(params, context);
    }

    return await this.executeMessages(action, params, context);
  }

  private async executeReaction(
    params: Record<string, unknown>,
    context: ConversationalActionContext,
  ): Promise<ConversationalActionResult> {
    const allowed = new Set([
      "action",
      "invisibleThinking",
      "visibleReaction",
      "endTurn",
      "channel",
      "target",
      "messageId",
      "accountId",
      "remove",
      ...context.allowedReactionFields,
    ]);
    assertOnlyFields(params, allowed, "react");
    const visibleReaction = readNonblank(params.visibleReaction, "react visibleReaction");
    rejectEmDashFamily(visibleReaction);
    const endTurn = readBoolean(params.endTurn, "react endTurn");
    const explicitRoute =
      params.channel !== undefined || params.target !== undefined || params.accountId !== undefined;
    let channel: string;
    let target: string;
    let messageId: string;
    let accountId: string | undefined;
    let dispatchMessageId = true;
    if (explicitRoute) {
      channel = readNonblank(params.channel, "react channel");
      target = readNonblank(params.target, "react target");
      messageId = readNonblank(params.messageId, "react messageId");
      accountId = readOptionalNonblank(params.accountId, "react accountId");
    } else {
      const current = context.currentReplyTarget;
      if (!current) {
        throw new Error("react requires authoritative inbound context or full explicit routing");
      }
      channel = current.channel;
      target = current.target;
      accountId = current.accountId;
      if (params.messageId !== undefined) {
        messageId = readNonblank(params.messageId, "react messageId");
      } else {
        if (!current.messageId?.trim()) {
          throw new Error("react requires a current inbound message id or an explicit messageId");
        }
        messageId = current.messageId;
        dispatchMessageId = false;
      }
    }
    const extras = extractMessageExtras(params, context.allowedReactionFields);
    const result = await context.dispatch({
      action: "react",
      authoredIndex: 0,
      params: {
        action: "react",
        channel,
        target,
        ...(dispatchMessageId ? { messageId } : {}),
        ...(accountId ? { accountId } : {}),
        emoji: visibleReaction,
        ...(params.remove === true ? { remove: true } : {}),
        ...extras,
      },
    });
    if (!result.ok) {
      return {
        payload: buildFailureReceipt(result, 0),
        terminate: false,
      };
    }
    const outcome = "reacted" as const;
    if (endTurn) {
      context.recordOutcome?.(outcome);
    }
    return {
      payload: {
        status: "reacted",
        messageId,
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      },
      terminate: endTurn,
      outcome,
    };
  }

  private async executeMessages(
    action: "reply" | "send",
    params: Record<string, unknown>,
    context: ConversationalActionContext,
  ): Promise<ConversationalActionResult> {
    const allowed = new Set([
      "action",
      "invisibleThinking",
      "visibleMessages",
      "endTurn",
      "quoteReply",
      ...(action === "send" ? ["channel", "target", "accountId"] : []),
      ...context.allowedMessageFields,
    ]);
    assertOnlyFields(params, allowed, action);
    const endTurn = readBoolean(params.endTurn, `${action} endTurn`);
    const extras = extractMessageExtras(params, context.allowedMessageFields);
    const visible = readVisibleMessages(params.visibleMessages, action, context);
    const hasMessageContent = context.hasMessageContent(extras);
    if (visible.suppression && !hasMessageContent) {
      return {
        payload: { status: "suppressed", ...visible.suppression },
        terminate: false,
      };
    }
    const visibleMessages = visible.messages;
    const quoteReply = readOptionalNonblank(params.quoteReply, `${action} quoteReply`);
    const route = resolveMessageRoute(action, params, context.currentReplyTarget);
    if (visibleMessages.length === 0 && !hasMessageContent) {
      throw new Error(`${action} requires visibleMessages or media or rich content`);
    }
    if (quoteReply) {
      if (action === "reply" && !context.currentReplyTarget?.messageId?.trim()) {
        throw new Error("reply quoteReply requires a current inbound message id");
      }
      if (!context.validateQuote) {
        throw new Error(`${action} quote validation is unavailable`);
      }
      await context.validateQuote({ ...route, quoteReply });
    }

    const authoredMessages = visibleMessages.length > 0 ? visibleMessages : [""];
    const receipt: ConversationalActionReceipt = { status: "sent", authoredMessages: [] };
    const warnings: string[] = [];
    if (visible.suppression) {
      warnings.push(visible.suppression.message);
    }
    let deliveredBubbleCount = 0;

    for (const [authoredIndex, message] of authoredMessages.entries()) {
      const dispatchParams: Record<string, unknown> = {
        action: "send",
        channel: route.channel,
        target: route.target,
        ...(route.accountId ? { accountId: route.accountId } : {}),
        message,
        ...(authoredIndex === 0 ? extras : {}),
        ...(quoteReply && authoredIndex === 0 ? { replyTo: quoteReply, quoteOnce: true } : {}),
      };
      let result: ConversationalDispatchResult;
      try {
        result = await context.dispatch({ action: "send", params: dispatchParams, authoredIndex });
      } catch (error) {
        result = { ok: false, bubbles: [], error: errorMessage(error) };
      }
      if (result.warnings) {
        warnings.push(...result.warnings);
      }
      if (result.ok && result.suppressed) {
        return {
          payload: {
            status: "suppressed",
            reason: result.suppressed.reason,
            message: result.suppressed.message,
          },
          terminate: false,
        };
      }
      const bubbles = result.bubbles.map((bubble, bubbleIndex) => ({
        bubbleIndex,
        ...bubble,
        quoted: Boolean(quoteReply) && deliveredBubbleCount + bubbleIndex === 0,
      }));
      deliveredBubbleCount += bubbles.length;
      if (!result.ok) {
        receipt.authoredMessages.push({
          authoredIndex,
          status: bubbles.length > 0 ? "partial_failed" : "failed",
          bubbles,
        });
        receipt.status = deliveredBubbleCount > 0 ? "partial_failed" : "failed";
        receipt.failure = {
          authoredIndex,
          bubbleIndex: bubbles.length,
          message: result.error,
        };
        break;
      }
      receipt.authoredMessages.push({ authoredIndex, status: "sent", bubbles });
    }

    if (warnings.length > 0) {
      receipt.warnings = warnings;
    }
    if (receipt.status !== "sent") {
      return { payload: receipt, terminate: false };
    }
    const outcome = "sent" as const;
    if (endTurn) {
      context.recordOutcome?.(outcome);
    }
    return { payload: receipt, terminate: endTurn, outcome };
  }
}

function readRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("conversational action must be an object");
  }
  return input as Record<string, unknown>;
}

function readAction(value: unknown): CoreConversationalAction {
  if (
    typeof value !== "string" ||
    !CORE_CONVERSATIONAL_ACTIONS.includes(value as CoreConversationalAction)
  ) {
    throw new Error("unsupported conversational action");
  }
  return value as CoreConversationalAction;
}

function requireInvisibleThinking(value: unknown): void {
  readNonblank(value, "invisibleThinking");
}

function readNonblank(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be non-blank text`);
  }
  return value;
}

function readOptionalNonblank(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readNonblank(value, label);
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be boolean`);
  }
  return value;
}

function rejectEmDashFamily(value: string): void {
  if (EM_DASH_FAMILY_PATTERN.test(value)) {
    throw new Error(EM_DASH_FAMILY_ERROR);
  }
}

function rejectLegacyQuoteFields(params: Record<string, unknown>): void {
  for (const key of LEGACY_QUOTE_FIELDS) {
    if (key in params) {
      throw new Error(`${key} is retired; use quoteReply`);
    }
  }
}

function assertOnlyFields(
  params: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  action: string,
): void {
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      throw new Error(`${action} does not accept ${key}`);
    }
  }
}

function readVisibleMessages(
  value: unknown,
  action: "reply" | "send",
  context: ConversationalActionContext,
): { messages: string[]; suppression?: { reason: string; message: string } } {
  if (value === undefined) {
    return { messages: [] };
  }
  if (!Array.isArray(value)) {
    throw new Error(`${action} visibleMessages must be an array`);
  }
  if (value.length > 9) {
    throw new Error(`${action} visibleMessages accepts at most 9 items`);
  }
  const messages: string[] = [];
  for (const [index, entry] of value.entries()) {
    const visible = readNonblank(entry, `${action} visibleMessages[${index}]`);
    rejectEmDashFamily(visible);
    const sanitized = context.sanitizeVisibleMessage?.(visible) ?? { text: visible };
    if (sanitized.suppression || !sanitized.text.trim()) {
      return {
        messages: [],
        suppression: sanitized.suppression ?? {
          reason: "output_safety",
          message: "Suppressed outbound message text after output safety filtering.",
        },
      };
    }
    rejectEmDashFamily(sanitized.text);
    messages.push(sanitized.text);
  }
  return { messages };
}

function resolveMessageRoute(
  action: "reply" | "send",
  params: Record<string, unknown>,
  current: CurrentReplyTarget | undefined,
): { channel: string; target: string; accountId?: string } {
  if (action === "reply") {
    if (!current) {
      throw new Error("reply requires authoritative inbound context");
    }
    return {
      channel: current.channel,
      target: current.target,
      ...(current.accountId ? { accountId: current.accountId } : {}),
    };
  }
  return {
    channel: readNonblank(params.channel, "send channel"),
    target: readNonblank(params.target, "send target"),
    ...(params.accountId !== undefined
      ? { accountId: readNonblank(params.accountId, "send accountId") }
      : {}),
  };
}

function extractMessageExtras(
  params: Record<string, unknown>,
  allowedMessageFields: ReadonlySet<string>,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const key of allowedMessageFields) {
    if (!CORE_CONTROL_FIELDS.has(key) && params[key] !== undefined) {
      extras[key] = params[key];
    }
  }
  return extras;
}

function buildFailureReceipt(
  result: Extract<ConversationalDispatchResult, { ok: false }>,
  authoredIndex: number,
): ConversationalActionReceipt {
  const bubbles = result.bubbles.map((bubble, bubbleIndex) => ({
    bubbleIndex,
    ...bubble,
    quoted: false,
  }));
  return {
    status: bubbles.length > 0 ? "partial_failed" : "failed",
    authoredMessages: [
      {
        authoredIndex,
        status: bubbles.length > 0 ? "partial_failed" : "failed",
        bubbles,
      },
    ],
    failure: { authoredIndex, bubbleIndex: bubbles.length, message: result.error },
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createConversationalAction(): ConversationalAction {
  return new AtomicConversationalAction();
}
