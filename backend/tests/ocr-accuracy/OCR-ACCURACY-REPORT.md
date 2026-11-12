# FinSight OCR Accuracy Assessment

Generated: 2026-11-12

Corpus: **122 receipt images**. Pipeline under test: `extractText()` (tesseract.js) followed by `parseReceiptFields()` and `parseLineItems()` — the same functions the receipt-scan endpoint calls.

A field is **correct** only on an exact match (amounts to the centavo, dates to the day). Vendor matching tolerates light OCR character noise but not a wrong line.

## Headline results

| Field | Correct | Wrong | Not extracted | Scored | Accuracy |
|---|---|---|---|---|---|
| Date | 52 | 15 | 34 | 101 | **51%** |
| Vendor | 52 | 57 | 0 | 109 | **48%** |
| Amount | 72 | 28 | 22 | 122 | **59%** |

All three fields correct on the same receipt: **42 of 122** (34%).

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
| real (earlier public-dataset photos) | 45 | 39% | 59% | 60% |
| real-ph (Philippine phone photos, single AI review, 800 px) | 49 | 28% | 10% | 35% |
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
| 32 | `real-04-cropped-vendor-glare` | Real phone photo, Indonesian drink-stall thermal receipt, header block blurred/illegible, single item, tight crop | — | — | ⬜ |
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
| 50 | `real-22-blank-total-field-curl` | Real phone photo, curled/curved credit-card slip photographed on a white envelope with shadow, 'Tip' and 'Total' lines printed but left BLANK for the customer to fill in — only 'AMOUNT' is printed | ⬜ | ✅ | ✅ |
| 51 | `real-23-handwritten-total-override` | Real phone photo, US sushi restaurant receipt, printed itemised total, PLUS a handwritten total ('153.71') pen-written over/near the printed total ($143.71) — apparently a tip-adjusted figure added by hand | ❌ | ✅ | ✅ |
| 52 | `real-24-yauatcha-no-date` | Real phone photo on a dark wood table, upscale restaurant (Honolulu, HI), 8 items, no date visible anywhere in the visible receipt body | — | ✅ | ✅ |
| 53 | `real-25-boa-dark-background` | Real phone photo against a near-black tablecloth (low background/receipt contrast in the photo, though the print itself is clean), suggested-gratuity lines below the total | ⬜ | ✅ | ✅ |
| 54 | `real-26-friendly-reds-clean` | Real phone photo, clean US restaurant receipt, '(2 @14.00)' multiplier notation, unambiguous US date | ✅ | ❌ | ✅ |
| 55 | `real-27-pappadeaux-ambiguous-us-date` | Real phone photo, US restaurant receipt (Houston, TX), date printed as '01/07/17' — both components <=12, genuinely ambiguous without locale context | ❌ | ❌ | ✅ |
| 56 | `real-28-carls-jr-translucent-bleed` | Real phone photo, thin/translucent thermal paper on a reflective wood table — a promotional background pattern printed on the paper's reverse bleeds through faintly behind the text, several $0.00 combo-modifier lines | ✅ | ✅ | ❌ |
| 57 | `real-29-saska-paperclip-clipboard` | Real phone photo, receipt held to a wooden clipboard by a large metal binder clip whose reflective wire partially crosses the header text, US date, suggested-tip lines | ✅ | ✅ | ✅ |
| 58 | `real-30-wings-things-over-menu-crumple` | Real phone photo, crumpled receipt resting on top of a bright yellow/red takeout menu (cluttered, high-contrast background bleeding into the frame around the receipt edges), no date visible in the photographed portion | — | ✅ | ❌ |
| 59 | `real-31-lan-sheng-item-price-column-shift` | Real phone photo on a fabric tablecloth, US Chinese restaurant receipt, 6 items where one line ('White Rice (S)') has no price printed in its row and the subtotal does not cleanly reconcile against the visibly legible per-item prices | ✅ | ✅ | ❌ |
| 60 | `real-32-mynews-handwritten-margin` | Real phone photo, Malaysian convenience-store tax invoice, a handwritten alphanumeric code ('A03115') pen-written in the top-right margin (unrelated to the transaction), GST columns | ✅ | ✅ | ✅ |
| 61 | `real-33-mcdonalds-my-combo-submenu` | Real phone photo, clean scan-quality Malaysian McDonald's receipt, a combo-meal line with indented sub-components (Coke, Fries) printed with no individual price of their own | ✅ | ❌ | ✅ |
| 62 | `real-34-parking-ticket-stamped-redacted` | Real phone photo, Malaysian parking-garage tax invoice (not a merchandise receipt), a black circular redaction mark over part of the GST ID, a 'POSTED' rubber stamp printed diagonally across the fee amount, entry/paid timestamps rather than a single transaction time | ❌ | ❌ | ✅ |
| 63 | `real-35-kings-confectionery-discount-column` | Real phone photo, Malaysian bakery tax invoice, Code/Description/Qty/Price/Discount%/Amount column layout, one item carries a 30% line-level discount already applied to its Amount | ✅ | ✅ | ✅ |
| 64 | `real-36-mrdiy-multiline-item-layout` | Real phone photo, Malaysian hardware-store tax invoice, each item spans THREE printed lines (name, size/SKU code line, then quantity x unit-price = amount on a separate line) rather than one line per item | ✅ | ✅ | ✅ |
| 65 | `real-37-gardenia-torn-multi-subtotal` | Real phone photo, top-left corner of the receipt physically torn off, a small paper/sticker patch obscuring part of one line, TWO separate zero-rated and standard-rated subtotals before the final Total Payable | ❌ | ✅ | ✅ |
| 66 | `real-38-super-seven-dot-noise-duplicate-lines` | Real phone photo, scattered small dark speckle/dot noise across the whole image (dust or a dirty lens), a duplicate item line (same SKU/product printed twice, two separate purchases of the same item), a handwritten total ('18.30') and checkmarks added over the printed Net Total | ✅ | ✅ | ✅ |
| 67 | `real-39-sanyu-stationery-clean` | Real phone photo, clean Malaysian stationery-shop tax invoice, a single SKU line with an inline '3 x 2.9000' quantity/unit-price notation, faint decorative background pattern printed on the paper itself | ✅ | ✅ | ✅ |
| 68 | `real-40-portugalia-euro-redaction-dots` | Real phone photo, Portuguese restaurant receipt (Lisbon), Euro currency, ISO date-time already printed, hand-applied black circular redaction dots over the customer tax-ID and part of the payment-method breakdown, a two-tier IVA(VAT)-rate breakdown table | ⬜ | ❌ | ❌ |
| 69 | `real-41-caravela-simple-euro` | Real phone photo, Portuguese shopping-mall food-court receipt, single item, Euro, ISO date already printed | ⬜ | ❌ | ⬜ |
| 70 | `real-42-fuel-pump-receipt-redaction` | Real phone photo, Portuguese fuel-pump receipt (not a merchandise purchase — litres of diesel at a per-litre rate), a black circular redaction mark over part of the total, an IVA/net breakdown table | ⬜ | ❌ | ✅ |
| 71 | `real-43-pollux-torn-skew-barcode` | Real phone photo, long Portuguese invoice photographed at a skewed angle, a black circular redaction dot over part of the quantity/description column, a printed barcode near the footer, single low-value item | ⬜ | ❌ | ✅ |
| 72 | `real-44-oriente-perfeito-handwritten-note` | Real phone photo, Portuguese small-business invoice, a handwritten note ('#788 Rueb') pen-written in the right margin next to the vendor block — unrelated to the transaction, does not overlap any printed field | ⬜ | ❌ | ✅ |
| 73 | `real-45-sticker-obstruction-cropped-vendor` | Real phone photo, an orange adhesive tab/sticker (unrelated object) overlapping the top-left corner of the frame, the issuing vendor's own name is above the top edge of the photographed area (only the recipient/client block is visible), a black redaction dot over part of a payment line | — | — | ✅ |
| 74 | `real-ph-rf-01-02` | Phone photo of a thermal receipt, Jollibee franchise, handwritten marks top right, slight tilt. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ⬜ |
| 75 | `real-ph-rf-02-07` | Phone photo of a thermal receipt, text logo header, slight fold. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ⬜ |
| 76 | `real-ph-rf-03-13` | Phone photo of a thermal receipt, faint print, date printed as 29JUL2024. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ⬜ |
| 77 | `real-ph-rf-04-19` | Phone photo of a thermal receipt, clean, ISO date. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ❌ |
| 78 | `real-ph-rf-05-camscanner-07-07-2024-23` | CamScanner flatbed-style scan, white background, high contrast, Wendy's, MM/DD date; same paper as ph-rf-29. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ❌ |
| 79 | `real-ph-rf-06-camscanner-07-07-2024-23` | CamScanner flatbed-style scan, white background, high contrast, Panda Express, TAX INVOICE banner above the name; same paper as ph-rf-23. Downscaled to 800 px tall by the dataset export. | ❌ | ❌ | ✅ |
| 80 | `real-ph-rf-07-camscanner-07-07-2024-23` | CamScanner flatbed-style scan, white background, high contrast, Wendy's; same paper as ph-rf-31. Downscaled to 800 px tall by the dataset export. | ✅ | ❌ | ✅ |
| 81 | `real-ph-rf-08-camscanner-07-07-2024-23` | CamScanner flatbed-style scan, white background, high contrast, MM/DD date. Downscaled to 800 px tall by the dataset export. | ❌ | ❌ | ✅ |
| 82 | `real-ph-rf-09-camscanner-07-07-2024-23` | CamScanner flatbed-style scan, white background, high contrast, Wendy's. Downscaled to 800 px tall by the dataset export. | ✅ | ❌ | ✅ |
| 83 | `real-ph-rf-10-camscanner-07-07-2024-23` | CamScanner flatbed-style scan, white background, high contrast, Wendy's; same paper as ph-rf-21 and ph-rf-30. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ❌ |
| 84 | `real-ph-rf-11-camscanner-07-07-2024-23` | CamScanner flatbed-style scan, white background, high contrast, date line below the crop; same paper as ph-rf-40. Downscaled to 800 px tall by the dataset export. | — | ✅ | ✅ |
| 85 | `real-ph-rf-12-camscanner-07-07-2024-23` | CamScanner flatbed-style scan, white background, high contrast, single item. Downscaled to 800 px tall by the dataset export. | — | ❌ | ✅ |
| 86 | `real-ph-rf-13-camscanner-07-07-2024-23` | CamScanner flatbed-style scan, white background, high contrast, clothing store, DD/MM date (31/01/2024), customer and card details printed. Downscaled to 800 px tall by the dataset export. | ❌ | ❌ | ✅ |
| 87 | `real-ph-rf-14-img-20240616-032703` | Phone photo of a thermal receipt, header cut at the left edge, MM-DD-YY date at the bottom. Downscaled to 800 px tall by the dataset export. | ✅ | ❌ | ✅ |
| 88 | `real-ph-rf-15-img-20240616-033147` | Phone photo of a thermal receipt, heavily faded fuel receipt, low contrast, logo header. Downscaled to 800 px tall by the dataset export. | — | ❌ | ⬜ |
| 89 | `real-ph-rf-16-img-20240616-033229` | Phone photo of a thermal receipt, crumpled, bent across the total. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ❌ |
| 90 | `real-ph-rf-17-img-20240616-034047` | Phone photo of a thermal receipt, debit card payment, MM-DD-YY date at the bottom. Downscaled to 800 px tall by the dataset export. | ❌ | ❌ | ❌ |
| 91 | `real-ph-rf-18-storage-emulated-0-dcim` | Phone photo of a thermal receipt, rotated 90 degrees, heavily crumpled, McDonald's. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ⬜ |
| 92 | `real-ph-rf-19-img-20240706-204424` | Phone photo of a thermal receipt, clean, MM/DD/YY date. Downscaled to 800 px tall by the dataset export. | ✅ | ❌ | ⬜ |
| 93 | `real-ph-rf-20-img-20240706-204827` | Phone photo of a thermal receipt, Wendy's, dim lighting. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ❌ |
| 94 | `real-ph-rf-21-img-20240706-204911` | Phone photo of a thermal receipt, Wendy's, dim, slight curl; same paper as ph-rf-10. Downscaled to 800 px tall by the dataset export. | ✅ | ❌ | ❌ |
| 95 | `real-ph-rf-22-img-20240706-204955` | Phone photo of a thermal receipt, Wendy's, GCash payment. Downscaled to 800 px tall by the dataset export. | ✅ | ❌ | ❌ |
| 96 | `real-ph-rf-23-img-20240706-205109` | Phone photo of a thermal receipt, rotated 90 degrees, Panda Express; same paper as ph-rf-06. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ⬜ |
| 97 | `real-ph-rf-24-img-20240706-205335` | Phone photo of a thermal receipt, clean, MM/DD date with time. Downscaled to 800 px tall by the dataset export. | ✅ | ❌ | ✅ |
| 98 | `real-ph-rf-25-img-20240706-205715` | Phone photo of a thermal receipt, rotated 90 degrees, restaurant with service charge, many items. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ⬜ |
| 99 | `real-ph-rf-26-img-20240706-233645` | Phone photo of a thermal receipt, Jollibee, dark background, handwritten number, ISO date. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ❌ |
| 100 | `real-ph-rf-27-img-20240706-233901` | Phone photo of a thermal receipt, dark background, date near the bottom. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ✅ |
| 101 | `real-ph-rf-28-img-20240706-234012` | Phone photo of a thermal receipt, Panda Express, TAX INVOICE banner, bottom cut. Downscaled to 800 px tall by the dataset export. | ❌ | ❌ | ✅ |
| 102 | `real-ph-rf-29-img-20240706-234532` | Phone photo of a thermal receipt, Wendy's, small in frame on a dark background; same paper as ph-rf-05. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ❌ |
| 103 | `real-ph-rf-30-img-20240706-234647` | Phone photo of a thermal receipt, Wendy's, small in frame; same paper as ph-rf-10. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ❌ |
| 104 | `real-ph-rf-31-img-20240706-234913` | Phone photo of a thermal receipt, Wendy's, tilted; same paper as ph-rf-07. Downscaled to 800 px tall by the dataset export. | ✅ | ✅ | ❌ |
| 105 | `real-ph-rf-32-img-20240707-002102` | Phone photo of a thermal receipt, ink stamp across the header, discount lines, card payment. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ❌ |
| 106 | `real-ph-rf-33-img-20240707-002809` | Phone photo of a thermal receipt, faint print, text logo. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ❌ |
| 107 | `real-ph-rf-34-img-20240707-002918` | Phone photo of a thermal receipt, clean, text logo. Downscaled to 800 px tall by the dataset export. | ❌ | ❌ | ✅ |
| 108 | `real-ph-rf-35-img-20240707-081542` | Phone photo of a thermal receipt, McDonald's, slight crumple, order-number banner above the name. Downscaled to 800 px tall by the dataset export. | ✅ | ✅ | ❌ |
| 109 | `real-ph-rf-36-img-20240707-081701` | Phone photo of a thermal receipt, McDonald's, heavily crumpled, faint lower half; same paper as ph-rf-18. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ❌ |
| 110 | `real-ph-rf-37-img-20240707-081901` | Phone photo of a thermal receipt, dot-matrix print, faded header, MM/DD/YY date. Downscaled to 800 px tall by the dataset export. | ❌ | ❌ | ❌ |
| 111 | `real-ph-rf-38-img-20240707-082642` | Phone photo of a thermal receipt, crumpled, bottom cut before the date. Downscaled to 800 px tall by the dataset export. | — | ✅ | ✅ |
| 112 | `real-ph-rf-39-img-20240707-110605` | Phone photo of a thermal receipt, clean, struck-through handwritten cash figures. Downscaled to 800 px tall by the dataset export. | ✅ | ❌ | ⬜ |
| 113 | `real-ph-rf-40-img-20240707-111613` | Phone photo of a thermal receipt, flat and clean; same paper as ph-rf-11. Downscaled to 800 px tall by the dataset export. | — | ❌ | ✅ |
| 114 | `real-ph-rf-41-img-20240707-111647` | Phone photo of a thermal receipt, flat and clean, single item. Downscaled to 800 px tall by the dataset export. | — | ❌ | ✅ |
| 115 | `real-ph-rf-42-img-20240707-112117` | Phone photo of a thermal receipt, text logo, faint, date cut at the bottom edge. Downscaled to 800 px tall by the dataset export. | — | ❌ | ❌ |
| 116 | `real-ph-rf-43-img-20240707-123525` | Phone photo of a thermal receipt, mobile-load purchase, faint. Downscaled to 800 px tall by the dataset export. | — | ✅ | ✅ |
| 117 | `real-ph-rf-44-img-20240707-123635` | Phone photo of a thermal receipt, 'SECOND RECEIPT', points redeemed, small in frame. Downscaled to 800 px tall by the dataset export. | — | ❌ | ❌ |
| 118 | `real-ph-rf-46-img-20240707-124504` | Phone photo of a thermal receipt, Robinsons-run supermarket, card payment, MM/DD date. Downscaled to 800 px tall by the dataset export. | ❌ | ❌ | ✅ |
| 119 | `real-ph-rf-47-img-20240707-124604` | Phone photo of a thermal receipt, logo header, MM/DD date. Downscaled to 800 px tall by the dataset export. | ❌ | ❌ | ⬜ |
| 120 | `real-ph-rf-48-img-20240707-124658` | Phone photo of a thermal receipt, GCash top-up acknowledgement receipt, high contrast. Downscaled to 800 px tall by the dataset export. | ✅ | ❌ | ❌ |
| 121 | `real-ph-rf-49-img-20240707-124737` | Phone photo of a thermal receipt, small in frame on a dark background. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ⬜ |
| 122 | `real-ph-rf-50-img-20240707-124832` | Phone photo of a thermal receipt, weighed items, card payment, small in frame. Downscaled to 800 px tall by the dataset export. | ⬜ | ❌ | ❌ |

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
| amount | `6000` | `null` | ⬜ |

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
| amount | `1802900` | `215` | ❌ |

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

