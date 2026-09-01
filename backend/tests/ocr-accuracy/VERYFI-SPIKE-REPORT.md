# Veryfi extraction — measurement spike

Generated: 2026-08-31

**Nothing in this report is wired into the app.** This measures whether Veryfi's receipt-specific OCR/data-extraction API reads the fields tesseract gets wrong (date, vendor, amount) — a reference point for where the deterministic pipeline is weakest, not a candidate being integrated.

Scored by `tests/ocr-accuracy/scoring.ts`, the same rules used for the deterministic pipeline, so these figures are directly comparable to `OCR-ACCURACY-REPORT.md`.

## Results

| Field | Veryfi | Deterministic (tesseract) |
|---|---|---|
| Date | 51/53 (96%) | 30/30 (100%) |
| Vendor | 36/54 (67%) | 28/29 (97%) |
| Amount | 63/64 (98%) | 30/30 (100%) |


## Latency

| | |
|---|---|
| Images | 64 |
| Mean latency | 3231 ms |

## What this corpus cannot tell you

The same caveat that qualifies the tesseract figures qualifies these: most of this corpus is synthetic renders or programmatic degradations of them, and only a couple of images are real photographs. Read any strong Veryfi showing on the synthetic majority as weak evidence; the real photo(s) are where a genuine capability gap would actually show.

## Per-image

| Image | Kind | Date | Vendor | Amount |
|---|---|---|---|---|
| `real-02-clean-digital` | real | ✅ | ✅ | ✅ |
| `real-03-ph-sales-invoice` | real | ❌ | — | ✅ |
| `syn-01-vendor-top-iso-date` | synthetic | ✅ | ✅ | ✅ |
| `syn-02-vendor-bottom` | synthetic | ✅ | ✅ | ✅ |
| `syn-04-month-name-date` | synthetic | ✅ | ✅ | ✅ |
| `syn-05-thousands-separator` | synthetic | ✅ | ❌ | ✅ |
| `syn-06-subtotal-then-total` | synthetic | ✅ | ❌ | ✅ |
| `syn-07-no-total-keyword` | synthetic | ✅ | ✅ | ✅ |
| `syn-08-peso-sign` | synthetic | ✅ | ✅ | ✅ |
| `syn-09-two-digit-year` | synthetic | ✅ | ✅ | ✅ |
| `syn-10-dd-mm-yyyy` | synthetic | ✅ | ✅ | ✅ |
| `syn-11-long-header` | synthetic | ✅ | ❌ | ✅ |
| `syn-12-tiny-amount` | synthetic | ✅ | ✅ | ✅ |
| `syn-13-many-items` | synthetic | ✅ | ✅ | ✅ |
| `syn-14-qty-columns` | synthetic | ✅ | ✅ | ✅ |
| `syn-15-vat-flags` | synthetic | ✅ | ✅ | ✅ |
| `syn-16-multiplier-prefix` | synthetic | ✅ | ❌ | ✅ |
| `syn-17-total-only` | synthetic | ✅ | ✅ | ✅ |
| `syn-19-savemore-payment-and-tax-lines` | synthetic | ✅ | ✅ | ✅ |
| `syn-18-discount-line` | synthetic | ✅ | ❌ | ✅ |
| `deg-01-blur` | degraded | ✅ | ✅ | ✅ |
| `deg-02-low-contrast` | degraded | ✅ | ✅ | ✅ |
| `deg-03-rotated` | degraded | ✅ | ❌ | ✅ |
| `deg-04-low-resolution` | degraded | ✅ | ❌ | ✅ |
| `deg-06-jpeg-artifacts` | degraded | ✅ | ❌ | ✅ |
| `deg-07-many-items-blur` | degraded | ✅ | ✅ | ✅ |
| `deg-08-many-items-low-contrast` | degraded | ✅ | ✅ | ✅ |
| `deg-09-qty-columns-rotated` | degraded | ✅ | ✅ | ✅ |
| `real-05-bintang-juice-camscan-watermark` | real | ⬜ | ✅ | ✅ |
| `real-07-glare-finger-obstruction` | real | — | ⬜ | ✅ |
| `real-08-diagonal-watermark-blur` | real | — | — | ✅ |
| `real-09-severe-blur-duplicate-items` | real | — | — | ✅ |
| `real-10-chopstick-obstruction-crumple` | real | — | — | ❌ |
| `real-11-thumb-obstruction-single-item` | real | — | — | ✅ |
| `real-12-long-13-item-blurry-header` | real | — | — | ✅ |
| `real-13-blur-vendor-two-item` | real | — | — | ✅ |
| `real-14-lamp-glare-discount-multiplier` | real | — | — | ✅ |
| `real-17-decorative-banner-wood-table` | real | ✅ | ✅ | ✅ |
| `real-18-via-emilia-clean` | real | ✅ | ❌ | ✅ |
| `real-19-togo-banner-asterisks` | real | ✅ | — | ✅ |
| `real-20-cluttered-menu-background-tilt` | real | ✅ | ❌ | ✅ |
| `real-21-jts-diner-clean` | real | ✅ | ✅ | ✅ |
| `real-22-blank-total-field-curl` | real | ✅ | ✅ | ✅ |
| `real-24-yauatcha-no-date` | real | — | ✅ | ✅ |
| `real-25-boa-dark-background` | real | ✅ | ✅ | ✅ |
| `real-26-friendly-reds-clean` | real | ✅ | ✅ | ✅ |
| `real-28-carls-jr-translucent-bleed` | real | ✅ | ✅ | ✅ |
| `real-29-saska-paperclip-clipboard` | real | ✅ | ✅ | ✅ |
| `real-30-wings-things-over-menu-crumple` | real | — | ✅ | ✅ |
| `real-31-lan-sheng-item-price-column-shift` | real | ✅ | ✅ | ✅ |
| `real-32-mynews-handwritten-margin` | real | ✅ | ❌ | ✅ |
| `real-33-mcdonalds-my-combo-submenu` | real | ✅ | ✅ | ✅ |
| `real-34-parking-ticket-stamped-redacted` | real | ✅ | ❌ | ✅ |
| `real-35-kings-confectionery-discount-column` | real | ✅ | ✅ | ✅ |
| `real-36-mrdiy-multiline-item-layout` | real | ✅ | ❌ | ✅ |
| `real-37-gardenia-torn-multi-subtotal` | real | ✅ | ❌ | ✅ |
| `real-38-super-seven-dot-noise-duplicate-lines` | real | ✅ | ❌ | ✅ |
| `real-39-sanyu-stationery-clean` | real | ✅ | ✅ | ✅ |
| `real-40-portugalia-euro-redaction-dots` | real | ✅ | ✅ | ✅ |
| `real-41-caravela-simple-euro` | real | ✅ | ❌ | ✅ |
| `real-42-fuel-pump-receipt-redaction` | real | ✅ | ❌ | ✅ |
| `real-43-pollux-torn-skew-barcode` | real | ✅ | ✅ | ✅ |
| `real-44-oriente-perfeito-handwritten-note` | real | ✅ | ✅ | ✅ |
| `real-45-sticker-obstruction-cropped-vendor` | real | — | — | ✅ |

