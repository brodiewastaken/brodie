// Whatsapp plugin module implements runtime behavior.
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const {
  setRuntime,
  getRuntime: getWhatsAppRuntime,
  tryGetRuntime: getOptionalWhatsAppRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "whatsapp",
  errorMessage: "WhatsApp runtime not initialized",
});

const setWhatsAppRuntime = setRuntime;
export { getOptionalWhatsAppRuntime, getWhatsAppRuntime, setWhatsAppRuntime };
