import { describe, expect, it } from "vitest";
import { classifyContextEngineCompactionProgress } from "./context-engine-compaction-progress.js";

describe("classifyContextEngineCompactionProgress", () => {
  it("accepts only an ok compaction with a measured token reduction", () => {
    expect(
      classifyContextEngineCompactionProgress({
        ok: true,
        compacted: true,
        result: { tokensBefore: 237_431, tokensAfter: 157_000 },
      }),
    ).toEqual({
      mutated: true,
      successfulMutation: true,
      retryAuthorized: true,
      exhausted: false,
      tokensBefore: 237_431,
      tokensAfter: 157_000,
    });
  });

  it("rejects compacted=true when the engine returned ok=false", () => {
    expect(
      classifyContextEngineCompactionProgress({
        ok: false,
        compacted: true,
        reason: "provider failed after an attempted sweep",
        result: { tokensBefore: 237_431, tokensAfter: 157_000 },
      }),
    ).toMatchObject({
      mutated: true,
      successfulMutation: false,
      retryAuthorized: false,
      exhausted: false,
    });
  });

  it("rejects a successful-looking compaction that did not reduce tokens", () => {
    expect(
      classifyContextEngineCompactionProgress({
        ok: true,
        compacted: true,
        result: { tokensBefore: 237_431, tokensAfter: 237_431 },
      }),
    ).toMatchObject({
      mutated: true,
      successfulMutation: true,
      retryAuthorized: false,
      exhausted: false,
    });
  });

  it("records an unmeasured mutation without authorizing a retry", () => {
    expect(
      classifyContextEngineCompactionProgress({
        ok: true,
        compacted: true,
        result: { tokensBefore: 237_431 },
      }),
    ).toEqual({
      mutated: true,
      successfulMutation: true,
      retryAuthorized: false,
      exhausted: false,
      tokensBefore: 237_431,
    });
  });

  it("preserves an explicit not-eligible result as exhaustion", () => {
    expect(
      classifyContextEngineCompactionProgress({
        ok: false,
        compacted: false,
        exhausted: true,
        reason: "no eligible context to compact",
      }),
    ).toEqual({
      mutated: false,
      successfulMutation: false,
      retryAuthorized: false,
      exhausted: true,
      reason: "no eligible context to compact",
    });
  });
});
