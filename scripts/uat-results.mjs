#!/usr/bin/env node
/**
 * Scores the UAT feedback forms.
 *
 * docs/uat-feedback-form.md defines the arithmetic (a response of 4 or 5 is
 * "positive"; each Part's score is positives over all its answered cells) and
 * three pass marks taken from the manuscript. Doing that by hand across eight
 * participants and thirty-odd rating questions is tedious and easy to get
 * subtly wrong — and a mis-added percentage in a results chapter is the kind
 * of error nobody catches later.
 *
 * Deliberately dependency-free and plain Node: it must still run in a year,
 * on whatever machine has the forms, without an install step.
 *
 *   node scripts/uat-results.mjs responses.csv
 *   node scripts/uat-results.mjs responses.csv --json
 *
 * INPUT — a CSV whose first column is the participant id and whose remaining
 * columns are headed with the question number from the form:
 *
 *   participant,6,7,8,9,10,11,12,...
 *   P1,5,4,4,5,4,5,4,...
 *   P2,4,4,3,4,4,4,5,...
 *
 * Blank cells are treated as "not answered" and excluded from that Part's
 * denominator rather than counted against it — a participant who skipped
 * Task 5 should not drag down the usability score for everyone who did it.
 */

import { readFileSync } from "node:fs";

/**
 * Which questions belong to which Part, and what each Part has to reach.
 *
 * Mirrors docs/uat-feedback-form.md. The two must be changed together: if a
 * question is added there and not here it is silently excluded from scoring,
 * which is the failure mode most likely to go unnoticed, so `verifyCoverage`
 * below checks the file's columns against these ranges and complains about
 * anything it does not recognise.
 */
const PARTS = [
  {
    id: "II",
    name: "Usefulness and relevance",
    experiment: "Experiment 1",
    questions: [6, 7, 8, 9, 10, 11],
    /** "At least 70% positive" — the manuscript's own wording. */
    threshold: 70,
    thresholdLabel: "≥ 70% positive",
    benchmark: { value: 84, note: "agreed FinSight would help them manage records (pre-development survey)" },
  },
  {
    id: "III",
    name: "Clarity and decision support",
    experiment: "Experiment 2",
    questions: [12, 13, 14, 15, 16, 17, 18, 19, 20],
    /** "Majority positive" — read as strictly more than half. */
    threshold: 50,
    thresholdLabel: "> 50% positive",
    benchmark: { value: 79, note: "agreed the overviews and insights would help (pre-development survey)" },
  },
  {
    id: "IV",
    name: "Ease of use and record management",
    experiment: "Experiment 3",
    questions: [22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32],
    threshold: 50,
    thresholdLabel: "> 50% positive",
    benchmark: { value: 86, note: "agreed it would make record handling easier (pre-development survey)" },
  },
  {
    id: "V",
    name: "Compared with how you work now",
    experiment: "(no manuscript criterion)",
    questions: [34, 35, 36, 37],
    threshold: null,
    thresholdLabel: "—",
    benchmark: null,
  },
];

/**
 * Questions the form's scoring guide says to report individually even when
 * the Part they sit in passes, because each maps to a known limitation.
 */
const WATCH_ITEMS = {
  19: "Trust in the numbers — the whole system's value rests on this. A clarity pass with low trust is a failure in practice.",
  23: "Understanding the three setup figures — these drive every insight, so a misunderstanding makes every later number wrong.",
  28: "Receipt read correctly — OCR was measured on a mostly-clean corpus; this is the real-world check.",
  29: "Noticed values were editable — the design assumes review before saving; if they don't notice, OCR errors become silent bad data.",
};

/** A response of 4 or 5. The form's own definition, in one place. */
const isPositive = (score) => score === 4 || score === 5;

/**
 * A deliberately small CSV reader.
 *
 * Handles quoted fields and escaped quotes, because a free-text answer
 * pasted into the sheet will contain commas sooner or later. Anything more
 * exotic than that is out of scope — this reads a file someone exported from
 * a spreadsheet, not arbitrary CSV from the internet.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function loadResponses(path) {
  const rows = parseCsv(readFileSync(path, "utf8"));
  if (rows.length < 2) {
    throw new Error("The file needs a header row and at least one participant row.");
  }

  const header = rows[0].map((h) => h.trim());
  const participants = rows.slice(1).map((cells) => {
    const answers = new Map();
    header.forEach((columnName, i) => {
      if (i === 0) return;
      const questionNumber = Number(columnName);
      const raw = (cells[i] ?? "").trim();
      if (!Number.isInteger(questionNumber) || raw === "") return;
      const score = Number(raw);
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        throw new Error(
          `Participant "${cells[0]}" has "${raw}" for question ${questionNumber}. ` +
            `Ratings must be whole numbers 1-5, or blank if unanswered.`,
        );
      }
      answers.set(questionNumber, score);
    });
    return { id: cells[0].trim() || "(unnamed)", answers };
  });

  return { header, participants };
}

/**
 * Complains about rating columns no Part claims.
 *
 * Silent exclusion is the failure this guards against: a question added to
 * the form but not to PARTS would simply never be scored, and the totals
 * would still look perfectly reasonable.
 */
