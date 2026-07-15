// Current-turn non-native media handed to context engines for externalization.
// Supporting engines persist each file once by idempotencyKey and replace the
// prompt marker; other engines leave the marker text in place.
export type ContextEngineExternalFileMediaUnderstanding = {
  kind: string;
  text: string;
  provider?: string;
  model?: string;
  trust: "derived_untrusted";
};

export type ContextEngineExternalFile = {
  /** Provisional prompt marker replaced by context engines that can externalize files. */
  marker: string;
  /** Stable dedupe key scoped by the context engine conversation. */
  idempotencyKey: string;
  attachmentIndex: number;
  mediaRef?: string;
  originalPath?: string;
  /** Host-managed path exposed only with an explicit managed-root allowlist. */
  managedLocalPath?: string;
  url?: string;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  kind?: string;
  sourceMessageId?: string;
  sourceIndex?: number;
  /** Stable digest of the exact managed file bytes. */
  contentHash?: string;
  /** Derived-only understanding carried to context engines with an explicit trust label. */
  understanding?: ContextEngineExternalFileMediaUnderstanding[];
  /** @deprecated Use understanding. */
  mediaUnderstanding?: ContextEngineExternalFileMediaUnderstanding[];
};