### `real-23-handwritten-total-override`

*Real phone photo, US sushi restaurant receipt, printed itemised total, PLUS a handwritten total ('153.71') pen-written over/near the printed total ($143.71) — apparently a tip-adjusted figure added by hand*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2018-05-11"` | `"2018-11-05"` | ❌ |

### `real-25-boa-dark-background`

*Real phone photo against a near-black tablecloth (low background/receipt contrast in the photo, though the print itself is clean), suggested-gratuity lines below the total*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2017-12-20"` | `null` | ⬜ |

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
| amount | `75.15` | `18.95` | ❌ |

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
| amount | `54.8` | `164.5` | ❌ |

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

### `real-43-pollux-torn-skew-barcode`

*Real phone photo, long Portuguese invoice photographed at a skewed angle, a black circular redaction dot over part of the quantity/description column, a printed barcode near the footer, single low-value item*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2019-10-15"` | `null` | ⬜ |
| vendor | `"Pollux Lisboa"` | `"—— potLUK | ISBUA"` | ❌ |

### `real-44-oriente-perfeito-handwritten-note`

*Real phone photo, Portuguese small-business invoice, a handwritten note ('#788 Rueb') pen-written in the right margin next to the vendor block — unrelated to the transaction, does not overlap any printed field*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2019-07-14"` | `null` | ⬜ |
| vendor | `"Oriente Perfeito"` | `"Entreposto Serva Bloco 1 Fracao F"` | ❌ |

