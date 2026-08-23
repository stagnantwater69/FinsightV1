import { IconChevronLeft } from "../icons";
import { SkeletonLine } from "../Skeleton";
import { groupConversations } from "../../lib/conversationGroups";
import { ConversationItem } from "./ConversationItem";
import type { Conversation } from "../../lib/types";

/**
 * The date-grouped conversation list, drawn OVER the drawer's message body.
 *
 * IT IS NOT A SECOND RAIL. The drawer is `sm:max-w-md` — around 448px — and a
 * conversation row is a line of prose, not an icon. Standing a history column
 * permanently beside the bubbles would leave both too narrow to read, which is
 * the "cramped" failure this layout exists to avoid. So history is a mode, not
 * a neighbour: it takes the full width of the panel while it is up, and gives
 * it all back the moment a conversation is chosen.
 *
 * NOTHING IN HERE TOUCHES CONVERSATION STATE. It receives a list and four
 * callbacks and holds no state of its own beyond each row's own rename draft.
 * Showing and hiding it is a flag in the drawer that reaches nothing which
 * fetches — the same separation AiChatContext's header comment describes, one
 * level down.
 */

interface Props {
  conversations: Conversation[];
  activeId: number | null;
  loading: boolean;
  error: string | null;
  onSelect: (id: number) => void;
  onRename: (id: number, title: string) => void;
  onDelete: (conversation: Conversation) => void;
  onClose: () => void;
}

export function ChatHistoryOverlay({
  conversations,
  activeId,
  loading,
  error,
  onSelect,
  onRename,
  onDelete,
  onClose,
}: Props) {
  const groups = groupConversations(conversations);

  return (
    /*
      Absolute over the body rather than a sibling column, and `bg-paper-50` so
      it is opaque — the bubbles underneath showing through a translucent list
      would read as two conversations at once.

      slide-in-right is the codebase's "a panel arrived" entrance (8px and a
      fade). Reused rather than given a bespoke keyframe: this is the same kind
      of arrival as the notification centre's, at a smaller scale.
    */
    <div className="absolute inset-0 z-10 flex animate-slide-in-right flex-col bg-paper-50">
      <div className="flex items-center gap-1 border-b border-paper-200 px-3 py-2">
        <h3 className="flex-1 text-[11px] font-bold uppercase tracking-[0.13em] text-ink-400">Chat history</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat history"
          aria-expanded
          className="tap h-9 w-9 min-h-0 min-w-0 rounded-lg text-ink-400 transition hover:bg-paper-100 hover:text-ink-700"
        >
          {/* Back to the conversation, so the arrow points the way the panel
              is about to move rather than being a generic dismiss ×. */}
          <IconChevronLeft className="h-[18px] w-[18px]" />
        </button>
      </div>

      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading ? (
          <div className="space-y-2 px-1 pt-3" aria-busy="true">
            <SkeletonLine className="h-4 w-20" />
            <SkeletonLine className="h-4" />
            <SkeletonLine className="h-4" />
            <SkeletonLine className="h-4 w-2/3" />
          </div>
        ) : error ? (
          <p role="alert" className="mx-1 mt-3 rounded-lg bg-tint-danger p-3 text-xs text-tone-danger">
            {error}
          </p>
        ) : conversations.length === 0 ? (
          // No mascot here. The welcome state this is sitting on top of already
          // carries Fin at full size, and a second illustration one keypress
          // apart would put the same character on screen twice in one panel.
          <p className="px-3 pt-4 text-xs leading-relaxed text-ink-400">
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
    </div>
  );
}
