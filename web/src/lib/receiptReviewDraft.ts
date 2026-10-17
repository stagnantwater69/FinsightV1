/**
 * Unsaved receipt-review edits, kept so a refresh does not throw away an
 * owner's corrections.
 *
 * Only the owner's edits are stored: field values, category choices, added
 * lines and the gap plan. Never images, upload keys, tokens or the duplicate
 * acknowledgement, which must be given again against a fresh check.
 *
 * sessionStorage, not localStorage: the draft survives a refresh but not the
 * tab, so a shared computer does not keep one owner's figures after they close
 * it. Keys carry the signed-in account, business profile and scan, and every
 * read re-checks all three, so another account or business never restores it.
 */
import { captureServerStateAccount } from "./serverStateCache";
import type { GapPlan } from "./receiptConfirm";

const PREFIX = "finsight.receiptReviewDraft.";
const VERSION = 1;
const MAX_DRAFT_CHARACTERS = 65_536;

type MaybeNumber = number | "";

export interface ReceiptReviewDraftEdits {
  date: string;
  description: string;
  vendor: string;
  amount: MaybeNumber;
  splits: { categoryId: MaybeNumber; amount: MaybeNumber }[];
  itemCategories: Record<number, MaybeNumber>;
  addedItems: { key: string; name: string; amount: MaybeNumber; categoryId: MaybeNumber }[];
  gapPlan: GapPlan;
  gapCategoryId: MaybeNumber;
  keptRepeatItemIds: number[];
  editingItem: { id: number; name: string; amount: MaybeNumber } | null;
}

interface StoredDraft {
  version: number;
  ownerId: string;
  businessProfileId: number;
  scanId: number;
  edits: ReceiptReviewDraftEdits;
}

function storageKey(ownerId: string, businessProfileId: number, scanId: number) {
  return `${PREFIX}${ownerId}.${businessProfileId}.${scanId}`;
}

function currentOwner(): string | null {
  return captureServerStateAccount()?.userId ?? null;
}

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function maybeNumber(value: unknown): value is MaybeNumber {
  return value === "" || (typeof value === "number" && Number.isFinite(value));
}

function maybeId(value: unknown): value is MaybeNumber {
  return value === "" || validId(value);
}

function validEdits(value: unknown): value is ReceiptReviewDraftEdits {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edits = value as Record<string, unknown>;
  const itemCategories = edits.itemCategories;
  const editingItem = edits.editingItem;
  return typeof edits.date === "string"
    && typeof edits.description === "string"
    && typeof edits.vendor === "string"
    && maybeNumber(edits.amount)
    && Array.isArray(edits.splits) && edits.splits.length > 0
    && edits.splits.every((split) => split && typeof split === "object"
      && maybeId((split as Record<string, unknown>).categoryId)
      && maybeNumber((split as Record<string, unknown>).amount))
    && Boolean(itemCategories) && typeof itemCategories === "object" && !Array.isArray(itemCategories)
    && Object.entries(itemCategories as Record<string, unknown>)
      .every(([id, categoryId]) => validId(Number(id)) && maybeId(categoryId))
    && Array.isArray(edits.addedItems)
    && edits.addedItems.every((added) => added && typeof added === "object"
      && typeof (added as Record<string, unknown>).key === "string"
      && typeof (added as Record<string, unknown>).name === "string"
      && maybeNumber((added as Record<string, unknown>).amount)
      && maybeId((added as Record<string, unknown>).categoryId))
    && (edits.gapPlan === null || edits.gapPlan === "proportional" || edits.gapPlan === "category" || edits.gapPlan === "shrink")
    && maybeId(edits.gapCategoryId)
    && Array.isArray(edits.keptRepeatItemIds) && edits.keptRepeatItemIds.every(validId)
    && (editingItem === null || (Boolean(editingItem) && typeof editingItem === "object"
      && validId((editingItem as Record<string, unknown>).id)
      && typeof (editingItem as Record<string, unknown>).name === "string"
      && maybeNumber((editingItem as Record<string, unknown>).amount)));
}

export function readReceiptReviewDraft(businessProfileId: number, scanId: number): ReceiptReviewDraftEdits | null {
  const ownerId = currentOwner();
  if (!ownerId) return null;
  try {
    const raw = sessionStorage.getItem(storageKey(ownerId, businessProfileId, scanId));
    if (!raw || raw.length > MAX_DRAFT_CHARACTERS) return null;
    const stored = JSON.parse(raw) as Partial<StoredDraft>;
    if (stored.version !== VERSION || stored.ownerId !== ownerId
      || stored.businessProfileId !== businessProfileId || stored.scanId !== scanId
      || !validEdits(stored.edits)) return null;
    return stored.edits;
  } catch {
    return null;
  }
}

/** A storage failure only loses the draft; it must never break the review. */
export function saveReceiptReviewDraft(businessProfileId: number, scanId: number, edits: ReceiptReviewDraftEdits) {
  const ownerId = currentOwner();
  if (!ownerId) return;
  const stored: StoredDraft = { version: VERSION, ownerId, businessProfileId, scanId, edits };
  try {
    const serialized = JSON.stringify(stored);
    if (serialized.length > MAX_DRAFT_CHARACTERS) return;
    sessionStorage.setItem(storageKey(ownerId, businessProfileId, scanId), serialized);
  } catch { /* Storage may be full or unavailable. */ }
}

export function removeReceiptReviewDraft(businessProfileId: number, scanId: number) {
  const ownerId = currentOwner();
  if (!ownerId) return;
  try {
    sessionStorage.removeItem(storageKey(ownerId, businessProfileId, scanId));
  } catch { /* Storage may be unavailable in this browser. */ }
}

/** Run on logout and session expiry, alongside the other per-account client state. */
export function clearReceiptReviewDrafts() {
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
  } catch { /* Storage may be unavailable in this browser. */ }
}
