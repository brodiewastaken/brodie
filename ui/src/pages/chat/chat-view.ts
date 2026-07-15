// Control UI view renders chat screen composition.
import { html, nothing, type TemplateResult } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import type { SessionsListResult } from "../../api/types.ts";
import type { ChatSendShortcut } from "../../app/settings.ts";
import { icons } from "../../components/icons.ts";
import type { ProviderQuotaPillProps } from "../../components/provider-quota-pill.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";
import type {
  ChatAttachment,
  ChatQueueItem,
  ChatStreamSegment,
} from "../../lib/chat/chat-types.ts";
import type { ChatSideResult } from "../../lib/chat/side-result.ts";
import type { EmbedSandboxMode } from "../../lib/chat/tool-display.ts";
import { type LoadRawTranscriptFullMessage, renderRawTranscript } from "./chat-raw-transcript.ts";
import {
  handleChatAttachmentDrop,
  renderChatComposer,
  resetChatComposerState,
} from "./components/chat-composer.ts";
import "./components/chat-sidebar.ts";
import {
  renderSessionWorkspaceRail,
  type SessionWorkspaceProps,
} from "./components/chat-session-workspace.ts";
import type {
  DetailFullMessageResult,
  SidebarContent,
  SidebarFullMessageRequest,
} from "./components/chat-sidebar.ts";
import {
  handleChatContextMenu,
  isChatThreadSearchOpen,
  renderChatPinnedMessages,
  renderChatSearchBar,
  resetChatThreadPresentationState,
  toggleChatThreadSearch,
} from "./components/chat-thread.ts";
import type { ChatInputHistoryKeyInput, ChatInputHistoryKeyResult } from "./input-history.ts";
import type { RealtimeTalkConversationEntry } from "./realtime-talk-conversation.ts";
import type { RealtimeTalkStatus } from "./realtime-talk.ts";
import type { ChatRunUiStatus } from "./run-lifecycle.ts";
import type { CompactionStatus, FallbackStatus } from "./tool-stream.ts";
import "../../components/resizable-divider.ts";

export type ChatProps = {
  paneId: string;
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  showToolCalls: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  runStatus?: ChatRunUiStatus | null;
  compactionStatus?: CompactionStatus | null;
  fallbackStatus?: FallbackStatus | null;
  messages: unknown[];
  historyHasMore?: boolean;
  historyLoadingOlder?: boolean;
  onLoadOlderHistory?: () => void;
  onLoadRawFullMessage?: LoadRawTranscriptFullMessage;
  sideResult?: ChatSideResult | null;
  toolMessages: unknown[];
  streamSegments: ChatStreamSegment[];
  stream: string | null;
  streamStartedAt: number | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  realtimeTalkActive?: boolean;
  realtimeTalkStatus?: RealtimeTalkStatus;
  realtimeTalkDetail?: string | null;
  realtimeTalkConversation?: RealtimeTalkConversationEntry[];
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  sessions: SessionsListResult | null;
  providerQuota?: ProviderQuotaPillProps;
  focusMode?: boolean;
  onLoadSidebarFullMessage?: (
    request: SidebarFullMessageRequest,
  ) => Promise<DetailFullMessageResult | null | undefined>;
  sidebarOpen?: boolean;
  sidebarContent?: SidebarContent | null;
  splitRatio?: number;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  chatMessageMaxWidth?: string | null;
  assistantName: string;
  sendShortcut?: ChatSendShortcut;
  assistantAvatar: string | null;
  userName?: string | null;
  userAvatar?: string | null;
  localMediaPreviewRoots?: string[];
  assistantAttachmentAuthToken?: string | null;
  autoExpandToolCalls?: boolean;
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  onAssistantAttachmentLoaded?: () => void;
  showNewMessages?: boolean;
  onScrollToBottom?: () => void;
  onRefresh: () => void;
  onToggleFocusMode?: () => void;
  getDraft?: () => string;
  onDraftChange: (next: string) => void;
  onRequestUpdate?: () => void;
  onHistoryKeydown?: (input: ChatInputHistoryKeyInput) => ChatInputHistoryKeyResult;
  onSlashIntent?: () => void | Promise<void>;
  onSend: () => void;
  onCompact?: () => void | Promise<void>;
  onOpenSessionCheckpoints?: () => void | Promise<void>;
  onToggleRealtimeTalk?: () => void;
  onDismissError?: () => void;
  onDismissRealtimeTalkError?: () => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onGoalCommand?: (command: string) => void;
  onDismissSideResult?: () => void;
  onNewSession: () => void;
  onClearHistory?: () => void;
  agentsList: {
    agents: Array<{ id: string; name?: string; identity?: { name?: string; avatarUrl?: string } }>;
    defaultId?: string;
  } | null;
  currentAgentId: string;
  fullMessageAgentId?: string;
  onAgentChange: (agentId: string) => void;
  onNavigateToAgent?: () => void;
  onSessionSelect?: (sessionKey: string) => void;
  onOpenSidebar?: (content: SidebarContent) => void;
  onOpenWorkspaceFile?: (target: { path: string; line?: number | null }) => void;
  onRevealWorkspaceFile?: (path: string) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
  basePath?: string;
  composerControls?: TemplateResult | typeof nothing;
  replyTarget?: { messageId: string; text: string; senderLabel?: string | null } | null;
  onClearReply?: () => void;
  onSetReply?: (target: { messageId: string; text: string; senderLabel?: string | null }) => void;
  sessionWorkspace?: SessionWorkspaceProps;
};

