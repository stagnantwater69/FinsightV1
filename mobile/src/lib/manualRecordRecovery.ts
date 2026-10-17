import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { newIdempotencyKey } from "./csvImport";
import { FIELD_LIMITS } from "./fieldLimits";
import { splitUtf8 } from "./secureSessionStorage";

export type ManualRecordKind = "expense" | "sales";
export interface ManualRecordScope { ownerId: number; businessProfileId: number; kind: ManualRecordKind }
export interface ManualRecordPayload {
  businessProfileId: number;
  date: string;
  description: string;
  amount: number;
  categoryId?: number;
  vendor?: string;
  includedInAvailableFundsBaseline?: boolean;
  availableFundsBaselineAt?: string;
}
export interface ManualRecordDraft { date: string; description: string; amount: string; categoryId?: number | null; vendor?: string }
export interface ManualRecordIntent {
  version: 1;
  scope: ManualRecordScope;
  key: string;
  payload: ManualRecordPayload;
  draft: ManualRecordDraft;
}
interface Header { version: 1; key: string; parts: number }
interface JournalEntry extends Header { businessProfileId: number; kind: ManualRecordKind }

const SAFE_KEY = /^[A-Za-z0-9_-]{8,100}$/;
const CHUNK_BYTES = 1500;
const MAX_PARTS = 64;
const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const ownerOperations = new Map<number, Promise<void>>();

