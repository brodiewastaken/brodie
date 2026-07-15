import { describe, expect, it } from "vitest";
import type { ConversationRoute } from "../routing/conversation-route.js";
import type { ScheduledEvent, SchedulerDispatchBatch } from "./conversation-scheduler.js";
import {
  renderSchedulerEnvelope,
  resolveSchedulerDebounceMs,
  schedulerExactRouteKey,
  type SchedulerPolicyConfig,
} from "./scheduler-policy.js";

const route: ConversationRoute = {
  channel: "discord",
  accountId: "primary",
  conversationKind: "channel",
  conversationId: "room",
  threadId: "thread",
  sessionKey: "agent:main:conversation:test:default:direct:session",
  queueLaneKey: "lane",
  transcriptOwner: {
    agentId: "main",
    sessionKey: "agent:main:conversation:test:default:direct:session",
  },
};

function scheduled(media = false): ScheduledEvent {
  return {
    id: "event",
    route,
    producerKind: media ? "human_media" : "human_message",
    createdAt: 1,
    human: true,
    media,
    payload: { text: "private" },
  };
}

describe("scheduler policy", () => {
  it("uses exact route, channel class, global class, then built-in debounce precedence", () => {
    const exactKey = schedulerExactRouteKey(scheduled());
    const config: SchedulerPolicyConfig = {
      debounce: {
        exactRoutes: { [exactKey]: { textMs: 6_900 } },
        channels: { discord: { shared: { textMs: 5_000 } } },
        conversationClasses: { shared: { textMs: 4_500 } },
      },
    };
    expect(resolveSchedulerDebounceMs({ event: scheduled(), config })).toBe(6_900);
    delete config.debounce?.exactRoutes?.[exactKey];
    expect(resolveSchedulerDebounceMs({ event: scheduled(), config })).toBe(5_000);
    delete config.debounce?.channels?.discord;
    expect(resolveSchedulerDebounceMs({ event: scheduled(), config })).toBe(4_500);
    expect(resolveSchedulerDebounceMs({ event: scheduled(true), config })).toBe(6_900);
  });

  it("renders exactly two independently configured header lines", () => {
    const batch: SchedulerDispatchBatch = {
      attemptId: "attempt",
      placement: "idle",
      events: [{ ...scheduled(), receiptId: "receipt", sequence: 1 }],
    };
    const rendered = renderSchedulerEnvelope({
      batch,
      payload: "hello",
      config: {
        copy: {
          sources: {
            human_message: { singular: "source one", plural: "source many" },
          },
          timing: { idle: { singular: "timing one", plural: "timing many" } },
        },
      },
    });
    expect(rendered).toBe("source one\ntiming one\nhello");
  });

  it("rejects an unconfigured future producer instead of guessing copy", () => {
    const batch: SchedulerDispatchBatch = {
      attemptId: "attempt",
      placement: "idle",
      events: [
        {
          ...scheduled(),
          producerKind: "future_producer" as ScheduledEvent["producerKind"],
          receiptId: "receipt",
          sequence: 1,
        },
      ],
    };
    expect(() => renderSchedulerEnvelope({ batch, payload: "hello" })).toThrow(
      "scheduler copy is missing source future_producer",
    );
  });
});
