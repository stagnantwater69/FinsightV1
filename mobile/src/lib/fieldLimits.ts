/**
 * How long each free-text field may be, mirroring the server's Zod schemas.
 *
 * WHY THESE EXIST AS CONSTANTS rather than as literals on each input. Every one
 * of them is enforced twice already — by `z.string().max(n)` in the controller,
 * and by the `VARCHAR(n)` column behind it — so nothing here is a security
 * control. What it buys is the same thing authValidation.ts exists for: an
 * owner on a metered phone connection should not pay for a round trip to be
 * told something the form already knew, and a rejection should not arrive after
 * they have typed three paragraphs into a box that let them.
 *
 * A `maxLength` attribute stops the typing at the limit instead, which is the
 * one form of validation that never needs a message.
 *
 * THE FIGURES MUST MATCH THE SERVER. Larger here and the box accepts what the
 * API will refuse; smaller and the box refuses what the API would have taken.
 * Both are pinned in backend/tests/contract/fieldLimits.test.ts against the real
 * schemas, so a column widened on one side fails there rather than in
 * production.
 *
 * Mirrored by web/src/lib/fieldLimits.ts, deliberately rather than shared —
 * the two apps have no build-time relationship, for the reason set out at the
 * top of authValidation.ts.
 */
export const FIELD_LIMITS = {
  /** ExpenseRecord.description / SalesReferenceRecord.description — VARCHAR(255). */
  recordDescription: 255,
  /** ExpenseRecord.vendor — VARCHAR(150). */
  vendor: 150,
  /** BusinessProfile.name — VARCHAR(150). */
  businessName: 150,
  /** BusinessProfile.type — VARCHAR(100). */
  businessType: 100,
  /** ExpenseCategory.name — VARCHAR(100). */
  categoryName: 100,
  /** ExpenseCategory.description — VARCHAR(255). */
  categoryDescription: 255,
  /** RecurringSchedule.label — what the owner calls the payment, VARCHAR(255). */
  recurringScheduleLabel: 255,
  /** CSV import batch title — VARCHAR(150). */
  importTitle: 150,
  /** The Ask FinSight question. Not a column — it is a cost ceiling on the model call. */
  aiQuestion: 500,
  /**
   * Spending Impact's "What are you planning to buy?" box —
   * `purchaseReviewSchema.description` is `z.string().min(3).max(255)`. Not a
   * column either: it is the description the purchase review is written about.
   */
  purchaseDescription: 255,
  /** BusinessOperatingDayOverride.reason — VARCHAR(120). */
  operatingOverrideReason: 120,
} as const;

/**
 * `purchaseDescription` above landed as a three-project edit in one batch —
 * this object, web/src/lib/fieldLimits.ts and the backend probe that now pins
 * the schema against it — because the contract suite asserts
 * `expect(mobileLimits).toEqual(webLimits)` key for key, both ways. Adding a
 * key to one client alone turns that assertion red, so anything added here is
 * added on both sides at once.
 *
 * That is also why `CONVERSATION_TITLE_MAX` is still out of this object — see
 * the note on it in lib/chatStore.ts.
 */
