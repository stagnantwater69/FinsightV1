# OCR accuracy corpus — attribution and sampling methodology

This corpus (`images/`, `ground-truth.json`) mixes originally-produced synthetic/degraded
receipts with real receipt photographs. The 42 real-photo images added under the `real-04`
through `real-45` ids are drawn from a third-party, publicly licensed dataset. This file
records where they came from and how they were selected and verified, so their provenance
and limitations travel with the corpus.

## Source dataset

**receipt-dataset-standardized** by mankind1023 —
https://huggingface.co/datasets/mankind1023/receipt-dataset-standardized

That dataset is itself a curated, re-annotated combination of four upstream public receipt
datasets. Per its own `NOTICE.md`, all four are reproduced here with the same citations:

1. **CORD (Consolidated Receipt Dataset v2)** — Clova AI / NAVER.
   Park, S., Lee, J., & Lee, H. (2019). *CORD: A Consolidated Receipt Dataset for Post-OCR
   Parsing* [Data set]. License: **CC-BY 4.0**.
   https://huggingface.co/datasets/naver-clova-ix/cord-v2

2. **SROIE (ICDAR 2019 Scanned Receipt OCR & Information Extraction)** — Huang, Z., Chen, K.,
   He, J., Bai, X., Karatzas, D., Lu, S., & Jawahar, C.V. (2019). *ICDAR 2019 Competition on
   Scanned Receipt OCR and Information Extraction* [Dataset]. Proceedings of the 15th
   International Conference on Document Analysis and Recognition (ICDAR 2019).
   https://doi.org/10.1109/ICDAR.2019.00244. License: **CC-BY 4.0**.

3. **ExpressExpense SRD (Free Receipt Images dataset)** — ExpressExpense.
   https://expressexpense.com/blog/free-receipt-images-ocr-machine-learning-dataset/.
   License: **MIT**.

4. **Zenodo Dataset of Invoices and Receipts** — Cruz, F., & Castelli, M. (2022). *Dataset of
   invoices and receipts including annotation of relevant fields* [Data set]. Zenodo.
   https://doi.org/10.5281/zenodo.6371710. License: **CC-BY 4.0**.

Filenames in this corpus keep each image's original source prefix (`cord_*`, `express_srd_*`,
`sroie_*`, `zenodo_*` — visible in the `id`/`conditions` mapping this file's methodology
section below, and recoverable from the original dataset's `MANIFEST.csv` if needed) so the
chain back to the correct upstream license is traceable per image.

**Important caveat carried forward from the source dataset's own `NOTICE.md`:** its JSON
annotations were produced by "a combination of original dataset annotations (where
available), AI-assisted OCR and information extraction using commercial AI models, and manual
review and normalization" and are explicitly described as **"not authoritative financial
ground truth."** FinSight's `ground-truth.json` entries for these images are **not** a copy of
that dataset's annotations — see the verification methodology below.

## Sampling methodology

From the ~2,780 images in the source dataset, a candidate pool of 64 was drawn (weighted
toward images with a plausible date+total in the dataset's own annotation, stratified across
the four source prefixes), then every candidate was opened and visually inspected by an
ai-ocr-analytics reviewer before inclusion. 42 of the 64 were kept; the rest were dropped for
redundancy with an already-kept image of the same vendor/layout, or because the header/vendor
was so degraded that no field could be verified with any confidence at all. The kept 42 were
deliberately selected to maximise, not average out, real-world photo difficulty and layout
diversity: heavy blur, strong lamp/window glare, finger/chopstick/paperclip/binder-clip
obstruction, crumpled and physically torn paper, cluttered backgrounds (receipt photographed
on a menu or fabric), redaction marks and privacy stickers, a rubber ink stamp crossing the
total, translucent thermal paper with backside bleed-through, multi-line-per-item layouts,
discount and multiplier-prefix lines, combo-meal sub-lines with no individual price, and both
DD/MM and MM/DD real receipts (UK, US, Malaysian, Portuguese, Indonesian) to exercise the
date-locale default.

## Verification methodology ("hand-verification" pass)

For every one of the 42 kept images, a reviewer read the actual image directly (not the
dataset's JSON) and independently transcribed vendor, date, total and line items. The source
dataset's own annotation was then consulted only as a cross-check — used to fill a field the
reviewer could not confidently read, or flagged in `vendor_note` where the two disagreed. In
several cases the dataset annotation was found to be wrong against the reviewer's own reading
and was **not** used (documented per-entry in `vendor_note` — e.g. `real-15-ikea-uk-dd-mm-date`,
`real-12-long-13-item-blurry-header`, `real-09-severe-blur-duplicate-items`). Fields the
reviewer could not read with reasonable confidence from the image itself were left `null`
rather than filled from the dataset's unverified annotation — matching this corpus's existing
`vendor_note`/`known_ambiguous` convention for `real-01`..`real-03`.

**What this verification is, and is not:** this is one AI reviewer reading each image once,
not a second human cross-checker, and not the receipt's original owner. It is materially
better than trusting an unverified AI-generated dataset annotation wholesale, but it is still
not the same standard as a human-transcribed ground truth corpus, and several entries are
explicitly flagged `known_ambiguous: true` with a `vendor_note` explaining exactly what is
uncertain and why (illegible digit, unreconciled subtotal, disputed vendor spelling, etc.).
Treat any accuracy figure computed against this corpus with that in mind — see
`OCR-ACCURACY-REPORT.md`'s own corpus-limitations section for the parallel caveat that already
applies to the original 3 real photos.

**Non-PH bias, unchanged limitation:** most of these 42 images are Indonesian (CORD), US
(ExpressExpense), Malaysian (SROIE) or Portuguese (Zenodo) receipts, not Philippine ones —
FinSight's target market. They were chosen for photo-quality and layout diversity (blur,
glare, obstruction, crumple, discount lines, multi-line items — problems that are not specific
to any one country's receipt format), not as a claim of Philippine-market representativeness.
The corpus's three original real photos (`real-01`..`real-03`) remain the only genuinely
Philippine real photos in the set; this addition does not change that.

## Housekeeping

The full upstream archive (~2,780 images, ~930MB) was downloaded to a scratch directory
outside the repository, used only to select and copy out the 42 chosen images, and deleted
afterward. It is not, and must not be, committed to this repository.
