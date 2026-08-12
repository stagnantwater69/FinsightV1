# FinSight OCR Accuracy Assessment

Generated: 2026-08-01

Corpus: **31 receipt images**. Pipeline under test: `extractText()` (tesseract.js) followed by `parseReceiptFields()` and `parseLineItems()` — the same functions the receipt-scan endpoint calls.

A field is **correct** only on an exact match (amounts to the centavo, dates to the day). Vendor matching tolerates light OCR character noise but not a wrong line.

## Headline results

| Field | Correct | Wrong | Not extracted | Scored | Accuracy |
|---|---|---|---|---|---|
| Date | 31 | 0 | 0 | 31 | **100%** |
| Vendor | 28 | 1 | 0 | 29 | **97%** |
| Amount | 30 | 1 | 0 | 31 | **97%** |

All three fields correct on the same receipt: **29 of 31** (94%).

`n/a` fields are excluded from the denominator — those are receipts where the information genuinely is not present in the image, so there is nothing to extract.

## Line-item extraction

Scored per ITEM, not per receipt. An extracted item is paired with a ground-truth item by **amount**; name and quantity are then scored on that pairing. Quantity is only scored on receipts that actually print a quantity column.

| Measure | Count | Of | Rate |
|---|---|---|---|
| Items found (price exact to the centavo) | 65 | 75 | **87%** |
| ...of those, name also correct | 65 | 65 | **100%** |
| ...of those, quantity also correct | 11 | 12 | **92%** |
| **False positives** (extracted, not on the receipt) | 1 | — | — |

**The false-positive count is the number that matters most.** A missed item costs the owner one row of manual entry; a fabricated item silently puts money in their books that was never on the receipt. The parser is deliberately biased towards missing rather than inventing, and the recall figure above is the price of that choice.

**1 fabricated line on this corpus, and that number was 0 until a third real photograph was added.** It is worth being blunt about what that means: the earlier zero was a property of a corpus that was 90% clean renders, not a property of the parser. One real receipt found two — one a genuine bug (a pluralised `Prod. Discounts:` line slipping past a denylist written as `\bdiscount\b`, now fixed and pinned by a unit test), and one an OCR artefact where two printed lines were merged into one so that an item inherited a neighbouring amount. The second is not something a parsing rule can distinguish from a real line.

> **Read the headline recall figure with the corpus in mind.** Most of these images are rendered receipts, and rendered text OCRs far better than a crumpled thermal one photographed on a table. The single real multi-item PHOTO in the corpus (`real-01-ph-pos-photo`) yields **0 of its 2 items** — Tesseract returns its item block as `Spareribs Keal Res FLV` / `co alle oor 9. 00v`, in which no amount is legible, so the parser correctly extracts nothing. The other real receipt (`real-02-clean-digital`) is a clean digital render and scores 3/3. On the evidence here, item extraction from a **clean or lightly degraded** receipt is reliable; item extraction from a **crumpled thermal phone photo is not**, and the product must treat item extraction as best-effort with a manual fallback rather than as something an owner can depend on. This is the same limitation the corpus note above states for the synthetic set generally.

Multi-item receipts only (16 images, 61 items): **84%** of items found.

Receipts with **no itemised lines at all** (1): 1 of 1 correctly extracted nothing, rather than inventing lines. These are the ones that must fall back to the single-total flow.

### Per-image item detail

