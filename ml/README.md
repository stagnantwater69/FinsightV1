# FinSight ML worker

The Python side of the Isolation Forest shadow detector (Workstream A of
`docs/ML-OCR-CSV-UI-IMPROVEMENT-PROMPT.md`; decisions in
`docs/ML-OCR-CSV-UI-PROGRAM.md` ADR-1/ADR-2).

## Layout

- `worker/server.py` — the scoring sidecar: stdlib-only HTTP server wrapping
  `sklearn.ensemble.IsolationForest`. Artifact-free (fit-per-request, fixed
  seed, **no pickle anywhere**), tenant-blind (numeric ids + numeric features
  only), bounded (1 MB body, 5,000 rows, 32 features), versioned
  (`if-contract-v1` / `iforest-v1` on every response).
- `worker/test_server.py` — contract validation + scoring unit tests.
- `experiment/` — the A1 offline evaluation harness and its generated
  reports. The corpus is 100% synthetic; see the header of
  `experiment/corpus.py` and the disclaimer inside every report.
- `requirements.txt` — exact pins. The versions recorded on findings assume
  these builds.

## Setup

```bash
python3 -m venv ml/.venv          # Python 3.14
ml/.venv/bin/pip install -r ml/requirements.txt
```

(If `ensurepip` is unavailable: `python3 -m venv --without-pip ml/.venv`,
then bootstrap pip with get-pip.py.)

## Run

```bash
ml/.venv/bin/python ml/worker/server.py --port 8321
curl -s localhost:8321/health
```

The backend reaches it at `ML_WORKER_URL` (default `http://127.0.0.1:8321`)
only when `ANOMALY_ISOLATION_FOREST_ENABLED="true"`. If the worker is down
the backend fails open: analysis jobs complete on the deterministic
detectors and a warning is logged. Keep the worker bound to localhost or a
private network — it has no authentication because it never receives
anything sensitive, but it also has no reason to be public.

Resource posture: `n_jobs=1`, one fit per PROFILE_REFRESH job (a few per
profile per day), ≤5,000×32 float64 per request → worst-case working set
well under 100 MB. A systemd/container memory cap of 512 MB is comfortable.

## Tests

```bash
ml/.venv/bin/python -m unittest discover -s ml/worker        # Python side
cd backend && npx vitest run tests/contract/mlWorkerContract.test.ts  # wire contract
```

The backend contract test spawns the real worker from `ml/.venv` and skips
(visibly) when the venv is missing.

## Experiment

```bash
ml/.venv/bin/python ml/experiment/run_experiment.py
```

Writes `ml/experiment/reports/isolation-forest-eval-<date>.md`. Re-run this
same harness against exported real shadow findings before any promotion out
of shadow mode (gate criteria:
`docs/ANOMALY-DETECTION-AND-LARGE-CSV-ANALYSIS-STRATEGY.md` §6.3).