export function resetChatViewState(paneId?: string) {
  resetChatComposerState(paneId);
  resetChatThreadPresentationState(paneId);
}

export function renderChat(props: ChatProps) {
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  const canCompose = props.connected && props.canSend;

  const thread = renderRawTranscript(props.messages, {
    loadFullMessage: props.onLoadRawFullMessage,
    onScroll: props.onChatScroll,
    loading: props.loading,
    stream: props.stream,
    canAbort: props.canAbort,
    realtimeTalkConversation: props.realtimeTalkConversation,
    onContextMenu: (event) => {
      const chatSection = (event.currentTarget as HTMLElement).closest(".card.chat");
      handleChatContextMenu(event, {
        paneId: props.paneId,
        onSetReply: props.onSetReply,
        onFocusComposer: () =>
          chatSection
            ?.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea")
            ?.focus({ preventScroll: true }),
      });
    },
  });

  const chatColumnFooter = renderChatComposer({
    paneId: props.paneId,
    sessionKey: props.sessionKey,
    currentAgentId: props.currentAgentId,
    connected: props.connected,
    canSend: props.canSend,
    disabledReason: props.disabledReason,
    sending: props.sending,
    canAbort: props.canAbort,
    runStatus: props.runStatus,
    compactionStatus: props.compactionStatus,
    fallbackStatus: props.fallbackStatus,
    messages: props.messages,
    stream: props.stream,
    sideResult: props.sideResult,
    queue: props.queue,
    draft: props.draft,
    sessions: props.sessions,
    providerQuota: props.providerQuota,
    assistantName: props.assistantName,
    sendShortcut: props.sendShortcut,
    attachments: props.attachments,
    showNewMessages: props.showNewMessages,
    replyTarget: props.replyTarget,
    realtimeTalkActive: props.realtimeTalkActive,
    realtimeTalkStatus: props.realtimeTalkStatus,
    realtimeTalkDetail: props.realtimeTalkDetail,
    realtimeTalkConversation: props.realtimeTalkConversation,
    composerControls: props.composerControls,
    getDraft: props.getDraft,
    onDraftChange: props.onDraftChange,
    onRequestUpdate: requestUpdate,
    onHistoryKeydown: props.onHistoryKeydown,
    onSlashIntent: props.onSlashIntent,
    onSend: props.onSend,
    onCompact: props.onCompact,
    onToggleRealtimeTalk: props.onToggleRealtimeTalk,
    onDismissRealtimeTalkError: props.onDismissRealtimeTalkError,
    onAbort: props.onAbort,
    onQueueRemove: props.onQueueRemove,
    onQueueRetry: props.onQueueRetry,
    onQueueSteer: props.onQueueSteer,
    onGoalCommand: props.onGoalCommand,
    onDismissSideResult: props.onDismissSideResult,
    onNewSession: props.onNewSession,
    onClearReply: props.onClearReply,
    onScrollToBottom: props.onScrollToBottom,
    onAttachmentsChange: props.onAttachmentsChange,
  });

  return html`
    <section
      class="card chat"
      style=${styleMap(
        props.chatMessageMaxWidth ? { "--chat-message-max-width": props.chatMessageMaxWidth } : {},
      )}
      @drop=${(event: DragEvent) => {
        event.preventDefault();
        if (canCompose) {
          handleChatAttachmentDrop(event, props);
        }
      }}
      @dragover=${(event: DragEvent) => event.preventDefault()}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Escape" && props.replyTarget && !event.defaultPrevented) {
          event.preventDefault();
          props.onClearReply?.();
          return;
        }
        if (event.key === "Escape" && props.sideResult && !isChatThreadSearchOpen(props.paneId)) {
          event.preventDefault();
          props.onDismissSideResult?.();
          return;
        }
        if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === "f") {
          event.preventDefault();
          toggleChatThreadSearch(props.paneId, requestUpdate);
        }
      }}
    >
      ${props.disabledReason ? html`<div class="callout">${props.disabledReason}</div>` : nothing}
      ${props.error
        ? html`
            <div class="callout danger callout--dismissible" role="alert">
              <span class="callout__content">${props.error}</span>
              ${props.onDismissError
                ? html`
                    <openclaw-tooltip content="Dismiss error">
                      <button
                        class="callout__dismiss"
                        type="button"
                        @click=${props.onDismissError}
                        aria-label="Dismiss error"
                      >
                        ${icons.x}
                      </button>
                    </openclaw-tooltip>
                  `
                : nothing}
            </div>
          `
        : nothing}
      ${props.focusMode && props.onToggleFocusMode
        ? html`
            <openclaw-tooltip content="Exit focus mode">
              <button
                class="chat-focus-exit"
                type="button"
                @click=${props.onToggleFocusMode}
                aria-label="Exit focus mode"
              >
                ${icons.x}
              </button>
            </openclaw-tooltip>
          `
        : nothing}
      ${renderChatSearchBar(props.paneId, requestUpdate)}
      ${renderChatPinnedMessages(
        {
          paneId: props.paneId,
          sessionKey: props.sessionKey,
          messages: props.messages,
          userName: props.userName,
          userAvatar: props.userAvatar,
        },
        requestUpdate,
      )}

      <div class="chat-transcript-toolbar">
        ${props.historyHasMore
          ? html`
              <button
                type="button"
                class="chat-load-older"
                ?disabled=${props.historyLoadingOlder}
                @click=${props.onLoadOlderHistory}
              >
                ${props.historyLoadingOlder ? "loading older rows…" : "load older rows"}
              </button>
            `
          : nothing}
      </div>

      <div
        class="chat-workbench ${props.sessionWorkspace?.collapsed
          ? "chat-workbench--workspace-collapsed"
          : ""}"
      >
        ${renderSessionWorkspaceRail(props.sessionWorkspace)}
        <div class="chat-workbench__main">
          <div class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}">
            <div
              class="chat-main"
              style="flex: ${sidebarOpen ? `0 1 ${splitRatio * 100}%` : "1 1 100%"}"
            >
              ${thread} ${chatColumnFooter}
            </div>

            ${sidebarOpen
              ? html`
                  <resizable-divider
                    .splitRatio=${splitRatio}
                    .label=${t("nav.resize")}
                    @resize=${(event: CustomEvent) =>
                      props.onSplitRatioChange?.(event.detail.splitRatio)}
                  ></resizable-divider>
                  <openclaw-chat-detail-panel
                    class="chat-sidebar"
                    .content=${props.sidebarContent ?? null}
                    .loadFullMessage=${props.onLoadSidebarFullMessage ?? null}
                    .canvasPluginSurfaceUrl=${props.canvasPluginSurfaceUrl ?? null}
                    .embedSandboxMode=${props.embedSandboxMode ?? "scripts"}
                    .allowExternalEmbedUrls=${props.allowExternalEmbedUrls ?? false}
                    .onOpenWorkspaceFile=${props.onOpenWorkspaceFile ?? null}
                    .onRevealInWorkspace=${props.onRevealWorkspaceFile ?? null}
                    @chat-detail-panel-close=${() => props.onCloseSidebar?.()}
                  ></openclaw-chat-detail-panel>
                `
              : nothing}
          </div>
        </div>
      </div>
    </section>
  `;
}
