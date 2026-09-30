# Receipt scanner evaluation

## Local OCR quality and latency gate

Run this from `backend/`:

```sh
npm run evaluate:receipt-scanner:local
```

Run `npm run typecheck:receipt-scanner:local` after changing the gate or its
contract.

The default run uses the generated and synthetically degraded fixtures in the
existing OCR corpus. It runs the bundled Tesseract engine through the production
parser and does not call Gemini, Veryfi, OpenRouter, Azure, or another hosted
provider. The command exits non-zero when a budget in
`local-quality-thresholds.json` is missed.

The initial synthetic budget pins the established 28-fixture baseline: exact
vendor, date, and total extraction on every fixture; at least 96% receipt-level
item accuracy; no OCR execution failures; and no fabricated item lines. The
item budget records the known rotated-quantity miss instead of describing the
baseline as perfect. The P95 ceiling uses the frozen local-result ceiling from
`docs/phase-0/benchmark-policy-v1.json`; P50 has a tighter engineering guardrail
and the report includes both values so changes are visible well before either
ceiling.

The generated `local-quality-results.json` contains:

- exact vendor, date, total, and receipt-level item accuracy;
- item-line recall, precision, and false-positive rate;
- OCR success and failure rates;
- nearest-rank P50 and P95 end-to-end local extraction latency;
- aggregate and per-provenance metrics; and
- every gate check with its actual value and configured threshold.

The report contains no receipt text, extracted values, image paths, credentials,
provider responses, or caller-supplied sample names. Sample identifiers are
deterministic pseudonyms made from truncated SHA-256 hashes. They prevent
accidental disclosure but are not anonymization: predictable source IDs remain
dictionary-guessable. Discovery and provenance counts describe the requested
scope; `totalReviewedManifestSamples` records the full reviewed manifest size.
The file remains sensitive, machine-local, mode `0600`, and ignored by git.

Use `--corpus all` to run every locally available fixture. Those results keep the
following groups separate:

- `SYNTHETIC_GENERATED` and `SYNTHETIC_DERIVED` are engineering fixtures.
- `PUBLIC_LICENSED_REAL_SINGLE_REVIEW` covers the public-dataset images described
  in `../ocr-accuracy/CORPUS-ATTRIBUTION.md`. They are useful diagnostics but do
  not satisfy owner-consent or double-review evidence requirements.
- `EXISTING_REAL_UNKNOWN_CONSENT` covers historical project images whose consent
  evidence is not recorded. They are never promoted based on a filename.
- `ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED` is reserved for explicitly
  documented local entries. The current corpus has none, so the report states
  `NOT_AVAILABLE` and never presents the current run as real-receipt acceptance
  evidence.

Every real fixture must carry explicit structured provenance metadata. The gate
does not infer evidence from an ID or filename. Public fixtures record source
and license attribution plus their single-review count; historical local images
explicitly record that consent and source attribution are unavailable.

Run `npm run evaluate:receipt-scanner:local -- --help` to select a corpus or
caller-supplied manifest, image directory, thresholds, and output path. The
synthetic profile remains the enforced default even during an `all` run, which
prevents private or optional files from silently changing the repeatable gate.

### Adding anonymized real receipts locally

Keep source images under `tests/ocr-accuracy/images/` or another ignored/private
directory. Do not commit receipt photos, raw OCR output, customer names, loyalty
numbers, payment details, addresses, phone numbers, or private storage links.

Before labeling an entry as anonymized real evidence:

1. Record consent for local engineering evaluation outside the repository.
2. Redact identifying and payment data from the image, then have a person review
   the redaction. Keep the unredacted source outside this corpus.
3. Have two people independently transcribe the expected fields. Resolve any
   disagreement before adding the entry.
4. Use an opaque ID and add this object to its `ground-truth.json` entry:

```json
{
  "provenance": {
    "label": "ANONYMIZED_CONSENTED_REAL_DOUBLE_REVIEWED",
    "consentRecorded": true,
    "anonymizationReviewed": true,
    "groundTruthReviewerCount": 2
  }
}
```

The schema rejects that label unless all three evidence fields are present. The
report marks the evidence available only when an eligible image was present and
attempted in the requested scope. Run `--corpus anonymized-real` to measure only
those entries. The default threshold
file deliberately remains a synthetic regression profile, so supply a separately
reviewed `--thresholds` file when enforcing an anonymized-real cohort budget.
This local label does not replace the sealed policy-v1 intake, cohort, retention,
or release-gate requirements below, and no local corpus result supports a
production accuracy claim.

## Legacy synthetic-fixture harness

Run `npm run evaluate:receipt-scanner` from `backend/`.

`manifest.json` is a tracked fixture index. Do not add private receipt metadata
or images to git. A sample may set `releaseGateEligible: true` only after its
consent, expected fields, document count, and (when supplied) corners were
reviewed independently from FinSight's output. Synthetic and unreviewed images
exercise the harness but never satisfy a release gate.

Optional `processedFile` evaluates a derived scanner image against its original.
The runner records which OCR candidate wins using the same objective selector as
production. Add handwritten and non-receipt samples with `writing` and `kind` so
their false-rejection/false-trigger metrics become measurable.

Numeric targets are frozen in `thresholds.json`. A threshold change requires a
documented product decision; tuning code to a sample and moving its gate in the
same change invalidates the comparison.

This legacy command overwrites the tracked `results.json` and `REPORT.md`. Do not
point it at a populated private acceptance corpus.

## Policy-v1 external evaluator

Run `npm run evaluate:receipt-scanner:policy-v1 -- --help` for the external
evaluator arguments. It accepts only caller-supplied absolute input and output
paths outside the repository. It verifies the pinned policy and normative
artifacts, the sealed intake and pair-label CSV files, consent and eligibility,
artifact hashes, result coverage, and corpus counts before aggregating scored
observations.

The policy-v1 runner does not execute OCR or contact a provider. It accepts
`LOCAL_TESSERACT` results only. The v1 contract cannot prove the policy-required
cloud region, provider version, input transform, Azure F0 resource, page-unit
cap, or provider-data lifecycle, so it rejects every cloud-provider result.

The sealed artifact map commits the run-plan hashes, field and handwriting
applicability, page counts, independent-trial bindings, metric families, and
ground-truth denominators before result data is opened. A supplied result
collection must cover its full eligible frame. Failed, timed-out, and missing
results stay in field metric denominators and are reported separately.

For `CAPSTONE_DEMO`, all Phase 0 corpus floors are checked before scored-result
bytes are read, and receipt/capture gates use consented-owner primaries only.
Use a separately sealed `LOCAL_ENGINEERING` run to report an under-floor corpus.

Applicability and denominators are structurally checked against that seal; two
custodians must still reconcile them with private ground truth before sealing.

The output is aggregate JSON created with mode `0600`. Existing outputs are not
overwritten. Missing evidence is recorded as `NOT_MEASURED`, and the report does
not include sample IDs, receipt text, field values, paths, or storage references.

See [the Phase 2 acceptance checklist](../../../docs/phase-2/PHASE-2-ACCEPTANCE-CHECKLIST.md)
for the private input contracts, sealing order, statistical methods, and manual
gates that this evaluator cannot close.
