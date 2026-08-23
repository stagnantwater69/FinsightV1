import { useCallback, useEffect, useState } from "react";
import { usePersistentState, useFocusTrap } from "../../lib/hooks";
import { IconPlus, IconSidebar } from "../icons";
import { SkeletonLine } from "../Skeleton";
import { groupConversations } from "../../lib/conversationGroups";
import { ConversationItem } from "./ConversationItem";
import type { Conversation } from "../../lib/types";

/**
 * The chat page's second rail: New Chat above a date-grouped conversation
 * list.
 *
 * IT IS A SEPARATE RAIL FROM THE APP NAV ON PURPOSE. Folding chat history
 * into AppShell's sidebar would have meant either stranding the owner on the
 * chat page with no way out, or stacking two unrelated lists in one 256px
 * column. So there are two rails with two controls and two persisted flags,
 * and neither knows about the other.
 *
 * NOTHING IN HERE TOUCHES CONVERSATION STATE. The collapsed flag lives in
 * `useChatRail` below, which returns view state and nothing else — no
 * conversation id, no message list, no fetch. That separation is the invariant
 * the whole change exists to establish: the previous drawer reset its
 * conversation every time it was opened or closed, and the fix is structural
 * rather than a guard clause someone can later remove.
 */

const isBool = (v: unknown): v is boolean => typeof v === "boolean";

export interface ChatRailState {
  /** Desktop only. Persisted, because re-collapsing it every visit is a chore. */
  collapsed: boolean;
  toggleCollapsed: () => void;
  /** Below `lg` the rail is an overlay. Transient — a reload should not reopen it. */
  mobileOpen: boolean;
  openMobile: () => void;
  closeMobile: () => void;
}

export function useChatRail(): ChatRailState {
  const [collapsed, setCollapsed] = usePersistentState("finsight.chatRailCollapsed", false, isBool);
  const [mobileOpen, setMobileOpen] = useState(false);

  return {
    collapsed,
    toggleCollapsed: useCallback(() => setCollapsed((v) => !v), [setCollapsed]),
    mobileOpen,
    openMobile: useCallback(() => setMobileOpen(true), []),
    closeMobile: useCallback(() => setMobileOpen(false), []),
  };
}

interface Props {
  rail: ChatRailState;
  conversations: Conversation[];
  activeId: number | null;
  loading: boolean;
  error: string | null;
  onNewChat: () => void;
  onSelect: (id: number) => void;
  onRename: (id: number, title: string) => void;
  onDelete: (conversation: Conversation) => void;
}

export function ChatHistoryRail(props: Props) {
  const { rail } = props;
  const trapRef = useFocusTrap<HTMLElement>(rail.mobileOpen);

  useEffect(() => {
    if (!rail.mobileOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") rail.closeMobile();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rail]);

  return (
    <>
      {/*
        DESKTOP — a real column in the flow, animating its own width.

        Collapsed it goes to zero width rather than to a strip of icons: a
        conversation row is a line of text, and there is no icon that stands in
        for "Why did rent go up?". `overflow-hidden` on the animating box with
        a fixed-width child inside means the contents slide out of view instead
        of reflowing to nothing on the way.
      */}
      <div
        className="hidden shrink-0 overflow-hidden border-r border-paper-200 bg-paper-50 transition-[width] duration-250 ease-shell lg:block"
        style={{ width: rail.collapsed ? 0 : "16.5rem" }}
      >
        <div className="flex h-full w-[16.5rem] flex-col" inert={rail.collapsed}>
          <RailContents {...props} onClose={rail.toggleCollapsed} closeLabel="Collapse chat history" />
        </div>
      </div>

      {/*
        BELOW lg — an overlay drawer with a scrim, closed by default.

        It overlays rather than squeezing: the message column is already the
        narrowest thing on the page at that width, and taking 264px out of it
        would leave the bubbles unreadable. Unmounted when closed rather than
        parked off-screen, so none of its controls sit in the tab order behind
        the page.
      */}
      {rail.mobileOpen ? (
        <>
          <div aria-hidden onClick={rail.closeMobile} className="fixed inset-0 z-40 bg-ink-900/40 lg:hidden" />
          <aside
            ref={trapRef}
            role="dialog"
            aria-modal="true"
            aria-label="Chat history"
            // slide-in-right is the codebase's "a panel arrived" entrance (8px
            // and a fade); it is small enough to read the same from either
            // edge, and inventing a mirrored keyframe for one drawer would put
            // a second motion idea in the system for no gain.
            className="fixed inset-y-0 left-0 z-50 flex w-[17.5rem] max-w-[85vw] animate-slide-in-right flex-col bg-paper-50 shadow-lg lg:hidden"
          >
            <RailContents {...props} onClose={rail.closeMobile} closeLabel="Close chat history" />
          </aside>
        </>
      ) : null}
    </>
  );
}

function RailContents({
  conversations,
  activeId,
  loading,
  error,
  onNewChat,
  onSelect,
  onRename,
  onDelete,
  onClose,
  closeLabel,
}: Props & { onClose: () => void; closeLabel: string }) {
  const groups = groupConversations(conversations);

  return (
    <>
      <div className="flex items-center gap-1 px-3 pb-1 pt-3">
        <h2 className="flex-1 text-[11px] font-bold uppercase tracking-[0.13em] text-ink-400">Chat history</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          aria-expanded
          className="tap h-9 w-9 min-h-0 min-w-0 rounded-lg text-ink-400 transition hover:bg-paper-100 hover:text-ink-700"
        >
          <IconSidebar className="h-[18px] w-[18px]" />
        </button>
      </div>

      <div className="px-3 pb-2 pt-1">
        <button
          type="button"
          onClick={onNewChat}
          className="flex min-h-tap w-full items-center justify-center gap-2 rounded-xl bg-brand-700 px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-800"
        >
          <IconPlus className="h-4 w-4 shrink-0" />
          New chat
        </button>
      </div>

      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading ? (
          <div className="space-y-2 px-1 pt-2" aria-busy="true">
            <SkeletonLine className="h-4 w-20" />
            <SkeletonLine className="h-4" />
            <SkeletonLine className="h-4" />
            <SkeletonLine className="h-4 w-2/3" />
          </div>
        ) : error ? (
          <p role="alert" className="mx-1 mt-2 rounded-lg bg-tint-danger p-3 text-xs text-tone-danger">
            {error}
          </p>
        ) : conversations.length === 0 ? (
          // No mascot here. The welcome state beside it already carries Fin at
          // full size, and a second illustration two columns apart would put
          // the same character on screen twice in one view.
          <p className="px-3 pt-3 text-xs leading-relaxed text-ink-400">
            Your conversations will appear here once you ask something.
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="pb-1">
              <div className="px-3 pb-1 pt-3 text-[10.5px] font-bold uppercase tracking-[0.13em] text-ink-400">
                {group.label}
              </div>
              <ul>
                {group.conversations.map((conversation) => (
                  <ConversationItem
                    key={conversation.id}
                    conversation={conversation}
                    active={conversation.id === activeId}
                    onSelect={() => onSelect(conversation.id)}
                    onRename={(title) => onRename(conversation.id, title)}
                    onDelete={() => onDelete(conversation)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </>
  );
}
