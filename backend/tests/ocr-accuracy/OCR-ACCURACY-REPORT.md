# FinSight OCR Accuracy Assessment

Generated: 2026-08-31

Corpus: **73 receipt images**. Pipeline under test: `extractText()` (tesseract.js) followed by `parseReceiptFields()` and `parseLineItems()` — the same functions the receipt-scan endpoint calls.

A field is **correct** only on an exact match (amounts to the centavo, dates to the day). Vendor matching tolerates light OCR character noise but not a wrong line.

## Headline results

| Field | Correct | Wrong | Not extracted | Scored | Accuracy |
|---|---|---|---|---|---|
| Date | 41 | 6 | 14 | 61 | **67%** |
| Vendor | 44 | 16 | 0 | 60 | **73%** |
| Amount | 49 | 13 | 11 | 73 | **67%** |

All three fields correct on the same receipt: **37 of 73** (51%).

`n/a` fields are excluded from the denominator — those are receipts where the information genuinely is not present in the image, so there is nothing to extract.

## Line-item extraction

Scored per ITEM, not per receipt. An extracted item is paired with a ground-truth item by **amount**; name and quantity are then scored on that pairing. Quantity is only scored on receipts that actually print a quantity column.

| Measure | Count | Of | Rate |
|---|---|---|---|
| Items found (price exact to the centavo) | 130 | 216 | **60%** |
| ...of those, name also correct | 120 | 130 | **92%** |
| ...of those, quantity also correct | 34 | 77 | **44%** |
| **False positives** (extracted, not on the receipt) | 14 | — | — |

**The false-positive count is the number that matters most.** A missed item costs the owner one row of manual entry; a fabricated item silently puts money in their books that was never on the receipt. The parser is deliberately biased towards missing rather than inventing, and the recall figure above is the price of that choice.

**14 fabricated lines on this corpus, and that number was 0 until a third real photograph was added.** It is worth being blunt about what that means: the earlier zero was a property of a corpus that was 90% clean renders, not a property of the parser. One real receipt found two — one a genuine bug (a pluralised `Prod. Discounts:` line slipping past a denylist written as `\bdiscount\b`, now fixed and pinned by a unit test), and one an OCR artefact where two printed lines were merged into one so that an item inherited a neighbouring amount. The second is not something a parsing rule can distinguish from a real line.

> **Read the headline recall figure with the corpus in mind.** Most of these images are rendered receipts, and rendered text OCRs far better than a crumpled thermal one photographed on a table. The single real multi-item PHOTO in the corpus (`real-01-ph-pos-photo`) yields **0 of its 2 items** — Tesseract returns its item block as `Spareribs Keal Res FLV` / `co alle oor 9. 00v`, in which no amount is legible, so the parser correctly extracts nothing. The other real receipt (`real-02-clean-digital`) is a clean digital render and scores 3/3. On the evidence here, item extraction from a **clean or lightly degraded** receipt is reliable; item extraction from a **crumpled thermal phone photo is not**, and the product must treat item extraction as best-effort with a manual fallback rather than as something an owner can depend on. This is the same limitation the corpus note above states for the synthetic set generally.

Multi-item receipts only (40 images, 185 items): **62%** of items found.

