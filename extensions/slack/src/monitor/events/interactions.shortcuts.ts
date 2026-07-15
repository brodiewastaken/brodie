// Slack plugin module implements shortcut interaction behavior.
import { createHash } from "node:crypto";
import type { GlobalShortcut, MessageShortcut, SlackShortcutMiddlewareArgs } from "@slack/bolt";
import { admitDurableSystemEventWake } from "openclaw/plugin-sdk/heartbeat-runtime";
import { authorizeSlackSystemEventSender } from "../auth.js";
import type { SlackMonitorContext } from "../context.js";

type SlackShortcutBody = GlobalShortcut | MessageShortcut;

function resolveMessageThreadTs(body: MessageShortcut): string | undefined {
  const threadTs = body.message.thread_ts;
  return typeof threadTs === "string" && threadTs.trim() ? threadTs.trim() : undefined;
}

async function handleSlackShortcut(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
  args: SlackShortcutMiddlewareArgs;
  formatSystemEvent: (payload: Record<string, unknown>) => string;
}): Promise<void> {
  const { ack, body } = params.args;
  await ack();
  if (params.ctx.shouldDropMismatchedSlackEvent?.(body)) {
    params.ctx.runtime.log?.("slack:interaction drop shortcut payload (mismatched app/team)");
    return;
  }

  const callbackId = body.callback_id?.trim();
  const userId = body.user?.id?.trim();
  if (!callbackId || !userId) {
    params.ctx.runtime.log?.("slack:interaction drop shortcut reason=invalid-payload");
    return;
  }
  params.trackEvent?.();

  const isMessageShortcut = body.type === "message_action";
  const messageBody = isMessageShortcut ? body : undefined;
  const channelId = messageBody?.channel.id?.trim() || undefined;
  if (isMessageShortcut && !channelId) {
    params.ctx.runtime.log?.(
      `slack:interaction drop shortcut callback=${callbackId} user=${userId} reason=missing-channel`,
    );
    return;
  }
  const threadTs = messageBody ? resolveMessageThreadTs(messageBody) : undefined;
  const auth = await authorizeSlackSystemEventSender({
    ctx: params.ctx,
    senderId: userId,
    channelId,
    channelType: isMessageShortcut ? undefined : "im",
    expectedSenderId: userId,
    interactiveEvent: true,
  });
  if (!auth.allowed) {
    params.ctx.runtime.log?.(
      `slack:interaction drop shortcut callback=${callbackId} user=${userId} reason=${auth.reason ?? "unauthorized"}`,
    );
    return;
  }

  const interactionType = isMessageShortcut ? "message_shortcut" : "global_shortcut";
  const messageTs = messageBody?.message.ts || messageBody?.message_ts;
  const eventPayload = {
    interactionType,
    actionId: `shortcut:${callbackId}`,
    callbackId,
    userId,
    teamId: body.team?.id ?? body.user.team_id,
    triggerId: body.trigger_id,
    actionTs: body.action_ts,
    channelId,
    channelName: messageBody?.channel.name,
    messageTs,
    threadTs,
    messageUserId: messageBody?.message.user,
    messageText: messageBody?.message.text,
    responseUrl: messageBody?.response_url,
  };
  const sessionKey = params.ctx.resolveSlackSystemEventSessionKey({
    channelId,
    channelType: auth.channelType,
    senderId: userId,
    threadTs,
  });
  const contextKey = [
    "slack:interaction:shortcut",
    interactionType,
    callbackId,
    channelId,
    messageTs,
    body.action_ts,
  ]
    .filter(Boolean)
    .join(":");

  params.ctx.runtime.log?.(
    `slack:interaction ${interactionType} callback=${callbackId} user=${userId} channel=${channelId ?? "direct"}`,
  );
  const systemEventText = params.formatSystemEvent(eventPayload);
  const deliveryContext = {
    channel: "slack" as const,
    to: auth.channelType === "im" ? `user:${userId}` : `channel:${channelId}`,
    accountId: params.ctx.accountId,
    threadId: threadTs,
  };
  await admitDurableSystemEventWake({
    cfg: params.ctx.cfg,
    sessionKey,
    systemEvent: { text: systemEventText, contextKey, deliveryContext },
    source: "hook",
    intent: "immediate",
    reason: "hook:slack-interaction",
    sourceGeneration: createHash("sha256")
      .update(params.ctx.accountId)
      .update("\0")
      .update(sessionKey)
      .update("\0")
      .update(contextKey)
      .digest("hex"),
    producerKind: "system",
    heartbeat: { target: "last" },
  });
}

export function registerSlackShortcutHandler(params: {
  ctx: SlackMonitorContext;
  trackEvent?: () => void;
  formatSystemEvent: (payload: Record<string, unknown>) => string;
}): void {
  if (typeof params.ctx.app.shortcut !== "function") {
    return;
  }
  params.ctx.app.shortcut(/.+/, async (args: SlackShortcutMiddlewareArgs<SlackShortcutBody>) => {
    await handleSlackShortcut({
      ctx: params.ctx,
      trackEvent: params.trackEvent,
      args,
      formatSystemEvent: params.formatSystemEvent,
    });
  });
}
