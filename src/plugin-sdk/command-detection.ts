/**
 * Public SDK subpath for detecting control commands in inbound messages.
 */
export {
  hasControlCommand,
  hasInlineCommandTokens,
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
} from "../auto-reply/command-detection.js";
export { isUnaddressedCommandExecutable } from "../auto-reply/command-invocation.js";
