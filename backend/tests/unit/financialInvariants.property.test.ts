import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { MAX_MONEY_AMOUNT, moneyAmountSchema } from "../../src/lib/money";
import {
  expenseDuplicateKeysOf,
  sameExpenseDuplicateIdentity,
  type ExpenseDuplicateIdentityInput,
} from "../../src/lib/expenseDuplicateIdentity";

/**
 * Generated cases for rules every money path relies on. Each property runs
 * thousands of inputs from a fixed seed, so a failure reproduces exactly; the
 * failing input is in the assertion message.
 */
const RUNS = 2_000;

/** mulberry32: small, fast, and the same sequence on every machine. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(values: readonly T[]) => values[int(0, values.length - 1)]!;
  return { next, int, pick };
}

/** Centavo counts spread across every magnitude the column holds, not just small ones. */
function centavos(rng: ReturnType<typeof random>): number {
  const digits = rng.int(1, 12);
  return Math.max(1, Math.min(rng.int(0, 10 ** digits - 1), MAX_MONEY_AMOUNT * 100));
}

describe("money amounts", () => {
  it("accepts every whole-centavo amount in range, and its centavos survive the round trip exactly", () => {
    const rng = random(1);
    for (let run = 0; run < RUNS; run++) {
      const cents = centavos(rng);
      const amount = cents / 100;
      expect(moneyAmountSchema.safeParse(amount).success, `amount ${amount}`).toBe(true);
      expect(new Prisma.Decimal(amount).mul(100).round().toNumber(), `amount ${amount}`).toBe(cents);
      expect(Math.round(amount * 100), `amount ${amount}`).toBe(cents);
    }
  });

  it("rejects any amount with a genuine third decimal", () => {
    const rng = random(2);
    for (let run = 0; run < RUNS; run++) {
      const mills = rng.int(1, 10 ** rng.int(2, 12)) * 10 + rng.int(1, 9);
      const amount = mills / 1_000;
      if (amount > MAX_MONEY_AMOUNT) continue;
      expect(moneyAmountSchema.safeParse(amount).success, `amount ${amount}`).toBe(false);
    }
  });

  it("sums item lines in centavos exactly as decimal arithmetic does", () => {
    // The reconciliation "do the items add up to the total" is done in
    // Math.round(x * 100) cents throughout; it must never disagree with exact
    // decimal arithmetic for amounts the schema accepts.
    const rng = random(3);
    for (let run = 0; run < RUNS; run++) {
      const items = Array.from({ length: rng.int(1, 40) }, () => rng.int(1, 5_000_000) / 100);
      const floatCents = items.reduce((sum, amount) => sum + Math.round(amount * 100), 0);
      const exact = items.reduce((sum, amount) => sum.add(new Prisma.Decimal(amount)), new Prisma.Decimal(0));
      expect(floatCents, `items ${items.join(",")}`).toBe(exact.mul(100).toNumber());
    }
  });
});

describe("expense duplicate identity", () => {
  const vendors = ["Puregold", "SM Hypermarket", "Aling Nena's Store", "7-Eleven", "", null] as const;
  const descriptions = ["Rice 25kg", "Cooking oil", "Delivery fee", "LPG refill", "", null] as const;
  const dates = ["2026-09-01", "2026-09-02", "2026-09-01T23:30:00.000Z"] as const;
  const amounts = [100, 100.5, 250, 1_234.56] as const;

  function expense(rng: ReturnType<typeof random>): ExpenseDuplicateIdentityInput {
    return { date: rng.pick(dates), amount: rng.pick(amounts), vendor: rng.pick(vendors), description: rng.pick(descriptions) };
  }

  /** The same text as an owner or a spreadsheet might type it differently. */
  function retyped(rng: ReturnType<typeof random>, text: string | null): string | null {
    if (text === null) return null;
    const variants = [
      (value: string) => value.toUpperCase(),
      (value: string) => value.toLowerCase(),
      (value: string) => `  ${value.replace(/ /g, "   ")}  `,
      (value: string) => value.replace(/ /g, " - "),
      (value: string) => value.replace(/[a-z]/gi, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0)),
    ];
    return rng.pick(variants)(text);
  }

  it("agrees with the CSV preview's keys: two expenses share a key exactly when they are the same expense", () => {
    // The preview flags duplicates by key; saving flags them with
    // sameExpenseDuplicateIdentity. If the two ever disagree, the preview
    // promises a duplicate the save will not find, or misses one it will.
    const rng = random(4);
    for (let run = 0; run < RUNS * 2; run++) {
      const left = expense(rng);
      const right = expense(rng);
      const leftKeys = new Set(expenseDuplicateKeysOf(left));
      const sharesKey = expenseDuplicateKeysOf(right).some((key) => leftKeys.has(key));
      expect(sharesKey, JSON.stringify({ left, right })).toBe(sameExpenseDuplicateIdentity(left, right));
    }
  });

  it("is symmetric", () => {
    const rng = random(5);
    for (let run = 0; run < RUNS; run++) {
      const left = expense(rng);
      const right = expense(rng);
      expect(sameExpenseDuplicateIdentity(left, right), JSON.stringify({ left, right }))
        .toBe(sameExpenseDuplicateIdentity(right, left));
    }
  });

  it("ignores case, spacing, punctuation and full-width letters in the vendor and description", () => {
    const rng = random(6);
    for (let run = 0; run < RUNS; run++) {
      const original = expense(rng);
      const copy = {
        ...original,
        vendor: retyped(rng, original.vendor ?? null),
        description: retyped(rng, original.description ?? null),
      };
      const identifiable = Boolean(original.vendor) || Boolean(original.description);
      expect(sameExpenseDuplicateIdentity(original, copy), JSON.stringify({ original, copy })).toBe(identifiable);
    }
  });

  it("never matches across a different calendar day or a different centavo", () => {
    const rng = random(7);
    for (let run = 0; run < RUNS; run++) {
      const original = { ...expense(rng), vendor: "Puregold", description: "Rice 25kg" };
      const nextDay = { ...original, date: "2026-09-03" };
      const offByOne = { ...original, amount: (Math.round(Number(original.amount) * 100) + 1) / 100 };
      expect(sameExpenseDuplicateIdentity(original, nextDay), JSON.stringify(original)).toBe(false);
      expect(sameExpenseDuplicateIdentity(original, offByOne), JSON.stringify(original)).toBe(false);
    }
  });
});
