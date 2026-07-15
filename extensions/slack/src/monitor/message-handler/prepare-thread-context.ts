// Slack plugin module implements prepare thread context behavior.
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
import type { ContextVisibilityMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  filterSupplementalContextItems,
  shouldIncludeSupplementalContext,
} from "openclaw/plugin-sdk/security-runtime";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackAllowListMatch } from "../allow-list.js";
import { readSessionUpdatedAt, resolveChannelResetConfig } from "../config.runtime.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackMediaResult } from "../media-types.js";
import { resolveSlackThreadHistory, type SlackThreadStarter } from "../thread.js";
import {
  applySlackThreadHistoryFilterPolicy,
  ensureSlackThreadHistoryHasBotRoot,
  formatSlackBotStarterThreadLabel,
  formatSlackThreadLabelSnippet,
  isSlackThreadAuthorCurrentBot,
  resolveSlackThreadHistoryFilterPolicy,
  shouldIncludeBotThreadStarterContext,
} from "./prepare-thread-context-root.js";
import { renderSlackThreadHistory } from "./thread-history-render.js";

const loadSlackMediaModule = createLazyRuntimeModule(() => import("../media.js"));
const loadMediaUnderstandingModule = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/media-understanding-runtime"),
);

type SlackThreadContextData = {
  threadStarterBody: string | undefined;
  threadHistoryBody: string | undefined;
  shouldSeedInitialThreadContext: boolean;
  threadLabel: string | undefined;
  threadStarterMedia: SlackMediaResult[] | null;
};

const SLACK_THREAD_CONTEXT_USER_LOOKUP_CONCURRENCY = 4;
// Keep Slack's bounded downloader parallelism when historical files are
// expanded one-at-a-time to avoid the normal eight-file hydration cap.
const SLACK_THREAD_CONTEXT_MEDIA_CONCURRENCY = 3;

type SlackThreadMediaUnderstanding = {
  kind: "image.description" | "audio.transcription" | "video.description";
  provider?: string;
  model?: string;
  text: string;
};

type SlackSessionResetFreshness = {
  state: "missing" | "fresh" | "stale";
};

type SlackSessionFreshnessRuntime = {
  session?: {
    resolveEntryResetFreshness?: (params: {
      storePath?: string;
      sessionKey: string;
      sessionCfg?: OpenClawConfig["session"];
      resetType: "thread";
      resetOverride?: ReturnType<typeof resolveChannelResetConfig>;
    }) => SlackSessionResetFreshness;
  };
};

function resolveSlackThreadSessionFreshness(params: {
  ctx: SlackMonitorContext;
  storePath: string;
  sessionKey: string;
}): SlackSessionResetFreshness | undefined {
  // Gateway startup supplies the full channel runtime, but the public surface
  // intentionally keeps non-context helpers untyped for external plugins.
  const runtime = params.ctx.channelRuntime as SlackSessionFreshnessRuntime | undefined;
  return runtime?.session?.resolveEntryResetFreshness?.({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    sessionCfg: params.ctx.cfg.session,
    resetType: "thread",
    resetOverride: resolveChannelResetConfig({
      sessionCfg: params.ctx.cfg.session,
      channel: "slack",
    }),
  });
}

function isSlackThreadContextSenderAllowed(params: {
  allowFromLower: string[];
  allowNameMatching: boolean;
  userId?: string;
  userName?: string;
  botId?: string;
}): boolean {
  if (params.allowFromLower.length === 0 || params.botId) {
    return true;
  }
  if (!params.userId) {
    return false;
  }
  return resolveSlackAllowListMatch({
    allowList: params.allowFromLower,
    id: params.userId,
    name: params.userName,
    allowNameMatching: params.allowNameMatching,
  }).allowed;
}

