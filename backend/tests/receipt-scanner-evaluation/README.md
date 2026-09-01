# Receipt scanner evaluation corpus

Run `npm run evaluate:receipt-scanner` from `backend/`.

`manifest.json` is the access-controlled index. Do not add private receipt
images to git. A sample may set `releaseGateEligible: true` only after its
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
