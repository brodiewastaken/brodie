// Streams LLM responses through registered providers and normalizes events.
// This facade owns the process-default AI runtime wiring: it installs the
// OpenClaw host policy ports and registers built-in providers exactly once,
// before any caller imports the stream API.
import { defaultApiRegistry } from "@openclaw/ai/internal/runtime";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import "./ai-transport-host.js";

// A plugin loaded from TypeScript source (jiti) can evaluate a second copy of
// this module. Its providers would resolve secrets against that copy's empty
// sentinel registry, so only the first copy in the process registers.
const BUILT_IN_PROVIDERS_REGISTERED = Symbol.for("openclaw.llm.builtInProvidersRegistered");
const processState = globalThis as { [BUILT_IN_PROVIDERS_REGISTERED]?: true };
if (!processState[BUILT_IN_PROVIDERS_REGISTERED]) {
  processState[BUILT_IN_PROVIDERS_REGISTERED] = true;
  registerBuiltInApiProviders(defaultApiRegistry);
}

export {
  complete,
  completeSimple,
  getEnvApiKey,
  stream,
  streamSimple,
} from "@openclaw/ai/internal/runtime";
