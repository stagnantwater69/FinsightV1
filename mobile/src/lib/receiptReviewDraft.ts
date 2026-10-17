import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { FIELD_LIMITS } from "./fieldLimits";
import type { ReconciliationPlan } from "./receiptConfirm";

/**
 * The owner's unsaved corrections to one scanned receipt, kept on this device
 * so an app restart does not throw them away.
 *
 * Only typed and chosen values are stored. Images, upload keys and session
 * tokens never enter a draft, and the slot is keyed by account, business and
 * scan so a draft can only come back to the review it was written for.
 * AuthContext clears an account's drafts when that account signs out.
 */
export interface ReceiptReviewDraftScope { ownerId: number; businessProfileId: number; scanId: number }

export interface ReceiptReviewAddedItem { key: string; name: string; amount: string; categoryId: number | null }

export interface ReceiptReviewEdits {
  date: string;
  description: string;
  vendor: string;
  amount: string;
  categoryId: number | null;
  /** Keyed by extracted item id. */
  itemCategories: Record<number, number | null>;
  addedItems: ReceiptReviewAddedItem[];
  plan: ReconciliationPlan;
  gapCategoryId: number | null;
  /** An item correction typed but not yet sent to the server. */
  editingItem: { id: number; name: string; amount: string } | null;
}

interface StoredDraft { version: 1; scope: ReceiptReviewDraftScope; edits: ReceiptReviewEdits }
type IndexEntry = [businessProfileId: number, scanId: number];

const PREFIX = "finsight.receiptReview.";
const CHUNK_BYTES = 1500;
const MAX_PARTS = 32;
const MAX_DRAFTS = 50;
const MAX_ADDED_ITEMS = 100;
const MAX_TEXT = 1000;
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const queues = new Map<number, Promise<unknown>>();
const generations = new Map<number, number>();
const storage = {
  getItemAsync: (key: string): Promise<string | null> => Platform.OS === "web" ? Promise.resolve(sessionStorage.getItem(key)) : SecureStore.getItemAsync(key, options),
  setItemAsync: (key: string, value: string): Promise<void> => Platform.OS === "web" ? Promise.resolve(sessionStorage.setItem(key, value)) : SecureStore.setItemAsync(key, value, options),
  deleteItemAsync: (key: string): Promise<void> => Platform.OS === "web" ? Promise.resolve(sessionStorage.removeItem(key)) : SecureStore.deleteItemAsync(key, options),
};

const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const nullableId = (value: unknown): value is number | null => value === null || positiveId(value);
const text = (value: unknown, max = MAX_TEXT): value is string => typeof value === "string" && value.length <= max;

function validScope(scope: ReceiptReviewDraftScope): void {
  if (!positiveId(scope.ownerId) || !positiveId(scope.businessProfileId) || !positiveId(scope.scanId)) {
    throw new Error("Choose an account and business before keeping receipt changes.");
  }
}
const indexKey = (ownerId: number) => `${PREFIX}${ownerId}.index`;
const slotKey = (ownerId: number, businessProfileId: number, scanId: number) => `${PREFIX}${ownerId}.${businessProfileId}.${scanId}`;

function serial<T>(ownerId: number, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(ownerId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  queues.set(ownerId, current);
  void current.finally(() => { if (queues.get(ownerId) === current) queues.delete(ownerId); }).catch(() => undefined);
  return current;
}

function utf8Width(character: string): number {
  const point = character.codePointAt(0)!;
  return point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
}

function chunks(value: string): string[] {
  const parts: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const width = utf8Width(character);
    if (bytes + width > CHUNK_BYTES) { parts.push(chunk); chunk = ""; bytes = 0; }
    chunk += character;
    bytes += width;
  }
  if (chunk) parts.push(chunk);
  if (parts.length === 0 || parts.length > MAX_PARTS) throw new Error("These receipt changes are too large to keep on this device.");
  return parts;
}

