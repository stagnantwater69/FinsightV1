import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { useDismiss, useMenuKeys } from "../../lib/hooks";
import { IconEdit, IconTrash } from "../icons";
import type { Conversation } from "../../lib/types";

/**
 * `Conversation_Title` is VARCHAR(120), and PATCH /ai/conversations/:id
 * rejects anything longer.
 *
 * Deliberately NOT added to lib/fieldLimits.ts: that object is asserted
 * key-for-key equal to mobile's copy by backend/tests/contract/fieldLimits.ts,
 * and mobile has no conversations in this pass — adding a key on one side only
 * would fail the contract. It lives here until mobile gains the feature.
 */
const TITLE_MAX = 120;

/**
 * One row of the chat history list, plus its Rename/Delete menu.
 *
 * THE ACTIVE STATE IS DELIBERATELY QUIET. A list of a dozen rows with a
 * saturated brand fill on one of them turns it into a stripe of colour
 * that pulls the eye away from the conversation itself — which is the thing
 * the owner is actually reading. So "which one am I in" is carried by the row
 * lifting onto `paper` with a hairline, the same way an active tab does in
 * InsightsTabs, rather than by a block of teal.
 *
 * RENAME IS INLINE, NOT A MODAL. Renaming a thread is a two-word edit on
 * something already on screen; opening a dialog over the list to do it loses
 * the context of the rows either side, which is usually why you are renaming
 * it at all. Delete goes the other way and takes the shared ConfirmDialog —
 * it is destructive and cascades to every message in the thread.
 */

interface Props {
  conversation: Conversation;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}

export function ConversationItem({ conversation, active, onSelect, onRename, onDelete }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(conversation.title);
  const { ref: menuRef, triggerRef } = useDismiss<HTMLDivElement>(menuOpen, () => setMenuOpen(false));
  const onMenuKeys = useMenuKeys();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function startRename() {
    setDraft(conversation.title);
    setMenuOpen(false);
    setEditing(true);
  }

  function commitRename() {
    setEditing(false);
    const next = draft.trim();
    // An empty title is not an edit, it is a slip — the row would become
    // unclickable-looking blank space. Silently keep what was there.
    if (!next || next === conversation.title) return;
    onRename(next);
  }

  if (editing) {
    return (
      <li>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            commitRename();
          }}
          className="px-1 py-0.5"
        >
          <label className="sr-only" htmlFor={`rename-${conversation.id}`}>
            Rename conversation
          </label>
          <input
            id={`rename-${conversation.id}`}
            ref={inputRef}
            value={draft}
            autoFocus
            maxLength={TITLE_MAX}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
            className="min-h-tap w-full rounded-xl border border-brand-300 bg-paper px-3 text-[13px] text-ink-900"
          />
        </form>
      </li>
    );
  }

  return (
    <li className="relative">
      <div
        className={`group flex items-center rounded-xl transition ${
          active ? "bg-paper shadow-sm ring-1 ring-paper-200" : "hover:bg-paper-100"
        }`}
      >
        <button
          type="button"
          onClick={onSelect}
          aria-current={active ? "true" : undefined}
          className={`flex min-h-tap min-w-0 flex-1 items-center rounded-xl px-3 text-left text-[13px] ${
            active ? "font-semibold text-ink-900" : "text-ink-600"
          }`}
        >
          <span className="truncate">{conversation.title}</span>
        </button>

        <div ref={menuRef} className="relative shrink-0 pr-1">
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`More options for ${conversation.title}`}
            /*
             * Hidden until the row is hovered or the button itself is
             * focused, so a list of twelve rows is not a column of twelve dot
             * clusters — but `focus-visible` keeps it reachable by Tab, which
             * `hidden until hover` alone would not.
             */
            className={`tap h-8 w-8 min-h-0 min-w-0 rounded-lg text-ink-400 transition hover:bg-paper-200 hover:text-ink-700 focus-visible:opacity-100 group-hover:opacity-100 ${
              menuOpen ? "opacity-100" : "opacity-0"
            }`}
          >
            <MoreHorizontal aria-hidden size={16} />
          </button>

          {menuOpen ? (
            <div
              role="menu"
              aria-label={`Conversation actions for ${conversation.title}`}
              onKeyDown={onMenuKeys}
              className="absolute right-0 top-full z-50 mt-1 w-40 animate-pop-down rounded-xl border border-paper-200 bg-paper p-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                onClick={startRename}
                className="flex min-h-tap w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-ink-700 transition hover:bg-paper-100"
              >
                <IconEdit className="h-4 w-4 shrink-0" />
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
                className="flex min-h-tap w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-tone-danger transition hover:bg-tint-danger"
              >
                <IconTrash className="h-4 w-4 shrink-0" />
                Delete
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}
