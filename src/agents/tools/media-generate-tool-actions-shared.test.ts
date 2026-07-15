import { describe, expect, it } from "vitest";
import { createMediaGenerateProviderListActionResult } from "./media-generate-tool-actions-shared.js";

const provider = {
  id: "canonical",
  aliases: ["alias"],
  label: "Canonical Media",
  defaultModel: "static-default",
  models: ["static-default", "static-extra"],
  capabilities: { generation: true },
  isConfigured: () => true,
};

function list(kind: "image_generation" | "video_generation" | "music_generation") {
  return createMediaGenerateProviderListActionResult({
    kind,
    providers: [provider],
    emptyText: "empty",
    cfg: {
      agents: {
        defaults: {
          model: { primary: "canonical/chat-model" },
          imageModel: { primary: "canonical/image-understanding-model" },
          imageGenerationModel: {
            primary: "alias/image-configured-primary",
            fallbacks: ["canonical/static-extra", "canonical/image-configured-fallback"],
          },
          videoGenerationModel: {
            primary: "alias/video-configured-primary",
            fallbacks: ["canonical/video-configured-fallback"],
          },
          musicGenerationModel: {
            primary: "alias/music-configured-primary",
          },
        },
      },
    },
    listModes: () => ["generate"],
    summarizeCapabilities: () => "generation",
  });
}

describe("createMediaGenerateProviderListActionResult", () => {
  it("unions configured models into the matching provider catalog through aliases", () => {
    const result = list("image_generation");
    const details = result.details.providers as Array<{
      id: string;
      models: string[];
      catalog: Array<Record<string, unknown>>;
    }>;
    const listed = details[0];

    expect(listed?.models).toEqual([
      "static-default",
      "static-extra",
      "image-configured-primary",
      "image-configured-fallback",
    ]);
    expect(listed?.catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "canonical",
          model: "image-configured-primary",
          source: "configured",
          configured: true,
        }),
        expect.objectContaining({
          provider: "canonical",
          model: "image-configured-fallback",
          source: "configured",
          configured: true,
        }),
      ]),
    );
    expect(listed?.catalog.filter((entry) => entry.model === "static-extra")).toHaveLength(1);
    expect(result.content[0]?.text).toContain("source: static + configured");
  });

  it.each([
    ["image_generation", "image-configured-primary"],
    ["video_generation", "video-configured-primary"],
    ["music_generation", "music-configured-primary"],
  ] as const)("keeps %s config isolated from other model families", (kind, expectedModel) => {
    const result = list(kind);
    const details = result.details.providers as Array<{
      models: string[];
    }>;
    const models = details[0]?.models ?? [];

    expect(models).toContain(expectedModel);
    expect(models).not.toContain("chat-model");
    expect(models).not.toContain("image-understanding-model");
    expect(models.filter((model) => model.includes("configured-primary"))).toEqual([expectedModel]);
  });
});
