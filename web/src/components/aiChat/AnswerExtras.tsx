import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { api } from "../../lib/api";
import { getErrorMessage } from "../../lib/errors";
import { CHAT_PAGE_ROUTES, recordHref } from "../../lib/chatLinks";
import { useToast } from "../Toast";
import { Button } from "../Button";
import { Money } from "../Money";
import { IconArrowRight } from "../icons";
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
 * Follow-ups and actions are shown on the LATEST reply only: an older reply's
 * suggestions belong to a moment that has passed, and its flag may have been
 * reviewed since.
 */

interface Props {
  metadata: ChatAnswerMetadata;
  latest: boolean;
  feedback: "up" | "down" | null;
  onFollowUp: (question: string) => void;
  onRate: (feedback: "up" | "down" | null) => void;
  /** Leaving the drawer for a page closes it, so the page is not under a dialog. */
  onNavigate: () => void;
}

const chipClass =
  "inline-flex min-h-tap items-center gap-2 rounded-lg border border-paper-200 bg-paper px-3 py-1.5 text-left text-xs text-ink-700 transition hover:border-brand-200 hover:bg-tint-brand";

export function AnswerExtras({ metadata, latest, feedback, onFollowUp, onRate, onNavigate }: Props) {
  const { references, pages, actions, followUps, period, amountCheck } = metadata;

  return (
    <div className="ml-8 flex max-w-[85%] flex-col gap-2">
      {references.length > 0 || pages.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {references.map((reference) => (
            <Link
              key={`${reference.recordType}-${reference.id}`}
              to={recordHref(reference)}
              onClick={onNavigate}
              className={chipClass}
            >
              <span className="min-w-0">
                <span className="block truncate font-medium text-ink-900">{reference.label}</span>
                <span className="text-ink-500">
                  <Money value={reference.amount} decimals /> · {reference.date}
                </span>
              </span>
              <IconArrowRight className="h-4 w-4 shrink-0 text-tone-brand" />
            </Link>
          ))}
          {pages.map((page) => (
            <Link key={page.key} to={CHAT_PAGE_ROUTES[page.key]} onClick={onNavigate} className={chipClass}>
              <span className="font-medium text-ink-900">Open {page.label}</span>
              <IconArrowRight className="h-4 w-4 shrink-0 text-tone-brand" />
            </Link>
          ))}
        </div>
      ) : null}

      {latest && actions.length > 0 ? <ActionRow actions={actions} onNavigate={onNavigate} /> : null}

      {period || amountCheck === "trimmed" ? (
        <p className="text-xs text-ink-500">
          {period ? `Based on your records for ${period}.` : null}
          {period && amountCheck === "trimmed" ? " " : null}
          {amountCheck === "trimmed"
            ? "Part of this answer was removed because it used a figure FinSight couldn't find in your records."
            : null}
        </p>
      ) : null}

      {latest && followUps.length > 0 ? (
        <div className="flex flex-wrap gap-2" aria-label="Suggested follow-up questions">
          {followUps.map((question) => (
            <button
              key={question}
              type="button"
              onClick={() => onFollowUp(question)}
              className="min-h-tap rounded-full border border-brand-200 px-3 text-xs text-tone-brand transition hover:bg-tint-brand"
            >
              {question}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-1">
        <RateButton label="Helpful" active={feedback === "up"} onClick={() => onRate(feedback === "up" ? null : "up")}>
          <ThumbsUp aria-hidden size={14} />
        </RateButton>
        <RateButton label="Not helpful" active={feedback === "down"} onClick={() => onRate(feedback === "down" ? null : "down")}>
          <ThumbsDown aria-hidden size={14} />
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
      className={`tap flex h-8 w-8 items-center justify-center rounded-md transition ${
        active ? "bg-tint-brand text-tone-brand" : "text-ink-600 hover:bg-paper-100 hover:text-ink-800"
      }`}
    >
      {children}
    </button>
  );
}

function ActionRow({ actions, onNavigate }: { actions: ChatAction[]; onNavigate: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: ChatAction) {
    if (action.kind === "open-spending-impact") {
      onNavigate();
      navigate(CHAT_PAGE_ROUTES["spending-impact"], { state: { plannedAmount: action.amount } });
      return;
    }
    setBusy(action.label);
    setError(null);
    try {
      await api.patch(`/insights/findings/${action.findingId}/review`, {
        status: action.status,
        feedback: action.feedback,
      });
      setDone(action.label);
      toast(`Noted — ${action.label.charAt(0).toLowerCase()}${action.label.slice(1)}`);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (done) {
    return <p className="text-xs text-tone-brand">Saved: {done}. This flag has left your review queue.</p>;
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