### `real-ph-rf-01-02`

*Phone photo of a thermal receipt, Jollibee franchise, handwritten marks top right, slight tilt. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-08-18"` | `null` | ⬜ |
| vendor | `"CUISINE ALA MORE INC."` | `"CUTS INE ALA more"` | ❌ |
| amount | `227` | `null` | ⬜ |

### `real-ph-rf-02-07`

*Phone photo of a thermal receipt, text logo header, slight fold. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-08-13"` | `null` | ⬜ |
| vendor | `"southstardrug"` | `"iodouill, 1 1T CO"` | ❌ |
| amount | `608` | `null` | ⬜ |

### `real-ph-rf-03-13`

*Phone photo of a thermal receipt, faint print, date printed as 29JUL2024. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-07-29"` | `null` | ⬜ |
| vendor | `"watsons"` | `"COA ety esse Pac. ¥"` | ❌ |
| amount | `349` | `null` | ⬜ |

### `real-ph-rf-04-19`

*Phone photo of a thermal receipt, clean, ISO date. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-07-25"` | `null` | ⬜ |
| vendor | `"Jollibee Foods Corp."` | `"ole Food Core"` | ❌ |
| amount | `322` | `162` | ❌ |

### `real-ph-rf-05-camscanner-07-07-2024-23`

