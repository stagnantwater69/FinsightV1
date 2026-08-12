/**
 * Splitting a receipt's tax, service charge or discount across the categories
 * it was spent on.
 *
 * WHY THIS EXISTS AT ALL: a receipt's item lines routinely do not sum to its
 * total. A VAT-exclusive register prints items totalling 1,000.00 under a
 * TOTAL of 1,120.00; a discount line takes 50.00 off. The total is the number
 * that actually left the owner's pocket and was confirmed against the photo,
 * so it is the anchor — the difference has to be accounted for somewhere
 * rather than quietly shrinking the total to match the items, which would
 * under-report the expense.
 *
 * Everything here works in CENTAVOS as integers. Money in floating point does
 * not add up (1200.10 + 800.20 !== 2000.30 in binary), and this module's whole
 * job is making parts sum exactly to a whole.
 */

/**
 * Distributes `totalCentavos` across buckets in proportion to `weights`, such
 * that the returned parts sum to EXACTLY `totalCentavos`.
 *
 * Uses the largest-remainder method. The naive approach — round each share
 * independently — loses or gains centavos: three equal categories sharing
 * 100 centavos each round to 33, summing to 99, and that missing centavo
 * becomes a "PHP 0.01 of the receipt total is not assigned" error the owner
 * cannot do anything about. Here every share is floored first, then the
 * leftover centavos are handed out one each to the buckets with the largest
 * discarded fraction. The result is both exact and the fairest rounding
 * available.
 *
 * Signed: `totalCentavos` may be negative (a discount). Math.floor rounds
 * toward negative infinity for both signs, so the sum of the floors is always
 * <= the target and the leftover to distribute is always >= 0. That keeps one
 * code path for tax and discounts rather than two that could disagree.
 *
 * @param totalCentavos the signed amount to distribute
 * @param weights       one non-negative weight per bucket, in bucket order
 * @returns             one integer centavo amount per bucket, summing to `totalCentavos`
 */
export function allocateProportionally(totalCentavos: number, weights: number[]): number[] {
  if (!Number.isInteger(totalCentavos)) {
    throw new Error("allocateProportionally expects integer centavos");
  }
  if (weights.length === 0) return [];
  if (weights.some((w) => w < 0)) {
    throw new Error("allocateProportionally expects non-negative weights");
  }

  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  /*
   * Zero total weight means every bucket is empty, so proportion is
   * undefined. Falling back to an equal split keeps the function total-
   * preserving instead of throwing at the one moment the caller has no
   * alternative — and an equal split of nothing across nothing is the least
   * surprising reading of "proportional" when all proportions are equal.
   */
  const effective = totalWeight === 0 ? weights.map(() => 1) : weights;
  const effectiveTotal = totalWeight === 0 ? weights.length : totalWeight;

  const exact = effective.map((w) => (totalCentavos * w) / effectiveTotal);
  const floors = exact.map((v) => Math.floor(v));
  const distributed = floors.reduce((sum, v) => sum + v, 0);

  // Always >= 0, because flooring can only ever move a value down.
  let leftover = totalCentavos - distributed;

  // Hand the leftover centavos to the largest discarded fractions first.
  // Ties break on the earlier bucket, so the result is deterministic — the
  // same receipt confirmed twice must produce the same split.
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  const result = [...floors];
  for (const { index } of order) {
    if (leftover <= 0) break;
    result[index] = result[index]! + 1;
    leftover -= 1;
  }

  return result;
}

/** How a receipt's unaccounted-for difference should be dealt with. */
export type ReconciliationMode =
  /** Spread across the item categories in proportion to their subtotals. */
  | { mode: "proportional" }
  /** Filed as its own record under one category (tax/charges only, never a discount). */
  | { mode: "category"; categoryId: number }
  /**
   * No gap to close. Rejected by the caller if a gap actually exists — this
   * is the mode for a receipt whose items already sum to the total, not a way
   * to save an unbalanced one.
   */
  | { mode: "none" };
