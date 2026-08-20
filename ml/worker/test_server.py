"""Unit tests for the ML sidecar's contract validation and scoring.

Run:  ml/.venv/bin/python -m unittest discover -s ml/worker -v
"""

from __future__ import annotations

import unittest

import numpy as np

from server import (
    CONTRACT_VERSION,
    MAX_ROWS,
    MIN_ROWS,
    ContractError,
    score,
    validate_request,
)


def request_body(rows: int = MIN_ROWS, features: int = 3, seed: int = 42) -> dict:
    rng = np.random.default_rng(7)
    return {
        "contractVersion": CONTRACT_VERSION,
        "seed": seed,
        "featureNames": [f"f{i}" for i in range(features)],
        "rows": [
            {"id": i + 1, "features": [float(v) for v in rng.normal(size=features)]}
            for i in range(rows)
        ],
    }


class ValidateRequestTests(unittest.TestCase):
    def test_accepts_a_well_formed_request(self) -> None:
        ids, matrix, seed = validate_request(request_body())
        self.assertEqual(len(ids), MIN_ROWS)
        self.assertEqual(matrix.shape, (MIN_ROWS, 3))
        self.assertEqual(seed, 42)

    def test_rejects_wrong_contract_version(self) -> None:
        body = request_body()
        body["contractVersion"] = "if-contract-v0"
        with self.assertRaises(ContractError):
            validate_request(body)

    def test_rejects_too_few_and_too_many_rows(self) -> None:
        with self.assertRaises(ContractError):
            validate_request(request_body(rows=MIN_ROWS - 1))
        body = request_body(rows=MIN_ROWS)
        body["rows"] = body["rows"] * (MAX_ROWS // MIN_ROWS + 1)
        with self.assertRaises(ContractError):
            validate_request(body)

    def test_rejects_width_mismatch_nan_and_non_numeric(self) -> None:
        body = request_body()
        body["rows"][0]["features"] = body["rows"][0]["features"][:-1]
        with self.assertRaises(ContractError):
            validate_request(body)

        body = request_body()
        body["rows"][0]["features"][0] = float("nan")
        with self.assertRaises(ContractError):
            validate_request(body)

        body = request_body()
        body["rows"][0]["features"][0] = "12"
        with self.assertRaises(ContractError):
            validate_request(body)

    def test_rejects_boolean_ids_and_seeds(self) -> None:
        body = request_body()
        body["rows"][0]["id"] = True
        with self.assertRaises(ContractError):
            validate_request(body)
        body = request_body()
        body["seed"] = True
        with self.assertRaises(ContractError):
            validate_request(body)


class ScoreTests(unittest.TestCase):
    def test_deterministic_for_same_seed(self) -> None:
        ids, matrix, seed = validate_request(request_body(rows=60))
        first = score(ids, matrix, seed)
        second = score(ids, matrix, seed)
        self.assertEqual(first["scores"], second["scores"])

    def test_planted_outlier_ranks_most_anomalous(self) -> None:
        body = request_body(rows=80)
        body["rows"][0]["features"] = [50.0, -50.0, 50.0]  # far outside N(0,1)
        ids, matrix, seed = validate_request(body)
        result = score(ids, matrix, seed)
        by_id = {entry["id"]: entry for entry in result["scores"]}
        self.assertEqual(by_id[1]["normalizedScore"], 1.0)
        self.assertLess(by_id[1]["decisionValue"], 0)

    def test_normalized_scores_span_zero_to_one(self) -> None:
        ids, matrix, seed = validate_request(request_body(rows=50))
        values = [entry["normalizedScore"] for entry in score(ids, matrix, seed)["scores"]]
        self.assertAlmostEqual(min(values), 0.0)
        self.assertAlmostEqual(max(values), 1.0)

    def test_response_carries_versions(self) -> None:
        ids, matrix, seed = validate_request(request_body())
        result = score(ids, matrix, seed)
        self.assertEqual(result["contractVersion"], CONTRACT_VERSION)
        self.assertEqual(result["modelVersion"], "iforest-v1")
        self.assertTrue(result["sklearnVersion"])
        self.assertEqual(result["trainedRows"], MIN_ROWS)


if __name__ == "__main__":
    unittest.main()