function positiveId(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function validScope(scope: ManualRecordScope): void {
  if (!positiveId(scope.ownerId) || !positiveId(scope.businessProfileId) || !["expense", "sales"].includes(scope.kind)) throw new Error("Choose an account and business before saving.");
}
const slotFor = (scope: ManualRecordScope) => `finsight.manual.${scope.ownerId}.${scope.businessProfileId}.${scope.kind}`;
const journalFor = (ownerId: number) => `finsight.manual.${ownerId}.journal`;
const partFor = (slot: string, header: Header, part: number) => `${slot}.${header.key}.${part}`;

function withOwner<T>(ownerId: number, action: () => Promise<T>): Promise<T> {
  const previous = ownerOperations.get(ownerId) ?? Promise.resolve();
  const result = previous.then(action);
  const settled = result.then(() => undefined, () => undefined);
  ownerOperations.set(ownerId, settled);
  void settled.then(() => { if (ownerOperations.get(ownerId) === settled) ownerOperations.delete(ownerId); });
  return result;
}

/** Split on code points, keeping each native value below the byte ceiling. */
export function manualRecoveryChunks(value: string): string[] {
  const chunks = splitUtf8(value, CHUNK_BYTES);
  if (chunks.length === 0 || chunks.length > MAX_PARTS) throw new Error("This recovery request is too large to store safely. Shorten the entered details before saving.");
  return chunks;
}

function parseHeader(raw: string): Header {
  const header = JSON.parse(raw) as Header;
  if (!header || header.version !== 1 || typeof header.key !== "string" || !SAFE_KEY.test(header.key) || !Number.isInteger(header.parts) || header.parts < 1 || header.parts > MAX_PARTS) throw new Error("Saved recovery details could not be read. Check your records before replacing them.");
  return header;
}

async function readRaw(slot: string): Promise<{ header: Header; raw: string } | null> {
  const pointer = await SecureStore.getItemAsync(slot, options);
  if (pointer === null) return null;
  const header = parseHeader(pointer);
  const chunks: string[] = [];
  for (let part = 0; part < header.parts; part += 1) {
    const chunk = await SecureStore.getItemAsync(partFor(slot, header, part), options);
    if (chunk === null) throw new Error("Saved recovery details are incomplete. Check your records before replacing them.");
    chunks.push(chunk);
  }
  return { header, raw: chunks.join("") };
}

async function removeParts(slot: string, header: Header): Promise<void> {
  for (let part = 0; part < header.parts; part += 1) await SecureStore.deleteItemAsync(partFor(slot, header, part), options);
}

async function writeRaw(slot: string, raw: string, key: string): Promise<Header> {
  const previous = await readRaw(slot);
  const chunks = manualRecoveryChunks(raw);
  const header: Header = { version: 1, key, parts: chunks.length };
  for (let part = 0; part < chunks.length; part += 1) await SecureStore.setItemAsync(partFor(slot, header, part), chunks[part]!, options);
  await SecureStore.setItemAsync(slot, JSON.stringify(header), options);
  const verified = await readRaw(slot);
  if (verified?.raw !== raw || verified.header.key !== key) throw new Error("FinSight could not verify the saved recovery request. Nothing was sent. Try again when device storage is available.");
  // Old journal chunks contain identifiers only; financial chunks are journaled.
  if (previous && previous.header.key !== key) await removeParts(slot, previous.header).catch(() => undefined);
  return header;
}

async function readJournal(ownerId: number): Promise<JournalEntry[]> {
  const stored = await readRaw(journalFor(ownerId));
  if (!stored) return [];
  const rows = JSON.parse(stored.raw) as JournalEntry[];
  if (!Array.isArray(rows) || rows.length > 256 || rows.some((row) => !row || row.version !== 1 || typeof row.key !== "string" || !SAFE_KEY.test(row.key) || !positiveId(row.businessProfileId) || !["expense", "sales"].includes(row.kind) || !Number.isInteger(row.parts) || row.parts < 1 || row.parts > MAX_PARTS)) throw new Error("Saved recovery details could not be read. Check your records before replacing them.");
  return rows;
}

function verifiedIntent(value: unknown, scope: ManualRecordScope): ManualRecordIntent {
  const intent = value as ManualRecordIntent;
  const payload = intent?.payload;
  const draft = intent?.draft;
  const payloadKeys = ["businessProfileId", "date", "description", "amount", "categoryId", "vendor", "includedInAvailableFundsBaseline", "availableFundsBaselineAt"];
  if (!intent || intent.version !== 1 || !intent.scope || intent.scope.ownerId !== scope.ownerId || intent.scope.businessProfileId !== scope.businessProfileId || intent.scope.kind !== scope.kind || typeof intent.key !== "string" || !SAFE_KEY.test(intent.key)
    || !payload || payload.businessProfileId !== scope.businessProfileId || Object.keys(payload).some((key) => !payloadKeys.includes(key))
    || typeof payload.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)
    || typeof payload.description !== "string" || !payload.description.trim() || payload.description.length > FIELD_LIMITS.recordDescription
    || typeof payload.amount !== "number" || !Number.isFinite(payload.amount) || payload.amount <= 0
    || (scope.kind === "expense" && !positiveId(payload.categoryId))
    || (scope.kind === "sales" && (payload.categoryId !== undefined || payload.vendor !== undefined))
    || (payload.vendor !== undefined && (typeof payload.vendor !== "string" || payload.vendor.length > FIELD_LIMITS.vendor))
    || (payload.includedInAvailableFundsBaseline !== undefined && typeof payload.includedInAvailableFundsBaseline !== "boolean")
    || (payload.availableFundsBaselineAt !== undefined && (typeof payload.availableFundsBaselineAt !== "string" || !Number.isFinite(Date.parse(payload.availableFundsBaselineAt))))
    || ((payload.includedInAvailableFundsBaseline !== undefined) !== (payload.availableFundsBaselineAt !== undefined))
    || !draft || draft.date !== payload.date || typeof draft.description !== "string" || draft.description.trim() !== payload.description
    || typeof draft.amount !== "string" || Number(draft.amount) !== payload.amount
    || (scope.kind === "expense" && (draft.categoryId !== payload.categoryId || typeof draft.vendor !== "string" || (draft.vendor.trim() || undefined) !== payload.vendor))) {
    throw new Error("Saved recovery details do not match this account and business. Check your records before replacing them.");
  }
  return Object.freeze({ ...intent, scope: Object.freeze({ ...scope }), payload: Object.freeze({ ...payload }), draft: Object.freeze({ ...draft }) });
}