*CamScanner flatbed-style scan, white background, high contrast, Wendy's, MM/DD date; same paper as ph-rf-29. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-07-06"` | `null` | ⬜ |
| vendor | `"WENPHIL CORPORATION"` | `"WENDY'S HAMBURGER RESTAURANT"` | ❌ |
| amount | `235` | `209.82` | ❌ |

### `real-ph-rf-06-camscanner-07-07-2024-23`

*CamScanner flatbed-style scan, white background, high contrast, Panda Express, TAX INVOICE banner above the name; same paper as ph-rf-23. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-07-06"` | `"2024-07-08"` | ❌ |
| vendor | `"JBPX FOODS INC."` | `"Panda Fxpros Gateway Hal 2"` | ❌ |

### `real-ph-rf-07-camscanner-07-07-2024-23`

*CamScanner flatbed-style scan, white background, high contrast, Wendy's; same paper as ph-rf-31. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"WENPHIL CORPORATION"` | `"WENDY'S HAMBURGER RESTAURANT"` | ❌ |

### `real-ph-rf-08-camscanner-07-07-2024-23`

*CamScanner flatbed-style scan, white background, high contrast, MM/DD date. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-07-03"` | `"2024-03-01"` | ❌ |
| vendor | `"KYU KYU RAMEN 99"` | `"FENPOOSS LEVEL 3 GATENAY Not FOOD"` | ❌ |

