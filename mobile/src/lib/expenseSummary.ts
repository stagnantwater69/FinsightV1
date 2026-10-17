import { formatMoney } from "./money";
import type { CategoryTrend, ExpenseBehavior } from "./types";

export interface CategoryFigure {
  categoryName: string;
  current: number;
  change: number;
}

/** The headline figures on Expense insight, all from one response and one denominator. */
export interface ExpenseSummaryFigures {
  total: number;
  categoryCount: number;
  recordCount: number;
  top: CategoryFigure | null;
  topShare: number;
  biggestIncrease: CategoryFigure | null;
  periodDelta: number;
  periodPercent: number | null;
  /** All time only: total spread over the months it covers. */
  monthlyAverage: number | null;
  monthsCovered: number;
  /** Spending as a share of recorded available funds. Never for All time. */
  fundsShare: number | null;
}

function changeOf(trend: CategoryTrend): number {
  return trend.change ?? trend.current - trend.previous;
}

function figure(trend: CategoryTrend): CategoryFigure {
  return { categoryName: trend.categoryName, current: trend.current, change: changeOf(trend) };
}

export function expenseSummaryFigures(
  data: Pick<ExpenseBehavior, "totals" | "categoryTrends" | "dailyTotals" | "dailyBucket">,
  availableFunds: number | null,
): ExpenseSummaryFigures {
  const total = data.totals.current;
  const spending = data.categoryTrends.filter((t) => t.current > 0);
  const top = [...spending].sort((a, b) => b.current - a.current)[0] ?? null;
  // Ranked by peso movement: a 300% rise on a PHP 200 category is noise.
  const risen = data.categoryTrends.filter((t) => changeOf(t) > 0).sort((a, b) => changeOf(b) - changeOf(a));
  const periodDelta = total - data.totals.previous;
  const monthsCovered = data.dailyBucket === "month" ? (data.dailyTotals ?? []).length : 0;
  return {
    total,
    categoryCount: spending.length,
    recordCount: data.categoryTrends.reduce((sum, t) => sum + (t.recordCount ?? 0), 0),
    top: top ? figure(top) : null,
    topShare: top && total > 0 ? (top.current / total) * 100 : 0,
    biggestIncrease: risen[0] ? figure(risen[0]) : null,
    periodDelta,
    periodPercent: data.totals.previous > 0 ? (periodDelta / data.totals.previous) * 100 : null,
    monthlyAverage: monthsCovered > 0 ? total / monthsCovered : null,
    monthsCovered,
    // All-time spending cannot be compared meaningfully with today's balance.
    fundsShare:
      availableFunds !== null && availableFunds > 0 && data.dailyBucket !== "month"
        ? (total / availableFunds) * 100
        : null,
  };
}

/** A run of text; `strong` runs are the figures and names the eye should land on. */
export interface SummarySegment {
  text: string;
  strong?: boolean;
  /** Set on currency, which always wears the mono figure face. */
  money?: boolean;
}

export type SummaryPointKind = "top" | "increase" | "total" | "flags";

export interface SummaryPoint {
  kind: SummaryPointKind;
  segments: SummarySegment[];
  /** 0..100, drawn as a share bar under the point. */
  share?: number;
}

export interface SummaryContext {
  /** "this week", "in August". */
  periodText: string;
  comparedWith: string | null;
  allTime: boolean;
  /** Expenses needing review or marked as possible duplicates (GET /records/flagged/count). */
  flaggedCount: number;
  /** Expenses well above their category's usual amount, this period. */
  unusualCount: number;
}

/**
 * The page's plain-language reading, composed from the figures above it,
 * never generated. Each point is one line the owner can check against a tile.
 */
export function expenseSummaryPoints(summary: ExpenseSummaryFigures, ctx: SummaryContext): SummaryPoint[] {
  const points: SummaryPoint[] = [];
  if (summary.top) {
    points.push({
      kind: "top",
      share: summary.topShare,
      segments: [
        { text: summary.top.categoryName, strong: true },
        { text: ` is your highest expense category ${ctx.periodText}: ` },
        { text: `${summary.topShare.toFixed(1)}%`, strong: true },
        { text: " of expenses." },
      ],
    });
  }
  if (summary.biggestIncrease && !ctx.allTime && ctx.comparedWith) {
    points.push({
      kind: "increase",
      segments: [
        { text: summary.biggestIncrease.categoryName, strong: true },
        { text: " rose the most: up " },
        { text: formatMoney(summary.biggestIncrease.change), strong: true, money: true },
        { text: ` vs ${ctx.comparedWith}.` },
      ],
    });
  }
  if (!ctx.allTime && ctx.comparedWith && summary.periodPercent !== null && summary.periodDelta !== 0) {
    const up = summary.periodDelta > 0;
    points.push({
      kind: "total",
      segments: [
        { text: "Total spending is " },
        { text: `${Math.abs(summary.periodPercent).toFixed(0)}%`, strong: true },
        { text: ` ${up ? "higher" : "lower"} than ${ctx.comparedWith}.` },
      ],
    });
  }
  // Two counts from two different checks, never summed: one expense can be in both.
  if (ctx.flaggedCount > 0 || ctx.unusualCount > 0) {
    const segments: SummarySegment[] = [];
    if (ctx.flaggedCount > 0) {
      segments.push(
        { text: String(ctx.flaggedCount), strong: true },
        { text: ` ${ctx.flaggedCount === 1 ? "expense" : "expenses"} to review` },
      );
    }
    if (ctx.unusualCount > 0) {
      if (segments.length) segments.push({ text: ", " });
      segments.push(
        { text: String(ctx.unusualCount), strong: true },
        { text: ` unusual for ${ctx.unusualCount === 1 ? "its" : "their"} category` },
      );
    }
    segments.push({ text: "." });
    points.push({ kind: "flags", segments });
  }
  return points;
}

export interface SummaryQuestion {
  label: string;
  question: string;
}

/** Questions that open Ask FinSight with the text typed in. Nothing is sent for the owner. */
export function expenseSummaryQuestions(summary: ExpenseSummaryFigures, ctx: SummaryContext): SummaryQuestion[] {
  const questions: SummaryQuestion[] = [];
  if (summary.biggestIncrease && !ctx.allTime && ctx.comparedWith) {
    questions.push({
      label: `Why did ${summary.biggestIncrease.categoryName} rise?`,
      question: `Why did ${summary.biggestIncrease.categoryName} increase by ${formatMoney(summary.biggestIncrease.change)} compared with ${ctx.comparedWith}?`,
    });
  } else if (summary.top) {
    questions.push({
      label: `Why is ${summary.top.categoryName} highest?`,
      question: `Why is ${summary.top.categoryName} my highest expense category ${ctx.periodText}?`,
    });
  }
  if (summary.top) {
    questions.push({
      label: `How can I spend less on ${summary.top.categoryName}?`,
      question: `How can I reduce my ${summary.top.categoryName} expenses ${ctx.periodText} without hurting the business?`,
    });
  }
  if (ctx.flaggedCount > 0 || ctx.unusualCount > 0) {
    questions.push({
      label: "What should I check first?",
      question: `Which of my flagged or unusual expenses ${ctx.periodText} should I check first, and why?`,
    });
  }
  return questions;
}
