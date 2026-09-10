# Receipt scanner evaluation

Generated: 2026-09-07T12:14:15.489Z

Samples run: **3**; release-gate-eligible: **0**.

> No sample is currently marked release-gate-eligible. These results exercise the harness but do not validate production thresholds.

| Metric | Result |
|---|---:|
| Document precision | Not measurable |
| Document recall | Not measurable |
| Obvious non-receipt false-trigger rate | Not measurable |
| Multi-receipt count accuracy | Not measurable |
| Handwritten hard-reject rate | Not measurable |
| Detector latency p95 | 206.4 ms |

## Original versus processed capture diagnostics

These groups include all fixtures for debugging and are not release-gate evidence. Unknown provenance is never inferred from filenames. Deltas compare the same image pair against the same ground truth; positive values gain correct fields and negative values lose them. Missing pairs or ground truth are not measurable.

| Capture source / mode | Samples | Paired samples | Date delta | Vendor delta | Amount delta |
|---|---:|---:|---:|---:|---:|
| unknown/unknown | 3 | 0 | Not measurable | Not measurable | Not measurable |

Set optional `captureSource` and `captureMode` only from recorded capture provenance, and `processedFile` to the corresponding corrected image. JSON includes per-field gains/regressions and a separate eligible-only breakdown. No receipt text or images are included in the report.

Add consented samples to `manifest.json`, verify ground truth independently, then set `releaseGateEligible` to true.