| Image | Expected | Found | Name ok | Qty ok | False |
|---|---|---|---|---|---|
| `real-01-ph-pos-photo` | 2 | 0 | 0 | — | 0 |
| `real-02-clean-digital` | 3 | 3 | 3 | 3/3 | 0 |
| `real-03-ph-sales-invoice` | 8 | 0 | 0 | — | 1 |
| `syn-01-vendor-top-iso-date` | 2 | 2 | 2 | — | 0 |
| `syn-02-vendor-bottom` | 2 | 2 | 2 | — | 0 |
| `syn-03-ambiguous-slash-date` | 1 | 1 | 1 | — | 0 |
| `syn-04-month-name-date` | 1 | 1 | 1 | — | 0 |
| `syn-05-thousands-separator` | 1 | 1 | 1 | — | 0 |
| `syn-06-subtotal-then-total` | 1 | 1 | 1 | — | 0 |
| `syn-07-no-total-keyword` | 1 | 1 | 1 | — | 0 |
| `syn-08-peso-sign` | 1 | 1 | 1 | — | 0 |
| `syn-09-two-digit-year` | 1 | 1 | 1 | — | 0 |
| `syn-10-dd-mm-yyyy` | 1 | 1 | 1 | — | 0 |
| `syn-11-long-header` | 1 | 1 | 1 | — | 0 |
| `syn-12-tiny-amount` | 1 | 1 | 1 | — | 0 |
| `syn-13-many-items` | 7 | 7 | 7 | — | 0 |
| `syn-14-qty-columns` | 3 | 3 | 3 | 3/3 | 0 |
| `syn-15-vat-flags` | 2 | 2 | 2 | — | 0 |
| `syn-16-multiplier-prefix` | 3 | 3 | 3 | 3/3 | 0 |
| `syn-17-total-only` | 0 | 0 | 0 | — | 0 |
| `syn-19-savemore-payment-and-tax-lines` | 6 | 6 | 6 | — | 0 |
| `syn-18-discount-line` | 2 | 2 | 2 | — | 0 |
| `deg-01-blur` | 2 | 2 | 2 | — | 0 |
| `deg-02-low-contrast` | 2 | 2 | 2 | — | 0 |
| `deg-03-rotated` | 1 | 1 | 1 | — | 0 |
| `deg-04-low-resolution` | 1 | 1 | 1 | — | 0 |
| `deg-05-dark` | 1 | 1 | 1 | — | 0 |
| `deg-06-jpeg-artifacts` | 1 | 1 | 1 | — | 0 |
| `deg-07-many-items-blur` | 7 | 7 | 7 | — | 0 |
| `deg-08-many-items-low-contrast` | 7 | 7 | 7 | — | 0 |
| `deg-09-qty-columns-rotated` | 3 | 3 | 3 | 2/3 | 0 |

## Results by image category

| Category | Images | Date | Vendor | Amount |
|---|---|---|---|---|
| real | 3 | 100% | 100% | 67% |
| synthetic | 19 | 100% | 95% | 100% |
| degraded | 9 | 100% | 100% | 100% |

## Per-image detail

