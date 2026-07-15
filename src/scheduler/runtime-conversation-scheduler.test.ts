import { describe, expect, it, vi } from "vitest";
import { markReplyPayloadForSourceSuppressionDelivery } from "../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ConversationRoute } from "../routing/conversation-route.js";
import {
  buildCanonicalConversationLaneKey,
  buildCanonicalConversationSessionKey,
} from "../routing/session-key.js";
import type {
  ScheduledEvent,
  SchedulerDispatchBatch,
  SchedulerInterruptedAttempt,
} from "./conversation-scheduler.js";
import type { HumanInboundEventPayload } from "./human-inbound.js";
import { runtimeConversationSchedulerTesting } from "./runtime-conversation-scheduler.js";
import { buildRuntimeProducerStartedEvidence } from "./runtime-producer-admission.js";

const route: ConversationRoute = {
  channel: "whatsapp",
  accountId: "brodie",
  conversationKind: "group",
  conversationId: "room",
  sessionKey: "agent:main:conversation:test:default:channel:room",
  queueLaneKey: "lane:room",
  transcriptOwner: {
    agentId: "main",
    sessionKey: "agent:main:conversation:test:default:channel:room",
  },
};

function scheduled(
  id: string,
  body: string,
  media: HumanInboundEventPayload["media"] = [],
): ScheduledEvent & { receiptId: string; sequence: number } {
  return {
    id,
    route,
    producerKind: "human_message",
    createdAt: 1_000,
    human: true,
    media: media.length > 0,
    receiptId: `receipt-${id}`,
    sequence: Number(id),
    payload: {
      version: 1,
      channel: "whatsapp",
      accountId: "brodie",
      conversationId: "room",
      sessionKey: route.sessionKey,
      messageId: `message-${id}`,
      receivedAt: 1_000 + Number(id),
      chatType: "group",
      duoRoom: true,
      sender: { id: "owner", name: "Abhay" },
      body,
      bodyForAgent: body,
      commandBody: body,
      commandAuthorized: false,
      wasMentioned: id === "1",
      media,
      conversation: {
        channel: "whatsapp",
        conversationType: "group",
        sessionKey: route.sessionKey,
      },
      nativeMetadata: {},
    },
  };
}

function interruptedAttempt(runCorrelationId = "run-1"): SchedulerInterruptedAttempt {
  return {
    attemptId: "attempt-1",
    laneKey: route.queueLaneKey,
    runCorrelationId,
    events: [scheduled("1", "first")],
  };
}

function dispatchBatch(): SchedulerDispatchBatch & {
  correlations: string[];
  starts: string[];
  outcomes: Array<{ outcome: string; evidence: string }>;
} {
  const correlations: string[] = [];
  const starts: string[] = [];
  const outcomes: Array<{ outcome: string; evidence: string }> = [];
  return {
    attemptId: "attempt",
    placement: "idle",
    events: [scheduled("1", "first")],
    correlations,
    starts,
    outcomes,
    recordRunCorrelationId: (runCorrelationId) => correlations.push(runCorrelationId),
    recordRunStarted: (evidence) => starts.push(evidence),
    recordRunTerminalOutcome: (outcome, evidence) => outcomes.push({ outcome, evidence }),
  };
}