### `real-ph-rf-09-camscanner-07-07-2024-23`

*CamScanner flatbed-style scan, white background, high contrast, Wendy's. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"WENPHIL CORPORATION"` | `"WENDY'S HAMBURGER RESTAURANT"` | ❌ |

### `real-ph-rf-10-camscanner-07-07-2024-23`

*CamScanner flatbed-style scan, white background, high contrast, Wendy's; same paper as ph-rf-21 and ph-rf-30. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-07-06"` | `null` | ⬜ |
| vendor | `"WENPHIL CORPORATION"` | `"WENDY'S HAMBURGER RESTAURANT"` | ❌ |
| amount | `251` | `224.11` | ❌ |

### `real-ph-rf-12-camscanner-07-07-2024-23`

*CamScanner flatbed-style scan, white background, high contrast, single item. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"MERCURY DRUG - QC ARANETA CENTER GEN. ROMU"` | `"fieceived Merchandise in Good Condition"` | ❌ |

### `real-ph-rf-13-camscanner-07-07-2024-23`

*CamScanner flatbed-style scan, white background, high contrast, clothing store, DD/MM date (31/01/2024), customer and card details printed. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-01-31"` | `"7020-01-31"` | ❌ |
| vendor | `"Guess?"` | `"STORE CODE + 442 TRANS © 7081"` | ❌ |

