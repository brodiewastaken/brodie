// Discord plugin module implements message handler behavior.
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { finiteSecondsToTimerSafeMilliseconds } from "openclaw/plugin-sdk/number-runtime";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import type { Client } from "../internal/discord.js";
import { admitDiscordScheduledInbound } from "../scheduler-admission.js";
import {
  buildDiscordInboundReplayKey,
  claimDiscordInboundReplay,
  commitDiscordInboundReplay,
  createDiscordInboundReplayGuard,
  DiscordRetryableInboundError,
  releaseDiscordInboundReplay,
} from "./inbound-dedupe.js";
import { buildDiscordInboundJob, resolveDiscordInboundJobQueueKey } from "./inbound-job.js";
import type { DiscordMessageEvent, DiscordMessageHandler } from "./listeners.js";
import { applyImplicitReplyBatchGate } from "./message-handler.batch-gate.js";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";
import { resolveDiscordAcceptedTypingPrestart } from "./message-handler.reply-typing-policy.js";
import {
  createDiscordMessageRunQueue,
  type DiscordMessageRunQueueTestingHooks,
} from "./message-run-queue.js";
import {
  hasDiscordMessageStickers,
  resolveDiscordMessageChannelId,
  resolveDiscordMessageText,
} from "./message-utils.js";
import {
  createDiscordReplyTypingFeedback,
  type DiscordReplyTypingFeedback,
} from "./reply-typing-feedback.js";
import type { DiscordMonitorStatusSink } from "./status.js";

type PreflightDiscordMessage =
  typeof import("./message-handler.preflight.js").preflightDiscordMessage;
type BuildDiscordMessageProcessContext = typeof buildDiscordMessageProcessContext;
type AdmitDiscordScheduledInbound = typeof admitDiscordScheduledInbound;
type CreateDiscordReplyTypingFeedback = typeof createDiscordReplyTypingFeedback;

type DiscordMessageHandlerParams = Omit<
  DiscordMessagePreflightParams,
  "ackReactionScope" | "groupPolicy" | "data" | "client"
> & {
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  testing?: DiscordMessageHandlerTestingHooks;
};

type DiscordMessageHandlerTestingHooks = DiscordMessageRunQueueTestingHooks & {
  preflightDiscordMessage?: PreflightDiscordMessage;
  createReplyTypingFeedback?: CreateDiscordReplyTypingFeedback;
  buildMessageProcessContext?: BuildDiscordMessageProcessContext;
  admitScheduledInbound?: AdmitDiscordScheduledInbound;
};

type PrestartedTypingFeedbackEntry = {
  channelId: string;
  feedback: DiscordReplyTypingFeedback;
};

const loadMessagePreflightRuntime = createLazyRuntimeModule(
  () => import("./message-handler.preflight.js"),
);
type DiscordMessageHandlerWithLifecycle = DiscordMessageHandler & {
  deactivate: () => void;
};

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function startAcceptedTypingFeedback(params: {
  ctx: DiscordMessagePreflightContext;
  createFeedback?: CreateDiscordReplyTypingFeedback;
  dedupeKey: string;
  activeFeedback: Map<string, PrestartedTypingFeedbackEntry>;
}): DiscordReplyTypingFeedback | undefined {
  const { ctx, createFeedback, dedupeKey, activeFeedback } = params;
  if (!resolveDiscordAcceptedTypingPrestart(ctx).shouldPrestart) {
    return undefined;
  }
  const channelId = ctx.messageChannelId.trim();
  const existing = activeFeedback.get(dedupeKey);
  if (existing) {
    // One pre-dispatch keepalive owns each serialized Discord queue key.
    // Later queued jobs get fresh typing when their dispatch turn starts.
    return undefined;
  }
  const replyTypingFeedback =
    ctx.replyTypingFeedback ??
    (createFeedback ?? createDiscordReplyTypingFeedback)({
      cfg: ctx.cfg,
      token: ctx.token,
      accountId: ctx.accountId,
      channelId: ctx.messageChannelId,
      log: logVerbose,
      keepaliveIntervalMs: finiteSecondsToTimerSafeMilliseconds(
        ctx.cfg.agents?.defaults?.typingIntervalSeconds ?? ctx.cfg.session?.typingIntervalSeconds,
      ),
    });
  const cleanup = replyTypingFeedback.onCleanup;
  replyTypingFeedback.onCleanup = () => {
    cleanup?.();
    // Cleanup is the lease release for both normal dispatch and skipped jobs.
    // Without this, a stale queue key would suppress future accepted typing.
    if (activeFeedback.get(dedupeKey)?.feedback === replyTypingFeedback) {
      activeFeedback.delete(dedupeKey);
    }
  };
  activeFeedback.set(dedupeKey, { channelId, feedback: replyTypingFeedback });
  ctx.replyTypingFeedback = replyTypingFeedback;
  void replyTypingFeedback.onReplyStart().catch((err: unknown) => {
    logVerbose(`discord accepted typing feedback failed: ${String(err)}`);
  });
  return replyTypingFeedback;
}