describe("runtime conversation scheduler", () => {
  it("reconstructs an exact canonical route for lifecycle cancellation", () => {
    const canonicalRoute: ConversationRoute = {
      channel: "whatsapp",
      accountId: "brodie",
      conversationKind: "group",
      conversationId: "🤙🏽 room",
      threadId: "thread:1",
      sessionKey: "",
      queueLaneKey: "",
      transcriptOwner: { agentId: "main", sessionKey: "" },
    };
    const sessionKey = buildCanonicalConversationSessionKey({
      agentId: "main",
      ...canonicalRoute,
    });
    expect(
      runtimeConversationSchedulerTesting.resolveCanonicalRouteForSessionKey(sessionKey),
    ).toEqual({
      ...canonicalRoute,
      sessionKey,
      queueLaneKey: buildCanonicalConversationLaneKey(canonicalRoute),
      transcriptOwner: { agentId: "main", sessionKey },
    });
    expect(
      runtimeConversationSchedulerTesting.resolveCanonicalRouteForSessionKey("agent:main:main"),
    ).toBeUndefined();
  });

  it("rekeys only nested controller completions onto internal lanes", () => {
    const nestedSessionKey = "agent:main:subagent:nested-controller";
    const completion = {
      ...scheduled("1", "completion"),
      human: false,
      producerKind: "subagent_completion" as const,
      route: {
        ...route,
        sessionKey: nestedSessionKey,
        transcriptOwner: { agentId: "main", sessionKey: nestedSessionKey },
      },
    };

    expect(
      runtimeConversationSchedulerTesting.resolveDurableRuntimeProducerRoute(completion),
    ).toMatchObject({
      channel: "internal",
      accountId: "main",
      conversationId: nestedSessionKey,
      sessionKey: nestedSessionKey,
    });
    expect(
      runtimeConversationSchedulerTesting.resolveDurableRuntimeProducerRoute({
        ...completion,
        route: {
          ...completion.route,
          sessionKey: "agent:main:main",
          transcriptOwner: { agentId: "main", sessionKey: "agent:main:main" },
        },
      }),
    ).toBeUndefined();
  });

  it("owns only supported human channel envelopes", () => {
    expect(runtimeConversationSchedulerTesting.isOwnedHumanEvent(scheduled("1", "first"))).toBe(
      true,
    );
    expect(
      runtimeConversationSchedulerTesting.isOwnedHumanEvent({
        ...scheduled("1", "first"),
        human: false,
        producerKind: "cron",
      }),
    ).toBe(false);
    expect(
      runtimeConversationSchedulerTesting.isOwnedHumanEvent({
        ...scheduled("1", "first"),
        payload: { channel: "unknown" },
      }),
    ).toBe(false);
  });

  it("rehydrates adapter-owned thread context for an idle scheduled turn", () => {
    const event = scheduled("1", "current message");
    event.payload = {
      ...(event.payload as HumanInboundEventPayload),
      supplemental: {
        thread: {
          starterBody: "thread starter",
          historyBody: "older human and bot messages",
          label: "Slack thread #project-room: thread starter",
        },
      },
    } as unknown as ScheduledEvent["payload"];
    const batch = dispatchBatch();
    batch.events = [event];

    const ctx = runtimeConversationSchedulerTesting.buildScheduledBatchContext(batch, {});

    expect(ctx.ThreadStarterBody).toBe("thread starter");
    expect(ctx.ThreadHistoryBody).toBe("older human and bot messages");
    expect(ctx.ThreadLabel).toBe("Slack thread #project-room: thread starter");
  });

  it("renders one ordered model turn with canonical delivery facts", () => {
    const batch: SchedulerDispatchBatch = {
      attemptId: "attempt",
      placement: "idle",
      events: [scheduled("1", "first"), scheduled("2", "second")],
    };
    const ctx = runtimeConversationSchedulerTesting.buildScheduledBatchContext(batch, {});

    expect(ctx).toMatchObject({
      SessionKey: route.sessionKey,
      AccountId: "brodie",
      ChatType: "group",
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "room",
      ExplicitDeliverRoute: true,
      MessageSids: ["message-1", "message-2"],
      MessageSidFirst: "message-1",
      MessageSidLast: "message-2",
      WasMentioned: true,
      InputProvenance: { kind: "external_user", sourceChannel: "whatsapp" },
    });
    expect(ctx.BodyForAgent).toContain("[📋 QUEUE ENGINE]");
    expect(ctx.BodyForAgent).toContain(
      "THE FOLLOWING MESSAGES ARRIVED IN QUICK SUCCESSION WHILE YOU WERE IDLE",
    );
    expect(ctx.BodyForAgent).toContain("[Inbound #1]: [Abhay]");
    expect(ctx.BodyForAgent).toContain("```text\nfirst\n```");
    expect(ctx.BodyForAgent).toContain("[Inbound #2]: [Abhay]");
    expect(ctx.BodyForAgent).toContain("```text\nsecond\n```");
    expect(ctx.GroupSystemPrompt).toContain("must later call the message tool");
  });

  it("preserves ambient room-event semantics through scheduler dispatch", () => {
    const event = scheduled("1", "ambient note");
    event.payload = {
      ...(event.payload as HumanInboundEventPayload),
      inboundEventKind: "room_event",
      wasMentioned: false,
    } as unknown as ScheduledEvent["payload"];
    const batch = dispatchBatch();
    batch.events = [event];

    const ctx = runtimeConversationSchedulerTesting.buildScheduledBatchContext(batch, {});

    expect(ctx.InboundEventKind).toBe("room_event");
    expect(ctx.GroupSystemPrompt).toContain("default to no response");
    expect(ctx.GroupSystemPrompt).not.toContain("must later call the message tool");
    expect(ctx.BodyForAgent).toContain("[ROOM EVENT]");
    expect(ctx.BodyForAgent).toContain("[NOT MENTIONED]");
  });

  it("settles delivery plus deliberate and implicit silence as successful outcomes", () => {
    const batch: SchedulerDispatchBatch = {
      attemptId: "attempt",
      placement: "idle",
      events: [scheduled("1", "first")],
    };

    expect(
      runtimeConversationSchedulerTesting.resolveOwnedBatchResult({
        batch,
        runCorrelationId: "run",
        runStarted: true,
        observedReplyDelivery: true,
        conversationOutcome: "sent",
      }),
    ).toMatchObject({ outcome: "sent", runCorrelationId: "run" });
    expect(
      runtimeConversationSchedulerTesting.resolveOwnedBatchResult({
        batch,
        runCorrelationId: "run",
        runStarted: true,
        observedReplyDelivery: false,
        conversationOutcome: "deliberate_silence",
      }),
    ).toMatchObject({ outcome: "deliberate_silence", runCorrelationId: "run" });
    expect(
      runtimeConversationSchedulerTesting.resolveOwnedBatchResult({
        batch,
        runCorrelationId: "run",
        runStarted: true,
        observedReplyDelivery: false,
        conversationOutcome: "implicit_silence",
      }),
    ).toMatchObject({ outcome: "implicit_silence", runCorrelationId: "run" });
    expect(
      runtimeConversationSchedulerTesting.resolveOwnedBatchResult({
        batch,
        runCorrelationId: "run",
        runStarted: false,
        observedReplyDelivery: false,
      }),
    ).toMatchObject({ outcome: "failed", failure: { kind: "source_run_not_started" } });
  });

  it("persists the scheduler attempt as the run correlation before model dispatch", () => {
    const correlations: string[] = [];
    const batch: SchedulerDispatchBatch = {
      attemptId: "attempt-before-model",
      placement: "idle",
      events: [scheduled("1", "first")],
      recordRunCorrelationId: (runCorrelationId) => correlations.push(runCorrelationId),
    };

    expect(runtimeConversationSchedulerTesting.beginOwnedBatchRun(batch)).toBe(
      "attempt-before-model",
    );
    expect(correlations).toEqual(["attempt-before-model"]);
  });

  it("keeps an enqueued owned run open through exact terminal persistence", async () => {
    const batch = dispatchBatch();
    const cfg: OpenClawConfig = {};
    let releaseQueuedRun!: () => void;
    const queuedRun = new Promise<void>((resolve) => {
      releaseQueuedRun = resolve;
    });
    const dispatch = runtimeConversationSchedulerTesting.dispatchOwnedBatchWithReply({
      batch,
      cfg,
      getReply: async (_ctx, opts) => {
        opts.queuedFollowupLifecycle?.onEnqueued?.();
        void queuedRun.then(async () => {
          opts.onAgentRunStart?.("attempt");
          await opts.onConversationOutcome?.("implicit_silence");
          opts.queuedFollowupLifecycle?.onComplete?.();
        });
      },
    });

    let settled = false;
    void dispatch.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseQueuedRun();
    await expect(dispatch).resolves.toMatchObject({
      outcome: "implicit_silence",
      runCorrelationId: "attempt",
    });
    const startedEvidence = runtimeConversationSchedulerTesting.buildOwnedRunStartedEvidence({
      sessionKey: route.sessionKey,
      runCorrelationId: "attempt",
    });
    const terminalEvidence = runtimeConversationSchedulerTesting.buildOwnedRunTerminalEvidence({
      sessionKey: route.sessionKey,
      runCorrelationId: "attempt",
      outcome: "implicit_silence",
    });
    expect(batch.correlations).toEqual(["attempt"]);
    expect(batch.starts).toEqual([startedEvidence]);
    expect(batch.outcomes).toEqual([{ outcome: "implicit_silence", evidence: terminalEvidence }]);
  });

  it("settles a message-tool endTurn reaction as a successful scheduler outcome", async () => {
    const batch = dispatchBatch();

    await expect(
      runtimeConversationSchedulerTesting.dispatchOwnedBatchWithReply({
        batch,
        cfg: {},
        getReply: async (_ctx, opts) => {
          opts.onAgentRunStart?.("attempt");
          await opts.onConversationOutcome?.("reacted");
        },
      }),
    ).resolves.toMatchObject({
      outcome: "reacted",
      runCorrelationId: "attempt",
    });
    expect(batch.outcomes).toEqual([
      {
        outcome: "reacted",
        evidence: runtimeConversationSchedulerTesting.buildOwnedRunTerminalEvidence({
          sessionKey: route.sessionKey,
          runCorrelationId: "attempt",
          outcome: "reacted",
        }),
      },
    ]);
  });

  it("delivers a returned terminal failure after a provisional-only run", async () => {
    const batch = dispatchBatch();
    const currentReplyTarget = {
      channel: "whatsapp",
      accountId: "brodie",
      target: "120363400000000000@g.us",
      messageId: "message-1",
    };
    batch.events = [
      {
        ...batch.events[0]!,
        route: { ...batch.events[0]!.route, currentReplyTarget },
      },
    ];
    const deliverReturnedReply = vi.fn(async () => true);

    await expect(
      runtimeConversationSchedulerTesting.dispatchOwnedBatchWithReply({
        batch,
        cfg: {},
        deliverReturnedReply,
        getReply: async (_ctx, opts) => {
          opts.onAgentRunStart?.("attempt");
          return {
            text: "terminal failure",
            isAgentRunFailure: true,
          };
        },
      }),
    ).resolves.toMatchObject({
      outcome: "sent",
      runCorrelationId: "attempt",
    });
    expect(deliverReturnedReply).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ isAgentRunFailure: true }),
        target: currentReplyTarget,
        runCorrelationId: "attempt",
      }),
    );
    expect(batch.outcomes.at(-1)).toEqual({
      outcome: "sent",
      evidence: runtimeConversationSchedulerTesting.buildOwnedRunTerminalEvidence({
        sessionKey: route.sessionKey,
        runCorrelationId: "attempt",
        outcome: "sent",
      }),
    });
  });

  it("does not settle a returned terminal failure without a provider receipt", async () => {
    const batch = dispatchBatch();
    batch.events = [
      {
        ...batch.events[0]!,
        route: {
          ...batch.events[0]!.route,
          currentReplyTarget: {
            channel: "whatsapp",
            accountId: "brodie",
            target: "120363400000000000@g.us",
            messageId: "message-1",
          },
        },
      },
    ];

    await expect(
      runtimeConversationSchedulerTesting.dispatchOwnedBatchWithReply({
        batch,
        cfg: {},
        deliverReturnedReply: async () => false,
        getReply: async (_ctx, opts) => {
          opts.onAgentRunStart?.("attempt");
          return {
            text: "terminal failure",
            isAgentRunFailure: true,
          };
        },
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      runCorrelationId: "attempt",
      failure: { kind: "source_run_missing_terminal_outcome" },
    });
    expect(batch.outcomes).toEqual([]);
  });

  it("does not credit a fallback notice when the terminal failure delivery fails", async () => {
    const batch = dispatchBatch();
    batch.events = [
      {
        ...batch.events[0]!,
        route: {
          ...batch.events[0]!.route,
          currentReplyTarget: {
            channel: "whatsapp",
            accountId: "brodie",
            target: "120363400000000000@g.us",
            messageId: "message-1",
          },
        },
      },
    ];

    await expect(
      runtimeConversationSchedulerTesting.dispatchOwnedBatchWithReply({
        batch,
        cfg: {},
        deliverReturnedReply: async ({ payload }) => payload.isFallbackNotice === true,
        getReply: async (_ctx, opts) => {
          opts.onAgentRunStart?.("attempt");
          return [
            markReplyPayloadForSourceSuppressionDelivery({
              text: "fallback active",
              isFallbackNotice: true,
            }),
            { text: "terminal failure", isAgentRunFailure: true },
          ];
        },
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      runCorrelationId: "attempt",
      failure: { kind: "source_run_missing_terminal_outcome" },
    });
    expect(batch.outcomes).toEqual([]);
  });

  it("keeps a fallback notice out of terminal delivery evidence", async () => {
    const batch = dispatchBatch();
    batch.events = [
      {
        ...batch.events[0]!,
        route: {
          ...batch.events[0]!.route,
          currentReplyTarget: {
            channel: "whatsapp",
            accountId: "brodie",
            target: "120363400000000000@g.us",
            messageId: "message-1",
          },
        },
      },
    ];

    await expect(
      runtimeConversationSchedulerTesting.dispatchOwnedBatchWithReply({
        batch,
        cfg: {},
        deliverReturnedReply: async () => true,
        getReply: async (_ctx, opts) => {
          opts.onAgentRunStart?.("attempt");
          await opts.onConversationOutcome?.("implicit_silence");
          return markReplyPayloadForSourceSuppressionDelivery({
            text: "fallback active",
            isFallbackNotice: true,
          });
        },
      }),
    ).resolves.toMatchObject({
      outcome: "implicit_silence",
      runCorrelationId: "attempt",
    });
    expect(batch.outcomes.at(-1)?.outcome).toBe("implicit_silence");
  });

  it("drives reply typing from the exact persisted current reply target", async () => {
    const batch = dispatchBatch();
    const currentReplyTarget = {
      channel: "whatsapp",
      accountId: "brodie",
      target: "120363400000000000@g.us",
      messageId: "message-1",
    };
    batch.events = [
      {
        ...batch.events[0]!,
        route: { ...batch.events[0]!.route, currentReplyTarget },
      },
    ];
    const onReplyStart = vi.fn(async () => undefined);
    const onTypingCleanup = vi.fn();
    const resolveTypingCallbacks = vi.fn(() => ({ onReplyStart, onTypingCleanup }));

    await runtimeConversationSchedulerTesting.dispatchOwnedBatchWithReply({
      batch,
      cfg: {},
      resolveTypingCallbacks,
      getReply: async (_ctx, opts) => {
        expect(opts.onReplyStart).toBe(onReplyStart);
        expect(opts.onTypingCleanup).toBe(onTypingCleanup);
        opts.onAgentRunStart?.("attempt");
        await opts.onConversationOutcome?.("implicit_silence");
      },
    });

    expect(resolveTypingCallbacks).toHaveBeenCalledWith({
      cfg: {},
      target: currentReplyTarget,
    });
  });

  it("does not invent typing callbacks without an exact current reply target", async () => {
    const resolveTypingCallbacks = vi.fn();

    await runtimeConversationSchedulerTesting.dispatchOwnedBatchWithReply({
      batch: dispatchBatch(),
      cfg: {},
      resolveTypingCallbacks,
      getReply: async (_ctx, opts) => {
        expect(opts.onReplyStart).toBeUndefined();
        expect(opts.onTypingCleanup).toBeUndefined();
        opts.onAgentRunStart?.("attempt");
        await opts.onConversationOutcome?.("implicit_silence");
      },
    });

    expect(resolveTypingCallbacks).not.toHaveBeenCalled();
  });

  it("projects exact typing identity and isolates adapter failures", async () => {
    const sendTyping = vi.fn(async () => {
      throw new Error("typing unavailable");
    });
    const clearTyping = vi.fn(async () => {
      throw new Error("typing clear unavailable");
    });
    const callbacks = runtimeConversationSchedulerTesting.resolveReplyTypingCallbacks({
      cfg: {},
      target: {
        channel: "whatsapp",
        accountId: "brodie",
        target: "120363400000000000@g.us",
        messageId: "message-1",
        threadId: "thread-1",
      },
      resolvePlugin: () => ({ heartbeat: { sendTyping, clearTyping } }) as never,
    });

    await expect(callbacks?.onReplyStart?.()).resolves.toBeUndefined();
    expect(() => callbacks?.onTypingCleanup?.()).not.toThrow();
    expect(sendTyping).toHaveBeenCalledWith({
      cfg: {},
      to: "120363400000000000@g.us",
      accountId: "brodie",
      threadId: "thread-1",
    });
    expect(clearTyping).toHaveBeenCalledWith({
      cfg: {},
      to: "120363400000000000@g.us",
      accountId: "brodie",
      threadId: "thread-1",
    });
  });

  it("stays inert when the selected channel has no typing adapter", () => {
    expect(
      runtimeConversationSchedulerTesting.resolveReplyTypingCallbacks({
        cfg: {},
        target: {
          channel: "missing",
          target: "somewhere",
          messageId: "message-1",
        },
        resolvePlugin: () => undefined,
      }),
    ).toBeUndefined();
  });

  it("injects one typed image batch after a tool result into the exact active run", async () => {
    const batch = dispatchBatch();
    const image = {
      kind: "image" as const,
      mimeType: "image/png",
      managedLocalPath: "/tmp/injected.png",
      sourceMessageId: "message-2",
      sourceIndex: 0,
      understanding: [],
    };
    batch.claimMidTurnHumanEvents = async () => [
      scheduled("2", "second", [image]),
      scheduled("3", "third"),
    ];
    const queued: Array<{ runId: string; text: string; images: unknown[]; message: unknown }> = [];

    await expect(
      runtimeConversationSchedulerTesting.dispatchOwnedBatchWithReply({
        batch,
        cfg: {},
        resolveActiveRunNativeImagePolicy: () => ({
          maxNativeImages: 1,
          omissionReason: "policy_ceiling",
        }),
        resolveMidTurnImages: async () => ({
          images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
          nativeImageInputs: [
            {
              attachmentIndex: 0,
              sourceMessageId: "message-2",
              sourceIndex: 0,
              contentHash: "sha256:image",
            },
          ],
        }),
        queueActiveRun: async (runId, text, options) => {
          queued.push({
            runId,
            text,
            images: options.images ?? [],
            message: await options.userTurnTranscriptRecorder.resolveMessage(),
          });
          return true;
        },
        getReply: async (_ctx, opts) => {
          opts.onAgentRunStart?.("attempt");
          await opts.onToolStreamBoundary?.();
          await opts.onConversationOutcome?.("implicit_silence");
        },
      }),
    ).resolves.toMatchObject({ outcome: "implicit_silence" });

    expect(queued).toHaveLength(1);
    expect(queued[0]?.runId).toBe("attempt");
    expect(queued[0]?.text).toContain("WHILE YOU WERE MID TURN");
    expect(queued[0]?.text).toContain("[Inbound #1]: [Abhay]");
    expect(queued[0]?.text).toContain("[Inbound #2]: [Abhay]");
    expect(queued[0]?.images).toEqual([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
    expect(queued[0]?.message).toMatchObject({
      role: "user",
      content: expect.stringContaining("WHILE YOU WERE MID TURN"),
      openclawSourceMessage: { text: "second\nthird" },
      __openclaw: {
        humanInboundBatch: {
          placement: "mid_turn_post_tool_result",
          inbounds: [
            { media: [{ nativeImageCandidate: { contentHash: "sha256:image" } }] },
            { media: [] },
          ],
        },
      },
    });
  });

  it("releases a mid-turn claim when injection preparation fails", async () => {
    const batch = dispatchBatch();
    const claimed = [scheduled("2", "second")];
    const released: string[][] = [];
    batch.claimMidTurnHumanEvents = async () => claimed;
    batch.releaseMidTurnHumanEvents = async (eventIds) => {
      released.push([...eventIds]);
    };

    await expect(
      runtimeConversationSchedulerTesting.dispatchOwnedBatchWithReply({
        batch,
        cfg: {},
        resolveActiveRunNativeImagePolicy: () => ({
          maxNativeImages: 1,
          omissionReason: "policy_ceiling",
        }),
        resolveMidTurnImages: async () => {
          throw new Error("image preparation failed");
        },
        getReply: async (_ctx, opts) => {
          opts.onAgentRunStart?.("attempt");
          await expect(opts.onToolStreamBoundary?.()).resolves.toBeUndefined();
          await opts.onConversationOutcome?.("implicit_silence");
        },
      }),
    ).resolves.toMatchObject({ outcome: "implicit_silence" });

    expect(released).toEqual([["2"]]);
  });

  it("defers an image batch when the exact active run image policy is unavailable", async () => {
    const batch = dispatchBatch();
    const claimed = [
      scheduled("2", "second", [
        {
          kind: "image",
          mimeType: "image/png",
          managedLocalPath: "/tmp/injected.png",
          sourceMessageId: "message-2",
          sourceIndex: 0,
          understanding: [],
        },
      ]),
    ];
    const released: string[][] = [];
    batch.claimMidTurnHumanEvents = async () => claimed;
    batch.releaseMidTurnHumanEvents = async (eventIds) => {
      released.push([...eventIds]);
    };
    const queueActiveRun = vi.fn(async () => true);

    await expect(
      runtimeConversationSchedulerTesting.dispatchOwnedBatchWithReply({
        batch,
        cfg: {},
        resolveActiveRunNativeImagePolicy: () => undefined,
        queueActiveRun,
        getReply: async (_ctx, opts) => {
          opts.onAgentRunStart?.("attempt");
          await expect(opts.onToolStreamBoundary?.()).resolves.toBeUndefined();
          await opts.onConversationOutcome?.("implicit_silence");
        },
      }),
    ).resolves.toMatchObject({ outcome: "implicit_silence" });

    expect(queueActiveRun).not.toHaveBeenCalled();
    expect(released).toEqual([["2"]]);
  });

  it("fails a scheduler-owned turn that returns before model execution", async () => {
    const batch = dispatchBatch();
    const cfg: OpenClawConfig = {};

    await expect(
      runtimeConversationSchedulerTesting.dispatchOwnedBatchWithReply({
        batch,
        cfg,
        getReply: async () => undefined,
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      failure: { kind: "source_run_not_started" },
    });
    expect(batch.starts).toEqual([]);
    expect(batch.outcomes).toEqual([]);
  });

  it("reconciles a runtime-owned interrupted attempt that is still live", async () => {
    expect(
      await runtimeConversationSchedulerTesting.reconcileOwnedInterruptedAttempt(
        interruptedAttempt(),
        {
          isRunLive: async (runCorrelationId, sessionKey) => {
            expect({ runCorrelationId, sessionKey }).toEqual({
              runCorrelationId: "run-1",
              sessionKey: route.sessionKey,
            });
            return true;
          },
          hasCommittedDelivery: async () => false,
        },
      ),
    ).toEqual({ status: "live" });
  });

  it("reconciles committed transcript delivery without redispatching", async () => {
    expect(
      runtimeConversationSchedulerTesting.hasCommittedMessageToolDelivery(
        [{ role: "assistant", idempotencyKey: "run-1:message-tool:fingerprint:call:0" }],
        "run-1",
      ),
    ).toBe(true);
    expect(
      runtimeConversationSchedulerTesting.hasCommittedMessageToolDelivery(
        [{ role: "assistant", idempotencyKey: "another-run:message-tool:fingerprint:call:0" }],
        "run-1",
      ),
    ).toBe(false);
    expect(
      await runtimeConversationSchedulerTesting.reconcileOwnedInterruptedAttempt(
        interruptedAttempt(),
        {
          isRunLive: async () => false,
          hasCommittedDelivery: async (sessionKey, runCorrelationId) => {
            expect({ sessionKey, runCorrelationId }).toEqual({
              sessionKey: route.sessionKey,
              runCorrelationId: "run-1",
            });
            return true;
          },
        },
      ),
    ).toEqual({
      status: "delivered",
      transcriptEvidence: `session:${route.sessionKey}:run:run-1`,
      runCorrelationId: "run-1",
    });
  });

  it("leaves an interrupted attempt unresolved while runtime proof may still appear", async () => {
    const attempt = interruptedAttempt();
    attempt.transcriptEvidence = runtimeConversationSchedulerTesting.buildOwnedRunStartedEvidence({
      sessionKey: route.sessionKey,
      runCorrelationId: "run-1",
    });
    expect(
      await runtimeConversationSchedulerTesting.reconcileOwnedInterruptedAttempt(attempt, {
        isRunLive: async () => false,
        hasCommittedDelivery: async () => false,
      }),
    ).toEqual({ status: "unresolved" });
  });

  it("settles a completed controller run after transcript consumption even when it stayed silent", async () => {
    const hasCommittedDelivery = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false);
    const completionAttempt = interruptedAttempt();
    completionAttempt.events = completionAttempt.events.map((event) => ({
      ...event,
      producerKind: "subagent_completion",
      human: false,
    }));

    expect(
      await runtimeConversationSchedulerTesting.reconcileOwnedInterruptedAttempt(
        completionAttempt,
        {
          isRunLive: async () => false,
          hasCommittedDelivery,
          readRunTerminalStatus: async () => "delivered",
        },
      ),
    ).toEqual({
      status: "delivered",
      transcriptEvidence: "controller-run:run-1:consumed",
      runCorrelationId: "run-1",
    });
    expect(hasCommittedDelivery).toHaveBeenCalledOnce();
  });

  it("does not credit a completed human turn without committed message-tool delivery", async () => {
    const attempt = interruptedAttempt();
    attempt.transcriptEvidence = runtimeConversationSchedulerTesting.buildOwnedRunStartedEvidence({
      sessionKey: route.sessionKey,
      runCorrelationId: "run-1",
    });
    expect(
      await runtimeConversationSchedulerTesting.reconcileOwnedInterruptedAttempt(attempt, {
        isRunLive: async () => false,
        hasCommittedDelivery: async () => false,
        readRunTerminalStatus: async () => "delivered",
      }),
    ).toEqual({
      status: "retryable",
      evidence: { kind: "source_run_completed_without_committed_delivery" },
    });
  });

  it("rehydrates exact terminal evidence without redispatching", async () => {
    const attempt = interruptedAttempt();
    attempt.transcriptEvidence = runtimeConversationSchedulerTesting.buildOwnedRunTerminalEvidence({
      sessionKey: route.sessionKey,
      runCorrelationId: "run-1",
      outcome: "implicit_silence",
    });
    const isRunLive = vi.fn<() => Promise<boolean>>();

    await expect(
      runtimeConversationSchedulerTesting.reconcileOwnedInterruptedAttempt(attempt, {
        isRunLive,
        hasCommittedDelivery: async () => false,
      }),
    ).resolves.toEqual({
      status: "delivered",
      transcriptEvidence: attempt.transcriptEvidence,
      runCorrelationId: "run-1",
    });
    expect(isRunLive).not.toHaveBeenCalled();
  });

  it("rejects mismatched terminal evidence and retries only a proven never-started run", async () => {
    const mismatched = interruptedAttempt();
    mismatched.transcriptEvidence =
      runtimeConversationSchedulerTesting.buildOwnedRunTerminalEvidence({
        sessionKey: `${route.sessionKey}:other`,
        runCorrelationId: "run-1",
        outcome: "sent",
      });
    const evidenceReader = {
      isRunLive: async () => false,
      hasCommittedDelivery: async () => false,
    };

    await expect(
      runtimeConversationSchedulerTesting.reconcileOwnedInterruptedAttempt(
        mismatched,
        evidenceReader,
      ),
    ).resolves.toEqual({ status: "unresolved" });
    await expect(
      runtimeConversationSchedulerTesting.reconcileOwnedInterruptedAttempt(
        interruptedAttempt(),
        evidenceReader,
      ),
    ).resolves.toEqual({
      status: "retryable",
      evidence: { kind: "source_run_never_started" },
    });
  });

  it("marks an authorized operator payload replayable when no run ever started", async () => {
    const attempt = interruptedAttempt();
    attempt.runCorrelationId = undefined;
    attempt.events = attempt.events.map((event) => ({
      ...event,
      producerKind: "operator",
      human: false,
      payload: {
        version: 1,
        kind: "runtime_turn",
        producerKind: "operator",
        agentId: "main",
        sessionKey: route.sessionKey,
        callId: "chat.send:turn-1",
        turnId: "turn-1",
        runId: "turn-1",
        recoveryPayload: { kind: "gateway_operator_chat", version: 1 },
      },
    }));

    await expect(
      runtimeConversationSchedulerTesting.reconcileOwnedInterruptedAttempt(attempt, {
        isRunLive: async () => false,
        hasCommittedDelivery: async () => false,
      }),
    ).resolves.toEqual({
      status: "replayable",
      evidence: { kind: "authorized_operator_turn_never_started" },
    });
  });

  it("rehydrates a non-conversational producer from exact durable completion evidence", async () => {
    const attempt = interruptedAttempt();
    attempt.events = attempt.events.map((event) => ({
      ...event,
      producerKind: "cron",
      human: false,
    }));
    attempt.transcriptEvidence =
      "producer:cron:session:agent:main:conversation:test:default:channel:room:run:run-1:outcome:completed";

    await expect(
      runtimeConversationSchedulerTesting.reconcileOwnedInterruptedAttempt(attempt, {
        isRunLive: async () => false,
        hasCommittedDelivery: async () => false,
      }),
    ).resolves.toEqual({
      status: "delivered",
      transcriptEvidence: attempt.transcriptEvidence,
      runCorrelationId: "run-1",
    });
  });

  it("uses the exact terminal run status to reconcile a started runtime producer", async () => {
    const attempt = interruptedAttempt();
    attempt.events = attempt.events.map((event) => ({
      ...event,
      producerKind: "sessions_send",
      human: false,
    }));
    attempt.transcriptEvidence = buildRuntimeProducerStartedEvidence({
      producerKind: "sessions_send",
      sessionKey: route.sessionKey,
      runCorrelationId: "run-1",
    });

    await expect(
      runtimeConversationSchedulerTesting.reconcileOwnedInterruptedAttempt(attempt, {
        isRunLive: async () => false,
        hasCommittedDelivery: async () => false,
        readRunTerminalStatus: async () => "delivered",
      }),
    ).resolves.toEqual({
      status: "delivered",
      transcriptEvidence: `session:${route.sessionKey}:run:run-1:completed`,
      runCorrelationId: "run-1",
    });

    await expect(
      runtimeConversationSchedulerTesting.reconcileOwnedInterruptedAttempt(attempt, {
        isRunLive: async () => false,
        hasCommittedDelivery: async () => false,
        readRunTerminalStatus: async () => undefined,
      }),
    ).resolves.toEqual({ status: "unresolved" });
  });
});
