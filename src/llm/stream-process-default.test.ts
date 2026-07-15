import { defaultApiRegistry } from "@openclaw/ai/internal/runtime";
import { describe, expect, it, vi } from "vitest";

describe("process-default built-in providers", () => {
  it("keeps the first module copy's providers when a second copy is evaluated", async () => {
    await import("./stream.js");
    const first = defaultApiRegistry.getApiProvider("anthropic-messages");
    expect(first).toBeDefined();

    // a jiti-loaded plugin evaluates a fresh copy of the module graph
    vi.resetModules();
    await import("./stream.js");

    expect(defaultApiRegistry.getApiProvider("anthropic-messages")).toBe(first);
  });
});
