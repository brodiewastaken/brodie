import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("scheduler config schema", () => {
  it("accepts route, channel, and global debounce layers plus split copy", () => {
    expect(
      OpenClawSchema.parse({
        scheduler: {
          enabled: true,
          capacity: { maxRows: 500, maxBytes: 1_000_000 },
          debounce: {
            exactRoutes: { '["discord","primary","room",null]': { textMs: 6_900 } },
            channels: { discord: { shared: { textMs: 4_200, mediaMs: 6_900 } } },
            conversationClasses: { direct: { textMs: 0, mediaMs: 6_900 } },
          },
          copy: {
            sources: { human_message: { singular: "one", plural: "many" } },
            timing: { idle: { singular: "now", plural: "now" } },
          },
        },
      }).scheduler,
    ).toMatchObject({ enabled: true, capacity: { maxRows: 500 } });
  });

  it("rejects negative timing and incomplete copy pairs", () => {
    expect(() =>
      OpenClawSchema.parse({
        scheduler: { debounce: { conversationClasses: { direct: { textMs: -1 } } } },
      }),
    ).toThrow();
    expect(() =>
      OpenClawSchema.parse({ scheduler: { copy: { genericSource: { singular: "only" } } } }),
    ).toThrow();
  });
});
