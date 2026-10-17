import type { ReactNode } from "react";
import { IconTile } from "../../components/IconTile";
import {
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  Flag,
  MessageCircleQuestion,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import { AiCard, Kw } from "../../components/ui";
import { formatMoney } from "../../components/Money";
import { ShareBar } from "./ExpenseVisuals";

interface CategoryFigure {
  categoryName: string;
  current: number;
  change: number;
}

export interface ExpenseSummaryFigures {
  total: number;
  top: CategoryFigure | null;
  topShare: number;
  biggestIncrease: CategoryFigure | null;
  periodDelta: number;
  periodPercent: number | null;
}

interface Point {
  icon: LucideIcon;
  body: ReactNode;
  visual?: ReactNode;
}

/**
 * "Summary" — the page's plain-language reading, composed from the same
 * figures as the tiles above it, never generated. One short line per point,
 * each with its own glyph, so it scans like a list of findings rather than
 * a paragraph. The question chips only open Ask FinSight with the question
 * typed in; nothing is sent on the owner's behalf.
 */
export function ExpenseSummaryCard({
  summary,
  periodText,
  comparedWith,
  allTime,
  categoryColor,
  flaggedCount,
  unusualCount,
  expandQuestion,
  onAsk,
}: {
  summary: ExpenseSummaryFigures;
  periodText: string;
  comparedWith: string;
  allTime: boolean;
  /** The largest category's colour in the donut, so the two read as one. */
  categoryColor: string;
  /** Large-expense flags awaiting review. */
  flaggedCount: number;
  /** Expenses well above their category's usual amount, this period. */
  unusualCount: number;
  expandQuestion: string | undefined;
  onAsk: (question?: string) => void;
}) {
  const points: Point[] = [];

  if (summary.top) {
    points.push({
      icon: Boxes,
      body: (
        <>
          <Kw>{summary.top.categoryName}</Kw> is your highest expense category{" "}
          {periodText}: <Kw>{summary.topShare.toFixed(1)}%</Kw> of expenses.
        </>
      ),
      visual: (
        <ShareBar
          percent={summary.topShare}
          color={categoryColor}
          className="mt-2 h-1.5"
          trackClassName="bg-white/15"
        />
      ),
    });
  }
  if (summary.biggestIncrease && !allTime) {
    points.push({
      icon: TrendingUp,
      body: (
        <>
          <Kw>{summary.biggestIncrease.categoryName}</Kw> rose the most: up{" "}
          <Kw>
            <span className="figure">
              {formatMoney(summary.biggestIncrease.change)}
            </span>
          </Kw>{" "}
          vs {comparedWith}.
        </>
      ),
    });
  }
  if (!allTime && summary.periodPercent !== null && summary.periodDelta !== 0) {
    const up = summary.periodDelta > 0;
    points.push({
      icon: up ? ArrowUpRight : ArrowDownRight,
      body: (
        <>
          Total spending is{" "}
          <Kw>
            <span className="figure">{Math.abs(summary.periodPercent).toFixed(0)}%</span>
          </Kw>{" "}
          {up ? "higher" : "lower"} than {comparedWith}.
        </>
      ),
    });
  }
  // Two separate counts, never summed: they come from different checks and
  // one expense can appear in both.
  if (flaggedCount > 0 || unusualCount > 0) {
    const parts: ReactNode[] = [];
    if (flaggedCount > 0) {
      parts.push(
        <span key="f">
          <Kw>{flaggedCount}</Kw> large {flaggedCount === 1 ? "expense" : "expenses"} flagged
        </span>,
      );
    }
    if (unusualCount > 0) {
      parts.push(
        <span key="u">
          <Kw>{unusualCount}</Kw> unusual for {unusualCount === 1 ? "its" : "their"} category
        </span>,
      );
    }
    points.push({
      icon: Flag,
      body: (
        <>
          {parts.length === 2 ? (
            <>
              {parts[0]}, {parts[1]}
            </>
          ) : (
            parts[0]
          )}
          . Review below.
        </>
      ),
    });
  }

  const questions: { label: string; question: string }[] = [];
  if (expandQuestion) {
    questions.push({
      label:
        summary.biggestIncrease && !allTime
          ? `Why did ${summary.biggestIncrease.categoryName} rise?`
          : `Why is ${summary.top?.categoryName ?? "this"} highest?`,
      question: expandQuestion,
    });
  }
  if (summary.top) {
    questions.push({
      label: `How can I spend less on ${summary.top.categoryName}?`,
      question: `How can I reduce my ${summary.top.categoryName} expenses ${periodText} without hurting the business?`,
    });
  }
  if (flaggedCount > 0 || unusualCount > 0) {
    questions.push({
      label: "What should I check first?",
      question: `Which of my flagged or unusual expenses ${periodText} should I check first, and why?`,
    });
  }

  return (
    <AiCard
      title="Summary"
      subtitle="Composed from your records, not AI-written"
      footer={
        <div className="space-y-3">
          {questions.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {questions.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => onAsk(q.question)}
                  className="tap-inline inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-brand-50 ring-1 ring-white/15 transition hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-200"
                >
                  <MessageCircleQuestion aria-hidden className="size-3.5 text-brand-200" />
                  {q.label}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => onAsk(expandQuestion)}
            className="tap-inline font-semibold text-accent-200 underline-offset-2 hover:underline"
          >
            Ask FinSight
          </button>
        </div>
      }
    >
      {points.length === 0 ? (
        <p>No expenses {periodText}.</p>
      ) : (
        <ul className="space-y-2.5">
          {points.map(({ icon: Icon, body, visual }, i) => (
            <li
              key={i}
              className="flex items-start gap-3 rounded-xl bg-white/[0.06] p-3 ring-1 ring-white/10"
            >
              <IconTile icon={Icon} />
              <div className="min-w-0 flex-1 text-[13.5px] leading-snug">
                <p>{body}</p>
                {visual}
              </div>
            </li>
          ))}
        </ul>
      )}
    </AiCard>
  );
}
