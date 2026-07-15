import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  cleanup: vi.fn(async () => undefined),
  runCapability: vi.fn(),
}));

vi.mock("../../media-understanding/runner.js", () => ({
  buildProviderRegistry: () => new Map(),
  normalizeMediaAttachments: (ctx: { MediaPaths: string[]; MediaUrls: string[] }) =>
    ctx.MediaPaths.map((path, index) => ({
      index,
      path: path || undefined,
      url: ctx.MediaUrls[index] || undefined,
      mime: "video/mp4",
      sourceIndex: index,
    })),
  resolveMediaAttachmentLocalRoots: () => [],
  createMediaAttachmentCache: () => ({ cleanup: mocks.cleanup }),
  runCapability: (...args: unknown[]) => mocks.runCapability(...args),
}));

const { createVideoTool } = await import("./video-tool.js");

describe("video understanding tool", () => {
  it("keeps prompt-plus-multiple-video understanding separate from generation", async () => {
    mocks.runCapability.mockResolvedValueOnce({
      outputs: [
        {
          kind: "video.description",
          attachmentIndex: 0,
          text: "first",
          provider: "google",
          model: "gemini-test",
        },
        {
          kind: "video.description",
          attachmentIndex: 1,
          text: "second",
          provider: "google",
          model: "gemini-test",
        },
      ],
      decision: { capability: "video", outcome: "success", attachments: [] },
    });
    const tool = createVideoTool({
      config: {
        tools: { media: { video: { prompt: "configured base task" } } },
      } as OpenClawConfig,
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    });
    if (!tool) {
      throw new Error("expected video understanding tool");
    }

    const result = await tool.execute("call-1", {
      prompt: "compare the clips",
      video: "media://inbound/one.mp4",
      videos: ["https://example.test/two.mp4", "media://inbound/one.mp4"],
    });

    expect(tool.name).toBe("video");
    expect(mocks.runCapability).toHaveBeenCalledOnce();
    expect(mocks.runCapability.mock.calls[0]?.[0]).toMatchObject({
      capability: "video",
      media: [
        { index: 0, path: "media://inbound/one.mp4", sourceIndex: 0 },
        { index: 1, url: "https://example.test/two.mp4", sourceIndex: 1 },
      ],
      config: {
        _requestPromptOverride:
          "configured base task\n\n[AGENT-REQUESTED FOCUS]\ncompare the clips",
      },
    });
    expect(result.content[0]?.text).toContain('"text": "first"');
    expect(result.content[0]?.text).toContain('"text": "second"');
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });
});
