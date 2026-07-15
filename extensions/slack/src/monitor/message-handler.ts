// Slack plugin module implements message handler behavior.
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { hasControlCommand } from "openclaw/plugin-sdk/command-detection";
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { ResolvedSlackAccount } from "../accounts.js";
import { admitSlackScheduledInbound } from "../scheduler-admission.js";
import type { SlackSendIdentity } from "../send.js";
import type { SlackMessageEvent } from "../types.js";
import { stripSlackMentionsForCommandDetection } from "./commands.js";
import type { SlackMonitorContext } from "./context.js";
import {
  hasSlackInboundMessageDelivery,
  recordSlackInboundMessageDeliveries,
} from "./inbound-delivery-state.js";
import {
  buildSlackDebounceKey,
  buildTopLevelSlackConversationKey,
} from "./message-handler/debounce-key.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";

const loadSlackMessagePipeline = createLazyRuntimeModule(
  () => import("./message-handler/pipeline.runtime.js"),
);

export type SlackMessageHandler = (
  message: SlackMessageEvent,
  opts: {
    source: "message" | "app_mention";
    wasMentioned?: boolean;
    relayIdentity?: SlackSendIdentity;
    /** Wait until any inbound debounce flush and dispatch has completed. */
    awaitDispatch?: boolean;
  },
) => Promise<void>;

type SlackDispatchCompletion = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type IngressSlackMessageOptions = Parameters<SlackMessageHandler>[1] & {
  retryAttempt?: number;
};

type QueuedSlackMessageOptions = IngressSlackMessageOptions & {
  dispatchCompletion?: Omit<SlackDispatchCompletion, "promise">;
};

function createSlackDispatchCompletion(): SlackDispatchCompletion {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const APP_MENTION_RETRY_TTL_MS = 60_000;
const RETRYABLE_FLUSH_MAX_ATTEMPTS = 3;
const RETRYABLE_FLUSH_RETRY_DELAY_MS = 1_000;
const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /reply session initialization conflicted for \S+/u;

export class SlackRetryableInboundError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SlackRetryableInboundError";
  }
}

function isRetryableSlackInboundError(error: unknown): boolean {
  if (error instanceof SlackRetryableInboundError) {
    return true;
  }
  return collectErrorGraphCandidates(error, (current) => [current.cause, current.error]).some(
    (candidate) => REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(formatErrorMessage(candidate)),
  );
}

function shouldDebounceSlackMessage(message: SlackMessageEvent, cfg: SlackMonitorContext["cfg"]) {
  const text = message.text ?? "";
  const textForCommandDetection = stripSlackMentionsForCommandDetection(text);
  return shouldDebounceTextInbound({
    text: textForCommandDetection,
    cfg,
    hasMedia: Boolean(message.files && message.files.length > 0),
  });
}

function buildSeenMessageKey(channelId: string | undefined, ts: string | undefined): string | null {
  if (!channelId || !ts) {
    return null;
  }
  return `${channelId}:${ts}`;
}

