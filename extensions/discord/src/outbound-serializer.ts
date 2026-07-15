// Discord plugin module serializes outbound message-producing REST sequences.
import { logInfo } from "openclaw/plugin-sdk/logging-core";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

const DISCORD_OUTBOUND_STARVATION_CAP_MS = 5 * 60 * 1000;
const tails = new Map<string, Promise<void>>();

function normalizeSerializationSegment(
  value: string | number | null | undefined,
): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return normalizeOptionalString(value);
}

export function resolveDiscordOutboundSerializationKey(params: {
  accountId?: string | null;
  channelId?: string | number | null;
  threadId?: string | number | null;
  fallbackId?: string | number | null;
}): string {
  const accountId = normalizeOptionalString(params.accountId) ?? "default";
  const destinationId =
    normalizeSerializationSegment(params.threadId) ??
    normalizeSerializationSegment(params.channelId) ??
    normalizeSerializationSegment(params.fallbackId) ??
    "unknown";
  return `discord:${accountId}:${destinationId}`;
}

export async function runDiscordOutboundSerialized<T>(params: {
  key?: string;
  accountId?: string | null;
  channelId?: string | number | null;
  threadId?: string | number | null;
  fallbackId?: string | number | null;
  task: () => Promise<T>;
}): Promise<T> {
  const key =
    params.key ??
    resolveDiscordOutboundSerializationKey({
      accountId: params.accountId,
      channelId: params.channelId,
      threadId: params.threadId,
      fallbackId: params.fallbackId,
    });
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(async () => await gate);
  tails.set(key, tail);
  await previous.catch(() => undefined);

  let evicted = false;
  const timer = setTimeout(() => {
    evicted = true;
    logInfo(
      `discord: outbound send exceeded ${DISCORD_OUTBOUND_STARVATION_CAP_MS}ms cap (key=${key}); unblocking queued sends for this destination`,
    );
    release();
  }, DISCORD_OUTBOUND_STARVATION_CAP_MS);
  timer.unref?.();

  try {
    return await params.task();
  } finally {
    clearTimeout(timer);
    if (!evicted) {
      release();
    }
    void tail.finally(() => {
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    });
  }
}

export const outboundSerializerTesting = {
  resetDiscordOutboundSerializer(): void {
    tails.clear();
  },
  getPendingDiscordOutboundKeys(): string[] {
    return [...tails.keys()];
  },
};