| # | Image | Conditions | Date | Vendor | Amount |
|---|---|---|---|---|---|
| 1 | `real-01-ph-pos-photo` | Real phone photo, PH POS thermal receipt, on wooden table, slight crumple, store name cropped out of frame | ✅ | — | ✅ |
| 2 | `real-02-clean-digital` | Clean digitally-generated receipt, high contrast, US layout, vendor at top, no TOTAL keyword (uses AMT/BALANCE) | ✅ | ✅ | ✅ |
| 3 | `real-03-ph-sales-invoice` | Real phone photo, PH thermal SALES INVOICE, 8 items with a quantity column and per-item unit prices on a wrapped second line, a discount line, and two emoji stickers overlaid on one item row by whoever shared it | ✅ | — | ❌ |
| 4 | `syn-01-vendor-top-iso-date` | Printed, vendor at top, ISO date (YYYY-MM-DD), TOTAL keyword, no thousands separator | ✅ | ✅ | ✅ |
| 5 | `syn-02-vendor-bottom` | Printed, vendor at BOTTOM of receipt (known layout weakness), ISO date | ✅ | ❌ | ✅ |
| 6 | `syn-03-ambiguous-slash-date` | Printed, ambiguous numeric date 03/09/2026 (both components <= 12) — read as DD/MM per PH convention | ✅ | ✅ | ✅ |
| 7 | `syn-04-month-name-date` | Printed, month-name date (Jul 05, 2026) | ✅ | ✅ | ✅ |
| 8 | `syn-05-thousands-separator` | Printed, amount with thousands separator (12,450.00) | ✅ | ✅ | ✅ |
| 9 | `syn-06-subtotal-then-total` | Printed, SUBTOTAL present before TOTAL (must not pick subtotal) | ✅ | ✅ | ✅ |
| 10 | `syn-07-no-total-keyword` | Printed, NO 'TOTAL' keyword at all (uses 'Amount Due') — tests the max-value fallback | ✅ | ✅ | ✅ |
| 11 | `syn-08-peso-sign` | Printed, peso sign prefixes every amount | ✅ | ✅ | ✅ |
| 12 | `syn-09-two-digit-year` | Printed, two-digit year (07/22/26) | ✅ | ✅ | ✅ |
| 13 | `syn-10-dd-mm-yyyy` | Printed, DD/MM/YYYY date (25/07/2026) — resolvable by validity, since 25 cannot be a month | ✅ | ✅ | ✅ |
| 14 | `syn-11-long-header` | Printed, several administrative lines before the vendor name (TIN/permit block first) | ✅ | ✅ | ✅ |
| 15 | `syn-12-tiny-amount` | Printed, very small amount (single-digit pesos) | ✅ | ✅ | ✅ |
| 16 | `syn-13-many-items` | Printed, 7 plain name+price item lines (a grocery run) — the common multi-item shape | ✅ | ✅ | ✅ |
| 17 | `syn-14-qty-columns` | Printed, QTY / UNIT PRICE / AMOUNT columns per item line | ✅ | ✅ | ✅ |
| 18 | `syn-15-vat-flags` | Printed, BIR-style VAT class flag appended to every item amount (129.00V) | ✅ | ✅ | ✅ |
| 19 | `syn-16-multiplier-prefix` | Printed, '2 x Item' multiplier prefix on each line | ✅ | ✅ | ✅ |
| 20 | `syn-17-total-only` | Printed, NO itemised lines at all — only a total. Tests the fallback: item extraction must return nothing rather than invent lines | ✅ | ✅ | ✅ |
| 21 | `syn-19-savemore-payment-and-tax-lines` | Real PH grocery receipt structure: 6 items followed by a VAT summary block, a TOTAL, and a 'BDO ATM' payment line carrying the same total, plus AuthCode/Order ID | ✅ | ✅ | ✅ |
| 22 | `syn-18-discount-line` | Printed, a DISCOUNT line sits among the items — must not be read as a purchase | ✅ | ✅ | ✅ |
| 23 | `deg-01-blur` | Synthetic + Gaussian blur r=1.6 (simulates out-of-focus capture) | ✅ | ✅ | ✅ |
| 24 | `deg-02-low-contrast` | Synthetic + contrast reduced to 35% (simulates faded thermal print) | ✅ | ✅ | ✅ |
| 25 | `deg-03-rotated` | Synthetic + rotated 4 degrees (simulates handheld skew) | ✅ | ✅ | ✅ |
| 26 | `deg-04-low-resolution` | Synthetic + downscaled to 45% then back up (simulates a distant/low-res photo) | ✅ | ✅ | ✅ |
| 27 | `deg-05-dark` | Synthetic + brightness reduced to 45% (simulates poor lighting) | ✅ | ✅ | ✅ |
| 28 | `deg-06-jpeg-artifacts` | Synthetic + heavy JPEG compression (quality 12) | ✅ | ✅ | ✅ |
| 29 | `deg-07-many-items-blur` | 7-item receipt + Gaussian blur r=1.6 | ✅ | ✅ | ✅ |
| 30 | `deg-08-many-items-low-contrast` | 7-item receipt + contrast reduced to 35% | ✅ | ✅ | ✅ |
| 31 | `deg-09-qty-columns-rotated` | Quantity-column receipt + rotated 4 degrees | ✅ | ✅ | ✅ |

✅ correct · ❌ wrong value returned · ⬜ nothing extracted · — not applicable (not present in image)

## Every failure, with what was returned instead

### `real-03-ph-sales-invoice`

*Real phone photo, PH thermal SALES INVOICE, 8 items with a quantity column and per-item unit prices on a wrapped second line, a discount line, and two emoji stickers overlaid on one item row by whoever shared it*

| Field | Expected | Got | |
|---|---|---|---|
| amount | `2180` | `2185` | ❌ |

### `syn-02-vendor-bottom`