async function readIntent(scope: ManualRecordScope): Promise<ManualRecordIntent | null> {
  const stored = await readRaw(slotFor(scope));
  if (!stored) {
    const journal = await readJournal(scope.ownerId);
    if (journal.some((row) => row.businessProfileId === scope.businessProfileId && row.kind === scope.kind)) throw new Error("Saved recovery details are incomplete. Check your records before replacing them.");
    return null;
  }
  const intent = verifiedIntent(JSON.parse(stored.raw), scope);
  if (intent.key !== stored.header.key) throw new Error("Saved recovery details could not be verified. Check your records before replacing them.");
  return intent;
}

export class PendingManualRecordError extends Error {
  constructor(public readonly intent: ManualRecordIntent) { super("A previous save still needs checking. Resolve it before saving different details."); }
}

export function readManualRecordIntent(scope: ManualRecordScope): Promise<ManualRecordIntent | null> {
  validScope(scope);
  if (Platform.OS === "web") return import("./manualRecordRecoveryWeb").then(({ webManualRecordTransaction }) => webManualRecordTransaction(scope, (value) => ({ result: value ? verifiedIntent(value, scope) : null }), true));
  return withOwner(scope.ownerId, () => readIntent(scope));
}

/** Save and read back the immutable request before any financial POST. */
export function prepareManualRecordIntent(scope: ManualRecordScope, payload: ManualRecordPayload, draft: ManualRecordDraft): Promise<ManualRecordIntent> {
  validScope(scope);
  if (Platform.OS === "web") return import("./manualRecordRecoveryWeb").then(async ({ webManualRecordTransaction }) => {
    const intent = await webManualRecordTransaction(scope, (value) => {
      if (value) throw new PendingManualRecordError(verifiedIntent(value, scope));
      const next = verifiedIntent(JSON.parse(JSON.stringify({ version: 1, scope, key: newIdempotencyKey(), payload, draft })), scope);
      manualRecoveryChunks(JSON.stringify(next));
      return { result: next, value: next };
    });
    const verified = await readManualRecordIntent(scope);
    if (!verified || JSON.stringify(verified) !== JSON.stringify(intent)) throw new Error("Browser recovery could not be verified. Nothing was sent. Reload recovery before saving.");
    return verified;
  });
  return withOwner(scope.ownerId, async () => {
    const previous = await readIntent(scope);
    if (previous) throw new PendingManualRecordError(previous);
    const intent = verifiedIntent(JSON.parse(JSON.stringify({ version: 1, scope, key: newIdempotencyKey(), payload, draft })), scope);
    const raw = JSON.stringify(intent);
    const parts = manualRecoveryChunks(raw).length;
    const journal = await readJournal(scope.ownerId);
    if (journal.length >= 256) throw new Error("Resolve saved recovery requests before creating another record on this device.");
    await writeRaw(journalFor(scope.ownerId), JSON.stringify([...journal, { version: 1, key: intent.key, parts, businessProfileId: scope.businessProfileId, kind: scope.kind }]), newIdempotencyKey());
    await writeRaw(slotFor(scope), raw, intent.key);
    return intent;
  });
}

export function clearManualRecordIntent(scope: ManualRecordScope, key: string): Promise<void> {
  validScope(scope);
  if (Platform.OS === "web") return import("./manualRecordRecoveryWeb").then(({ webManualRecordTransaction }) => webManualRecordTransaction(scope, (value) => {
    if (value && verifiedIntent(value, scope).key !== key) throw new Error("The saved recovery request changed. Reload this form before continuing.");
    return { result: undefined, value: null };
  }));
  return withOwner(scope.ownerId, async () => {
    const slot = slotFor(scope);
    const stored = await readRaw(slot);
    if (stored && stored.header.key !== key) throw new Error("The saved recovery request changed. Reload this form before continuing.");
    const journal = await readJournal(scope.ownerId);
    const entry = journal.find((row) => row.key === key && row.businessProfileId === scope.businessProfileId && row.kind === scope.kind);
    if (stored) {
      await SecureStore.deleteItemAsync(slot, options);
      if (await SecureStore.getItemAsync(slot, options) !== null) throw new Error("The previous request could not be cleared from device storage.");
    }
    if (entry) await removeParts(slot, entry);
    const remaining = journal.filter((row) => row !== entry);
    await writeRaw(journalFor(scope.ownerId), JSON.stringify(remaining), newIdempotencyKey());
  });
}

