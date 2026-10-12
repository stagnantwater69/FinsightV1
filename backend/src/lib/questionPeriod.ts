import { utcAddDays, utcDateKey, utcIsoWeekday } from "./dates";
import type { PeriodSelection } from "./reportingPeriod";

/**
 * The period a chat question names, read deterministically from its words.
 *
 * Ask FinSight used to ground every answer in the last 30 days, so "what did I
 * spend in January?" was answered from September's figures, or not at all. The
 * period is parsed HERE rather than left to the model because it decides which
 * rows the server reads: a model that misread "Enero" would quietly answer
 * about the wrong month with figures that looked authoritative.
 *
 * English, Filipino and Taglish phrasings are all recognised. Anything not
 * recognised returns null and the caller keeps its default window, which is
 * the behaviour before this existed.
 */
export interface QuestionPeriod {
  selection: PeriodSelection;
  /** How the period is described back to the owner and the model, e.g. "January 2022". */
  label: string;
}

const MONTH_NAMES: Record<string, number> = {
  january: 1, jan: 1, enero: 1,
  february: 2, feb: 2, pebrero: 2, febrero: 2,
  march: 3, mar: 3, marso: 3,
  april: 4, apr: 4, abril: 4,
  may: 5, mayo: 5,
  june: 6, jun: 6, hunyo: 6,
  july: 7, jul: 7, hulyo: 7,
  august: 8, aug: 8, agosto: 8,
  september: 9, sept: 9, sep: 9, setyembre: 9, septiyembre: 9,
  october: 10, oct: 10, oktubre: 10,
  november: 11, nov: 11, nobyembre: 11,
  december: 12, dec: 12, disyembre: 12,
};

const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Longest rolling window a question may ask for — beyond this, "all time" is the honest reading. */
const MAX_ROLLING_DAYS = 366;

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function monthSelection(year: number, month: number): QuestionPeriod {
  return { selection: { kind: "month", month: monthKey(year, month) }, label: `${MONTH_LABELS[month - 1]} ${year}` };
}

/** A whole calendar year, as a rolling window ending on 31 December (or today, for the current year). */
function yearSelection(year: number, today: Date): QuestionPeriod | null {
  const start = new Date(Date.UTC(year, 0, 1));
  if (start > today) return null;
  const yearEnd = new Date(Date.UTC(year, 11, 31));
  const end = yearEnd < today ? yearEnd : today;
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  return { selection: { kind: "rolling", days, endDate: end }, label: year === today.getUTCFullYear() ? `${year} so far` : `${year}` };
}

export function extractQuestionPeriod(question: string, today: Date): QuestionPeriod | null {
  const q = question.toLowerCase().replace(/[’']/g, "'");
  const thisYear = today.getUTCFullYear();
  const thisMonth = today.getUTCMonth() + 1;

  if (/\b(all[- ]time|ever|since (i|we) started|from the (start|beginning)|lahat ng panahon|kahit kailan)\b/.test(q)) {
    return { selection: { kind: "all" }, label: "all time" };
  }

  if (/\b(this week|ngayong linggo|this wk)\b/.test(q)) {
    return { selection: { kind: "week" }, label: "this week" };
  }
  if (/\b(last week|nakaraang linggo|noong isang linggo)\b/.test(q)) {
    const thisMonday = utcAddDays(today, -(utcIsoWeekday(today) - 1));
    const lastSunday = utcAddDays(thisMonday, -1);
    return {
      selection: { kind: "rolling", days: 7, endDate: lastSunday },
      label: `last week (${utcDateKey(utcAddDays(lastSunday, -6))} to ${utcDateKey(lastSunday)})`,
    };
  }

  if (/\b(this month|ngayong buwan|this mo)\b/.test(q)) {
    return monthSelection(thisYear, thisMonth);
  }
  if (/\b(last month|nakaraang buwan|noong isang buwan|previous month)\b/.test(q)) {
    return thisMonth === 1 ? monthSelection(thisYear - 1, 12) : monthSelection(thisYear, thisMonth - 1);
  }

  const lastNDays = q.match(/\b(?:last|past|nakaraang)\s+(\d{1,3})\s+(days?|araw)\b/);
  if (lastNDays) {
    const days = Number(lastNDays[1]);
    if (days >= 1 && days <= MAX_ROLLING_DAYS) {
      return { selection: { kind: "rolling", days }, label: `the last ${days} day${days === 1 ? "" : "s"}` };
    }
  }

  // "2022-01" — an explicit month key.
  const isoMonth = q.match(/\b((?:19|20)\d{2})-(0[1-9]|1[0-2])\b/);
  if (isoMonth) return monthSelection(Number(isoMonth[1]), Number(isoMonth[2]));

  // A month name, optionally with a year on either side: "January 2022", "jan 2022", "2022 January".
  // "may" is also an ordinary English word ("may I…") and Filipino ("may utang"),
  // so on its own it only counts when a year is next to it.
  const monthPattern = new RegExp(`\\b(${Object.keys(MONTH_NAMES).join("|")})\\b(?:\\s*,?\\s*((?:19|20)\\d{2}))?`, "g");
  for (const match of q.matchAll(monthPattern)) {
    const name = match[1]!;
    const month = MONTH_NAMES[name]!;
    const before = q.slice(Math.max(0, match.index! - 6), match.index!).match(/((?:19|20)\d{2})\s*$/);
    const yearText = match[2] ?? before?.[1];
    if (name === "may" && !yearText) continue;
    // Three-letter English words that are also month abbreviations ("mar", "jun")
    // only count beside a year, for the same reason.
    if (name.length === 3 && !yearText && !["jan", "feb", "apr", "aug", "sep", "oct", "nov", "dec"].includes(name)) continue;
    if (yearText) return monthSelection(Number(yearText), month);
    // No year: the most recent such month that has started.
    return monthSelection(month > thisMonth ? thisYear - 1 : thisYear, month);
  }

  if (/\b(this year|ngayong taon)\b/.test(q)) return yearSelection(thisYear, today);
  if (/\b(last year|nakaraang taon|noong isang taon)\b/.test(q)) return yearSelection(thisYear - 1, today);
  const bareYear = q.match(/\b(?:in|for|of|noong|nung|sa|during)\s+((?:19|20)\d{2})\b/);
  if (bareYear) return yearSelection(Number(bareYear[1]), today);

  return null;
}

