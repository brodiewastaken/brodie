import { describe, expect, it } from "vitest";
import {
  buildQueueBatchIdentity,
  mergeQueueBatchIdentities,
  normalizeQueueBatchIdentity,
} from "./queue-batch-identity.js";

describe("queue batch identity", () => {
  it("builds and merges ordered identities for one route", () => {
    const first = buildQueueBatchIdentity({
      routeKey: "route-a",
      sourceMessageIds: ["message-1"],
      nativeImageCount: 1,
    });
    const second = buildQueueBatchIdentity({
      routeKey: "route-a",
      sourceMessageIds: ["message-2", "message-3"],
      nativeImageCount: 2,
    });

    expect(mergeQueueBatchIdentities([first, second])).toEqual({
      version: 1,
      routeKey: "route-a",
      sourceMessageIds: ["message-1", "message-2", "message-3"],
      nativeImageCount: 3,
    });
  });

  it("refuses incomplete or cross-route batches", () => {
    const first = buildQueueBatchIdentity({
      routeKey: "route-a",
      sourceMessageIds: ["message-1"],
      nativeImageCount: 0,
    });
    const otherRoute = buildQueueBatchIdentity({
      routeKey: "route-b",
      sourceMessageIds: ["message-2"],
      nativeImageCount: 0,
    });

    expect(mergeQueueBatchIdentities([first, undefined])).toBeUndefined();
    expect(mergeQueueBatchIdentities([first, otherRoute])).toBeUndefined();
  });

  it("validates replayed metadata without coercing malformed fields", () => {
    expect(
      normalizeQueueBatchIdentity({
        version: 1,
        routeKey: " route-a ",
        sourceMessageIds: [" message-1 "],
        nativeImageCount: 0,
      }),
    ).toEqual({
      version: 1,
      routeKey: "route-a",
      sourceMessageIds: ["message-1"],
      nativeImageCount: 0,
    });
    expect(
      normalizeQueueBatchIdentity({
        version: 1,
        routeKey: "route-a",
        sourceMessageIds: ["message-1"],
        nativeImageCount: -1,
      }),
    ).toBeUndefined();
  });
});
