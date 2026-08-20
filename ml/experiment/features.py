"""Python mirror of the if-features-v1 contract, for offline evaluation only.

The production feature builder is the TypeScript one
(backend/src/services/anomalyDetection/isolationForestFeatures.ts); this
mirror exists so the offline experiment can run without a database. Keep the
semantics aligned — the contract test that matters for production is the
TS↔Python wire test, not this file.
"""

from __future__ import annotations

import math

from corpus import Txn

FEATURE_NAMES = [
    "logAmount",
    "amountToCategoryMedian",
    "amountToVendorMedian",
    "categoryMadZ",
    "weekdaySin",
    "weekdayCos",
    "dayOfMonthSin",
    "dayOfMonthCos",
    "daysSinceSimilar",
    "vendorCount7d",
    "vendorCount30d",
    "categoryCount7d",
    "categoryCount30d",
    "vendorIsNew",
    "categoryRarity",
    "descriptionNovelty",
    "sourceCsv",
    "sourceReceipt",
]

RATIO_CAP = 10.0
DAYS_SINCE_CAP = 90.0


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 == 1 else (ordered[middle - 1] + ordered[middle]) / 2


def _bigrams(text: str) -> set[str]:
    normalized = "".join(ch for ch in text.lower() if ch.isalnum() or ch == " ").strip()
    return {normalized[i : i + 2] for i in range(len(normalized) - 1)} if len(normalized) > 1 else set()


def _similarity(a: str, b: str) -> float:
    left, right = _bigrams(a), _bigrams(b)
    if not left or not right:
        return 0.0
    return 2 * len(left & right) / (len(left) + len(right))


def features_for(candidate: Txn, prior: list[Txn]) -> list[float]:
    vendor = (candidate.vendor or "").lower().strip()
    category_amounts = [txn.amount for txn in prior if txn.category == candidate.category]
    vendor_records = [txn for txn in prior if vendor and (txn.vendor or "").lower().strip() == vendor]

    category_median = _median(category_amounts)
    mad = _median([abs(value - category_median) for value in category_amounts])
    mad_z = min(abs(0.6745 * (candidate.amount - category_median) / mad), RATIO_CAP) if len(category_amounts) >= 5 and mad > 0 else 0.0

    def capped_ratio(baseline: float) -> float:
        return RATIO_CAP if baseline <= 0 else min(candidate.amount / baseline, RATIO_CAP)

    similar = [txn for txn in prior if txn.category == candidate.category or (vendor and (txn.vendor or "").lower().strip() == vendor)]
    days_since = DAYS_SINCE_CAP if not similar else min((candidate.date - max(txn.date for txn in similar)).days, DAYS_SINCE_CAP)

    def count_in(records: list[Txn], days: int) -> float:
        return float(sum(1 for txn in records if 0 <= (candidate.date - txn.date).days <= days))

    category_records = [txn for txn in prior if txn.category == candidate.category]
    share = len(category_amounts) / len(prior) if prior else 0.0
    novelty = 1 - max((_similarity(candidate.description, txn.description) for txn in prior), default=0.0)

    weekday = candidate.date.weekday()
    day_of_month = candidate.date.day
    return [
        math.log1p(max(candidate.amount, 0)),
        capped_ratio(category_median),
        capped_ratio(_median([txn.amount for txn in vendor_records])) if vendor_records else RATIO_CAP,
        mad_z,
        math.sin(2 * math.pi * weekday / 7),
        math.cos(2 * math.pi * weekday / 7),
        math.sin(2 * math.pi * (day_of_month - 1) / 31),
        math.cos(2 * math.pi * (day_of_month - 1) / 31),
        float(days_since),
        count_in(vendor_records, 7),
        count_in(vendor_records, 30),
        count_in(category_records, 7),
        count_in(category_records, 30),
        1.0 if vendor and not vendor_records else 0.0,
        max(0.0, 1 - share / 0.05),
        novelty,
        1.0 if candidate.source == "csv" else 0.0,
        1.0 if candidate.source == "receipt" else 0.0,
    ]


def build_matrix(records: list[Txn]) -> list[list[float]]:
    return [features_for(record, records[:index]) for index, record in enumerate(records)]
