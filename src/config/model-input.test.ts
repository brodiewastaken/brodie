import { describe, expect, it } from "vitest";
import { patchAgentDefaultModelConfig } from "./model-input.js";

describe("patchAgentDefaultModelConfig", () => {
  it("preserves a string-form primary when patching fallbacks", () => {
    expect(
      patchAgentDefaultModelConfig("openai/gpt-5.6-sol", {
        fallbacks: ["anthropic/claude-opus-5"],
      }),
    ).toEqual({
      primary: "openai/gpt-5.6-sol",
      fallbacks: ["anthropic/claude-opus-5"],
    });
  });
});
