import type { JsonValue } from "./conversation-scheduler.js";

export type HumanInboundUnderstanding = {
  kind: "image.description" | "audio.transcription" | "video.description" | "file.extraction";
  text: string;
  provider: string;
  model?: string;
  trust: "derived_untrusted";
};

export type HumanInboundMedia = {
  kind: "image" | "video" | "audio" | "file" | "sticker";
  mimeType?: string;
  sizeBytes?: number;
  fileName?: string;
  mediaRef: string;
  managedLocalPath?: string;
  url?: string;
  caption?: string;
  sourceMessageId: string;
  sourceIndex: number;
  nativeImageCandidate?: { contentHash: string };
  nativeImageOmission?: { reason: "policy_ceiling" | "model_not_image_capable" };
  externalFileMarker?: string;
  understanding: HumanInboundUnderstanding[];
  metadata?: JsonValue;
};

export type HumanInboundConversation = {
  channel: string;
  conversationType: string;
  conversationName?: string;
  conversationLabel?: string;
  conversationMembers?: Array<{ label: string; id?: string; brodie?: boolean }>;
  sessionKey: string;
  guild?: { id: string; name?: string };
  nativeChannel?: { id: string; name?: string; kind?: string };
  parentChannel?: { id: string; name?: string };
  thread?: { id: string; name?: string };
  topic?: { id: string; name?: string };
  chatId?: string;
};

export type HumanInboundQuote = {
  sender: string;
  senderId: string;
  messageId: string;
  timestamp?: string;
  body?: string;
  quoteText?: string;
  media?: HumanInboundMedia[];
};

export type HumanInboundForward = {
  forwardedFrom?: string;
  forwardedFromId?: string;
  forwardedFromUsername?: string;
  forwardedAt?: string;
};

export type HumanInboundLocation = {
  latitude: number;
  longitude: number;
  accuracyM?: number;
  name?: string;
  address?: string;
  caption?: string;
};

export type HumanInbound = {
  sourceEventId: string;
  sender: {
    label: string;
    id: string;
    username?: string;
    displayName?: string;
    nativeId?: string;
    memberRoleIds?: string[];
    bot?: boolean;
  };
  messageId?: string;
  timestamp?: string;
  inboundEventKind?: string;
  eventType?: string;
  reaction?: JsonValue;
  quotePosition?: number;
  wasMentioned?: boolean;
  contextFlags?: string[];
  authoredBody?: string;
  bodyForAgent?: string;
  quote?: HumanInboundQuote;
  forward?: HumanInboundForward;
  location?: HumanInboundLocation;
  media: HumanInboundMedia[];
  nativeMetadata: JsonValue;
};

/** One adapter-owned source event. The scheduler materializes the batch after debounce. */
export type HumanInboundEventPayload = {
  version: 1;
  channel: "whatsapp" | "discord" | "telegram" | "slack";
  accountId: string;
  conversationId: string;
  destination?: string;
  nativeChannelId?: string;
  threadId?: string;
  sessionKey: string;
  messageId: string;
  receivedAt: number;
  chatType: "direct" | "group" | "channel";
  participantCount?: number;
  duoRoom?: boolean;
  sender: {
    id: string;
    name?: string;
    e164?: string;
    username?: string;
    displayName?: string;
    tag?: string;
    roles?: string[];
    bot?: boolean;
    nativeId?: string;
  };
  body?: string;
  bodyForAgent?: string;
  commandBody?: string;
  commandAuthorized: boolean;
  wasMentioned?: boolean;
  inboundEventKind?: string;
  eventType?: string;
  reaction?: JsonValue;
  quotePosition?: number;
  quote?: HumanInboundQuote;
  forward?: HumanInboundForward;
  location?: HumanInboundLocation;
  supplemental?: {
    thread?: {
      starterBody?: string;
      historyBody?: string;
      label?: string;
    };
  };
  media: HumanInboundMedia[];
  conversation: HumanInboundConversation;
  nativeMetadata: JsonValue;
};