Receipts with **no itemised lines at all** (2): 1 of 2 correctly extracted nothing, rather than inventing lines. These are the ones that must fall back to the single-total flow.

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
| `real-04-cropped-vendor-glare` | 1 | 0 | 0 | — | 0 |
| `real-05-bintang-juice-camscan-watermark` | 2 | 0 | 0 | — | 0 |
| `real-06-severe-blur-curled-thermal` | 1 | 0 | 0 | — | 0 |
| `real-07-glare-finger-obstruction` | 1 | 0 | 0 | — | 0 |
| `real-08-diagonal-watermark-blur` | 1 | 0 | 0 | — | 0 |
| `real-09-severe-blur-duplicate-items` | 2 | 0 | 0 | — | 0 |
| `real-10-chopstick-obstruction-crumple` | 1 | 0 | 0 | — | 0 |
| `real-11-thumb-obstruction-single-item` | 1 | 0 | 0 | — | 0 |
| `real-12-long-13-item-blurry-header` | 13 | 0 | 0 | — | 0 |
| `real-13-blur-vendor-two-item` | 2 | 0 | 0 | — | 0 |
| `real-14-lamp-glare-discount-multiplier` | 1 | 0 | 0 | — | 0 |
| `real-15-ikea-uk-dd-mm-date` | 5 | 5 | 5 | 5/5 | 1 |
| `real-16-new-china-us-date` | 4 | 4 | 4 | 3/4 | 0 |
| `real-17-decorative-banner-wood-table` | 6 | 0 | 0 | — | 0 |
| `real-18-via-emilia-clean` | 3 | 3 | 3 | 3/3 | 0 |
| `real-19-togo-banner-asterisks` | 3 | 1 | 1 | 0/1 | 0 |
| `real-20-cluttered-menu-background-tilt` | 3 | 0 | 0 | — | 0 |
| `real-21-jts-diner-clean` | 4 | 4 | 3 | 0/4 | 0 |
| `real-22-blank-total-field-curl` | 0 | 0 | 0 | — | 1 |
| `real-23-handwritten-total-override` | 9 | 8 | 8 | 0/8 | 0 |
| `real-24-yauatcha-no-date` | 8 | 7 | 7 | 7/7 | 0 |
| `real-25-boa-dark-background` | 2 | 2 | 2 | 2/2 | 0 |
| `real-26-friendly-reds-clean` | 6 | 5 | 3 | 0/5 | 0 |
| `real-27-pappadeaux-ambiguous-us-date` | 3 | 2 | 2 | 1/2 | 2 |
| `real-28-carls-jr-translucent-bleed` | 1 | 1 | 1 | 1/1 | 2 |
| `real-29-saska-paperclip-clipboard` | 8 | 8 | 8 | 0/8 | 0 |
| `real-30-wings-things-over-menu-crumple` | 3 | 1 | 0 | 0/1 | 0 |
| `real-31-lan-sheng-item-price-column-shift` | 5 | 1 | 0 | 0/1 | 0 |
| `real-32-mynews-handwritten-margin` | 1 | 0 | 0 | — | 0 |
| `real-33-mcdonalds-my-combo-submenu` | 1 | 1 | 1 | 1/1 | 0 |
| `real-34-parking-ticket-stamped-redacted` | 1 | 0 | 0 | — | 0 |
| `real-35-kings-confectionery-discount-column` | 5 | 0 | 0 | — | 2 |
| `real-36-mrdiy-multiline-item-layout` | 2 | 1 | 0 | 0/1 | 0 |
| `real-37-gardenia-torn-multi-subtotal` | 7 | 5 | 2 | 0/5 | 2 |
| `real-38-super-seven-dot-noise-duplicate-lines` | 6 | 5 | 5 | 0/5 | 0 |
| `real-39-sanyu-stationery-clean` | 1 | 0 | 0 | — | 0 |
| `real-40-portugalia-euro-redaction-dots` | 13 | 1 | 0 | 0/1 | 2 |
| `real-41-caravela-simple-euro` | 1 | 0 | 0 | — | 0 |
| `real-42-fuel-pump-receipt-redaction` | 1 | 0 | 0 | — | 0 |
| `real-43-pollux-torn-skew-barcode` | 1 | 0 | 0 | — | 1 |
| `real-44-oriente-perfeito-handwritten-note` | 1 | 0 | 0 | — | 0 |
| `real-45-sticker-obstruction-cropped-vendor` | 1 | 0 | 0 | — | 0 |

## Results by image category

| Category | Images | Date | Vendor | Amount |
|---|---|---|---|---|
| real | 45 | 39% | 50% | 47% |
| synthetic | 19 | 100% | 100% | 100% |
| degraded | 9 | 100% | 100% | 100% |

## Per-image detail