export function createDiscordMessageHandler(
  params: DiscordMessageHandlerParams,
): DiscordMessageHandlerWithLifecycle {
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.discord !== undefined,
    groupPolicy: params.discordConfig?.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const ackReactionScope =
    params.discordConfig?.ackReactionScope ??
    params.cfg.messages?.ackReactionScope ??
    "group-mentions";
  const preflightDiscordMessageImpl = params.testing?.preflightDiscordMessage;
  const replayGuard = createDiscordInboundReplayGuard();
  // The map owns pre-dispatch typing leases, not queued work itself.
  // Each lease is released by the feedback cleanup hook installed below.
  const prestartedTypingFeedback = new Map<string, PrestartedTypingFeedbackEntry>();
  const messageRunQueue = createDiscordMessageRunQueue({
    runtime: params.runtime,
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
    replayGuard,
    testing: params.testing,
  });

  const admitPreparedMessage = async (options: {
    ctx: DiscordMessagePreflightContext;
    replayKeys: string[];
    nativeBatch: boolean;
  }) => {
    const { ctx, replayKeys, nativeBatch } = options;
    const queueKey = resolveDiscordInboundJobQueueKey(ctx);
    startAcceptedTypingFeedback({
      ctx,
      createFeedback: params.testing?.createReplyTypingFeedback,
      dedupeKey: queueKey,
      activeFeedback: prestartedTypingFeedback,
    });
    applyImplicitReplyBatchGate(ctx, params.replyToMode, nativeBatch);
    if (params.testing && !params.testing.admitScheduledInbound) {
      messageRunQueue.enqueue(buildDiscordInboundJob(ctx, { replayKeys }));
      return;
    }
    if (ctx.hasControlCommand) {
      messageRunQueue.enqueue(buildDiscordInboundJob(ctx, { replayKeys }));
      return;
    }
    const preparedProcessContext = await (
      params.testing?.buildMessageProcessContext ?? buildDiscordMessageProcessContext
    )({
      ctx,
      text: ctx.messageText,
      mediaList: ctx.preparedMedia,
    });
    if (!preparedProcessContext) {
      await commitDiscordInboundReplay({ replayKeys, replayGuard });
      ctx.replyTypingFeedback?.onCleanup?.();
      return;
    }
    const admission = await (params.testing?.admitScheduledInbound ?? admitDiscordScheduledInbound)(
      {
        ctx,
        prepared: preparedProcessContext,
        onError: (error) => {
          logVerbose(`discord: scheduler admission failed open (${String(error)})`);
        },
      },
    );
    if (!admission.result.accepted) {
      messageRunQueue.enqueue(buildDiscordInboundJob(ctx, { replayKeys, preparedProcessContext }));
      return;
    }

    await commitDiscordInboundReplay({ replayKeys, replayGuard });
    ctx.replyTypingFeedback?.onCleanup?.();
  };

  const { debouncer } = createChannelInboundDebouncer<{
    data: DiscordMessageEvent;
    client: Client;
    abortSignal?: AbortSignal;
    replayKey?: string;
  }>({
    cfg: params.cfg,
    channel: "discord",
    buildKey: (entry) => {
      const message = entry.data.message;
      const authorId = entry.data.author?.id;
      if (!message || !authorId) {
        return null;
      }
      const channelId = resolveDiscordMessageChannelId({
        message,
        eventChannelId: entry.data.channel_id,
      });
      if (!channelId) {
        return null;
      }
      return `discord:${params.accountId}:${channelId}:${authorId}`;
    },
    shouldDebounce: (entry) => {
      const message = entry.data.message;
      if (!message) {
        return false;
      }
      const baseText = resolveDiscordMessageText(message, { includeForwarded: false });
      return shouldDebounceTextInbound({
        text: baseText,
        cfg: params.cfg,
        hasMedia:
          (message.attachments && message.attachments.length > 0) ||
          hasDiscordMessageStickers(message),
      });
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      const replayKeys = entries.map((entry) => entry.replayKey).filter(isNonEmptyString);
      const abortSignal = last.abortSignal;
      if (abortSignal?.aborted) {
        releaseDiscordInboundReplay({
          replayKeys,
          error: abortSignal.reason,
          replayGuard,
        });
        return;
      }
      const completedReplayKeys = new Set<string>();
      try {
        const preflight =
          preflightDiscordMessageImpl ??
          (await loadMessagePreflightRuntime()).preflightDiscordMessage;
        for (const entry of entries) {
          const entryReplayKeys = entry.replayKey ? [entry.replayKey] : [];
          const ctx = await preflight({
            ...params,
            ackReactionScope,
            groupPolicy,
            abortSignal,
            data: entry.data,
            client: entry.client,
          });
          if (!ctx) {
            await commitDiscordInboundReplay({ replayKeys: entryReplayKeys, replayGuard });
            entryReplayKeys.forEach((key) => completedReplayKeys.add(key));
            continue;
          }
          await admitPreparedMessage({
            ctx,
            replayKeys: entryReplayKeys,
            nativeBatch: entries.length > 1,
          });
          entryReplayKeys.forEach((key) => completedReplayKeys.add(key));
        }
      } catch (error) {
        const unsettledReplayKeys = replayKeys.filter((key) => !completedReplayKeys.has(key));
        if (error instanceof DiscordRetryableInboundError) {
          releaseDiscordInboundReplay({ replayKeys: unsettledReplayKeys, error, replayGuard });
        } else {
          await commitDiscordInboundReplay({ replayKeys: unsettledReplayKeys, replayGuard });
        }
        throw error;
      }
    },
    onError: (err) => {
      params.runtime.error(danger(`discord debounce flush failed: ${String(err)}`));
    },
  });

  const handler: DiscordMessageHandlerWithLifecycle = async (data, client, options) => {
    try {
      if (options?.abortSignal?.aborted) {
        return;
      }
      // Filter bot-own messages before they enter the debounce queue.
      // The same check exists in preflightDiscordMessage(), but by that point
      // the message has already consumed debounce capacity and blocked
      // legitimate user messages. On active servers this causes cumulative
      // slowdown (see #15874).
      const msgAuthorId = data.message?.author?.id ?? data.author?.id;
      if (params.botUserId && msgAuthorId === params.botUserId) {
        return;
      }
      const replayKey = buildDiscordInboundReplayKey({
        accountId: params.accountId,
        data,
      });
      if (
        !(await claimDiscordInboundReplay({
          replayKey,
          replayGuard,
        }))
      ) {
        return;
      }

      await debouncer.enqueue({
        data,
        client,
        abortSignal: options?.abortSignal,
        replayKey: replayKey ?? undefined,
      });
    } catch (err) {
      params.runtime.error(danger(`handler failed: ${String(err)}`));
    }
  };

  handler.deactivate = messageRunQueue.deactivate;

  return handler;
}