### `real-ph-rf-14-img-20240616-032703`

*Phone photo of a thermal receipt, header cut at the left edge, MM-DD-YY date at the bottom. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"MERCURY DRUG - MKTI LEGASPI VLG SALCEDO"` | `"Rece1ved Merchandise In Good Condit on"` | ❌ |

### `real-ph-rf-15-img-20240616-033147`

*Phone photo of a thermal receipt, heavily faded fuel receipt, low contrast, logo header. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"PETRON"` | `"| = SY MOSES ©"` | ❌ |
| amount | `284.44` | `null` | ⬜ |

### `real-ph-rf-16-img-20240616-033229`

*Phone photo of a thermal receipt, crumpled, bent across the total. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-05-31"` | `null` | ⬜ |
| vendor | `"RED RIBBON QUIRINO HIWAY BARTOLOME"` | `"7D REGAN ATRIND | Tu gro oe"` | ❌ |
| amount | `450` | `50.1` | ❌ |

### `real-ph-rf-17-img-20240616-034047`

*Phone photo of a thermal receipt, debit card payment, MM-DD-YY date at the bottom. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-05-27"` | `"2024-05-21"` | ❌ |
| vendor | `"MERCURY DRUG - ARTC FARMERS MARKET ARCADE"` | `"#1 FIRIERS WRKET ARCADE ARANETA CENTER"` | ❌ |
| amount | `269.5` | `9.5` | ❌ |

### `real-ph-rf-18-storage-emulated-0-dcim`

*Phone photo of a thermal receipt, rotated 90 degrees, heavily crumpled, McDonald's. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-05-28"` | `null` | ⬜ |
| vendor | `"GOLDEN ARCHES DEVELOPMENT CORPORATION"` | `"ED HEPES chin =i gesiSasuinon"` | ❌ |
| amount | `89` | `null` | ⬜ |

### `real-ph-rf-19-img-20240706-204424`

*Phone photo of a thermal receipt, clean, MM/DD/YY date. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"Starbucks Coffee"` | `"OFD by: Rustan Coffee Corp."` | ❌ |
| amount | `85` | `null` | ⬜ |

### `real-ph-rf-20-img-20240706-204827`

*Phone photo of a thermal receipt, Wendy's, dim lighting. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-07-06"` | `null` | ⬜ |
| vendor | `"WENPHIL CORPORATION"` | `"WENDY'S HAMBURGER RESTAURANT"` | ❌ |
| amount | `85` | `76.89` | ❌ |

### `real-ph-rf-21-img-20240706-204911`

*Phone photo of a thermal receipt, Wendy's, dim, slight curl; same paper as ph-rf-10. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"WENPHIL CORPORATION"` | `"'s MAMBLIRGER RESTAURANT"` | ❌ |
| amount | `251` | `24.11` | ❌ |

### `real-ph-rf-22-img-20240706-204955`

*Phone photo of a thermal receipt, Wendy's, GCash payment. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"WENPHIL CORPORATION"` | `"WENDY'S HAMBURGER RESTAURANT"` | ❌ |
| amount | `398` | `98` | ❌ |

### `real-ph-rf-23-img-20240706-205109`

*Phone photo of a thermal receipt, rotated 90 degrees, Panda Express; same paper as ph-rf-06. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-07-06"` | `null` | ⬜ |
| vendor | `"JBPX FOODS INC."` | `"iE Ek in"` | ❌ |
| amount | `354` | `null` | ⬜ |

### `real-ph-rf-24-img-20240706-205335`

*Phone photo of a thermal receipt, clean, MM/DD date with time. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"BONCHON GATEWAY MALL"` | `"operated by: Scot and Food Grow"` | ❌ |

### `real-ph-rf-25-img-20240706-205715`

*Phone photo of a thermal receipt, rotated 90 degrees, restaurant with service charge, many items. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-01-22"` | `null` | ⬜ |
| vendor | `"ROTI SHOP"` | `"INA ra CET Re"` | ❌ |
| amount | `3064.25` | `null` | ⬜ |

### `real-ph-rf-26-img-20240706-233645`