| # | Image | Conditions | Date | Vendor | Amount |
|---|---|---|---|---|---|
| 1 | `real-01-ph-pos-photo` | Real phone photo, PH POS thermal receipt, on wooden table, slight crumple, store name cropped out of frame | ✅ | — | ✅ |
| 2 | `real-02-clean-digital` | Clean digitally-generated receipt, high contrast, US layout, vendor at top, no TOTAL keyword (uses AMT/BALANCE) | ✅ | ✅ | ✅ |
| 3 | `real-03-ph-sales-invoice` | Real phone photo, PH thermal SALES INVOICE, 8 items with a quantity column and per-item unit prices on a wrapped second line, a discount line, and two emoji stickers overlaid on one item row by whoever shared it | ✅ | — | ❌ |
| 4 | `syn-01-vendor-top-iso-date` | Printed, vendor at top, ISO date (YYYY-MM-DD), TOTAL keyword, no thousands separator | ✅ | ✅ | ✅ |
| 5 | `syn-02-vendor-bottom` | Printed, vendor at BOTTOM of receipt (known layout weakness), ISO date | ✅ | ✅ | ✅ |
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
| 32 | `real-04-cropped-vendor-glare` | Real phone photo, Indonesian drink-stall thermal receipt, header block blurred/illegible, single item, tight crop | — | — | ❌ |
| 33 | `real-05-bintang-juice-camscan-watermark` | Real phone photo scanned through the CamScanner app (adds a small logo + 'Scanned with CamScanner' watermark, bottom-left), Indonesian juice stall, otherwise clear print | ⬜ | ❌ | ⬜ |
| 34 | `real-06-severe-blur-curled-thermal` | Real phone photo, curled/perforated thermal receipt edge, out-of-focus capture, black background | ⬜ | — | ⬜ |
| 35 | `real-07-glare-finger-obstruction` | Real phone photo, strong glare plus the photographer's own thumb partially covering the lower-right corner, single item, bakery chain receipt | — | ❌ | ⬜ |
| 36 | `real-08-diagonal-watermark-blur` | Real phone photo, blurred header, a repeating diagonal text watermark ('D'crepes') overlaid across the whole frame by whoever shared the photo — distinct from the receipt's own printed content | — | — | ⬜ |
| 37 | `real-09-severe-blur-duplicate-items` | Real phone photo, severe blur, vendor and every administrative line illegible, TWO separate identical-item order lines (not a quantity of 2 on one line) | — | — | ⬜ |
| 38 | `real-10-chopstick-obstruction-crumple` | Real phone photo on a wood-grain table, wooden chopsticks and a pink napkin partially resting on/behind the receipt, blurred header, single abbreviated item name | — | — | ⬜ |
| 39 | `real-11-thumb-obstruction-single-item` | Real phone photo, blurred header, photographer's thumb visible at the left edge, single high-value electronics item, no tax line | — | — | ✅ |
| 40 | `real-12-long-13-item-blurry-header` | Real phone photo, long 13-line itemised restaurant receipt with small print, header fully blurred, some leading quantity digits at the left margin partly cut off | — | — | ❌ |
| 41 | `real-13-blur-vendor-two-item` | Real phone photo, blurred café/bakery header, two items, service charge + tax lines | — | — | ⬜ |
| 42 | `real-14-lamp-glare-discount-multiplier` | Real phone photo taken under a warm lamp with strong glare and a pixelated/redacted-looking header, one item with a '2x' multiplier prefix AND a 30% discount line reducing it | — | — | ⬜ |
| 43 | `real-15-ikea-uk-dd-mm-date` | Real phone photo, IKEA Food UK receipt, clean print, GBP, DD/MM/YYYY date format | ⬜ | ✅ | ✅ |
| 44 | `real-16-new-china-us-date` | Real phone photo, US restaurant receipt (Mesa, AZ), MM-DD-YYYY date format, clean print | ❌ | ✅ | ✅ |
| 45 | `real-17-decorative-banner-wood-table` | Real phone photo on a dark wood table, upscale restaurant receipt (Dublin, Ireland), unambiguous month-name date, no decorative banner but tight crop | ⬜ | ❌ | ✅ |
| 46 | `real-18-via-emilia-clean` | Real phone photo, clean US restaurant receipt (Miami Beach, FL), month-name date, an order-tracking URL/code line | ⬜ | ✅ | ✅ |
| 47 | `real-19-togo-banner-asterisks` | Real phone photo, decorative asterisk banner ('*** TO GO ***') above the vendor block, US date, unambiguous | ⬜ | — | ❌ |
| 48 | `real-20-cluttered-menu-background-tilt` | Real phone photo, receipt photographed resting on top of a restaurant menu (cluttered background text behind/around it), slight tilt, US date | ⬜ | ❌ | ⬜ |
| 49 | `real-21-jts-diner-clean` | Real phone photo, clean US diner receipt, US date with AM/PM time, a '(2 @2.95)' multiplier notation | ❌ | ✅ | ✅ |
| 50 | `real-22-blank-total-field-curl` | Real phone photo, curled/curved credit-card slip photographed on a white envelope with shadow, 'Tip' and 'Total' lines printed but left BLANK for the customer to fill in — only 'AMOUNT' is printed | ⬜ | ❌ | ✅ |
| 51 | `real-23-handwritten-total-override` | Real phone photo, US sushi restaurant receipt, printed itemised total, PLUS a handwritten total ('153.71') pen-written over/near the printed total ($143.71) — apparently a tip-adjusted figure added by hand | ❌ | ✅ | ✅ |
| 52 | `real-24-yauatcha-no-date` | Real phone photo on a dark wood table, upscale restaurant (Honolulu, HI), 8 items, no date visible anywhere in the visible receipt body | — | ❌ | ✅ |
| 53 | `real-25-boa-dark-background` | Real phone photo against a near-black tablecloth (low background/receipt contrast in the photo, though the print itself is clean), suggested-gratuity lines below the total | ⬜ | ❌ | ❌ |
| 54 | `real-26-friendly-reds-clean` | Real phone photo, clean US restaurant receipt, '(2 @14.00)' multiplier notation, unambiguous US date | ✅ | ❌ | ✅ |
| 55 | `real-27-pappadeaux-ambiguous-us-date` | Real phone photo, US restaurant receipt (Houston, TX), date printed as '01/07/17' — both components <=12, genuinely ambiguous without locale context | ❌ | ❌ | ❌ |
| 56 | `real-28-carls-jr-translucent-bleed` | Real phone photo, thin/translucent thermal paper on a reflective wood table — a promotional background pattern printed on the paper's reverse bleeds through faintly behind the text, several $0.00 combo-modifier lines | ✅ | ✅ | ❌ |
| 57 | `real-29-saska-paperclip-clipboard` | Real phone photo, receipt held to a wooden clipboard by a large metal binder clip whose reflective wire partially crosses the header text, US date, suggested-tip lines | ✅ | ✅ | ✅ |
| 58 | `real-30-wings-things-over-menu-crumple` | Real phone photo, crumpled receipt resting on top of a bright yellow/red takeout menu (cluttered, high-contrast background bleeding into the frame around the receipt edges), no date visible in the photographed portion | — | ✅ | ❌ |
| 59 | `real-31-lan-sheng-item-price-column-shift` | Real phone photo on a fabric tablecloth, US Chinese restaurant receipt, 6 items where one line ('White Rice (S)') has no price printed in its row and the subtotal does not cleanly reconcile against the visibly legible per-item prices | ✅ | ✅ | ❌ |
| 60 | `real-32-mynews-handwritten-margin` | Real phone photo, Malaysian convenience-store tax invoice, a handwritten alphanumeric code ('A03115') pen-written in the top-right margin (unrelated to the transaction), GST columns | ✅ | ✅ | ✅ |
| 61 | `real-33-mcdonalds-my-combo-submenu` | Real phone photo, clean scan-quality Malaysian McDonald's receipt, a combo-meal line with indented sub-components (Coke, Fries) printed with no individual price of their own | ✅ | ❌ | ✅ |
| 62 | `real-34-parking-ticket-stamped-redacted` | Real phone photo, Malaysian parking-garage tax invoice (not a merchandise receipt), a black circular redaction mark over part of the GST ID, a 'POSTED' rubber stamp printed diagonally across the fee amount, entry/paid timestamps rather than a single transaction time | ❌ | ❌ | ✅ |
| 63 | `real-35-kings-confectionery-discount-column` | Real phone photo, Malaysian bakery tax invoice, Code/Description/Qty/Price/Discount%/Amount column layout, one item carries a 30% line-level discount already applied to its Amount | ✅ | ✅ | ❌ |
| 64 | `real-36-mrdiy-multiline-item-layout` | Real phone photo, Malaysian hardware-store tax invoice, each item spans THREE printed lines (name, size/SKU code line, then quantity x unit-price = amount on a separate line) rather than one line per item | ✅ | ✅ | ✅ |
| 65 | `real-37-gardenia-torn-multi-subtotal` | Real phone photo, top-left corner of the receipt physically torn off, a small paper/sticker patch obscuring part of one line, TWO separate zero-rated and standard-rated subtotals before the final Total Payable | ❌ | ✅ | ✅ |
| 66 | `real-38-super-seven-dot-noise-duplicate-lines` | Real phone photo, scattered small dark speckle/dot noise across the whole image (dust or a dirty lens), a duplicate item line (same SKU/product printed twice, two separate purchases of the same item), a handwritten total ('18.30') and checkmarks added over the printed Net Total | ✅ | ✅ | ✅ |
| 67 | `real-39-sanyu-stationery-clean` | Real phone photo, clean Malaysian stationery-shop tax invoice, a single SKU line with an inline '3 x 2.9000' quantity/unit-price notation, faint decorative background pattern printed on the paper itself | ✅ | ✅ | ✅ |
| 68 | `real-40-portugalia-euro-redaction-dots` | Real phone photo, Portuguese restaurant receipt (Lisbon), Euro currency, ISO date-time already printed, hand-applied black circular redaction dots over the customer tax-ID and part of the payment-method breakdown, a two-tier IVA(VAT)-rate breakdown table | ⬜ | ❌ | ❌ |
| 69 | `real-41-caravela-simple-euro` | Real phone photo, Portuguese shopping-mall food-court receipt, single item, Euro, ISO date already printed | ⬜ | ❌ | ⬜ |
| 70 | `real-42-fuel-pump-receipt-redaction` | Real phone photo, Portuguese fuel-pump receipt (not a merchandise purchase — litres of diesel at a per-litre rate), a black circular redaction mark over part of the total, an IVA/net breakdown table | ⬜ | ❌ | ⬜ |
| 71 | `real-43-pollux-torn-skew-barcode` | Real phone photo, long Portuguese invoice photographed at a skewed angle, a black circular redaction dot over part of the quantity/description column, a printed barcode near the footer, single low-value item | ⬜ | ❌ | ❌ |
| 72 | `real-44-oriente-perfeito-handwritten-note` | Real phone photo, Portuguese small-business invoice, a handwritten note ('#788 Rueb') pen-written in the right margin next to the vendor block — unrelated to the transaction, does not overlap any printed field | ⬜ | ❌ | ❌ |
| 73 | `real-45-sticker-obstruction-cropped-vendor` | Real phone photo, an orange adhesive tab/sticker (unrelated object) overlapping the top-left corner of the frame, the issuing vendor's own name is above the top edge of the photographed area (only the recipient/client block is visible), a black redaction dot over part of a payment line | — | — | ✅ |

✅ correct · ❌ wrong value returned · ⬜ nothing extracted · — not applicable (not present in image)

## Every failure, with what was returned instead

### `real-03-ph-sales-invoice`

*Real phone photo, PH thermal SALES INVOICE, 8 items with a quantity column and per-item unit prices on a wrapped second line, a discount line, and two emoji stickers overlaid on one item row by whoever shared it*

| Field | Expected | Got | |
|---|---|---|---|
| amount | `2180` | `2185` | ❌ |

### `real-04-cropped-vendor-glare`

*Real phone photo, Indonesian drink-stall thermal receipt, header block blurred/illegible, single item, tight crop*

| Field | Expected | Got | |
|---|---|---|---|
| amount | `6000` | `6.6` | ❌ |

### `real-05-bintang-juice-camscan-watermark`

*Real phone photo scanned through the CamScanner app (adds a small logo + 'Scanned with CamScanner' watermark, bottom-left), Indonesian juice stall, otherwise clear print*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2019-08-01"` | `null` | ⬜ |
| vendor | `"BINTANG JUICE"` | `"BINT ANG"` | ❌ |
| amount | `20000` | `null` | ⬜ |

### `real-06-severe-blur-curled-thermal`

*Real phone photo, curled/perforated thermal receipt edge, out-of-focus capture, black background*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2017-11-24"` | `null` | ⬜ |
| amount | `22000` | `null` | ⬜ |

### `real-07-glare-finger-obstruction`

*Real phone photo, strong glare plus the photographer's own thumb partially covering the lower-right corner, single item, bakery chain receipt*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"TOUS LES JOURS"` | `"CHANGE 67,500"` | ❌ |
| amount | `32500` | `null` | ⬜ |

### `real-08-diagonal-watermark-blur`

*Real phone photo, blurred header, a repeating diagonal text watermark ('D'crepes') overlaid across the whole frame by whoever shared the photo — distinct from the receipt's own printed content*

| Field | Expected | Got | |
|---|---|---|---|
| amount | `24000` | `null` | ⬜ |

### `real-09-severe-blur-duplicate-items`

*Real phone photo, severe blur, vendor and every administrative line illegible, TWO separate identical-item order lines (not a quantity of 2 on one line)*

| Field | Expected | Got | |
|---|---|---|---|
| amount | `138600` | `null` | ⬜ |

### `real-10-chopstick-obstruction-crumple`

*Real phone photo on a wood-grain table, wooden chopsticks and a pink napkin partially resting on/behind the receipt, blurred header, single abbreviated item name*

| Field | Expected | Got | |
|---|---|---|---|
| amount | `53999` | `null` | ⬜ |

### `real-12-long-13-item-blurry-header`

*Real phone photo, long 13-line itemised restaurant receipt with small print, header fully blurred, some leading quantity digits at the left margin partly cut off*

| Field | Expected | Got | |
|---|---|---|---|
| amount | `1802900` | `150` | ❌ |

### `real-13-blur-vendor-two-item`

*Real phone photo, blurred café/bakery header, two items, service charge + tax lines*

| Field | Expected | Got | |
|---|---|---|---|
| amount | `159638` | `null` | ⬜ |

### `real-14-lamp-glare-discount-multiplier`

*Real phone photo taken under a warm lamp with strong glare and a pixelated/redacted-looking header, one item with a '2x' multiplier prefix AND a 30% discount line reducing it*

| Field | Expected | Got | |
|---|---|---|---|
| amount | `12600` | `null` | ⬜ |

### `real-15-ikea-uk-dd-mm-date`

*Real phone photo, IKEA Food UK receipt, clean print, GBP, DD/MM/YYYY date format*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2016-04-06"` | `null` | ⬜ |

### `real-16-new-china-us-date`

*Real phone photo, US restaurant receipt (Mesa, AZ), MM-DD-YYYY date format, clean print*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2016-03-12"` | `"2016-12-03"` | ❌ |

### `real-17-decorative-banner-wood-table`

*Real phone photo on a dark wood table, upscale restaurant receipt (Dublin, Ireland), unambiguous month-name date, no decorative banner but tight crop*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2019-02-16"` | `null` | ⬜ |
| vendor | `"Marco Pierre White Steakhouse & Grill"` | `"Rercmicraita totoman ke"` | ❌ |

### `real-18-via-emilia-clean`

*Real phone photo, clean US restaurant receipt (Miami Beach, FL), month-name date, an order-tracking URL/code line*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2017-04-27"` | `null` | ⬜ |

### `real-19-togo-banner-asterisks`

*Real phone photo, decorative asterisk banner ('*** TO GO ***') above the vendor block, US date, unambiguous*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2018-12-31"` | `null` | ⬜ |
| amount | `58.3` | `17` | ❌ |

### `real-20-cluttered-menu-background-tilt`

*Real phone photo, receipt photographed resting on top of a restaurant menu (cluttered background text behind/around it), slight tilt, US date*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2014-08-30"` | `null` | ⬜ |
| vendor | `"Fuzzy's Taco Shop"` | `"Can seas § Soft Drink in"` | ❌ |
| amount | `12.03` | `null` | ⬜ |

### `real-21-jts-diner-clean`

*Real phone photo, clean US diner receipt, US date with AM/PM time, a '(2 @2.95)' multiplier notation*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2016-02-12"` | `"2016-12-02"` | ❌ |

### `real-22-blank-total-field-curl`

*Real phone photo, curled/curved credit-card slip photographed on a white envelope with shadow, 'Tip' and 'Total' lines printed but left BLANK for the customer to fill in — only 'AMOUNT' is printed*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2017-06-05"` | `null` | ⬜ |
| vendor | `"Hedleys"` | `"| WEST HOLLYWOOD CA 9006"` | ❌ |

### `real-23-handwritten-total-override`

*Real phone photo, US sushi restaurant receipt, printed itemised total, PLUS a handwritten total ('153.71') pen-written over/near the printed total ($143.71) — apparently a tip-adjusted figure added by hand*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2018-05-11"` | `"2018-11-05"` | ❌ |

### `real-24-yauatcha-no-date`

*Real phone photo on a dark wood table, upscale restaurant (Honolulu, HI), 8 items, no date visible anywhere in the visible receipt body*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"YAUATCHA"` | `"2 International Market Place"` | ❌ |

### `real-25-boa-dark-background`

*Real phone photo against a near-black tablecloth (low background/receipt contrast in the photo, though the print itself is clean), suggested-gratuity lines below the total*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2017-12-20"` | `null` | ⬜ |
| vendor | `"BOA"` | `"Separate checks: 1-of-3"` | ❌ |
| amount | `47.09` | `43` | ❌ |

### `real-26-friendly-reds-clean`

*Real phone photo, clean US restaurant receipt, '(2 @14.00)' multiplier notation, unambiguous US date*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"Friendly Red's of Windham"` | `"23 Friendly Red's"` | ❌ |

### `real-27-pappadeaux-ambiguous-us-date`

*Real phone photo, US restaurant receipt (Houston, TX), date printed as '01/07/17' — both components <=12, genuinely ambiguous without locale context*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2017-01-07"` | `"2017-07-01"` | ❌ |
| vendor | `"Pappadeaux Seafood Kitchen"` | `"P SEAFOOD KITCHEN X"` | ❌ |
| amount | `42.16` | `38.95` | ❌ |

### `real-28-carls-jr-translucent-bleed`

*Real phone photo, thin/translucent thermal paper on a reflective wood table — a promotional background pattern printed on the paper's reverse bleeds through faintly behind the text, several $0.00 combo-modifier lines*

| Field | Expected | Got | |
|---|---|---|---|
| amount | `7.61` | `1.61` | ❌ |

### `real-30-wings-things-over-menu-crumple`

*Real phone photo, crumpled receipt resting on top of a bright yellow/red takeout menu (cluttered, high-contrast background bleeding into the frame around the receipt edges), no date visible in the photographed portion*

| Field | Expected | Got | |
|---|---|---|---|
| amount | `30.58` | `6.99` | ❌ |

### `real-31-lan-sheng-item-price-column-shift`

*Real phone photo on a fabric tablecloth, US Chinese restaurant receipt, 6 items where one line ('White Rice (S)') has no price printed in its row and the subtotal does not cleanly reconcile against the visibly legible per-item prices*

| Field | Expected | Got | |
|---|---|---|---|
| amount | `75.15` | `973.77` | ❌ |

### `real-33-mcdonalds-my-combo-submenu`

*Real phone photo, clean scan-quality Malaysian McDonald's receipt, a combo-meal line with indented sub-components (Coke, Fries) printed with no individual price of their own*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"McDonald's"` | `"Gerbang Alaf Restaurants Sdn Bhd"` | ❌ |

### `real-34-parking-ticket-stamped-redacted`

*Real phone photo, Malaysian parking-garage tax invoice (not a merchandise receipt), a black circular redaction mark over part of the GST ID, a 'POSTED' rubber stamp printed diagonally across the fee amount, entry/paid timestamps rather than a single transaction time*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2017-04-30"` | `"2017-08-30"` | ❌ |
| vendor | `"Amano Malaysia Sdn Bhd"` | `"TEMASYA INDUSTRIAL PARK"` | ❌ |

### `real-35-kings-confectionery-discount-column`

*Real phone photo, Malaysian bakery tax invoice, Code/Description/Qty/Price/Discount%/Amount column layout, one item carries a 30% line-level discount already applied to its Amount*

| Field | Expected | Got | |
|---|---|---|---|
| amount | `25.15` | `29.15` | ❌ |

### `real-37-gardenia-torn-multi-subtotal`

*Real phone photo, top-left corner of the receipt physically torn off, a small paper/sticker patch obscuring part of one line, TWO separate zero-rated and standard-rated subtotals before the final Total Payable*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2017-09-22"` | `"201-09-22"` | ❌ |

### `real-40-portugalia-euro-redaction-dots`

*Real phone photo, Portuguese restaurant receipt (Lisbon), Euro currency, ISO date-time already printed, hand-applied black circular redaction dots over the customer tax-ID and part of the payment-method breakdown, a two-tier IVA(VAT)-rate breakdown table*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2017-11-20"` | `null` | ⬜ |
| vendor | `"Portugália"` | `"Wyily Prt ya par progr ana"` | ❌ |
| amount | `54.8` | `48.07` | ❌ |

### `real-41-caravela-simple-euro`

*Real phone photo, Portuguese shopping-mall food-court receipt, single item, Euro, ISO date already printed*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2019-04-25"` | `null` | ⬜ |
| vendor | `"Caravela Alimentação, S.A"` | `"at - »aidll BU (SE IRN PRL"` | ❌ |
| amount | `6.4` | `null` | ⬜ |

### `real-42-fuel-pump-receipt-redaction`

*Real phone photo, Portuguese fuel-pump receipt (not a merchandise purchase — litres of diesel at a per-litre rate), a black circular redaction mark over part of the total, an IVA/net breakdown table*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2019-10-30"` | `null` | ⬜ |
| vendor | `"PMRP Unipessoal, Lda."` | `"be bp 11Y ET i1Geira"` | ❌ |
| amount | `40` | `null` | ⬜ |

### `real-43-pollux-torn-skew-barcode`

*Real phone photo, long Portuguese invoice photographed at a skewed angle, a black circular redaction dot over part of the quantity/description column, a printed barcode near the footer, single low-value item*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2019-10-15"` | `null` | ⬜ |
| vendor | `"Pollux Lisboa"` | `"—— potLUK | ISBUA"` | ❌ |
| amount | `4.15` | `19.1` | ❌ |

### `real-44-oriente-perfeito-handwritten-note`

*Real phone photo, Portuguese small-business invoice, a handwritten note ('#788 Rueb') pen-written in the right margin next to the vendor block — unrelated to the transaction, does not overlap any printed field*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2019-07-14"` | `null` | ⬜ |
| vendor | `"Oriente Perfeito"` | `"Entreposto Serva Bloco 1 Fracao F"` | ❌ |
| amount | `6` | `0` | ❌ |

## Corpus composition and what it does and does not prove

| Category | Count | What it tests |
|---|---|---|
| real | 45 | Genuine receipt photographs — 3 Philippine, the remaining 42 sourced from a licensed public dataset (CORD/SROIE/ExpressExpense/Zenodo, see CORPUS-ATTRIBUTION.md), independently hand-verified against the image rather than trusting that dataset's own AI-assisted annotations |
| synthetic | 19 | Parser robustness across layouts, date formats, amount formats, currency symbols, header styles |
| degraded | 9 | Synthetic receipts degraded with blur, low contrast, rotation, downscaling, darkness and JPEG artifacts |

**This corpus over-states robustness to real-world photo quality.** Only 45 of the 73 images are real photographs. The 9 degraded images are *rendered* receipts with uniform, synthetic degradation applied programmatically — real phone captures have uneven lighting, curled thermal paper, motion blur, shadows and fold creases that are not reproduced here. Tesseract handled every degraded image perfectly, which is a claim about clean-render-plus-filter, **not** about a shopkeeper photographing a crumpled receipt in a dim store.

**No handwritten receipts are included.** None were available. Handwritten *resibo* are common in sari-sari stores, and tesseract's default model is trained on printed text — accuracy on handwriting should be assumed poor until measured. This is an untested gap, not a passing case.

## Failure patterns

### 1. Ambiguous numeric dates — resolved by defaulting to DD/MM

When a date reads `11/07/2026` and both components are ≤ 12, nothing in the text can resolve it. The parser previously assumed **MM/DD** (US convention) and read that as 7 November; on the real Philippine receipt in this corpus the true date was **11 July**, so it was exactly wrong, and confidently so.

The default is now **DD/MM**, the Philippine convention and this app's target market. Date accuracy went from 95% to **100%** on this corpus. Validity still wins where only one reading is possible — `07/22/2026` is still read as 22 July, because 22 cannot be a month.

**The cost, stated plainly:** a genuinely US-format receipt is now misread instead. That trade is unavoidable without a per-profile locale setting, and it is the right way round for these users. `syn-03` in the corpus is that ambiguous case, and its ground truth is the DD/MM reading.

### 2. Vendor name printed in the footer — fixed, not eliminated

`syn-02-vendor-bottom` used to fail: tesseract read `*** SALES INVOICE ***` as `*xx GALES INVOICE ***`, and the garbled spelling slipped past the exact-phrase filter that was supposed to discard it while the asterisks stayed intact. The header decoy then outscored the real footer name, `TINDAHAN NI MANG JOSE`, on position alone. Two additive changes fixed this specific failure: decorative banner punctuation (`*`, `~`, `===`) now disqualifies a candidate line regardless of what the (possibly OCR-mangled) words inside it say, and closing boilerplate ("thank you", "come again", "salamat") is excluded the same way "SALES INVOICE" already was. `syn-02` now passes.

**This is not a general solve for footer vendors.** It closes the one reproducible failure mode in this corpus — a decorative document header beating a real name below it. A footer name competing against a *plausible, undecorated* line elsewhere on the receipt (a second business-looking phrase, an address that happens to read as words) can still lose on position; no case of that exists in this corpus to measure against. Continue treating vendor as a first draft the confirm screen may need to correct, especially on receipts this corpus does not cover.

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

5. **A footer vendor name lost to a garbled document-header banner (defect, fixed).** See failure pattern 2 above — decorative banner punctuation and closing boilerplate ('thank you, come again') are now excluded from vendor candidates regardless of OCR spelling noise, and the Filipino 'tindahan' was added alongside 'store' as a recognised business-type word.

Measured effect across all five: date accuracy 90% → **100%**, vendor accuracy 89% → **100%** on this corpus, all-three-correct 16/20 → **30/31**. Every fix is pinned by regression tests in `tests/unit/ocrParsing.test.ts`.

## Bottom line

Once the corpus stopped being 90% clean renders, the headline numbers dropped hard: date 67%, vendor 73%, amount 67% overall (see "Results by image category" above for the real-only breakdown, which is materially lower than the synthetic/degraded rows). Synthetic and degraded images still score ~100% — that number was never wrong, it was just describing a narrow slice of conditions (clean renders, and uniform programmatic degradation of clean renders) that most real phone photos of a crumpled or glare-lit thermal receipt do not resemble. **The corpus was the thing hiding the gap, not the parser being newly broken.**

This is not read as "the parser regressed" — nothing in `ocr.service.ts` changed between the 31-image and 73-image runs. It is read as "the 31-image number was measuring the wrong thing." See the failure taxonomy in the plan/PR notes for this corpus-expansion pass for the specific, evidenced categories behind these numbers (blur/glare/obstruction, non-PH date locales, vendor-in-footer-or-cropped, unreconciled real subtotals, and more) — that taxonomy, not this summary paragraph, is the actionable input for Phase 3 fixes.

The design already assumes OCR will be wrong sometimes: every scan lands on a confirm screen as an editable draft and nothing is saved until the owner accepts it. That safety net matters more, not less, in light of these numbers.

