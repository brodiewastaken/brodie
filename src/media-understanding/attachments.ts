// Public attachment facade for normalization, selection, and local media caching helpers.
export {
  isAudioAttachment,
  normalizeAttachments,
  resolveAttachmentKind,
} from "./attachments.normalize.js";
export { selectAttachments } from "./attachments.select.js";
export {
  MediaAttachmentCache,
  type MediaAttachmentCacheOptions,
  type PersistedMediaAttachment,
} from "./attachments.cache.js";