function verifyCoverage(header) {
  const known = new Set(PARTS.flatMap((p) => p.questions));
  const unclaimed = header
    .slice(1)
    .map((h) => Number(h.trim()))
    .filter((n) => Number.isInteger(n) && !known.has(n));
  return unclaimed;
}

function scorePart(part, participants) {
  const perQuestion = part.questions.map((q) => {
    const scores = participants.map((p) => p.answers.get(q)).filter((s) => s !== undefined);
    const positives = scores.filter(isPositive).length;
    return {
      question: q,
      answered: scores.length,
      positives,
      mean: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      positivePct: scores.length ? (positives / scores.length) * 100 : null,
    };
  });

  const answered = perQuestion.reduce((sum, q) => sum + q.answered, 0);
  const positives = perQuestion.reduce((sum, q) => sum + q.positives, 0);
  const positivePct = answered ? (positives / answered) * 100 : null;

  return {
    ...part,
    answered,
    positives,
    positivePct,
    perQuestion,
    passes:
      part.threshold === null || positivePct === null
        ? null
        : part.id === "II"
          ? positivePct >= part.threshold // "at least 70%"
          : positivePct > part.threshold, // "majority"
  };
}

const pct = (v) => (v === null ? "  —  " : `${v.toFixed(1)}%`.padStart(6));
const mean = (v) => (v === null ? " — " : v.toFixed(2));

function report(results, participants, unclaimed) {
  const n = participants.length;
  console.log("");
  console.log("FinSight — UAT results");
  console.log("======================");
  console.log(`Participants: ${n}`);
  if (n < 10) {
    // The form's own scoring guide says percentages are shaky below about
    // ten respondents. Saying so here means nobody has to remember it.
    console.log(
      "NOTE: with fewer than 10 respondents, report the raw counts alongside\n" +
        "      any percentage — the percentages move a lot per person.",
    );
  }
  if (unclaimed.length > 0) {
    console.log(`WARNING: columns not claimed by any Part, so NOT scored: ${unclaimed.join(", ")}`);
  }

  for (const part of results) {
    console.log("");
    console.log(`Part ${part.id} — ${part.name}  (${part.experiment})`);
    console.log("-".repeat(60));
    const verdict = part.passes === null ? "" : part.passes ? "  PASS" : "  FAIL";
    console.log(`  Positive: ${pct(part.positivePct)}   Criterion: ${part.thresholdLabel}${verdict}`);
    console.log(`  ${part.positives} positive of ${part.answered} answered`);
    if (part.benchmark && part.positivePct !== null) {
      const delta = part.positivePct - part.benchmark.value;
      console.log(
        `  Pre-development benchmark: ${part.benchmark.value}% — ${part.benchmark.note}\n` +
          `  Difference after use: ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} points`,
      );
    }
    console.log("");
    console.log("    Q    mean   positive   answered");
    for (const q of part.perQuestion) {
      const watch = WATCH_ITEMS[q.question] ? "  <- watch" : "";
      console.log(
        `   ${String(q.question).padStart(2)}    ${mean(q.mean)}    ${pct(q.positivePct)}      ${String(q.answered).padStart(2)}${watch}`,
      );
    }
  }

  console.log("");
  console.log("Items to report individually, whatever the Part totals say");
  console.log("-".repeat(60));
  for (const [question, why] of Object.entries(WATCH_ITEMS)) {
    const found = results.flatMap((p) => p.perQuestion).find((q) => q.question === Number(question));
    const score = found ? `${pct(found.positivePct)} positive, mean ${mean(found.mean)}` : "not in the data";
    console.log(`  Q${question}: ${score}`);
    console.log(`        ${why}`);
  }
  console.log("");
}

function main() {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith("--"));
  const asJson = args.includes("--json");

  if (!path) {
    console.error("Usage: node scripts/uat-results.mjs <responses.csv> [--json]");
    process.exit(2);
  }

  const { header, participants } = loadResponses(path);
  const unclaimed = verifyCoverage(header);
  const results = PARTS.map((part) => scorePart(part, participants));

  if (asJson) {
    console.log(JSON.stringify({ participants: participants.length, unclaimed, parts: results }, null, 2));
    return;
  }
  report(results, participants, unclaimed);
}

try {
  main();
} catch (err) {
  console.error(`\nCould not score the responses: ${err.message}\n`);
  process.exit(1);
}