*Phone photo of a thermal receipt, Jollibee, dark background, handwritten number, ISO date. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-07-05"` | `null` | ⬜ |
| vendor | `"Quest Food Corporation"` | `"STORE #044"` | ❌ |
| amount | `245` | `24` | ❌ |

### `real-ph-rf-27-img-20240706-233901`

*Phone photo of a thermal receipt, dark background, date near the bottom. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-07-06"` | `null` | ⬜ |
| vendor | `"DAVAO TUNA GRILL"` | `"Corporation"` | ❌ |

### `real-ph-rf-28-img-20240706-234012`

*Phone photo of a thermal receipt, Panda Express, TAX INVOICE banner, bottom cut. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-07-06"` | `"2024-06-11"` | ❌ |
| vendor | `"JBPX FOODS INC."` | `"Panda Express Gateuay Hal)"` | ❌ |

### `real-ph-rf-29-img-20240706-234532`

*Phone photo of a thermal receipt, Wendy's, small in frame on a dark background; same paper as ph-rf-05. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-07-06"` | `null` | ⬜ |
| vendor | `"WENPHIL CORPORATION"` | `"Bon a hoe arasanns"` | ❌ |
| amount | `235` | `1228.1` | ❌ |

### `real-ph-rf-30-img-20240706-234647`

*Phone photo of a thermal receipt, Wendy's, small in frame; same paper as ph-rf-10. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-07-06"` | `null` | ⬜ |
| vendor | `"WENPHIL CORPORATION"` | `"(GENIE TECHNOLOGIES INC"` | ❌ |
| amount | `251` | `224.11` | ❌ |

### `real-ph-rf-31-img-20240706-234913`

*Phone photo of a thermal receipt, Wendy's, tilted; same paper as ph-rf-07. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| amount | `298` | `31.93` | ❌ |

### `real-ph-rf-32-img-20240707-002102`

*Phone photo of a thermal receipt, ink stamp across the header, discount lines, card payment. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-01-31"` | `null` | ⬜ |
| vendor | `"CHARLES & KEITH"` | `"oe IE rR"` | ❌ |
| amount | `25834.3` | `2306.3` | ❌ |

### `real-ph-rf-33-img-20240707-002809`

*Phone photo of a thermal receipt, faint print, text logo. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-06-18"` | `null` | ⬜ |
| vendor | `"7-ELEVEN"` | `"VAT Exempted 0"` | ❌ |
| amount | `46` | `6` | ❌ |

### `real-ph-rf-34-img-20240707-002918`

*Phone photo of a thermal receipt, clean, text logo. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-06-26"` | `"2020-08-01"` | ❌ |
| vendor | `"7-ELEVEN"` | `"HUIPPING SLVER CORPORATION"` | ❌ |

### `real-ph-rf-35-img-20240707-081542`

*Phone photo of a thermal receipt, McDonald's, slight crumple, order-number banner above the name. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| amount | `124` | `124.8` | ❌ |

### `real-ph-rf-36-img-20240707-081701`

*Phone photo of a thermal receipt, McDonald's, heavily crumpled, faint lower half; same paper as ph-rf-18. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-05-28"` | `null` | ⬜ |
| vendor | `"GOLDEN ARCHES DEVELOPMENT CORPORATION"` | `"OLDEN ARCHES DEUSLOPHENT CORPORATION"` | ❌ |
| amount | `89` | `100.09` | ❌ |

### `real-ph-rf-37-img-20240707-081901`

*Phone photo of a thermal receipt, dot-matrix print, faded header, MM/DD/YY date. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-06-16"` | `"2025-06-16"` | ❌ |
| vendor | `"DUNKIN' DONUTS"` | `"Tam TOUT FoARe SARRARATTON"` | ❌ |
| amount | `377` | `397.9` | ❌ |

### `real-ph-rf-39-img-20240707-110605`

*Phone photo of a thermal receipt, clean, struck-through handwritten cash figures. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"Starbucks Coffee"` | `"UPD by: Rustan Cotfee Corp"` | ❌ |
| amount | `445` | `null` | ⬜ |

### `real-ph-rf-40-img-20240707-111613`

*Phone photo of a thermal receipt, flat and clean; same paper as ph-rf-11. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"MERCURY DRUG - QC ARANETA CENTER GEN. ROMU"` | `"Received Merchandise in Goo"` | ❌ |

### `real-ph-rf-41-img-20240707-111647`

*Phone photo of a thermal receipt, flat and clean, single item. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"MERCURY DRUG - ARANETA CTR FARMER'S PLAZA"` | `"Received Merchandise in Good Condition"` | ❌ |

### `real-ph-rf-42-img-20240707-112117`

*Phone photo of a thermal receipt, text logo, faint, date cut at the bottom edge. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"watsons"` | `"PRED IY FAMILYHEAL TI & BEAUTY COMP"` | ❌ |
| amount | `42.5` | `0.01` | ❌ |

