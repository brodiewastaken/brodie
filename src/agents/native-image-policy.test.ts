import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { OpenClawSchema } from "../config/zod-schema.js";
import { DEFAULT_MAX_NATIVE_IMAGES, resolveNativeImagePolicy } from "./native-image-policy.js";

function resolve(cfg: OpenClawConfig) {
  return resolveNativeImagePolicy({ cfg, provider: "openai", model: "gpt-5.6-sol" });
}

describe("resolveNativeImagePolicy", () => {
  it("uses model, global, then the 42-image default", () => {
    expect(
      resolve({
        agents: {
          defaults: {
            maxNativeImages: 31,
            models: { "openai/gpt-5.6-sol": { maxNativeImages: 17 } },
          },
        },
      }),
    ).toEqual({ maxNativeImages: 17, source: "model" });
    expect(resolve({ agents: { defaults: { maxNativeImages: 23 } } })).toEqual({
      maxNativeImages: 23,
      source: "global",
    });
    expect(resolve({})).toEqual({ maxNativeImages: DEFAULT_MAX_NATIVE_IMAGES, source: "default" });
    expect(resolve({ agents: { defaults: { maxNativeImages: 0 } } })).toEqual({
      maxNativeImages: 0,
      source: "global",
    });
  });

  it.each([0, 42, Number.MAX_SAFE_INTEGER])("accepts safe integer %s", (value) => {
    expect(
      OpenClawSchema.safeParse({
        agents: {
          defaults: {
            maxNativeImages: value,
            models: { "openai/gpt-5.6-sol": { maxNativeImages: value } },
          },
        },
      }).success,
    ).toBe(true);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid value %s", (value) => {
    expect(
      OpenClawSchema.safeParse({ agents: { defaults: { maxNativeImages: value } } }).success,
    ).toBe(false);
    expect(
      OpenClawSchema.safeParse({
        agents: { defaults: { models: { "openai/gpt-5.6-sol": { maxNativeImages: value } } } },
      }).success,
    ).toBe(false);
  });
});