function resolveSlackThreadMediaCapability(
  contentType: string | undefined,
): "image" | "audio" | "video" | undefined {
  if (contentType?.startsWith("image/")) {
    return "image";
  }
  if (contentType?.startsWith("audio/")) {
    return "audio";
  }
  if (contentType?.startsWith("video/")) {
    return "video";
  }
  return undefined;
}

async function resolveSlackThreadMediaUnderstanding(params: {
  media: SlackMediaResult | null;
  fallbackContentType?: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  chatType: "direct" | "channel";
}): Promise<SlackThreadMediaUnderstanding | undefined> {
  if (!params.media) {
    return undefined;
  }
  const contentType = params.media.contentType ?? params.fallbackContentType;
  const capability = resolveSlackThreadMediaCapability(contentType);
  if (!capability) {
    return undefined;
  }
  try {
    const { runMediaUnderstandingFile } = await loadMediaUnderstandingModule();
    const result = await runMediaUnderstandingFile({
      capability,
      filePath: params.media.path,
      mime: contentType,
      cfg: params.cfg,
      scopeContext: {
        sessionKey: params.sessionKey,
        channel: "slack",
        chatType: params.chatType,
      },
    });
    const text = result.text?.trim();
    if (!text) {
      return undefined;
    }
    return {
      kind:
        capability === "audio"
          ? "audio.transcription"
          : capability === "video"
            ? "video.description"
            : "image.description",
      ...(result.provider ? { provider: result.provider } : {}),
      ...(result.model ? { model: result.model } : {}),
      text,
    };
  } catch (err) {
    // Historical media remains useful through its verified local path when
    // optional understanding fails; dropping the whole history would hide
    // Slack source evidence because one provider or decoder was unavailable.
    logVerbose(`slack: historical media understanding failed: ${String(err)}`);
    return undefined;
  }
}

async function resolveSlackThreadUserMap(params: {
  ctx: SlackMonitorContext;
  messages: SlackThreadStarter[];
}): Promise<Map<string, { name?: string }>> {
  const uniqueUserIds: string[] = [];
  const seen = new Set<string>();
  for (const item of params.messages) {
    if (!item.userId || seen.has(item.userId)) {
      continue;
    }
    seen.add(item.userId);
    uniqueUserIds.push(item.userId);
  }
  const userMap = new Map<string, { name?: string }>();
  if (uniqueUserIds.length === 0) {
    return userMap;
  }
  const { results } = await runTasksWithConcurrency({
    tasks: uniqueUserIds.map((id) => async () => {
      const user = await params.ctx.resolveUserName(id);
      return user ? { id, user } : null;
    }),
    limit: SLACK_THREAD_CONTEXT_USER_LOOKUP_CONCURRENCY,
  });
  for (const result of results) {
    if (result) {
      userMap.set(result.id, result.user);
    }
  }
  return userMap;
}

