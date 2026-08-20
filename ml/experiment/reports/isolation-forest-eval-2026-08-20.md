# Isolation Forest offline evaluation (A1)

Generated: 2026-08-20 · seed 42 · sklearn IsolationForest(n_estimators=200, contamination=auto)

**Corpus: 100% SYNTHETIC.** Generated Philippine small-business expense streams with ~2% injected, labeled
anomalies (decimal_shift, new_vendor_burst, unusual_combo, duplicate_like) in the evaluation half only.
These numbers validate the harness and the detector's separation of planted anomaly classes;
they are **not** evidence about real owner data. Production exposure remains gated on shadow-mode
results against real records — this report does not clear that gate by itself.

Alert budget: 2 findings per 100 evaluated records, applied identically to every detector.

## Segment: sparse (~120 records) (6 profiles)

| Detector | Precision@budget | Recall | Findings/100 |
|---|---:|---:|---:|
| Rules (IQR/MAD + novelty) | 1.00 | 0.41 | — |
| Isolation Forest | 0.97 | 0.46 | 1.81 |
| Ensemble (union) | 0.98 | 0.58 | — |

- Incremental true positives found ONLY by the forest: **13**
- Forest pick stability across refit seeds (Jaccard): 0.86
- Mean fit+score latency: 4525 ms · peak feature+model memory: 1.1 MB

| Anomaly class | Planted | Caught by rules | Caught by forest |
|---|---:|---:|---:|
| decimal_shift | 19 | 15 | 19 |
| duplicate_like | 24 | 0 | 0 |
| new_vendor_burst | 18 | 10 | 7 |
| unusual_combo | 17 | 7 | 10 |

## Segment: medium (~400 records) (6 profiles)

| Detector | Precision@budget | Recall | Findings/100 |
|---|---:|---:|---:|
| Rules (IQR/MAD + novelty) | 1.00 | 0.41 | — |
| Isolation Forest | 1.00 | 0.50 | 2.00 |
| Ensemble (union) | 1.00 | 0.55 | — |

- Incremental true positives found ONLY by the forest: **35**
- Forest pick stability across refit seeds (Jaccard): 0.88
- Mean fit+score latency: 31021 ms · peak feature+model memory: 1.4 MB

| Anomaly class | Planted | Caught by rules | Caught by forest |
|---|---:|---:|---:|
| decimal_shift | 65 | 63 | 61 |
| duplicate_like | 59 | 0 | 0 |
| new_vendor_burst | 52 | 18 | 22 |
| unusual_combo | 64 | 17 | 37 |

## Segment: busy (~1000 records) (6 profiles)

| Detector | Precision@budget | Recall | Findings/100 |
|---|---:|---:|---:|
| Rules (IQR/MAD + novelty) | 1.00 | 0.42 | — |
| Isolation Forest | 0.99 | 0.50 | 2.00 |
| Ensemble (union) | 0.99 | 0.57 | — |

- Incremental true positives found ONLY by the forest: **45**
- Forest pick stability across refit seeds (Jaccard): 0.82
- Mean fit+score latency: 44607 ms · peak feature+model memory: 1.7 MB

| Anomaly class | Planted | Caught by rules | Caught by forest |
|---|---:|---:|---:|
| decimal_shift | 78 | 74 | 70 |
| duplicate_like | 73 | 0 | 0 |
| new_vendor_burst | 73 | 35 | 41 |
| unusual_combo | 76 | 17 | 38 |

## Gate decision

Promotion out of shadow mode requires this same harness run against REAL shadow-mode findings and owner
feedback, meeting the criteria in docs/ANOMALY-DETECTION-AND-LARGE-CSV-ANALYSIS-STRATEGY.md §6.3.
The synthetic result above justifies only: shipping the detector OFF by default, in shadow mode,
behind ANOMALY_ISOLATION_FOREST_ENABLED.
