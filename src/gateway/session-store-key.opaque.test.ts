import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionStoreKey } from "./session-store-key.js";

describe("opaque session-store keys", () => {
  const cfg = {} as OpenClawConfig;

  it("preserves opaque agent keys", () => {
    const key = "agent:main:conversation:discord:default:channel:room";
    expect(resolveSessionStoreKey({ cfg, sessionKey: key })).toBe(key);
  });

  it.each(["http://agent:main:main", "HTTPS://agent:main:main", "custom://peer"])(
    "rejects URI-shaped input %s",
    (sessionKey) => {
      expect(() => resolveSessionStoreKey({ cfg, sessionKey })).toThrow(
        "expected a non-empty opaque identifier",
      );
    },
  );
});
