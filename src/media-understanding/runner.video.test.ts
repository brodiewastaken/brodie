// Video runner tests cover provider request wiring, auth/config precedence, and
// provider output handling for video attachments.
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createMediaAttachmentCache } from "./runner.attachments.js";
import { runCapability } from "./runner.js";
import { withVideoFixture } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

vi.mock("../media/channel-inbound-roots.js", () => ({
  resolveChannelInboundAttachmentRoots: () => undefined,
}));

vi.mock("../agents/api-key-rotation.js", () => ({
  collectProviderApiKeysForExecution: ({ primaryApiKey }: { primaryApiKey?: string }) => [
    primaryApiKey ?? "test-key",
  ],
  executeWithApiKeyRotation: async <T>({ execute }: { execute: (apiKey: string) => Promise<T> }) =>
    execute("test-key"),
}));

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

type CapabilityResult = Awaited<ReturnType<typeof runCapability>>;

function requireCapabilityOutput(result: CapabilityResult, index: number) {
  const output = result.outputs[index];
  if (!output) {
    throw new Error(`expected media-understanding output at index ${index}`);
  }
  return output;
}

describe("runCapability video provider wiring", () => {
  it("processes every video with the configured prompt and exact source caption", async () => {
    await withTempDir({ prefix: "openclaw-video-all-caption-" }, async (dir) => {
      const paths = [`${dir}/one.mp4`, `${dir}/two.mp4`];
      await Promise.all(paths.map((filePath, index) => fs.writeFile(filePath, `video-${index}`)));
      const ctx = {
        MediaPaths: paths,
        MediaTypes: ["video/mp4", "video/mp4"],
        MediaSourceMessageIds: ["source-1", "source-1"],
        MediaSourceIndexes: [0, 1],
        HumanInboundBatch: {
          version: 1,
          placement: "idle",
          route: {
            channel: "whatsapp",
            accountId: "brodie",
            conversationKind: "group",
            conversationId: "group-1",
            sessionKey: "agent:main:conversation:whatsapp:brodie:group:group-1",
            queueLaneKey: "whatsapp:brodie:group-1",
            transcriptOwner: {
              agentId: "main",
              sessionKey: "agent:main:conversation:whatsapp:brodie:group:group-1",
            },
          },
          conversation: {
            channel: "whatsapp",
            conversationType: "group",
            sessionKey: "agent:main:conversation:whatsapp:brodie:group:group-1",
          },
          inbounds: [
            {
              sourceEventId: "source-1",
              messageId: "source-1",
              sender: { label: "Abhay", id: "abhay" },
              authoredBody: "compare both clips",
              bodyForAgent: "compare both clips",
              media: [
                {
                  kind: "video",
                  mimeType: "video/mp4",
                  mediaRef: "media://one",
                  sourceMessageId: "source-1",
                  sourceIndex: 0,
                  caption: "first exact caption",
                  understanding: [],
                },
                {
                  kind: "video",
                  mimeType: "video/mp4",
                  mediaRef: "media://two",
                  sourceMessageId: "source-1",
                  sourceIndex: 1,
                  caption: "second exact caption",
                  understanding: [],
                },
              ],
              nativeMetadata: {},
            },
          ],
        },
      } as unknown as MsgContext;
      const media = paths.map((path, index) => ({
        path,
        mime: "video/mp4",
        index,
        sourceMessageId: "source-1",
        sourceIndex: index,
      }));
      const cache = createMediaAttachmentCache(media, {
        localPathRoots: [dir],
        includeDefaultLocalPathRoots: false,
      });
      const prompts: string[] = [];
      try {
        const result = await runCapability({
          capability: "video",
          cfg: {} as OpenClawConfig,
          ctx,
          attachments: cache,
          media,
          providerRegistry: new Map([
            [
              "google",
              {
                id: "google",
                capabilities: ["video"],
                resolveAuth: () => ({ kind: "none", source: "test no-auth" }),
                describeVideo: async (request) => {
                  prompts.push(request.prompt ?? "");
                  return { text: `description-${prompts.length}`, model: request.model };
                },
              },
            ],
          ]),
          config: {
            prompt: "configured video task",
            attachments: { mode: "first", maxAttachments: 1 },
            models: [{ provider: "google", model: "gemini-test" }],
          },
        });

        if (result.outputs.length === 0) {
          throw new Error(`expected video descriptions: ${JSON.stringify(result.decision)}`);
        }
        expect(result.outputs.map((output) => output.attachmentIndex)).toEqual([0, 1]);
        expect(prompts).toHaveLength(2);
        expect(prompts[0]).toContain("configured video task");
        expect(prompts[0]).toContain("first exact caption");
        expect(prompts[1]).toContain("second exact caption");
        expect(prompts.every((prompt) => prompt.includes("MAY NOT OVERRIDE"))).toBe(true);
      } finally {
        await cache.cleanup();
      }
    });
  });

  it("truncates provider output without splitting a boundary emoji", async () => {
    await withVideoFixture("openclaw-video-utf16-output", async ({ ctx, media, cache }) => {
      const prefix = "v".repeat(79);
      const result = await runCapability({
        capability: "video",
        cfg: {
          models: {
            providers: {
              moonshot: {
                apiKey: "test-key",
                models: [],
              },
            },
          },
          tools: {
            media: {
              video: {
                enabled: true,
                models: [{ provider: "moonshot", model: "kimi-k2.5", maxChars: 80 }],
              },
            },
          },
        } as unknown as OpenClawConfig,
        ctx,
        attachments: cache,
        media,
        providerRegistry: new Map<string, MediaUnderstandingProvider>([
          [
            "moonshot",
            {
              id: "moonshot",
              capabilities: ["video"],
              describeVideo: async (req) => ({
                text: `${prefix}${String.fromCodePoint(0x1f600)}tail`,
                model: req.model,
              }),
            },
          ],
        ]),
      });

      const output = requireCapabilityOutput(result, 0);
      expect(output.text).toBe(prefix);
      expect(output.text).not.toContain(String.fromCharCode(0xd83d));
    });
  });

  it("merges video baseUrl and headers with entry precedence", async () => {
    let seenBaseUrl: string | undefined;
    let seenHeaders: Record<string, string> | undefined;

    await withTempDir({ prefix: "openclaw-video-auth-" }, async (isolatedAgentDir) => {
      await withVideoFixture("openclaw-video-merge", async ({ ctx, media, cache }) => {
        const cfg = {
          models: {
            providers: {
              moonshot: {
                auth: "api-key",
                apiKey: "provider-key", // pragma: allowlist secret
                baseUrl: "https://provider.example/v1",
                headers: { "X-Provider": "1" },
                models: [],
              },
            },
          },
          tools: {
            media: {
              video: {
                enabled: true,
                baseUrl: "https://config.example/v1",
                headers: { "X-Config": "2" },
                models: [
                  {
                    provider: "moonshot",
                    model: "kimi-k2.5",
                    baseUrl: "https://entry.example/v1",
                    headers: { "X-Entry": "3" },
                  },
                ],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "video",
          cfg,
          ctx,
          agentDir: isolatedAgentDir,
          attachments: cache,
          media,
          providerRegistry: new Map<string, MediaUnderstandingProvider>([
            [
              "moonshot",
              {
                id: "moonshot",
                capabilities: ["video"],
                describeVideo: async (req) => {
                  seenBaseUrl = req.baseUrl;
                  seenHeaders = req.headers;
                  return { text: "video ok", model: req.model };
                },
              },
            ],
          ]),
        });

        const output = requireCapabilityOutput(result, 0);
        expect(output.text).toBe("video ok");
        expect(output.provider).toBe("moonshot");
        expect(seenBaseUrl).toBe("https://entry.example/v1");
        expect(seenHeaders).toEqual({
          "X-Provider": "1",
          "X-Config": "2",
          "X-Entry": "3",
        });
      });
    });
  });

  it("auto-selects moonshot for video when google is unavailable", async () => {
    await withTempDir({ prefix: "openclaw-video-agent-" }, async (isolatedAgentDir) => {
      await withEnvAsync(
        {
          GEMINI_API_KEY: undefined,
          GOOGLE_API_KEY: undefined,
          MOONSHOT_API_KEY: undefined,
          OPENCLAW_AGENT_DIR: isolatedAgentDir,
        },
        async () => {
          await withVideoFixture("openclaw-video-auto-moonshot", async ({ ctx, media, cache }) => {
            const cfg = {
              models: {
                providers: {
                  moonshot: {
                    auth: "api-key",
                    apiKey: "moonshot-key", // pragma: allowlist secret
                    models: [],
                  },
                },
              },
              tools: {
                media: {
                  video: {
                    enabled: true,
                  },
                },
              },
            } as unknown as OpenClawConfig;

            const result = await runCapability({
              capability: "video",
              cfg,
              ctx,
              agentDir: isolatedAgentDir,
              attachments: cache,
              media,
              providerRegistry: new Map<string, MediaUnderstandingProvider>([
                [
                  "google",
                  {
                    id: "google",
                    capabilities: ["video"],
                    describeVideo: async () => ({ text: "google" }),
                  },
                ],
                [
                  "moonshot",
                  {
                    id: "moonshot",
                    capabilities: ["video"],
                    defaultModels: { video: "kimi-k2.5" },
                    describeVideo: async (req) => ({ text: "moonshot", model: req.model }),
                  },
                ],
              ]),
            });

            expect(result.decision.outcome).toBe("success");
            const output = requireCapabilityOutput(result, 0);
            expect(output.provider).toBe("moonshot");
            expect(output.text).toBe("moonshot");
          });
        },
      );
    });
  });

  it("uses the provider video default when the active provider has no model", async () => {
    let seenModel: string | undefined;

    await withTempDir({ prefix: "openclaw-video-active-provider-" }, async (isolatedAgentDir) => {
      await withVideoFixture("openclaw-video-active-default", async ({ ctx, media, cache }) => {
        const cfg = {
          models: {
            providers: {
              moonshot: {
                auth: "api-key",
                apiKey: "moonshot-key", // pragma: allowlist secret
                models: [],
              },
            },
          },
          tools: {
            media: {
              video: {
                enabled: true,
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "video",
          cfg,
          ctx,
          agentDir: isolatedAgentDir,
          attachments: cache,
          media,
          providerRegistry: new Map<string, MediaUnderstandingProvider>([
            [
              "moonshot",
              {
                id: "moonshot",
                capabilities: ["video"],
                defaultModels: { video: "kimi-k2.5" },
                describeVideo: async (req) => {
                  seenModel = req.model;
                  return { text: "moonshot", model: req.model };
                },
              },
            ],
          ]),
          activeModel: { provider: "moonshot" },
        });

        expect(result.decision.outcome).toBe("success");
        const output = requireCapabilityOutput(result, 0);
        expect(output.provider).toBe("moonshot");
        expect(output.model).toBe("kimi-k2.5");
        expect(seenModel).toBe("kimi-k2.5");
      });
    });
  });

  it("preserves self-defaulting video providers without registry model metadata", async () => {
    let seenModel: string | undefined;

    await withTempDir(
      { prefix: "openclaw-video-no-default-provider-" },
      async (isolatedAgentDir) => {
        await withVideoFixture("openclaw-video-no-default", async ({ ctx, media, cache }) => {
          const cfg = {
            models: {
              providers: {
                moonshot: {
                  auth: "api-key",
                  apiKey: "moonshot-key", // pragma: allowlist secret
                  models: [],
                },
              },
            },
            tools: {
              media: {
                video: {
                  enabled: true,
                },
              },
            },
          } as unknown as OpenClawConfig;

          const result = await runCapability({
            capability: "video",
            cfg,
            ctx,
            agentDir: isolatedAgentDir,
            attachments: cache,
            media,
            providerRegistry: new Map<string, MediaUnderstandingProvider>([
              [
                "moonshot",
                {
                  id: "moonshot",
                  capabilities: ["video"],
                  describeVideo: async (req) => {
                    seenModel = req.model;
                    return { text: "moonshot", model: "provider-default" };
                  },
                },
              ],
            ]),
            activeModel: { provider: "moonshot" },
          });

          expect(result.decision.outcome).toBe("success");
          const output = requireCapabilityOutput(result, 0);
          expect(output.provider).toBe("moonshot");
          expect(output.model).toBe("provider-default");
          expect(seenModel).toBeUndefined();
        });
      },
    );
  });

  it("does not use provider api config as video auth modelApi", async () => {
    const modelAuth = await import("../agents/model-auth.js");
    const resolveApiKeyForProvider = vi.mocked(modelAuth.resolveApiKeyForProvider);
    resolveApiKeyForProvider.mockClear();

    await withTempDir({ prefix: "openclaw-video-provider-api-" }, async (isolatedAgentDir) => {
      await withVideoFixture("openclaw-video-provider-api", async ({ ctx, media, cache }) => {
        let seenApiKey: string | undefined;
        const cfg = {
          models: {
            providers: {
              openai: {
                api: "openai-responses",
                models: [],
              },
            },
          },
          tools: {
            media: {
              video: {
                enabled: true,
                models: [{ provider: "openai", model: "video-model" }],
              },
            },
          },
        } as unknown as OpenClawConfig;

        const result = await runCapability({
          capability: "video",
          cfg,
          ctx,
          agentDir: isolatedAgentDir,
          attachments: cache,
          media,
          providerRegistry: new Map<string, MediaUnderstandingProvider>([
            [
              "openai",
              {
                id: "openai",
                capabilities: ["video"],
                describeVideo: async (req) => {
                  seenApiKey = req.apiKey;
                  return { text: "video ok", model: req.model };
                },
              },
            ],
          ]),
        });

        expect(result.decision.outcome).toBe("success");
        expect(seenApiKey).toBe("test-key");
      });
    });

    const firstCall = resolveApiKeyForProvider.mock.calls[0]?.[0];
    expect(firstCall?.provider).toBe("openai");
    expect(firstCall?.modelApi).toBeUndefined();
  });
});