## Where it went wrong

### `real-03-ph-sales-invoice`

*Real phone photo, PH thermal SALES INVOICE, 8 items with a quantity column and per-item unit prices on a wrapped second line, a discount line, and two emoji stickers overlaid on one item row by whoever shared it*

| Field | Expected | Got |
|---|---|---|
| date | `2026-04-06` | `2026-06-04` |

### `syn-05-thousands-separator`

*Printed, amount with thousands separator (12,450.00)*

| Field | Expected | Got |
|---|---|---|
| vendor | `METRO WHOLESALE TRADING` | `Metro` |

### `syn-06-subtotal-then-total`

*Printed, SUBTOTAL present before TOTAL (must not pick subtotal)*

| Field | Expected | Got |
|---|---|---|
| vendor | `SARI-SARI EXPRESS` | `SARI-SARI` |

### `syn-11-long-header`

*Printed, several administrative lines before the vendor name (TIN/permit block first)*

| Field | Expected | Got |
|---|---|---|
| vendor | `LAPU-LAPU TRADING CO` | `LAPU-LAPU TRADING` |

### `syn-16-multiplier-prefix`

*Printed, '2 x Item' multiplier prefix on each line*

| Field | Expected | Got |
|---|---|---|
| vendor | `TALAMBAN BEVERAGE CENTER` | `TALAMBAN BEVERAGE` |

### `syn-18-discount-line`

*Printed, a DISCOUNT line sits among the items — must not be read as a purchase*

| Field | Expected | Got |
|---|---|---|
| vendor | `SOUTH CITY PHARMACY` | `SOUTH CITY` |

