# Learning from what owners correct

Every receipt confirmation is a person telling us whether an extraction was right. This
document describes what FinSight records of that, what the resulting figures do and do not
prove, and what may be changed on the strength of them.

## Why this exists

The confirm screen is the only place the app is ever handed ground truth by someone who can
actually see the receipt. Until now that answer was discarded at the moment it was given: the
owner's edits went to `ExpenseRecord`, the reading stayed on `ReceiptScan`, and nothing
recorded that the two disagreed.

The accuracy figures the project had before this came from
[`tests/ocr-accuracy/`](../backend/tests/ocr-accuracy) — 31 images with hand-written ground
truth. That corpus is a good yardstick and a small sample, and the confidence calibration
built on it says so itself: its low-confidence evidence is two real photographs, and it calls
`n=2` the honest limit of the exercise. Confirmed receipts are the way out of that.

## What is recorded

One `ReceiptFieldCorrection` row per field an owner reviewed, written at confirmation.

| Field | Compared |
|---|---|
| `date` | `ReceiptScan.extractedDate` against the confirmed date |
| `vendor` | `ReceiptScan.extractedVendor` against the confirmed vendor |
| `amount` | `ReceiptScan.extractedAmount` against the confirmed total |
| `itemCategory` | the categoriser's pick against the category the owner filed the line under |
| `itemPresence` | a line the owner typed in (OCR missed it) or deleted (OCR invented it) |

Each row carries the two values, the confidence the engine reported, which system produced
the reading (`ocr`, `vision`, `ai-category`), and `wasEdited`.

**A row is written for every reviewed field, not only the changed ones.** Logging only edits
would give a numerator with no denominator — "vendor was corrected 40 times" is not an
accuracy figure without knowing how many vendors were shown — and would lose the case this
measurement is most useful for: a field read at 30% confidence that the owner confirmed
untouched says the *confidence score* is miscalibrated, not that the extraction is bad, and
nothing was edited to record it by.

### Two things are deliberately not recorded

**A confidence for `itemCategory`.** `ReceiptScanItem.amountConfidence` is how sure OCR was
that it read the line's *amount*. It says nothing about whether the categoriser filed the line
correctly. Borrowing it would put a real-looking number into the calibration report that no
model ever produced for that decision.

**Anything about owner-added lines beyond their existence.** Schema note 12: a row a human
supplied must never be counted as something FinSight extracted.

### Nothing was backfilled

`confirmReceipt` overwrites `ReceiptScanItem.categoryId` with the owner's choice as it writes
the expense records, so for every scan confirmed before this feature existed the categoriser's
original pick is gone. A backfill would have recorded "the AI agreed with the owner" for every
historical item — the one answer we know cannot be verified. Measurement starts from the
migration.

The same overwrite is why `snapshotItemCategories` runs *before* the record-writing loop, and
why there is an integration test whose only job is to fail if it ever moves after it.

## What the figures prove, and what they do not

**An edit is strong evidence.** Someone actively disagreed with what was on screen.

**A confirmation is weak evidence.** It covers both "I checked this and it is right" and "I
glanced at it and tapped". It is also biased towards agreement by construction: the confirm
screen shows FinSight's answer first, and the owner has to overcome it to disagree.

So the reports call the headline number **"left unchanged"** rather than "accuracy", and it
should be read as an **upper bound**. The one number that must never be produced is a single
blended accuracy figure that hides which half of the evidence it rests on.

There is a way to measure the anchoring bias rather than just noting it — show a sample of
owners the confirm screen with the low-confidence highlighting suppressed, and compare
correction rates. That has not been done. Until it is, the size of the bias is unknown, which
is why nothing downstream treats confirmations as verified truth.

## Reading the data

Neither script is part of `npm test`; both read the live database.

```bash
npx tsx tests/ocr-accuracy/live-feedback-report.ts --days 30
npx tsx tests/ocr-accuracy/recalibrate-threshold.ts --days 90
```

The first writes `LIVE-FEEDBACK-REPORT.md` — per-field accuracy, per-source accuracy, the
share of scans needing any fix at all, confidence calibration, and the mistakes that keep
recurring. The second reports whether `LOW_CONFIDENCE` still sits where it should.

**Use the corpus to judge a change; use these to find out what to change.** `run-assessment.ts`
scores fixed images, so a difference between two runs is caused by the code. The live sample
moves on its own every week — a drop between runs might be a worse parser or might be a
fortnight of crumpled thermal receipts.

## What may be changed on the strength of this

In rough order of how cheap and how reversible:

1. **Confidence thresholds.** `recalibrate-threshold.ts` reports where `LOW_CONFIDENCE` would
   sit if chosen the way the shipped 75 was — the midpoint of the empty band between the
   most confident reading anyone corrected and the least confident one anyone accepted.
2. **The deterministic parsers.** A vendor whose name always mangles the same way, a date
   format that always flips — these show up as recurring clusters and are ordinary bug fixes.
3. **The categoriser's prompt.** Recurring `itemCategory` clusters are candidates for
   few-shot examples or for the business's own category descriptions.
4. **The vision extraction prompt**, on the same basis.

### Three rules for acting on it

**Nothing changes itself.** `recalibrate-threshold.ts` prints a recommendation and edits
nothing. A threshold that moves on its own is one nobody reviewed, fitted to whatever the last
few weeks looked like, and its behaviour on the day it drifts is not attributable to any
change anyone made.

**Corrections are reviewed by a person before they become prompt examples.** A pool of
corrections can be poisoned — by one owner who files things idiosyncratically, or simply by
someone who was wrong. Batch review is the check.

**Every change is re-run against the corpus before it ships.** That is the only measurement in
this project where a difference between two runs is caused by the change rather than by the
sample.

## Privacy

Correction rows contain vendor names, item names and amounts — the owner's own data, already
present in `ReceiptScan` and `ExpenseRecord`, and never leaving the database. Deleting a
receipt deletes them with it (`onDelete: Cascade`), so an owner's deletion is a real deletion
rather than one that quietly preserves the analytics.

Aggregate figures — percentages, counts, calibration — carry nothing identifying and can be
shared freely. **Recurring-error clusters cannot**: `"pandesal: Uncategorized -> Ingredients"`
is fine, a vendor name is a real business someone buys from. Anything lifted out of a cluster
and into a prompt is real transaction data and needs a human to look at it first — which is
the same review step rule two already requires for a different reason.

If corrections are ever used to improve extraction for *other* owners — which is what putting
a real example into a shared prompt does — that needs to be disclosed rather than assumed.
Today the data only informs changes a developer makes by hand.