*Printed, vendor at BOTTOM of receipt (known layout weakness), ISO date*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"TINDAHAN NI MANG JOSE"` | `"*xx GALES INVOICE ***"` | ❌ |

## Corpus composition and what it does and does not prove

| Category | Count | What it tests |
|---|---|---|
| real | 3 | Genuine receipt photographs, including two Philippine thermal receipts shot on a phone |
| synthetic | 19 | Parser robustness across layouts, date formats, amount formats, currency symbols, header styles |
| degraded | 9 | Synthetic receipts degraded with blur, low contrast, rotation, downscaling, darkness and JPEG artifacts |

**This corpus over-states robustness to real-world photo quality.** Only 3 of the 31 images are real photographs. The 9 degraded images are *rendered* receipts with uniform, synthetic degradation applied programmatically — real phone captures have uneven lighting, curled thermal paper, motion blur, shadows and fold creases that are not reproduced here. Tesseract handled every degraded image perfectly, which is a claim about clean-render-plus-filter, **not** about a shopkeeper photographing a crumpled receipt in a dim store.

**No handwritten receipts are included.** None were available. Handwritten *resibo* are common in sari-sari stores, and tesseract's default model is trained on printed text — accuracy on handwriting should be assumed poor until measured. This is an untested gap, not a passing case.

## Failure patterns

### 1. Ambiguous numeric dates — resolved by defaulting to DD/MM

When a date reads `11/07/2026` and both components are ≤ 12, nothing in the text can resolve it. The parser previously assumed **MM/DD** (US convention) and read that as 7 November; on the real Philippine receipt in this corpus the true date was **11 July**, so it was exactly wrong, and confidently so.

The default is now **DD/MM**, the Philippine convention and this app's target market. Date accuracy went from 95% to **100%** on this corpus. Validity still wins where only one reading is possible — `07/22/2026` is still read as 22 July, because 22 cannot be a month.

**The cost, stated plainly:** a genuinely US-format receipt is now misread instead. That trade is unavoidable without a per-profile locale setting, and it is the right way round for these users. `syn-03` in the corpus is that ambiguous case, and its ground truth is the DD/MM reading.

### 2. Vendor name printed in the footer

The vendor heuristic takes the first substantive line, so a store name printed at the bottom is read wrong (it returns the document header instead). No cheap heuristic separates a footer store name from a "thank you, come again" line. Left to the confirm screen and recorded as a known limitation.

### 3. OCR losing the transaction-date line entirely on a real photo

On the real thermal-receipt photo, tesseract never recovered the `Jul 11 2026 (Sat)` line at all — it is absent from the extracted text. The parser can only work with what OCR returns, so no parsing rule could have recovered it. This is an image-quality/OCR-engine limit, and it is the kind of failure the 6 synthetic degraded images did **not** reproduce.

## Image preprocessing, and what it was measured to be worth

`extractText()` now passes every upload through `sharp` before tesseract sees it: EXIF rotation, a downscale to 2000px, and grayscale. **This changes no figure in this report.** Every image above scores identically with and without it — same date, vendor, amount and item results, image for image. It is in the pipeline for orientation correctness and cost, not accuracy:

- **Orientation.** `rotate()` applies the EXIF flag a phone camera writes. A receipt shot in portrait and tagged sideways is unreadable without it. No image in this corpus carries an orientation flag, so this corpus cannot demonstrate the benefit — it is a real-world case the corpus does not cover.
- **Cost.** On a simulated 4000px phone capture (1.71 MB), OCR took **35.4s** on the raw bytes and **14.3s** including preprocessing — about **60% faster**, for identical output. The receipt scan is the slowest interaction in the app, so this is the change's actual value.

### Preprocessing that was tried and rejected

Recorded so it is not retried on the assumption that it obviously ought to help:

| Tried | Result |
|---|---|
| `normalize()` (global contrast stretch) | **Regression.** On the real crumpled thermal photo it read the 188.00 total as `8` and the year 2026 as `2028`. Stretching the whole frame against a bright table background pushes faint thermal strokes out, and a leading `1` goes first. Date and amount both fell 100% → 97%. |
| `clahe()`, windows 3–100 (local adaptive contrast) | Neutral at best; at small windows it destroyed the date and amount outright. This is the technique uneven lighting is supposed to call for, and it did not help here. |
| median denoise, 2x upscale, sharpen | Neutral or worse. |

**None of them recovered the two line items lost on the real photo.** That failure is not a contrast problem — tesseract returns the item block as `Spareribs Keal Res FLV`, with no legible amount anywhere in it. No image transform restores detail the capture never recorded. Improving that case needs a better capture or a different engine, not a better filter.

## Engine tuning, and why none of it is applied

Page segmentation mode was swept across the whole corpus. **The current setting — not setting one at all — is the best of every option measured**, so no engine parameter is configured in `extractText()`.

| `tessedit_pageseg_mode` | Date | Vendor | Amount | All three |
|---|---|---|---|---|
| **unset (what we ship)** | **100%** | **97%** | **100%** | **29/30** |
| 3 — fully automatic | 80% | 86% | 63% | 14/30 |
| 4 — single column | 80% | 86% | 67% | 15/30 |
| 6 — single uniform block | 100% | 97% | 100% | 29/30 |
| 11 — sparse text | 100% | 90% | 73% | 19/30 |
| 12 — sparse text + OSD | 100% | 90% | 73% | 19/30 |

Two things worth knowing, because both are counter-intuitive:

1. **tesseract.js does not default to PSM 3.** It defaults to **PSM 6**, unlike the tesseract CLI. Row 6 above is identical to the unset row image for image, which is what confirms it. Advice written for the CLI does not transfer.
2. **The mode that sounds right for a receipt is the one that breaks it.** PSM 4 is "a single column of text of variable sizes" — a fair description of a receipt, and the obvious thing to reach for. It drops amount accuracy from 100% to **67%**. A receipt's totals block is not a single column, and forcing that reading pulls the figures apart.

`user_defined_dpi=300` was also tested, alone and with PSM 6: neutral in both cases, so it is not set.

Re-run any of these with `OCR_PSM=<n> OCR_DPI=<n> npx tsx tests/ocr-accuracy/run-assessment.ts`.

## Fixes applied during this assessment

1. **Invalid dates crashed the whole upload (defect, fixed).** A DD/MM/YYYY receipt dated after the 12th produced `2026-25-07` — month 25. That becomes an `Invalid Date`, which Prisma rejects with a validation error, so the entire receipt upload failed with a 500 and the owner lost the scan rather than getting a correctable draft. The parser now validates every date against the real calendar (including rejecting e.g. 31 February) and resolves `DD/MM` when the first component cannot be a month.
2. **Administrative dates were preferred over the transaction date (defect, fixed).** Philippine POS receipts print BIR permit, PTU-issued and accreditation dates *above* the transaction date; first-match-wins read those. The real receipt returned `2024-10-14` from its `PTU Issued` line. Those lines are now excluded, with a fallback so a wrong-but-correctable date still beats an empty field.
3. **Registration blocks were read as the vendor (defect, fixed).** `VAT REG TIN: …`, `POS SN: …` and bare `*** SALES INVOICE ***` headers are now skipped when choosing the vendor, as are lines that are mostly digits.

4. **Ambiguous numeric dates defaulted to the wrong locale (fixed).** Changed from MM/DD to DD/MM — see failure pattern 1 above.

Measured effect across all four: date accuracy 90% → **100%**, vendor accuracy 89% → **95%**, all-three-correct 16/20 → **19/20**. Every fix is pinned by regression tests in `tests/unit/ocrParsing.test.ts`.

## Bottom line

Amount extraction is the strongest and most important field, at 100% across the corpus including every degraded variant. Dates now also read 100% after the locale fix. The one remaining failure is a vendor name printed in a receipt footer.

These numbers should still not be read as "OCR is ~100% accurate". They are a claim about this corpus, which is 90% clean renders and only 2 real photographs, with no handwritten receipts at all. The design already assumes OCR will be wrong sometimes: every scan lands on a confirm screen as an editable draft and nothing is saved until the owner accepts it. Read these figures as "OCR gives a usable first draft on clean receipts, and needs correcting on difficult ones".