### `deg-03-rotated`

*Synthetic + rotated 4 degrees (simulates handheld skew)*

| Field | Expected | Got |
|---|---|---|
| vendor | `METRO WHOLESALE TRADING` | `Metro` |

### `deg-04-low-resolution`

*Synthetic + downscaled to 45% then back up (simulates a distant/low-res photo)*

| Field | Expected | Got |
|---|---|---|
| vendor | `METRO WHOLESALE TRADING` | `Metro` |

### `deg-06-jpeg-artifacts`

*Synthetic + heavy JPEG compression (quality 12)*

| Field | Expected | Got |
|---|---|---|
| vendor | `SARI-SARI EXPRESS` | `SARI-SARI` |

### `real-10-chopstick-obstruction-crumple`

*Real phone photo on a wood-grain table, wooden chopsticks and a pink napkin partially resting on/behind the receipt, blurred header, single abbreviated item name*

| Field | Expected | Got |
|---|---|---|
| amount | `53999` | `53.999` |

### `real-18-via-emilia-clean`

*Real phone photo, clean US restaurant receipt (Miami Beach, FL), month-name date, an order-tracking URL/code line*

| Field | Expected | Got |
|---|---|---|
| vendor | `VIA EMILIA 9` | `Via Emilia` |

### `real-20-cluttered-menu-background-tilt`

*Real phone photo, receipt photographed resting on top of a restaurant menu (cluttered background text behind/around it), slight tilt, US date*

| Field | Expected | Got |
|---|---|---|
| vendor | `Fuzzy's Taco Shop` | `ONE EVER LIZZY'S` |

### `real-32-mynews-handwritten-margin`

*Real phone photo, Malaysian convenience-store tax invoice, a handwritten alphanumeric code ('A03115') pen-written in the top-right margin (unrelated to the transaction), GST columns*

| Field | Expected | Got |
|---|---|---|
| vendor | `myNEWS.com` | `PAGOH REST AND SERVICE AREA` |

### `real-34-parking-ticket-stamped-redacted`

*Real phone photo, Malaysian parking-garage tax invoice (not a merchandise receipt), a black circular redaction mark over part of the GST ID, a 'POSTED' rubber stamp printed diagonally across the fee amount, entry/paid timestamps rather than a single transaction time*

| Field | Expected | Got |
|---|---|---|
| vendor | `Amano Malaysia Sdn Bhd` | `AMANO MALAYSIA` |

### `real-36-mrdiy-multiline-item-layout`

*Real phone photo, Malaysian hardware-store tax invoice, each item spans THREE printed lines (name, size/SKU code line, then quantity x unit-price = amount on a separate line) rather than one line per item*

| Field | Expected | Got |
|---|---|---|
| vendor | `MR. D.I.Y. (KUCHAI) SDN BHD` | `Mr. D.I.Y` |

### `real-37-gardenia-torn-multi-subtotal`

*Real phone photo, top-left corner of the receipt physically torn off, a small paper/sticker patch obscuring part of one line, TWO separate zero-rated and standard-rated subtotals before the final Total Payable*

| Field | Expected | Got |
|---|---|---|
| vendor | `GARDENIA BAKERIES (KL) SDN BHD` | `GARDENIA BAKERIES (KL)` |

### `real-38-super-seven-dot-noise-duplicate-lines`

*Real phone photo, scattered small dark speckle/dot noise across the whole image (dust or a dirty lens), a duplicate item line (same SKU/product printed twice, two separate purchases of the same item), a handwritten total ('18.30') and checkmarks added over the printed Net Total*

| Field | Expected | Got |
|---|---|---|
| vendor | `SUPER SEVEN CASH & CARRY SDN BHD` | `SUPER SEVEN CASH & CARRY` |

### `real-41-caravela-simple-euro`

*Real phone photo, Portuguese shopping-mall food-court receipt, single item, Euro, ISO date already printed*

| Field | Expected | Got |
|---|---|---|
| vendor | `Caravela Alimentação, S.A` | `CARAVELA ALIMENTAÇÃO` |

### `real-42-fuel-pump-receipt-redaction`

*Real phone photo, Portuguese fuel-pump receipt (not a merchandise purchase — litres of diesel at a per-litre rate), a black circular redaction mark over part of the total, an IVA/net breakdown table*

| Field | Expected | Got |
|---|---|---|
| vendor | `PMRP Unipessoal, Lda.` | `PMRP Unipessoal` |

