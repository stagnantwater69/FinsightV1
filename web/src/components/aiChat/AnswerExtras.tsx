import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Copy, ThumbsDown, ThumbsUp } from "lucide-react";
import { api } from "../../lib/api";
import { getErrorMessage } from "../../lib/errors";
import { CHAT_PAGE_ROUTES, recordHref } from "../../lib/chatLinks";
import { useToast } from "../Toast";
import { useBusinessProfiles } from "../../context/BusinessProfileContext";
import { watchRecurringPattern } from "../../pages/expenseInsight/reviewRequests";
import { Button } from "../Button";
import { Money } from "../Money";
import { IconArrowRight, IconChevronDown } from "../icons";
import type { ChatAction, ChatAnswerMetadata } from "../../lib/types";

/**
 * Everything the server resolved alongside one of Fin's replies.
 *
 * None of it is the model's say-so. Record links are records the server put in
 * that message's context (so they are always this owner's), page links come
 * from a fixed catalogue mapped to routes in lib/chatLinks, and actions are
 * built by the server from the flag the chat was opened on. An action still
 * runs only when the owner presses it, through the same endpoint the review
 * queue's own buttons use.
 *
 * Actions are shown on the LATEST reply only: an older reply's suggestions
 * belong to a moment that has passed, and its flag may have been reviewed
 * since. Follow-up questions are not drawn here at all; the drawer shows the
 * latest reply's in one row above the composer.
 */

interface Props {
  metadata: ChatAnswerMetadata;
  /** The reply text, for Copy answer. */
  content: string;
  latest: boolean;
  feedback: "up" | "down" | null;
  onRate: (feedback: "up" | "down" | null) => void;
  /** Leaving the drawer for a page closes it, so the page is not under a dialog. */
  onNavigate: () => void;
}

const linkCardClass =
  "flex min-h-tap items-center gap-3 rounded-xl border border-paper-200 bg-paper px-3 py-2 text-left text-sm transition hover:border-brand-200 hover:bg-tint-brand";

export function AnswerExtras({ metadata, content, latest, feedback, onRate, onNavigate }: Props) {
  const { references, pages, actions, period, amountCheck } = metadata;
  const toast = useToast();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const recordCount = `${references.length} ${references.length === 1 ? "record" : "records"}`;

  async function copyAnswer() {
    try {
      await navigator.clipboard.writeText(content);
      toast("Answer copied");
    } catch {
      toast("Couldn't copy the answer. Select the text and copy it instead.");
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/*
        Where the answer came from, collapsed to one line. The records are the
        ones the server put in this message's context, so opening the list is
        how an owner checks the answer against their own books.
      */}
      {references.length > 0 ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setSourcesOpen((open) => !open)}
            aria-expanded={sourcesOpen}
            className="tap flex items-center gap-1.5 self-start rounded-lg text-xs font-semibold text-ink-600 transition hover:text-ink-900"
          >
            Based on {recordCount}
            {period ? ` · ${period}` : null}
            <IconChevronDown className={`h-4 w-4 transition-transform ${sourcesOpen ? "rotate-180" : ""}`} />
          </button>
          {sourcesOpen ? (
            <div className="flex animate-pop-down flex-col gap-2">
              {references.map((reference) => (
                <Link
                  key={`${reference.recordType}-${reference.id}`}
                  to={recordHref(reference)}
                  onClick={onNavigate}
                  className={linkCardClass}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink-900">{reference.label}</span>
                    <span className="text-xs text-ink-500">
                      <Money value={reference.amount} decimals /> · {reference.date}
                    </span>
                  </span>
                  <IconArrowRight className="h-4 w-4 shrink-0 text-tone-brand" />
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      ) : period ? (
        <p className="text-xs text-ink-500">Based on your records for {period}.</p>
      ) : null}

      {amountCheck === "trimmed" ? (
        <p className="text-xs text-ink-500">
          Part of this answer was removed because it used a figure FinSight couldn't find in your records.
        </p>
      ) : null}

      {pages.map((page) => (
        <Link key={page.key} to={CHAT_PAGE_ROUTES[page.key]} onClick={onNavigate} className={linkCardClass}>
          <span className="flex-1 font-medium text-ink-900">Open {page.label}</span>
          <IconArrowRight className="h-4 w-4 shrink-0 text-tone-brand" />
        </Link>
      ))}

      {latest && actions.length > 0 ? <ActionRow actions={actions} onNavigate={onNavigate} /> : null}

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => void copyAnswer()}
          className="tap flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-ink-600 transition hover:bg-paper-100 hover:text-ink-800"
        >
          <Copy aria-hidden size={14} />
          Copy answer
        </button>
        <span className="flex-1" />
        <RateButton label="Helpful" active={feedback === "up"} onClick={() => onRate(feedback === "up" ? null : "up")}>
          <ThumbsUp aria-hidden size={16} fill={feedback === "up" ? "currentColor" : "none"} />
        </RateButton>
        <RateButton label="Not helpful" active={feedback === "down"} onClick={() => onRate(feedback === "down" ? null : "down")}>
          <ThumbsDown aria-hidden size={16} fill={feedback === "down" ? "currentColor" : "none"} />
        </RateButton>
      </div>
    </div>
  );
}

function RateButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`tap flex h-8 w-8 items-center justify-center rounded-md transition active:scale-90 ${
        active ? "text-tone-brand" : "text-ink-500 hover:text-ink-800"
      }`}
    >
      {children}
    </button>
  );
}

function ActionRow({ actions, onNavigate }: { actions: ChatAction[]; onNavigate: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { selected } = useBusinessProfiles();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: ChatAction) {
    if (action.kind === "open-spending-impact") {
      onNavigate();
      navigate(CHAT_PAGE_ROUTES["spending-impact"], { state: { plannedAmount: action.amount } });
      return;
    }
    if (action.kind === "prefill-record") {
      // Opens the normal form filled in; nothing is saved until the owner saves it there.
      onNavigate();
      const duplicateFrom =
        action.recordType === "sales"
          ? { description: action.description, amount: action.amount }
          : { description: action.description, vendor: "", amount: action.amount };
      navigate(CHAT_PAGE_ROUTES[action.recordType === "sales" ? "add-sales" : "add-expense"], { state: { duplicateFrom } });
      return;
    }
    if (action.kind === "watch-recurring-pattern" && !selected) return;
    setBusy(action.label);
    setError(null);
    try {
      if (action.kind === "watch-recurring-pattern") {
        await watchRecurringPattern(selected!.id, action.patternId);
        setDone(`${action.label}. It is now on your Payment calendar.`);
      } else if (action.kind === "review-finding") {
        await api.patch(`/insights/findings/${action.findingId}/review`, {
          status: action.status,
          feedback: action.feedback,
        });
        setDone(`${action.label}. This flag has left your review queue.`);
      } else {
        return;
      }
      toast(`Noted — ${action.label.charAt(0).toLowerCase()}${action.label.slice(1)}`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return <p className="text-xs text-tone-brand">Saved: {done}</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action.label}
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void run(action)}
          >
            {busy === action.label ? "Saving…" : action.label}
          </Button>
        ))}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-tone-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
