// Fireworks setup module handles plugin onboarding behavior.
import {
  createModelCatalogPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildFireworksCatalogModels,
  buildFireworksProvider,
  FIREWORKS_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";

export const FIREWORKS_DEFAULT_MODEL_REF = `fireworks/${FIREWORKS_DEFAULT_MODEL_ID}`;

const fireworksPresetAppliers = createModelCatalogPresetAppliers({
  primaryModelRef: FIREWORKS_DEFAULT_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => {
    const defaultProvider = buildFireworksProvider();
    const catalogModels = buildFireworksCatalogModels();
    return {
      providerId: "fireworks",
      api: defaultProvider.api ?? "openai-completions",
      baseUrl: defaultProvider.baseUrl,
      catalogModels,
      aliases: catalogModels.map((model) =>
        model.id === FIREWORKS_DEFAULT_MODEL_ID
          ? { modelRef: `fireworks/${model.id}`, alias: "Kimi K3" }
          : { modelRef: `fireworks/${model.id}` },
      ),
    };
  },
});

export function applyFireworksConfig(cfg: OpenClawConfig): OpenClawConfig {
  return fireworksPresetAppliers.applyConfig(cfg);
}