function verifiedEdits(value: unknown): ReceiptReviewEdits {
  const edits = value as ReceiptReviewEdits | null;
  const added = edits?.addedItems;
  const categories = edits?.itemCategories;
  const editing = edits?.editingItem;
  if (!edits || typeof edits !== "object"
    || !text(edits.date, 32) || !text(edits.description, FIELD_LIMITS.recordDescription) || !text(edits.vendor, FIELD_LIMITS.vendor) || !text(edits.amount, 32)
    || !nullableId(edits.categoryId) || !nullableId(edits.gapCategoryId)
    || ![null, "proportional", "category", "shrink"].includes(edits.plan)
    || !categories || typeof categories !== "object" || Array.isArray(categories)
    || Object.entries(categories).some(([id, category]) => !positiveId(Number(id)) || !nullableId(category))
    || !Array.isArray(added) || added.length > MAX_ADDED_ITEMS
    || added.some((row) => !row || !text(row.key, 100) || !text(row.name) || !text(row.amount, 32) || !nullableId(row.categoryId))
    || (editing !== null && (!editing || !positiveId(editing.id) || !text(editing.name) || !text(editing.amount, 32)))) {
    throw new Error("Saved receipt changes could not be read.");
  }
  return {
    date: edits.date,
    description: edits.description,
    vendor: edits.vendor,
    amount: edits.amount,
    categoryId: edits.categoryId,
    itemCategories: Object.fromEntries(Object.entries(categories).map(([id, category]) => [Number(id), category])),
    addedItems: added.map((row) => ({ key: row.key, name: row.name, amount: row.amount, categoryId: row.categoryId })),
    plan: edits.plan,
    gapCategoryId: edits.gapCategoryId,
    editingItem: editing ? { id: editing.id, name: editing.name, amount: editing.amount } : null,
  };
}

async function readIndex(ownerId: number): Promise<IndexEntry[]> {
  const raw = await storage.getItemAsync(indexKey(ownerId));
  if (!raw) return [];
  const rows: unknown = JSON.parse(raw);
  if (!Array.isArray(rows) || rows.length > MAX_DRAFTS || rows.some((row) => !Array.isArray(row) || row.length !== 2 || !positiveId(row[0]) || !positiveId(row[1]))) {
    throw new Error("Saved receipt changes could not be read.");
  }
  return rows as IndexEntry[];
}

async function readSlot(scope: ReceiptReviewDraftScope): Promise<ReceiptReviewEdits | null> {
  const key = slotKey(scope.ownerId, scope.businessProfileId, scope.scanId);
  const head = await storage.getItemAsync(key);
  if (head === null) return null;
  const header = JSON.parse(head) as { parts?: unknown };
  if (!Number.isSafeInteger(header?.parts) || (header.parts as number) < 1 || (header.parts as number) > MAX_PARTS) throw new Error("Saved receipt changes are incomplete.");
  let raw = "";
  for (let part = 0; part < (header.parts as number); part += 1) {
    const chunk = await storage.getItemAsync(`${key}.${part}`);
    if (chunk === null) throw new Error("Saved receipt changes are incomplete.");
    raw += chunk;
  }
  const stored = JSON.parse(raw) as StoredDraft;
  if (!stored || stored.version !== 1 || !stored.scope
    || stored.scope.ownerId !== scope.ownerId || stored.scope.businessProfileId !== scope.businessProfileId || stored.scope.scanId !== scope.scanId) {
    throw new Error("Saved receipt changes belong to a different receipt.");
  }
  return verifiedEdits(stored.edits);
}

/** How many chunks the slot's header claims; an unreadable header means every slot may be in use. */
async function storedPartCount(key: string): Promise<number> {
  const head = await storage.getItemAsync(key);
  if (head === null) return 0;
  try {
    const parts = (JSON.parse(head) as { parts?: unknown })?.parts;
    return Number.isSafeInteger(parts) && (parts as number) >= 1 && (parts as number) <= MAX_PARTS ? parts as number : MAX_PARTS;
  } catch {
    return MAX_PARTS;
  }
}

async function removeSlot(ownerId: number, businessProfileId: number, scanId: number): Promise<void> {
  const key = slotKey(ownerId, businessProfileId, scanId);
  // The header goes first so a half-removed slot reads as absent, not corrupt.
  await storage.deleteItemAsync(key);
  for (let part = 0; part < MAX_PARTS; part += 1) await storage.deleteItemAsync(`${key}.${part}`);
}

