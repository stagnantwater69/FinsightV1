# Receipt scanner evaluation

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