export function createSlackMessageHandler(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
}): SlackMessageHandler {
  const { ctx, account, trackEvent } = params;
  const { debounceMs, debouncer } = createChannelInboundDebouncer<{
    message: SlackMessageEvent;
    opts: QueuedSlackMessageOptions;
  }>({
    cfg: ctx.cfg,
    channel: "slack",
    buildKey: (entry) => buildSlackDebounceKey(entry.message, ctx.accountId),
    shouldDebounce: (entry) => shouldDebounceSlackMessage(entry.message, ctx.cfg),
    onFlush: async (entries) => {
      let completedEntryCount = 0;
      const retryEntries = (sourceError: unknown): boolean => {
        if (!isRetryableSlackInboundError(sourceError)) {
          return false;
        }
        const nextEntries: Array<(typeof entries)[number]> = [];
        for (const entry of entries.slice(completedEntryCount)) {
          // Relay delivery owns retry until its dispatch completion is acknowledged.
          // Scheduling here as well can race the router redelivery and duplicate a reply.
          if (entry.opts.dispatchCompletion) {
            continue;
          }
          const retryAttempt = entry.opts.retryAttempt ?? 0;
          if (retryAttempt >= RETRYABLE_FLUSH_MAX_ATTEMPTS) {
            continue;
          }
          const { dispatchCompletion: _dispatchCompletion, ...retryOpts } = entry.opts;
          nextEntries.push({
            message: entry.message,
            opts: {
              ...retryOpts,
              retryAttempt: retryAttempt + 1,
            },
          });
        }
        if (nextEntries.length === 0) {
          return false;
        }
        const retryTimer = setTimeout(() => {
          for (const entry of nextEntries) {
            // Re-enter ingress so a relay replay or another successful attempt wins
            // through the normal delivery and seen-message gates before dispatch.
            void enqueueSlackMessage(entry.message, entry.opts).catch((err: unknown) => {
              ctx.runtime.error?.(`slack inbound retry enqueue failed: ${formatErrorMessage(err)}`);
            });
          }
        }, RETRYABLE_FLUSH_RETRY_DELAY_MS);
        retryTimer.unref?.();
        return true;
      };
      try {
        await (async () => {
          const last = entries.at(-1);
          if (!last) {
            return;
          }
          const flushedKey = buildSlackDebounceKey(last.message, ctx.accountId);
          const topLevelConversationKey = buildTopLevelSlackConversationKey(
            last.message,
            ctx.accountId,
          );
          if (flushedKey && topLevelConversationKey) {
            const pendingKeys = pendingTopLevelDebounceKeys.get(topLevelConversationKey);
            if (pendingKeys) {
              pendingKeys.delete(flushedKey);
              if (pendingKeys.size === 0) {
                pendingTopLevelDebounceKeys.delete(topLevelConversationKey);
              }
            }
          }
          try {
            const { prepareSlackMessage, dispatchPreparedSlackMessage } =
              await loadSlackMessagePipeline();
            for (const entry of entries) {
              const seenMessageKey = buildSeenMessageKey(entry.message.channel, entry.message.ts);
              const {
                dispatchCompletion: _completion,
                awaitDispatch: _awaitDispatch,
                ...entryOpts
              } = entry.opts;
              const appMentionRetryKey =
                seenMessageKey && entryOpts.source === "app_mention" && !ctx.botUserId
                  ? seenMessageKey
                  : undefined;
              if (appMentionRetryKey) {
                appMentionPreparingKeys.add(appMentionRetryKey);
              }
              const prepared = await (async () => {
                try {
                  const result = await prepareSlackMessage({
                    ctx,
                    account,
                    message: entry.message,
                    opts: {
                      ...entryOpts,
                      ...(seenMessageKey && entryOpts.source === "message"
                        ? {
                            shouldRecordDroppedHistory: () =>
                              !appMentionPreparingKeys.has(seenMessageKey) &&
                              !appMentionDispatchedKeys.has(seenMessageKey),
                          }
                        : {}),
                    },
                  });
                  if (result && seenMessageKey) {
                    pruneAppMentionRetryKeys(Date.now());
                    if (entryOpts.source === "app_mention") {
                      rememberExpiringAppMentionKey(appMentionDispatchedKeys, seenMessageKey);
                    } else if (
                      entryOpts.source === "message" &&
                      appMentionDispatchedKeys.has(seenMessageKey)
                    ) {
                      appMentionDispatchedKeys.delete(seenMessageKey);
                      appMentionRetryKeys.delete(seenMessageKey);
                      return null;
                    }
                    appMentionRetryKeys.delete(seenMessageKey);
                  }
                  return result;
                } finally {
                  if (appMentionRetryKey) {
                    appMentionPreparingKeys.delete(appMentionRetryKey);
                  }
                }
              })();
              if (!prepared) {
                completedEntryCount += 1;
                entry.opts.dispatchCompletion?.resolve();
                continue;
              }
              try {
                const commandBody = prepared.ctxPayload.CommandBody ?? "";
                const schedulerAdmission = hasControlCommand(commandBody, ctx.cfg)
                  ? undefined
                  : await admitSlackScheduledInbound({
                      prepared,
                      source: entryOpts.source,
                      onError: (error) => {
                        ctx.runtime.error?.(
                          `slack scheduler admission failed open: ${formatErrorMessage(error)}`,
                        );
                      },
                    });
                if (!schedulerAdmission?.result.accepted) {
                  await dispatchPreparedSlackMessage(prepared);
                }
                await recordSlackInboundMessageDeliveries({
                  accountId: ctx.accountId,
                  messages: [entry.message],
                });
                completedEntryCount += 1;
                entry.opts.dispatchCompletion?.resolve();
              } catch (error) {
                if (!isRetryableSlackInboundError(error)) {
                  await recordSlackInboundMessageDeliveries({
                    accountId: ctx.accountId,
                    messages: [entry.message],
                  });
                }
                throw error;
              }
            }
          } catch (error) {
            if (isRetryableSlackInboundError(error)) {
              // Every buffered event passed the seen gate before this dispatch.
              for (const entry of entries.slice(completedEntryCount)) {
                const entrySeenKey = buildSeenMessageKey(entry.message.channel, entry.message.ts);
                if (entrySeenKey) {
                  appMentionDispatchedKeys.delete(entrySeenKey);
                }
                ctx.releaseSeenMessage(entry.message.channel, entry.message.ts);
              }
            }
            throw error;
          }
        })();
      } catch (error) {
        retryEntries(error);
        for (const entry of entries.slice(completedEntryCount)) {
          entry.opts.dispatchCompletion?.reject(error);
        }
        throw error;
      }
    },
    onError: (err) => {
      ctx.runtime.error?.(`slack inbound debounce flush failed: ${formatErrorMessage(err)}`);
    },
  });
  const threadTsResolver = createSlackThreadTsResolver({ client: ctx.app.client });
  const pendingTopLevelDebounceKeys = new Map<string, Set<string>>();
  const appMentionRetryKeys = new Map<string, number>();
  const appMentionPreparingKeys = new Set<string>();
  const appMentionDispatchedKeys = new Map<string, number>();

  const pruneAppMentionRetryKeys = (rawNow: number): boolean => {
    const now = asDateTimestampMs(rawNow);
    if (now === undefined) {
      appMentionRetryKeys.clear();
      appMentionDispatchedKeys.clear();
      return false;
    }
    for (const [key, expiresAt] of appMentionRetryKeys) {
      if (asDateTimestampMs(expiresAt) === undefined || expiresAt <= now) {
        appMentionRetryKeys.delete(key);
      }
    }
    for (const [key, expiresAt] of appMentionDispatchedKeys) {
      if (asDateTimestampMs(expiresAt) === undefined || expiresAt <= now) {
        appMentionDispatchedKeys.delete(key);
      }
    }
    return true;
  };

  const rememberExpiringAppMentionKey = (map: Map<string, number>, key: string): void => {
    const now = Date.now();
    if (!pruneAppMentionRetryKeys(now)) {
      return;
    }
    const expiresAt = resolveExpiresAtMsFromDurationMs(APP_MENTION_RETRY_TTL_MS, { nowMs: now });
    if (expiresAt !== undefined) {
      map.set(key, expiresAt);
    }
  };

  const rememberAppMentionRetryKey = (key: string) => {
    rememberExpiringAppMentionKey(appMentionRetryKeys, key);
  };

  const consumeAppMentionRetryKey = (key: string) => {
    const now = Date.now();
    if (!pruneAppMentionRetryKeys(now)) {
      return false;
    }
    if (!appMentionRetryKeys.has(key)) {
      return false;
    }
    appMentionRetryKeys.delete(key);
    return true;
  };

  async function enqueueSlackMessage(
    message: SlackMessageEvent,
    opts: IngressSlackMessageOptions,
  ): Promise<SlackDispatchCompletion | undefined> {
    if (opts.source === "message" && message.type !== "message") {
      return undefined;
    }
    if (
      opts.source === "message" &&
      message.subtype &&
      message.subtype !== "file_share" &&
      message.subtype !== "bot_message" &&
      message.subtype !== "thread_broadcast"
    ) {
      return undefined;
    }
    const seenMessageKey = buildSeenMessageKey(message.channel, message.ts);
    if (
      seenMessageKey &&
      (await hasSlackInboundMessageDelivery({
        accountId: ctx.accountId,
        channelId: message.channel,
        ts: message.ts,
      }))
    ) {
      return undefined;
    }
    const wasSeen = seenMessageKey ? ctx.markMessageSeen(message.channel, message.ts) : false;
    if (seenMessageKey && opts.source === "message" && !wasSeen) {
      // Prime exactly one fallback app_mention allowance immediately so a near-simultaneous
      // app_mention is not dropped while message handling is still in-flight.
      rememberAppMentionRetryKey(seenMessageKey);
    }
    if (seenMessageKey && wasSeen) {
      // Allow exactly one app_mention retry if the same ts was previously dropped
      // from the message stream before it reached dispatch.
      if (opts.source !== "app_mention" || !consumeAppMentionRetryKey(seenMessageKey)) {
        return undefined;
      }
    }
    trackEvent?.();
    const resolvedMessage = await threadTsResolver.resolve({ message, source: opts.source });
    const debounceKey = buildSlackDebounceKey(resolvedMessage, ctx.accountId);
    const conversationKey = buildTopLevelSlackConversationKey(resolvedMessage, ctx.accountId);
    const canDebounce = debounceMs > 0 && shouldDebounceSlackMessage(resolvedMessage, ctx.cfg);
    if (!canDebounce && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey);
      if (pendingKeys && pendingKeys.size > 0) {
        const keysToFlush = Array.from(pendingKeys);
        for (const pendingKey of keysToFlush) {
          await debouncer.flushKey(pendingKey);
        }
      }
    }
    if (canDebounce && debounceKey && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey) ?? new Set<string>();
      pendingKeys.add(debounceKey);
      pendingTopLevelDebounceKeys.set(conversationKey, pendingKeys);
    }
    const dispatchCompletion = opts.awaitDispatch ? createSlackDispatchCompletion() : undefined;
    await debouncer.enqueue({
      message: resolvedMessage,
      opts: {
        ...opts,
        ...(dispatchCompletion
          ? {
              dispatchCompletion: {
                resolve: dispatchCompletion.resolve,
                reject: dispatchCompletion.reject,
              },
            }
          : {}),
      },
    });
    return dispatchCompletion;
  }

  return async (message, opts) => {
    const dispatchCompletion = await enqueueSlackMessage(message, opts);
    await dispatchCompletion?.promise;
  };
}
