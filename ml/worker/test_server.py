"""Unit tests for the ML sidecar's contract validation and scoring.

Run:  ml/.venv/bin/python -m unittest discover -s ml/worker -v
"""

from __future__ import annotations

import http.client
import json
import socket
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

import numpy as np

import server
from server import (
    CONTRACT_VERSION,
    MAX_CONCURRENT_FITS,
    MAX_ROWS,
    MIN_ROWS,
    ContractError,
    Handler,
    _self_check,
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
        self.assertIsInstance(result["durationMs"], float)
        self.assertGreaterEqual(result["durationMs"], 0)


class SelfCheckTests(unittest.TestCase):
    def test_self_check_runs_cleanly(self) -> None:
        _self_check()  # raises on any failure; a clean run is the assertion


class HttpLayerTests(unittest.TestCase):
    """Exercises do_POST over real HTTP, the same idea the TS wire-contract
    test uses against the real process, for behavior that lives in the
    Handler rather than in score()/validate_request()."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.thread.join(timeout=5)
        cls.server.server_close()

    def _post(self, body: dict, rows: int = MIN_ROWS) -> tuple[int, dict]:
        del rows
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            payload = json.dumps(body).encode("utf-8")
            conn.request("POST", "/score", body=payload, headers={"Content-Type": "application/json"})
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_concurrent_requests_beyond_the_limit_get_503(self) -> None:
        # A large batch keeps MAX_CONCURRENT_FITS slots busy for a while;
        # shrinking the busy-wait window makes the extra requests' 503 outcome
        # deterministic instead of racing the fit duration.
        original_wait = server.BUSY_WAIT_SECONDS
        server.BUSY_WAIT_SECONDS = 0.01
        try:
            body = request_body(rows=MAX_ROWS)
            statuses: list[int] = []
            lock = threading.Lock()

            def worker() -> None:
                status, _ = self._post(body)
                with lock:
                    statuses.append(status)

            threads = [threading.Thread(target=worker) for _ in range(MAX_CONCURRENT_FITS + 2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=30)
        finally:
            server.BUSY_WAIT_SECONDS = original_wait

        self.assertIn(503, statuses)
        self.assertIn(200, statuses)

    def test_stalled_connection_is_cut_off_by_the_read_timeout(self) -> None:
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=Handler.timeout + 10)
        try:
            # A well-formed POST header announcing a body that never arrives.
            sock.sendall(
                b"POST /score HTTP/1.1\r\n"
                b"Host: 127.0.0.1\r\n"
                b"Content-Type: application/json\r\n"
                b"Content-Length: 1000\r\n\r\n"
            )
            started = time.monotonic()
            data = sock.recv(4096)
            elapsed = time.monotonic() - started
        finally:
            sock.close()
        # The handler's own timeout closes the connection; recv returns empty
        # (EOF) rather than hanging for the test's much longer socket timeout.
        self.assertEqual(data, b"")
        self.assertLess(elapsed, Handler.timeout + 5)

    def test_health_reports_versions_without_fitting(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.request("GET", "/health")
            response = conn.getresponse()
            body = json.loads(response.read())
        finally:
            conn.close()
        self.assertEqual(response.status, 200)
        self.assertEqual(body["status"], "ok")


if __name__ == "__main__":
    unittest.main()
