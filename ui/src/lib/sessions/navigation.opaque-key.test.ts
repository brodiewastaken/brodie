import { describe, expect, it } from "vitest";
import { resolveSessionKey, searchForSession } from "./navigation.js";

describe("opaque session navigation", () => {
  it("round trips the complete canonical key as query data", () => {
    const key = "agent:main:conversation:discord:default:channel:room%2Fa%3F";
    const search = searchForSession(key);
    expect(search).toContain(encodeURIComponent(key));
    expect(new URLSearchParams(search).get("session")).toBe(key);
  });

  it("migrates a persisted length-prefixed conversation key before navigation", () => {
    expect(
      resolveSessionKey(
        "agent:main:conversation-v1:8:whatsapp|6:brodie|5:group|23:120363406331109499@g.us|-",
        null,
      ),
    ).toBe("agent:main:conversation:whatsapp:brodie:group:120363406331109499@g.us");
  });
});