/** Explicit owner resolution can clear a corrupt payload using its journal. */
export function discardManualRecordRecovery(scope: ManualRecordScope, expectedKey: string | null): Promise<void> {
  validScope(scope);
  if (Platform.OS === "web") return import("./manualRecordRecoveryWeb").then(({ webManualRecordTransaction }) => webManualRecordTransaction(scope, (value) => {
    if (value) {
      let intent: ManualRecordIntent | null = null;
      try { intent = verifiedIntent(value, scope); } catch { /* Owner explicitly resolves corrupt recovery. */ }
      if (intent && intent.key !== expectedKey) throw new Error("The previous request changed. Reload recovery before clearing it.");
      if (expectedKey && !intent) throw new Error("The previous request changed. Reload recovery before clearing it.");
    }
    return { result: undefined, value: null };
  }));
  return withOwner(scope.ownerId, async () => {
    const journal = await readJournal(scope.ownerId);
    const matches = journal.filter((row) => row.businessProfileId === scope.businessProfileId && row.kind === scope.kind);
    const slot = slotFor(scope);
    const pointer = await SecureStore.getItemAsync(slot, options);
    if (pointer !== null) {
      let header: Header | null = null;
      try { header = parseHeader(pointer); } catch { /* Explicitly resolving unreadable recovery. */ }
      if (expectedKey && header?.key !== expectedKey) throw new Error("The previous request changed. Reload recovery before clearing it.");
      if (!expectedKey && header) {
        let valid = false;
        try { valid = await readIntent(scope) !== null; } catch { /* Its chunks may be corrupt. */ }
        if (valid) throw new Error("A previous request is now available. Reload recovery before clearing it.");
      }
    }
    await SecureStore.deleteItemAsync(slot, options);
    if (await SecureStore.getItemAsync(slot, options) !== null) throw new Error("The previous request could not be cleared from device storage.");
    for (const entry of matches) await removeParts(slot, entry);
    await writeRaw(journalFor(scope.ownerId), JSON.stringify(journal.filter((row) => !matches.includes(row))), newIdempotencyKey());
  });
}

export function isDefiniteManualRecordRejection(error: unknown): boolean {
  const details = error as { status?: unknown; code?: unknown } | null;
  return typeof details?.status === "number" && details.status >= 400 && details.status < 500 && details.status !== 408
    && details.code !== "MANUAL_CREATE_KEY_CONFLICT" && details.code !== "MANUAL_CREATE_RECORD_DELETED";
}

export function verifiedManualRecordResult(value: unknown, scope: ManualRecordScope): number {
  const record = value as { id?: unknown; businessProfileId?: unknown; type?: unknown } | null;
  if (!record || !positiveId(record.id) || record.businessProfileId !== scope.businessProfileId || record.type !== scope.kind) {
    throw new Error("FinSight returned a save result that could not be verified. Keep the previous request and check your records.");
  }
  return record.id;
}

/** Unknown requests survive logout; account deletion erases the owner's journal. */
export function clearManualRecordRecoveryForOwner(ownerId: number): Promise<void> {
  if (!positiveId(ownerId)) return Promise.resolve();
  if (Platform.OS === "web") return import("./manualRecordRecoveryWeb").then(({ clearWebManualRecordOwner }) => clearWebManualRecordOwner(ownerId));
  return withOwner(ownerId, async () => {
    const entries = await readJournal(ownerId);
    for (const entry of entries) {
      const slot = slotFor({ ownerId, businessProfileId: entry.businessProfileId, kind: entry.kind });
      await SecureStore.deleteItemAsync(slot, options);
      await removeParts(slot, entry);
    }
    const journal = await readRaw(journalFor(ownerId));
    await SecureStore.deleteItemAsync(journalFor(ownerId), options);
    if (journal) await removeParts(journalFor(ownerId), journal.header);
  });
}
