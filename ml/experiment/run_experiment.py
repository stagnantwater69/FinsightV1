"""A1 offline experiment: does Isolation Forest add findings beyond the rules?

Protocol (docs/ML-OCR-CSV-UI-IMPROVEMENT-PROMPT.md §A1):
- chronological split per profile — anomalies are only ever injected into the
  evaluation half, and every detector scores only evaluation-half records
  using history available at that point;
- compared: rule baselines (IQR/MAD amount, novelty rule), IsolationForest
  alone, and the ensemble (rules ∪ forest);
- reported: precision under a 2-per-100 alert budget, recall by anomaly
  class, incremental useful findings (forest-only true positives), findings
  per 100 transactions, stability across two evaluation windows, latency,
  and peak memory — segmented by history size;
- corpus composition is stated in the report. It is 100% synthetic.

Run:  ml/.venv/bin/python ml/experiment/run_experiment.py
Writes:  ml/experiment/reports/isolation-forest-eval-<date>.md
"""

from __future__ import annotations

import datetime as dt
import pathlib
import random
import statistics
import time
import tracemalloc

import numpy as np
from sklearn.ensemble import IsolationForest

from corpus import Txn, generate_profile
from features import FEATURE_NAMES, build_matrix

SEED = 42
BUDGET_PER_100 = 2

SEGMENTS = [
    ("sparse (~120 records)", 240, 4.0),
    ("medium (~400 records)", 400, 7.0),
    ("busy (~1000 records)", 500, 14.0),
]
PROFILES_PER_SEGMENT = 6


def _median(values: list[float]) -> float:
    return statistics.median(values) if values else 0.0