### `real-ph-rf-44-img-20240707-123635`

*Phone photo of a thermal receipt, 'SECOND RECEIPT', points redeemed, small in frame. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"PUREGOLD PRICE CLUB, INC."` | `"Turrent Tan ptanill be credited ton"` | ❌ |
| amount | `3838.72` | `7.08` | ❌ |

### `real-ph-rf-46-img-20240707-124504`

*Phone photo of a thermal receipt, Robinsons-run supermarket, card payment, MM/DD date. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-01-25"` | `"2005-12-30"` | ❌ |
| vendor | `"THE MARKETPLACE"` | `"HON § SUPERMARKET CORPORATLL"` | ❌ |

### `real-ph-rf-47-img-20240707-124604`

*Phone photo of a thermal receipt, logo header, MM/DD date. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-02-01"` | `"2012-08-25"` | ❌ |
| vendor | `"Robinsons Supermarket"` | `"robs Supermarket Corporatio"` | ❌ |
| amount | `62` | `null` | ⬜ |

### `real-ph-rf-48-img-20240707-124658`

*Phone photo of a thermal receipt, GCash top-up acknowledgement receipt, high contrast. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| vendor | `"Robinsons Supermarket"` | `"fobinson's Supermarket Corporation"` | ❌ |
| amount | `3000` | `73000` | ❌ |

### `real-ph-rf-49-img-20240707-124737`

*Phone photo of a thermal receipt, small in frame on a dark background. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-07-03"` | `null` | ⬜ |
| vendor | `"Robinsons Supermarket"` | `"io anryen. mm you Salts. uate"` | ❌ |
| amount | `11` | `null` | ⬜ |

### `real-ph-rf-50-img-20240707-124832`

*Phone photo of a thermal receipt, weighed items, card payment, small in frame. Downscaled to 800 px tall by the dataset export.*

| Field | Expected | Got | |
|---|---|---|---|
| date | `"2024-02-02"` | `null` | ⬜ |
| vendor | `"Robinsons Supermarket"` | `"BINGON'S SUPERMARKET CORPCRATION"` | ❌ |
| amount | `511.34` | `15.2` | ❌ |

## Corpus composition and what it does and does not prove

| Category | Count | What it tests |
|---|---|---|
| real | 94 | Genuine receipt photographs — 3 Philippine, the remaining 91 sourced from a licensed public dataset (CORD/SROIE/ExpressExpense/Zenodo, see CORPUS-ATTRIBUTION.md), independently hand-verified against the image rather than trusting that dataset's own AI-assisted annotations |
| synthetic | 19 | Parser robustness across layouts, date formats, amount formats, currency symbols, header styles |
| degraded | 9 | Synthetic receipts degraded with blur, low contrast, rotation, downscaling, darkness and JPEG artifacts |

**This corpus over-states robustness to real-world photo quality.** Only 94 of the 122 images are real photographs. The 9 degraded images are *rendered* receipts with uniform, synthetic degradation applied programmatically — real phone captures have uneven lighting, curled thermal paper, motion blur, shadows and fold creases that are not reproduced here. Tesseract handled every degraded image perfectly, which is a claim about clean-render-plus-filter, **not** about a shopkeeper photographing a crumpled receipt in a dim store.

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

Once the corpus stopped being 90% clean renders, the headline numbers dropped hard: date 51%, vendor 48%, amount 59% overall (see "Results by image category" above for the real-only breakdown, which is materially lower than the synthetic/degraded rows). Synthetic and degraded images still score ~100% — that number was never wrong, it was just describing a narrow slice of conditions (clean renders, and uniform programmatic degradation of clean renders) that most real phone photos of a crumpled or glare-lit thermal receipt do not resemble. **The corpus was the thing hiding the gap, not the parser being newly broken.**

This is not read as "the parser regressed" — nothing in `ocr.service.ts` changed between the 31-image and 73-image runs. It is read as "the 31-image number was measuring the wrong thing." See the failure taxonomy in the plan/PR notes for this corpus-expansion pass for the specific, evidenced categories behind these numbers (blur/glare/obstruction, non-PH date locales, vendor-in-footer-or-cropped, unreconciled real subtotals, and more) — that taxonomy, not this summary paragraph, is the actionable input for Phase 3 fixes.

The design already assumes OCR will be wrong sometimes: every scan lands on a confirm screen as an editable draft and nothing is saved until the owner accepts it. That safety net matters more, not less, in light of these numbers.

