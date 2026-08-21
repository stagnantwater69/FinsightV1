# Scripts

## `uat-results.mjs` — score the UAT feedback forms

This tool is retained for an adviser-required or future external participant
study. Do not populate it with answers from the development team and report the
percentages as representative user acceptance results. Team-only capstone
verification is recorded with `docs/internal-acceptance-checklist.md` instead.

Turns the rating questions from `docs/uat-feedback-form.md` into the figures
that document's scoring guide asks for: a positive percentage per Part against
its manuscript criterion, a mean and positive rate per question, and the
individual items the guide says to report regardless of whether the Part
passed.

```bash
# 1. Copy the template and fill it in as forms come back
cp scripts/uat-responses-template.csv uat-responses.csv

# 2. Score it
node scripts/uat-results.mjs uat-responses.csv

# ...or get the same numbers as JSON, for a chart or a spreadsheet
node scripts/uat-results.mjs uat-responses.csv --json
```

No dependencies and no install step — plain Node, so it still runs on whatever
machine has the forms in a year's time.

### Filling in the CSV

One row per participant. The first column is the participant id (use the same
anonymous id as the paper form — **not** their name). Every other column is
headed with a question number from the feedback form and holds a rating of
1–5.

**Leave a cell blank if the participant did not answer it.** Blanks are
excluded from that Part's denominator rather than counted as negative, so a
participant who skipped the spreadsheet-import task does not drag down the
usability score for everyone who did it.

Only the Likert questions (Parts II–V) are scored here. The free-text answers
(38–43) and the Part I profile questions are read by hand — they are the
material for the discussion, not the arithmetic.

### What it checks for you

- **Ratings outside 1–5 are rejected**, naming the participant and question,
  rather than being coerced into something plausible.
- **Columns no Part claims are reported**, because a question added to the form
  but not to the script would otherwise be silently excluded and the totals
  would still look reasonable.
- **Fewer than 10 respondents prints a warning** to report raw counts alongside
  percentages — the form's own scoring guide says percentages are shaky below
  that, and it is easy to forget once you have a tidy percentage in hand.

### Keeping it in step with the form

The question-to-Part mapping and the pass marks live in the `PARTS` constant at
the top of the script, mirroring `docs/uat-feedback-form.md`. **If you change
the form, change that constant in the same commit** — the coverage warning will
catch a question that was added, but not one that was moved between Parts.
