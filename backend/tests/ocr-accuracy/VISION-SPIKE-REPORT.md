# Vision-model extraction — measurement spike

Generated: 2026-07-31

**Nothing in this report is wired into the app.** This measures whether a multimodal model (`gemini-3.5-flash-lite`) reads receipts that tesseract cannot, whether it invents lines that were never printed, and what it costs — so the decision to use one for extraction can be made against numbers instead of estimates.

Scored by `tests/ocr-accuracy/scoring.ts`, the same rules used for the deterministic pipeline, so these figures are directly comparable to OCR-ACCURACY-REPORT.md.

## Results

| Field | Vision | Deterministic (tesseract) |
|---|---|---|
| Date | 30/30 (100%) | 30/30 (100%) |
| Vendor | 29/29 (100%) | 28/29 (97%) |
| Amount | 30/30 (100%) | 30/30 (100%) |
| Items found | 67/67 (100%) | 65/67 (97%) |
| **Items invented (false positives)** | **0** | **0** |


## Cost and latency

| | |
|---|---|
| Images | 30 |
| Input tokens (measured) | 41,500 |
| Output tokens (measured) | 3,995 |
| Mean latency | 1693 ms |
| Indicative cost per scan | $0.00019 |

Token counts are measured and exact. The dollar figure multiplies them by an **assumed** $0.1/M input and $0.4/M output — verify against current published pricing before quoting it.

## The number that decides this

**0 invented items across 30 images.**

This is the figure the architectural objection rests on. A missed item costs the owner one row of typing; a fabricated one puts a purchase in their books that never happened, and a spending monitor must not do the second.

**But zero here is not the same guarantee the parser gives.** The deterministic parser cannot fabricate a line — structurally, not by good behaviour: it only ever reports what a regex matched in text tesseract returned. The model's zero is *empirical*, measured on this corpus on this day. It is strong evidence and it is not a proof, and no number of clean runs converts one into the other. That distinction is the whole of the decision: whether an extractor that is measurably better but only probabilistically safe should be allowed to write numbers into someone's accounts.

The mitigation the plan already specifies is what makes that trade defensible: this never replaces the deterministic path, it only runs where that path returned nothing, and anything it produces is flagged as a guess rather than presented as a reading — so the failure mode is a wrong number the owner is told to check, not a wrong number presented as fact.

## Run-to-run stability

**Temperature 0 did not make this reproducible.** Repeated full-corpus runs did not produce identical results, which the deterministic parser does by construction.

The observed instability was in the response *envelope*, not the reading: on one run `deg-05-dark` came back as a bare JSON object and on the next as that same object wrapped in a single-element array. The receipt was read correctly both times — date, vendor and total all exact — but the unhandled shape scored as a totally unreadable image until the parser was taught to unwrap it.

Two things follow. First, an integration must treat the response shape as untrusted and validate it, exactly as `validateItemCategories` already does for the categoriser. Second, and less comfortably: a component whose output shape moves between identical calls is one whose failure modes cannot be fully enumerated from a single measurement. Budget for surprises this corpus did not produce.

## What this corpus cannot tell you

The same caveat that qualifies the tesseract figures qualifies these: **26 of the 30 images are synthetic renders or programmatic degradations of them**, and only 2 are real photographs. A vision model scoring well on clean renders is no more surprising than tesseract doing so.

The result that is not explained by corpus composition is `real-01-ph-pos-photo` — the genuine crumpled thermal phone photo, the corpus's hardest image, and the one tesseract reads 0 of 2 items from after preprocessing and engine tuning both failed to move it. Read the comparison as: **strong evidence on the hard real case, weak evidence everywhere else.**

## Per-image

| Image | Kind | Date | Vendor | Amount | Items | Invented |
|---|---|---|---|---|---|---|
| `real-01-ph-pos-photo` | real | ✅ | — | ✅ | 2/2 | 0 |
| `real-02-clean-digital` | real | ✅ | ✅ | ✅ | 3/3 | 0 |
| `syn-01-vendor-top-iso-date` | synthetic | ✅ | ✅ | ✅ | 2/2 | 0 |
| `syn-02-vendor-bottom` | synthetic | ✅ | ✅ | ✅ | 2/2 | 0 |
| `syn-03-ambiguous-slash-date` | synthetic | ✅ | ✅ | ✅ | 1/1 | 0 |
| `syn-04-month-name-date` | synthetic | ✅ | ✅ | ✅ | 1/1 | 0 |
| `syn-05-thousands-separator` | synthetic | ✅ | ✅ | ✅ | 1/1 | 0 |
| `syn-06-subtotal-then-total` | synthetic | ✅ | ✅ | ✅ | 1/1 | 0 |
| `syn-07-no-total-keyword` | synthetic | ✅ | ✅ | ✅ | 1/1 | 0 |
| `syn-08-peso-sign` | synthetic | ✅ | ✅ | ✅ | 1/1 | 0 |
| `syn-09-two-digit-year` | synthetic | ✅ | ✅ | ✅ | 1/1 | 0 |
| `syn-10-dd-mm-yyyy` | synthetic | ✅ | ✅ | ✅ | 1/1 | 0 |
| `syn-11-long-header` | synthetic | ✅ | ✅ | ✅ | 1/1 | 0 |
| `syn-12-tiny-amount` | synthetic | ✅ | ✅ | ✅ | 1/1 | 0 |
| `syn-13-many-items` | synthetic | ✅ | ✅ | ✅ | 7/7 | 0 |
| `syn-14-qty-columns` | synthetic | ✅ | ✅ | ✅ | 3/3 | 0 |
| `syn-15-vat-flags` | synthetic | ✅ | ✅ | ✅ | 2/2 | 0 |
| `syn-16-multiplier-prefix` | synthetic | ✅ | ✅ | ✅ | 3/3 | 0 |
| `syn-17-total-only` | synthetic | ✅ | ✅ | ✅ | 0/0 | 0 |
| `syn-19-savemore-payment-and-tax-lines` | synthetic | ✅ | ✅ | ✅ | 6/6 | 0 |
| `syn-18-discount-line` | synthetic | ✅ | ✅ | ✅ | 2/2 | 0 |
| `deg-01-blur` | degraded | ✅ | ✅ | ✅ | 2/2 | 0 |
| `deg-02-low-contrast` | degraded | ✅ | ✅ | ✅ | 2/2 | 0 |
| `deg-03-rotated` | degraded | ✅ | ✅ | ✅ | 1/1 | 0 |
| `deg-04-low-resolution` | degraded | ✅ | ✅ | ✅ | 1/1 | 0 |
| `deg-05-dark` | degraded | ✅ | ✅ | ✅ | 1/1 | 0 |
| `deg-06-jpeg-artifacts` | degraded | ✅ | ✅ | ✅ | 1/1 | 0 |
| `deg-07-many-items-blur` | degraded | ✅ | ✅ | ✅ | 7/7 | 0 |
| `deg-08-many-items-low-contrast` | degraded | ✅ | ✅ | ✅ | 7/7 | 0 |
| `deg-09-qty-columns-rotated` | degraded | ✅ | ✅ | ✅ | 3/3 | 0 |