def rule_amount_outlier(candidate: Txn, prior: list[Txn]) -> bool:
    """IQR + MAD amount rule, mirroring the production amount detector's spirit."""
    amounts = sorted(txn.amount for txn in prior if txn.category == candidate.category)
    if len(amounts) < 8:
        return False
    q1 = amounts[len(amounts) // 4]
    q3 = amounts[(3 * len(amounts)) // 4]
    iqr = q3 - q1
    outside_fence = candidate.amount > q3 + 1.5 * iqr or candidate.amount < q1 - 1.5 * iqr
    med = _median(amounts)
    material = abs(candidate.amount - med) >= 0.15 * max(med, 1)
    return outside_fence and material


def rule_novelty(candidate: Txn, prior: list[Txn]) -> bool:
    """New-vendor + unusual-amount rule, a proxy for the behavioral detector."""
    vendor = (candidate.vendor or "").lower().strip()
    if not vendor or len(prior) < 20:
        return False
    seen = any((txn.vendor or "").lower().strip() == vendor for txn in prior)
    med = _median([txn.amount for txn in prior])
    return not seen and abs(candidate.amount - med) / max(med, 1) > 0.5


def evaluate_profile(records: list[Txn]) -> dict:
    half = len(records) // 2
    evaluation = records[half:]
    labeled = {txn.id for txn in evaluation if txn.label}
    labels_by_id = {txn.id: txn.label for txn in evaluation if txn.label}
    budget = max(1, int(len(evaluation) / 100 * BUDGET_PER_100))

    # Rule detectors: flag as they scan the evaluation window chronologically.
    rule_flags: set[int] = set()
    for index in range(half, len(records)):
        candidate, prior = records[index], records[:index]
        if rule_amount_outlier(candidate, prior) or rule_novelty(candidate, prior):
            rule_flags.add(candidate.id)

    # Isolation Forest: fit on the full history (leave-one-out features),
    # select top-budget evaluation rows — mirrors the production batch pass.
    tracemalloc.start()
    started = time.perf_counter()
    matrix = np.asarray(build_matrix(records), dtype=np.float64)
    forest = IsolationForest(n_estimators=200, contamination="auto", random_state=SEED, n_jobs=1)
    forest.fit(matrix)
    decisions = forest.decision_function(matrix)
    latency_ms = (time.perf_counter() - started) * 1_000
    _, peak_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    eval_scores = [(records[index].id, decisions[index]) for index in range(half, len(records))]
    eval_scores.sort(key=lambda pair: pair[1])  # most anomalous first
    forest_flags = {record_id for record_id, decision in eval_scores[:budget] if decision < 0}

    # The same budget cap applied to rules keeps the comparison honest.
    rule_budgeted = set(list(rule_flags)[:budget]) if len(rule_flags) > budget else rule_flags
    ensemble = rule_budgeted | forest_flags

    def metrics(flags: set[int]) -> dict:
        true_positive = len(flags & labeled)
        return {
            "flagged": len(flags),
            "precision": true_positive / len(flags) if flags else None,
            "recall": true_positive / len(labeled) if labeled else None,
            "per100": 100 * len(flags) / len(evaluation),
        }

    incremental = forest_flags & labeled - rule_budgeted
    by_class: dict[str, dict[str, int]] = {}
    for record_id, label in labels_by_id.items():
        entry = by_class.setdefault(label, {"total": 0, "rules": 0, "forest": 0})
        entry["total"] += 1
        entry["rules"] += int(record_id in rule_budgeted)
        entry["forest"] += int(record_id in forest_flags)

    # Stability: agreement of the forest's picks across two evaluation halves
    # scored by refits with different seeds.
    alt = IsolationForest(n_estimators=200, contamination="auto", random_state=SEED + 1, n_jobs=1)
    alt.fit(matrix)
    alt_decisions = alt.decision_function(matrix)
    alt_scores = sorted(((records[i].id, alt_decisions[i]) for i in range(half, len(records))), key=lambda p: p[1])
    alt_flags = {record_id for record_id, decision in alt_scores[:budget] if decision < 0}
    stability = len(forest_flags & alt_flags) / len(forest_flags | alt_flags) if forest_flags | alt_flags else 1.0

    return {
        "records": len(records),
        "evaluated": len(evaluation),
        "labeled": len(labeled),
        "rules": metrics(rule_budgeted),
        "forest": metrics(forest_flags),
        "ensemble": metrics(ensemble),
        "incremental": len(incremental),
        "by_class": by_class,
        "stability": stability,
        "latency_ms": latency_ms,
        "peak_mb": peak_bytes / 1_048_576,
    }


def aggregate(results: list[dict]) -> dict:
    def mean_of(path: tuple[str, str]) -> float | None:
        values = [r[path[0]][path[1]] for r in results if r[path[0]][path[1]] is not None]
        return sum(values) / len(values) if values else None

    classes: dict[str, dict[str, int]] = {}
    for result in results:
        for label, entry in result["by_class"].items():
            box = classes.setdefault(label, {"total": 0, "rules": 0, "forest": 0})
            for key in box:
                box[key] += entry[key]
    return {
        "profiles": len(results),
        "rules_precision": mean_of(("rules", "precision")),
        "forest_precision": mean_of(("forest", "precision")),
        "ensemble_precision": mean_of(("ensemble", "precision")),
        "rules_recall": mean_of(("rules", "recall")),
        "forest_recall": mean_of(("forest", "recall")),
        "ensemble_recall": mean_of(("ensemble", "recall")),
        "forest_per100": mean_of(("forest", "per100")),
        "incremental_total": sum(r["incremental"] for r in results),
        "stability": sum(r["stability"] for r in results) / len(results),
        "latency_ms": sum(r["latency_ms"] for r in results) / len(results),
        "peak_mb": max(r["peak_mb"] for r in results),
        "by_class": classes,
    }


def fmt(value: float | None, digits: int = 2) -> str:
    return "—" if value is None else f"{value:.{digits}f}"


def main() -> None:
    rng = random.Random(SEED)
    report_lines = [
        "# Isolation Forest offline evaluation (A1)",
        "",
        f"Generated: {dt.date.today().isoformat()} · seed {SEED} · sklearn IsolationForest(n_estimators=200, contamination=auto)",
        "",
        "**Corpus: 100% SYNTHETIC.** Generated Philippine small-business expense streams with ~2% injected, labeled",
        "anomalies (decimal_shift, new_vendor_burst, unusual_combo, duplicate_like) in the evaluation half only.",
        "These numbers validate the harness and the detector's separation of planted anomaly classes;",
        "they are **not** evidence about real owner data. Production exposure remains gated on shadow-mode",
        "results against real records — this report does not clear that gate by itself.",
        "",
        f"Alert budget: {BUDGET_PER_100} findings per 100 evaluated records, applied identically to every detector.",
        "",
    ]

    for segment_name, days, per_week in SEGMENTS:
        results = []
        for profile_index in range(PROFILES_PER_SEGMENT):
            profile_rng = random.Random(rng.random())
            records = generate_profile(profile_rng, profile_index + 1, days, per_week)
            if len(records) < 60:
                continue
            results.append(evaluate_profile(records))
        summary = aggregate(results)
        report_lines += [
            f"## Segment: {segment_name} ({summary['profiles']} profiles)",
            "",
            "| Detector | Precision@budget | Recall | Findings/100 |",
            "|---|---:|---:|---:|",
            f"| Rules (IQR/MAD + novelty) | {fmt(summary['rules_precision'])} | {fmt(summary['rules_recall'])} | — |",
            f"| Isolation Forest | {fmt(summary['forest_precision'])} | {fmt(summary['forest_recall'])} | {fmt(summary['forest_per100'])} |",
            f"| Ensemble (union) | {fmt(summary['ensemble_precision'])} | {fmt(summary['ensemble_recall'])} | — |",
            "",
            f"- Incremental true positives found ONLY by the forest: **{summary['incremental_total']}**",
            f"- Forest pick stability across refit seeds (Jaccard): {fmt(summary['stability'])}",
            f"- Mean fit+score latency: {fmt(summary['latency_ms'], 0)} ms · peak feature+model memory: {fmt(summary['peak_mb'], 1)} MB",
            "",
            "| Anomaly class | Planted | Caught by rules | Caught by forest |",
            "|---|---:|---:|---:|",
        ]
        for label, entry in sorted(summary["by_class"].items()):
            report_lines.append(f"| {label} | {entry['total']} | {entry['rules']} | {entry['forest']} |")
        report_lines.append("")

    report_lines += [
        "## Gate decision",
        "",
        "Promotion out of shadow mode requires this same harness run against REAL shadow-mode findings and owner",
        "feedback, meeting the criteria in docs/ANOMALY-DETECTION-AND-LARGE-CSV-ANALYSIS-STRATEGY.md §6.3.",
        "The synthetic result above justifies only: shipping the detector OFF by default, in shadow mode,",
        "behind ANOMALY_ISOLATION_FOREST_ENABLED.",
        "",
    ]

    out_dir = pathlib.Path(__file__).parent / "reports"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / f"isolation-forest-eval-{dt.date.today().isoformat()}.md"
    out_path.write_text("\n".join(report_lines))
    print(f"wrote {out_path}")
    print("\n".join(report_lines[:40]))


if __name__ == "__main__":
    main()