export async function resolveSlackThreadContextData(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  isThreadReply: boolean;
  threadTs: string | undefined;
  threadStarter: SlackThreadStarter | null;
  roomLabel: string;
  storePath: string;
  sessionKey: string;
  forceInitialHistory?: boolean;
  allowFromLower: string[];
  allowNameMatching: boolean;
  contextVisibilityMode: ContextVisibilityMode;
  envelopeOptions: ReturnType<
    typeof import("openclaw/plugin-sdk/channel-inbound").resolveEnvelopeFormatOptions
  >;
  effectiveDirectMedia: SlackMediaResult[] | null;
}): Promise<SlackThreadContextData> {
  const botIdentity = {
    botUserId: params.ctx.botUserId,
    botId: params.ctx.botId,
  };
  const isCurrentBotAuthor = (author: { userId?: string; botId?: string }): boolean =>
    isSlackThreadAuthorCurrentBot({ identity: botIdentity, author });

  let threadStarterBody: string | undefined;
  let threadHistoryBody: string | undefined;
  let threadLabel: string | undefined;
  let threadStarterMedia: SlackMediaResult[] | null = null;
  const threadSessionFreshness =
    params.isThreadReply && params.threadTs
      ? resolveSlackThreadSessionFreshness({
          ctx: params.ctx,
          storePath: params.storePath,
          sessionKey: params.sessionKey,
        })
      : undefined;
  const threadSessionPreviousTimestamp =
    params.isThreadReply && params.threadTs && !threadSessionFreshness
      ? readSessionUpdatedAt({
          storePath: params.storePath,
          sessionKey: params.sessionKey,
        })
      : undefined;
  const shouldSeedInitialThreadContext = Boolean(
    params.isThreadReply &&
    params.threadTs &&
    (threadSessionFreshness
      ? threadSessionFreshness.state !== "fresh"
      : threadSessionPreviousTimestamp === undefined),
  );
  const shouldLoadInitialThreadHistory =
    shouldSeedInitialThreadContext || params.forceInitialHistory === true;
  const isDirectThread =
    params.message.channel_type === "im" || params.message.channel.startsWith("D");
  const mediaBySlackFileKey = new Map<string, Promise<SlackMediaResult | null>>();
  const mediaBySlackFileObject = new Map<
    NonNullable<SlackThreadStarter["files"]>[number],
    Promise<SlackMediaResult | null>
  >();
  const resolveThreadFile = (
    file: NonNullable<SlackThreadStarter["files"]>[number],
  ): Promise<SlackMediaResult | null> => {
    const key = file.id ?? file.url_private ?? file.url_private_download;
    const cached = key ? mediaBySlackFileKey.get(key) : mediaBySlackFileObject.get(file);
    if (cached) {
      return cached;
    }
    const pending = loadSlackMediaModule()
      .then(({ resolveSlackMedia }) =>
        resolveSlackMedia({
          files: [file],
          client: params.ctx.app.client,
          token: params.ctx.botToken,
          maxBytes: params.ctx.mediaMaxBytes,
        }),
      )
      .then((media) => media?.[0] ?? null);
    if (key) {
      mediaBySlackFileKey.set(key, pending);
    } else {
      mediaBySlackFileObject.set(file, pending);
    }
    return pending;
  };
  const resolveThreadFiles = async (
    files: SlackThreadStarter["files"],
  ): Promise<SlackMediaResult[]> => {
    if (!files || files.length === 0) {
      return [];
    }
    const { results } = await runTasksWithConcurrency({
      tasks: files.map((file) => () => resolveThreadFile(file)),
      limit: SLACK_THREAD_CONTEXT_MEDIA_CONCURRENCY,
    });
    return results.filter((result): result is SlackMediaResult => result !== null);
  };

  if (!params.isThreadReply || !params.threadTs) {
    return {
      threadStarterBody,
      threadHistoryBody,
      shouldSeedInitialThreadContext,
      threadLabel,
      threadStarterMedia,
    };
  }

  const starter = params.threadStarter;
  const starterSenderName =
    params.allowNameMatching && params.allowFromLower.length > 0 && starter?.userId
      ? (await params.ctx.resolveUserName(starter.userId))?.name
      : undefined;
  const starterIsCurrentBot = Boolean(
    starter &&
    isCurrentBotAuthor({
      userId: starter.userId,
      botId: starter.botId,
    }),
  );
  const starterAllowed =
    !starter ||
    (!starterIsCurrentBot &&
      isSlackThreadContextSenderAllowed({
        allowFromLower: params.allowFromLower,
        allowNameMatching: params.allowNameMatching,
        userId: starter.userId,
        userName: starterSenderName,
        botId: starter.botId,
      }));
  const includeStarterContext =
    !starter ||
    (!starterIsCurrentBot &&
      shouldIncludeSupplementalContext({
        mode: params.contextVisibilityMode,
        kind: "thread",
        senderAllowed: starterAllowed,
      }));

  if (starter?.text && includeStarterContext) {
    threadStarterBody = starter.text;
    const snippet = formatSlackThreadLabelSnippet(starter.text);
    threadLabel = `Slack thread ${params.roomLabel}${snippet ? `: ${snippet}` : ""}`;
    // Root media seeds a new thread session once. Rehydrating it later makes
    // old files look like current-turn uploads and repeats media processing.
    if (
      shouldSeedInitialThreadContext &&
      !params.effectiveDirectMedia &&
      starter.files &&
      starter.files.length > 0
    ) {
      const starterMedia = await resolveThreadFiles(starter.files);
      threadStarterMedia = starterMedia.length > 0 ? starterMedia : null;
      if (threadStarterMedia?.length) {
        const starterPlaceholders = threadStarterMedia.map((item) => item.placeholder).join(", ");
        logVerbose(`slack: hydrated thread starter file ${starterPlaceholders} from root message`);
      }
    }
  } else {
    threadLabel = `Slack thread ${params.roomLabel}`;
  }

  const includeBotStarterAsRootContext = shouldIncludeBotThreadStarterContext({
    starterIsCurrentBot,
    isNewThreadSession: shouldSeedInitialThreadContext,
    hasStarterText: Boolean(starter?.text),
  });

  if (starter?.text && starterIsCurrentBot && !includeBotStarterAsRootContext) {
    logVerbose("slack: omitted current-bot thread starter from context");
  } else if (starter?.text && !includeStarterContext && !starterIsCurrentBot) {
    logVerbose(
      `slack: omitted thread starter from context (mode=${params.contextVisibilityMode}, sender_allowed=${starterAllowed ? "yes" : "no"})`,
    );
  } else if (includeBotStarterAsRootContext) {
    threadLabel = formatSlackBotStarterThreadLabel({
      roomLabel: params.roomLabel,
      starterText: starter?.text,
    });
    logVerbose("slack: retained current-bot thread starter as assistant root context");
  }

  const threadInitialHistoryLimit = params.account.config?.thread?.initialHistoryLimit ?? 20;

  if (threadInitialHistoryLimit > 0 && shouldLoadInitialThreadHistory) {
    const currentBotRootTs = starter?.ts ?? params.threadTs;
    const threadHistoryResult = await resolveSlackThreadHistory({
      channelId: params.message.channel,
      threadTs: params.threadTs,
      client: params.ctx.app.client,
      currentMessageTs: params.message.ts,
      limit: threadInitialHistoryLimit,
    });
    const threadHistory = threadHistoryResult.messages;

    const threadHistoryWithBotRootUnbounded = ensureSlackThreadHistoryHasBotRoot({
      history: threadHistory,
      includeBotStarterAsRootContext,
      threadStarter: starter ? { ...starter, ts: currentBotRootTs } : null,
    });
    const botRootWasInjected = threadHistoryWithBotRootUnbounded.length > threadHistory.length;
    // A restored root consumes one configured history slot. Preserve it first,
    // then keep the newest replies in their existing order so root injection
    // cannot exceed the limit or evict a newer reply instead of an older one.
    const retainedReplySlots = Math.max(0, threadInitialHistoryLimit - 1);
    const threadHistoryWithBotRoot =
      botRootWasInjected && threadHistoryWithBotRootUnbounded.length > threadInitialHistoryLimit
        ? [
            threadHistoryWithBotRootUnbounded[0]!,
            ...(retainedReplySlots > 0
              ? threadHistoryWithBotRootUnbounded.slice(-retainedReplySlots)
              : []),
          ]
        : threadHistoryWithBotRootUnbounded;

    if (threadHistoryWithBotRoot.length > 0) {
      const historyFilterPolicy = resolveSlackThreadHistoryFilterPolicy({
        includeBotStarterAsRootContext,
        starterTs: currentBotRootTs,
      });
      const {
        kept: threadHistoryWithoutCurrentBot,
        omittedCurrentBot: omittedCurrentBotHistoryCount,
      } =
        // A missing/stale room transcript has no prior assistant rows to
        // deduplicate, so restore brodie's Slack replies with the human turns.
        // Direct sessions can already own those rows outside the Slack UI
        // thread and retain the legacy current-bot filter to avoid duplication.
        shouldSeedInitialThreadContext && !isDirectThread
          ? { kept: threadHistoryWithBotRoot, omittedCurrentBot: 0 }
          : applySlackThreadHistoryFilterPolicy({
              history: threadHistoryWithBotRoot,
              policy: historyFilterPolicy,
              identity: botIdentity,
            });

      const userMapForFilter =
        params.contextVisibilityMode !== "all" &&
        params.allowNameMatching &&
        params.allowFromLower.length > 0
          ? await resolveSlackThreadUserMap({
              ctx: params.ctx,
              messages: threadHistoryWithoutCurrentBot,
            })
          : new Map<string, { name?: string }>();
      const { items: filteredThreadHistory, omitted: omittedHistoryCount } =
        params.contextVisibilityMode === "all"
          ? { items: threadHistoryWithoutCurrentBot, omitted: 0 }
          : filterSupplementalContextItems({
              items: threadHistoryWithoutCurrentBot,
              mode: params.contextVisibilityMode,
              kind: "thread",
              isSenderAllowed: (historyMsg) => {
                if (
                  isCurrentBotAuthor({
                    userId: historyMsg.userId,
                    botId: historyMsg.botId,
                  })
                ) {
                  return true;
                }
                const msgUser = historyMsg.userId ? userMapForFilter.get(historyMsg.userId) : null;
                return isSlackThreadContextSenderAllowed({
                  allowFromLower: params.allowFromLower,
                  allowNameMatching: params.allowNameMatching,
                  userId: historyMsg.userId,
                  userName: msgUser?.name,
                  botId: historyMsg.botId,
                });
              },
            });
      const userMap = await resolveSlackThreadUserMap({
        ctx: params.ctx,
        messages: filteredThreadHistory,
      });
      if (omittedHistoryCount > 0 || omittedCurrentBotHistoryCount > 0) {
        logVerbose(
          `slack: omitted ${omittedHistoryCount + omittedCurrentBotHistoryCount} thread message(s) from context (mode=${params.contextVisibilityMode})`,
        );
      }

      const historicalMedia = new Map<
        SlackThreadStarter,
        Map<
          NonNullable<SlackThreadStarter["files"]>[number],
          {
            media: SlackMediaResult | null;
            understanding?: SlackThreadMediaUnderstanding;
          }
        >
      >();
      const historicalFileTasks = filteredThreadHistory.flatMap((historyMsg) =>
        (historyMsg.files ?? []).map((file) => async () => ({
          historyMsg,
          file,
          result: await resolveThreadFile(file).then(async (media) => ({
            media,
            understanding: await resolveSlackThreadMediaUnderstanding({
              media,
              fallbackContentType: file.mimetype,
              cfg: params.ctx.cfg,
              sessionKey: params.sessionKey,
              chatType: isDirectThread ? "direct" : "channel",
            }),
          })),
        })),
      );
      if (historicalFileTasks.length > 0) {
        const { results } = await runTasksWithConcurrency({
          tasks: historicalFileTasks,
          limit: SLACK_THREAD_CONTEXT_MEDIA_CONCURRENCY,
        });
        for (const { historyMsg, file, result } of results) {
          const byFile = historicalMedia.get(historyMsg) ?? new Map();
          byFile.set(file, result);
          historicalMedia.set(historyMsg, byFile);
        }
      }

      const currentBotName =
        (await params.ctx.resolveUserName(params.ctx.botUserId))?.name ?? "Bot (this assistant)";
      const renderedMessages = filteredThreadHistory.map((historyMsg) => {
        const msgUser = historyMsg.userId ? userMap.get(historyMsg.userId) : null;
        const isCurrentBot = isCurrentBotAuthor({
          userId: historyMsg.userId,
          botId: historyMsg.botId,
        });
        const senderType = isCurrentBot ? "assistant_self" : historyMsg.botId ? "bot" : "human";
        return {
          message: historyMsg,
          senderName: isCurrentBot
            ? currentBotName
            : (msgUser?.name ??
              historyMsg.botName ??
              (historyMsg.botId ? `Bot (${historyMsg.botId})` : "Unknown")),
          senderId: isCurrentBot ? params.ctx.botUserId : (historyMsg.userId ?? historyMsg.botId),
          senderType,
          media: (historyMsg.files ?? []).map((file) => ({
            file,
            resolved: historicalMedia.get(historyMsg)?.get(file)?.media ?? null,
            understanding: historicalMedia.get(historyMsg)?.get(file)?.understanding,
          })),
        } as const;
      });
      if (renderedMessages.length > 0) {
        const currentInboundIsCurrentBot = isCurrentBotAuthor({
          userId: params.message.user,
          botId: params.message.bot_id,
        });
        const currentInboundUserName = params.message.user
          ? (await params.ctx.resolveUserName(params.message.user))?.name
          : undefined;
        const currentInboundSenderType = currentInboundIsCurrentBot
          ? "assistant_self"
          : params.message.bot_id
            ? "bot"
            : "human";
        const currentInboundSenderName = currentInboundIsCurrentBot
          ? currentBotName
          : (currentInboundUserName ??
            params.message.username ??
            (params.message.bot_id ? `Bot (${params.message.bot_id})` : "Unknown"));
        const rootMessage =
          filteredThreadHistory.find((historyMsg) => historyMsg.ts === params.threadTs) ?? starter;
        const rootIsCurrentBot = Boolean(
          rootMessage &&
          isCurrentBotAuthor({
            userId: rootMessage.userId,
            botId: rootMessage.botId,
          }),
        );
        const fetchedMessageDroppedForInjectedRoot =
          botRootWasInjected &&
          !threadHistoryResult.threadRootFetched &&
          threadHistory.length >= threadInitialHistoryLimit
            ? 1
            : 0;
        threadHistoryBody = renderSlackThreadHistory({
          teamId: params.ctx.teamId,
          channelId: params.message.channel,
          roomLabel: params.roomLabel,
          threadTs: params.threadTs,
          historyLimit: threadInitialHistoryLimit,
          currentInbound: {
            messageId: params.message.ts,
            senderName: currentInboundSenderName,
            senderId: currentInboundIsCurrentBot
              ? params.ctx.botUserId
              : (params.message.user ?? params.message.bot_id),
            senderType: currentInboundSenderType,
          },
          messages: renderedMessages,
          accounting: {
            messagesFetched: threadHistoryResult.messagesFetched,
            emptyMessagesOmitted: threadHistoryResult.emptyMessagesOmitted,
            messagesOmittedByLimit:
              threadHistoryResult.messagesOmittedByLimit + fetchedMessageDroppedForInjectedRoot,
            messagesOmittedByVisibility: omittedHistoryCount,
            messagesOmittedAsDuplicateAssistant: omittedCurrentBotHistoryCount,
            threadRootRestored: botRootWasInjected,
            threadRootFetched: threadHistoryResult.threadRootFetched,
            currentInboundExcluded: threadHistoryResult.currentInboundExcluded,
            historyComplete: threadHistoryResult.historyComplete,
          },
          botUserId: params.ctx.botUserId,
          rootSenderId: rootIsCurrentBot
            ? params.ctx.botUserId
            : (rootMessage?.userId ?? rootMessage?.botId),
          envelopeOptions: params.envelopeOptions,
        });
        logVerbose(
          `slack: populated thread history with ${filteredThreadHistory.length} messages for new session`,
        );
      }
    }
  }

  return {
    threadStarterBody,
    threadHistoryBody,
    shouldSeedInitialThreadContext,
    threadLabel,
    threadStarterMedia,
  };
}
