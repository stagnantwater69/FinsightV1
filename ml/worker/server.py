"""FinSight ML scoring sidecar.

A deliberately tiny, stdlib-only HTTP server wrapping scikit-learn's
IsolationForest for the anomaly-detection shadow detector.

Design rules (see docs/ML-OCR-CSV-UI-PROGRAM.md, ADR-1/ADR-2):

- ARTIFACT-FREE. The model is fitted per request on the bounded feature
  matrix the TypeScript service sends, with a fixed seed. Nothing is ever
  pickled, loaded, or persisted — which is also the whole "never load
  untrusted pickle artifacts" story: there are no artifacts.
- TENANT-BLIND. The request carries opaque numeric row ids and numeric
  features only. No tenant identifiers, no descriptions, no vendor names.
  This process cannot leak what it never receives.
- BOUNDED. Requests over MAX_BODY_BYTES, MAX_ROWS, or MAX_FEATURES are
  rejected with 4xx before any numpy allocation.
- VERSIONED. Every response carries the contract, model, and library
  versions so a finding can always be traced to the code that scored it.

Run:  .venv/bin/python ml/worker/server.py [--port 8321]
Health:  GET /health
Score:   POST /score  (contract if-contract-v1, see ml/README.md)
"""

from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sklearn
from sklearn.ensemble import IsolationForest

CONTRACT_VERSION = "if-contract-v1"
MODEL_VERSION = "iforest-v1"

MAX_BODY_BYTES = 1_000_000
MAX_ROWS = 5_000
MIN_ROWS = 20  # a forest fitted on fewer rows is noise, not a model
MAX_FEATURES = 32


class ContractError(ValueError):
    """A request that violates the contract. Always a 4xx, never a crash."""


def validate_request(payload: object) -> tuple[list[int], np.ndarray, int]:
    if not isinstance(payload, dict):
        raise ContractError("body must be a JSON object")
    if payload.get("contractVersion") != CONTRACT_VERSION:
        raise ContractError(f"unsupported contractVersion (expected {CONTRACT_VERSION})")
    seed = payload.get("seed")
    if not isinstance(seed, int) or isinstance(seed, bool) or seed < 0:
        raise ContractError("seed must be a non-negative integer")
    names = payload.get("featureNames")
    if not isinstance(names, list) or not names or len(names) > MAX_FEATURES:
        raise ContractError(f"featureNames must be a list of 1..{MAX_FEATURES} strings")
    if not all(isinstance(name, str) for name in names):
        raise ContractError("featureNames must all be strings")
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise ContractError("rows must be a list")
    if len(rows) < MIN_ROWS:
        raise ContractError(f"at least {MIN_ROWS} rows are required to fit")
    if len(rows) > MAX_ROWS:
        raise ContractError(f"at most {MAX_ROWS} rows are accepted")

    ids: list[int] = []
    matrix: list[list[float]] = []
    width = len(names)
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ContractError(f"rows[{index}] must be an object")
        row_id = row.get("id")
        if not isinstance(row_id, int) or isinstance(row_id, bool):
            raise ContractError(f"rows[{index}].id must be an integer")
        features = row.get("features")
        if not isinstance(features, list) or len(features) != width:
            raise ContractError(f"rows[{index}].features must have exactly {width} values")
        values: list[float] = []
        for position, value in enumerate(features):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ContractError(f"rows[{index}].features[{position}] must be a finite number")
            number = float(value)
            if not np.isfinite(number):
                raise ContractError(f"rows[{index}].features[{position}] must be a finite number")
            values.append(number)
        ids.append(row_id)
        matrix.append(values)

    return ids, np.asarray(matrix, dtype=np.float64), seed


def score(ids: list[int], matrix: np.ndarray, seed: int) -> dict:
    """Fit-and-score in one pass. Deterministic for a given (matrix, seed)."""
    forest = IsolationForest(
        n_estimators=200,
        contamination="auto",
        random_state=seed,
        n_jobs=1,  # bounded CPU: the caller is a background job, not a UI
    )
    forest.fit(matrix)
    # decision_function: positive = normal side, negative = anomalous side.
    decisions = forest.decision_function(matrix)
    # Percentile-normalised anomaly score in [0, 1]: 1.0 = most anomalous row
    # of this batch. Rank-based, so it is stable under monotone changes and
    # directly usable for the caller's alert-budget top-K selection. The raw
    # decision value rides along for audit.
    order = np.argsort(decisions)  # ascending: most anomalous first
    ranks = np.empty(len(decisions), dtype=np.float64)
    ranks[order] = np.arange(len(decisions), dtype=np.float64)
    denominator = max(len(decisions) - 1, 1)
    normalized = 1.0 - ranks / denominator
    return {
        "contractVersion": CONTRACT_VERSION,
        "modelVersion": MODEL_VERSION,
        "sklearnVersion": sklearn.__version__,
        "trainedRows": int(matrix.shape[0]),
        "featureCount": int(matrix.shape[1]),
        "scores": [
            {
                "id": row_id,
                "decisionValue": round(float(decisions[index]), 6),
                "normalizedScore": round(float(normalized[index]), 6),
            }
            for index, row_id in enumerate(ids)
        ],
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "finsight-ml/1"

    def _respond(self, status: int, body: dict) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        if self.path == "/health":
            self._respond(
                200,
                {
                    "status": "ok",
                    "contractVersion": CONTRACT_VERSION,
                    "modelVersion": MODEL_VERSION,
                    "sklearnVersion": sklearn.__version__,
                    "numpyVersion": np.__version__,
                    "pythonVersion": sys.version.split()[0],
                },
            )
        else:
            self._respond(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/score":
            self._respond(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            self._respond(413, {"error": f"body must be 1..{MAX_BODY_BYTES} bytes"})
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self._respond(400, {"error": "body must be valid JSON"})
            return
        try:
            ids, matrix, seed = validate_request(payload)
        except ContractError as error:
            self._respond(422, {"error": str(error)})
            return
        try:
            self._respond(200, score(ids, matrix, seed))
        except Exception as error:  # noqa: BLE001 — a scoring crash must be a 500, not a dead worker
            self._respond(500, {"error": f"scoring failed: {type(error).__name__}"})

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        # One structured-ish line per request; quiet enough for a sidecar.
        sys.stderr.write(f"finsight-ml {self.address_string()} {format % args}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="FinSight ML scoring sidecar")
    parser.add_argument("--port", type=int, default=8321)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    sys.stderr.write(
        f"finsight-ml listening on {args.host}:{args.port} "
        f"(sklearn {sklearn.__version__}, numpy {np.__version__})\n"
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
