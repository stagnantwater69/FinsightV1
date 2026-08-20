"""Synthetic labeled transaction corpus for the Isolation Forest experiment.

EVERY RECORD HERE IS SYNTHETIC. The generator produces plausible Philippine
small-business expense streams (steady suppliers, weekly cadences, month-end
utilities) and injects labeled anomalies on top. Results measured on this
corpus say "the harness works and the detector separates planted anomaly
classes" — they are NOT evidence about real owner data, which is exactly why
the production detector ships in shadow mode. The same harness re-runs
unchanged against exported real shadow findings once they exist.

Anomaly classes injected (label = class name):

- decimal_shift     an amount 10x/100x its pattern (data-entry error)
- new_vendor_burst  several rapid payments to a never-seen vendor
- unusual_combo     normal-looking amount, but new vendor + odd timing +
                    novel description together (the multivariate case
                    rule detectors miss by construction)
- duplicate_like    a near-copy of an earlier record days later
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import random

VENDORS = ["San Miguel", "Puregold", "Meralco", "Manila Water", "LGU Permit", "Wet Market", "Shell Station"]
CATEGORIES = {"inventory": 0, "utilities": 1, "transport": 2, "supplies": 3, "rent": 4}
DESCRIPTIONS = {
    "inventory": ["beverage restock", "dry goods restock", "frozen goods delivery"],
    "utilities": ["electric bill", "water bill"],
    "transport": ["delivery fuel", "tricycle fare"],
    "supplies": ["packaging supplies", "cleaning supplies"],
    "rent": ["stall rent"],
}


@dataclasses.dataclass
class Txn:
    id: int
    category: int
    vendor: str | None
    description: str
    amount: float
    date: dt.date
    source: str  # manual | csv | receipt
    label: str | None  # anomaly class, or None for normal


def generate_profile(rng: random.Random, profile_id: int, days: int, txns_per_week: float) -> list[Txn]:
    """One business's chronological stream with ~2% labeled anomalies."""
    start = dt.date(2025, 6, 1)
    records: list[Txn] = []
    next_id = profile_id * 100_000

    # Steady patterns: each (category, vendor) pair has its own price level.
    patterns = []
    for name, category in CATEGORIES.items():
        vendor = rng.choice(VENDORS)
        base = rng.uniform(300, 5_000)
        patterns.append((name, category, vendor, base))

    day = 0
    while day < days:
        for name, category, vendor, base in patterns:
            if rng.random() < txns_per_week / 7 / len(patterns) * 5:
                next_id += 1
                records.append(
                    Txn(
                        id=next_id,
                        category=category,
                        vendor=vendor if rng.random() > 0.1 else None,
                        description=rng.choice(DESCRIPTIONS[name]),
                        amount=round(base * rng.uniform(0.85, 1.15), 2),
                        date=start + dt.timedelta(days=day),
                        source=rng.choices(["manual", "csv", "receipt"], weights=[6, 2, 2])[0],
                        label=None,
                    )
                )
        day += 1

    records.sort(key=lambda txn: (txn.date, txn.id))

    # Inject ~2% anomalies into the SECOND half only, so a chronological
    # train/evaluate split never trains on an evaluation anomaly.
    half = len(records) // 2
    injectable = list(range(half, len(records)))
    rng.shuffle(injectable)
    count = max(4, len(records) // 50)
    for index in injectable[:count]:
        base = records[index]
        kind = rng.choice(["decimal_shift", "new_vendor_burst", "unusual_combo", "duplicate_like"])
        next_id += 1
        if kind == "decimal_shift":
            records[index] = dataclasses.replace(base, amount=round(base.amount * rng.choice([10, 100]), 2), label=kind)
        elif kind == "new_vendor_burst":
            records[index] = dataclasses.replace(
                base, vendor=f"Unknown Trader {next_id % 97}", amount=round(base.amount * rng.uniform(0.9, 1.4), 2), label=kind
            )
        elif kind == "unusual_combo":
            records[index] = dataclasses.replace(
                base,
                vendor=f"Oddity Ventures {next_id % 89}",
                description="one-off arrangement payment",
                date=base.date + dt.timedelta(days=rng.choice([0, 1])),
                label=kind,
            )
        else:  # duplicate_like
            source = records[max(index - rng.randint(3, 10), 0)]
            records[index] = dataclasses.replace(
                source, id=base.id, date=source.date + dt.timedelta(days=rng.randint(2, 5)), label=kind
            )

    records.sort(key=lambda txn: (txn.date, txn.id))
    return records