/** Resolves to null when no draft exists; a draft that fails verification is removed. */
export function readReceiptReviewDraft(scope: ReceiptReviewDraftScope): Promise<ReceiptReviewEdits | null> {
  validScope(scope);
  return serial(scope.ownerId, async () => {
    try {
      return await readSlot(scope);
    } catch {
      await removeSlot(scope.ownerId, scope.businessProfileId, scope.scanId).catch(() => undefined);
      return null;
    }
  });
}

export function saveReceiptReviewDraft(scope: ReceiptReviewDraftScope, edits: ReceiptReviewEdits): Promise<void> {
  validScope(scope);
  const generation = generations.get(scope.ownerId) ?? 0;
  return serial(scope.ownerId, async () => {
    if ((generations.get(scope.ownerId) ?? 0) !== generation) throw new Error("The account changed. Receipt changes were not kept.");
    const stored: StoredDraft = { version: 1, scope: { ...scope }, edits: verifiedEdits(JSON.parse(JSON.stringify(edits))) };
    const raw = JSON.stringify(stored);
    const parts = chunks(raw);
    const existing = await readIndex(scope.ownerId);
    const last = existing[existing.length - 1];
    if (!last || last[0] !== scope.businessProfileId || last[1] !== scope.scanId) {
      const index = existing.filter(([business, scan]) => business !== scope.businessProfileId || scan !== scope.scanId);
      // Oldest drafts give way rather than letting the index grow without bound.
      while (index.length >= MAX_DRAFTS) {
        const [business, scan] = index.shift()!;
        await removeSlot(scope.ownerId, business, scan);
      }
      index.push([scope.businessProfileId, scope.scanId]);
      await storage.setItemAsync(indexKey(scope.ownerId), JSON.stringify(index));
    }
    const key = slotKey(scope.ownerId, scope.businessProfileId, scope.scanId);
    const previousParts = await storedPartCount(key);
    for (let part = 0; part < parts.length; part += 1) await storage.setItemAsync(`${key}.${part}`, parts[part]!);
    await storage.setItemAsync(key, JSON.stringify({ parts: parts.length }));
    for (let part = parts.length; part < previousParts; part += 1) await storage.deleteItemAsync(`${key}.${part}`);
    const verified = await readSlot(scope);
    if (!verified || JSON.stringify(verified) !== JSON.stringify(stored.edits)) throw new Error("Receipt changes could not be verified on this device.");
    if ((generations.get(scope.ownerId) ?? 0) !== generation) {
      await removeSlot(scope.ownerId, scope.businessProfileId, scope.scanId);
      throw new Error("The account changed. Receipt changes were not kept.");
    }
  });
}

export function clearReceiptReviewDraft(scope: ReceiptReviewDraftScope): Promise<void> {
  validScope(scope);
  return serial(scope.ownerId, async () => {
    await removeSlot(scope.ownerId, scope.businessProfileId, scope.scanId);
    let index: IndexEntry[] = [];
    try { index = await readIndex(scope.ownerId); } catch { /* An unreadable index is rewritten below. */ }
    await storage.setItemAsync(indexKey(scope.ownerId), JSON.stringify(index.filter(([business, scan]) => business !== scope.businessProfileId || scan !== scope.scanId)));
  });
}

/** Called on sign-out; any save still queued for this account is refused. */
export function clearReceiptReviewDraftsForOwner(ownerId: number): Promise<void> {
  if (!positiveId(ownerId)) return Promise.resolve();
  generations.set(ownerId, (generations.get(ownerId) ?? 0) + 1);
  return serial(ownerId, async () => {
    let index: IndexEntry[] = [];
    try { index = await readIndex(ownerId); } catch { /* Nothing readable to walk; the index itself is still removed. */ }
    for (const [business, scan] of index) await removeSlot(ownerId, business, scan);
    await storage.deleteItemAsync(indexKey(ownerId));
  });
}
