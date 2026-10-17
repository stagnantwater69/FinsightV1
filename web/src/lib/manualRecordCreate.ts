import { isAxiosError } from "axios";
import { api } from "./api";
import { randomId } from "./uuid";
import { captureServerStateAccount, type ServerStateAccount } from "./serverStateCache";
import type { RecordItem } from "./types";

export type ManualRecordKind = "expense" | "sales";
export interface ManualCreateScope {
  ownerId: number;
  businessProfileId: number;
  kind: ManualRecordKind;
}
export interface ManualCreatePayload {
  businessProfileId: number;
  date: string;
  description: string;
  amount: number;
  categoryId?: number;
  vendor?: string;
  includedInAvailableFundsBaseline?: boolean;
  availableFundsBaselineAt?: string;
}
export interface PendingManualCreate {
  version: 1;
  scope: ManualCreateScope;
  body: ManualCreatePayload & { idempotencyKey: string };
  dispatchCount: number;
  confirmedRecord?: RecordItem;
}

const DATABASE = "finsight-manual-create-v1";
const STORE = "pending";
const deletedOwnerKey = (ownerId: number) => `deleted-owner:${ownerId}`;
const STORAGE_ERROR = "Your save recovery could not be stored. Nothing new was sent. Allow browser storage, then try again.";
const BODY_FIELDS = new Set(["businessProfileId", "date", "description", "amount", "categoryId", "vendor", "includedInAvailableFundsBaseline", "availableFundsBaselineAt", "idempotencyKey"]);

export class ManualCreateCorruptError extends Error {
  readonly fingerprint: string;
  constructor(value: unknown) {
    super("Your previous save recovery could not be read. Check your records, then resolve this business's recovery below.");
    this.fingerprint = JSON.stringify(value);
  }
}

function validAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    && value <= 9_999_999_999.99 && Number(value.toFixed(2)) === value;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function manualCreateScopeKey(scope: ManualCreateScope): string {
  return `${scope.ownerId}:${scope.businessProfileId}:${scope.kind}`;
}

function validRecord(value: unknown, scope: ManualCreateScope): value is RecordItem {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RecordItem>;
  return Number.isSafeInteger(record.id) && Number(record.id) > 0
    && record.businessProfileId === scope.businessProfileId
    && record.type === scope.kind
    && typeof record.description === "string" && record.description.length > 0 && record.description.length <= 255
    && validAmount(record.amount);
}

function decode(value: unknown, scope: ManualCreateScope): PendingManualCreate | null {
  if (value === undefined) return null;
  const pending = value as PendingManualCreate;
  const body = pending?.body;
  const baselineIncluded = body?.includedInAvailableFundsBaseline;
  const baselineAt = body?.availableFundsBaselineAt;
  const validBaseline = (baselineIncluded === undefined && baselineAt === undefined)
    || (typeof baselineIncluded === "boolean" && typeof baselineAt === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(baselineAt) && Number.isFinite(Date.parse(baselineAt)));
  if (!pending || pending.version !== 1 || !pending.scope
    || !Number.isSafeInteger(scope.ownerId) || scope.ownerId <= 0
    || !Number.isSafeInteger(scope.businessProfileId) || scope.businessProfileId <= 0
    || (scope.kind !== "expense" && scope.kind !== "sales")
    || pending.scope.ownerId !== scope.ownerId || pending.scope.businessProfileId !== scope.businessProfileId || pending.scope.kind !== scope.kind
    || !pending.body || pending.body.businessProfileId !== scope.businessProfileId
    || typeof pending.body.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(pending.body.idempotencyKey)
    || !Number.isSafeInteger(pending.dispatchCount) || pending.dispatchCount < 0
    || Object.keys(pending.body).some((key) => !BODY_FIELDS.has(key))
    || !validDate(pending.body.date) || typeof pending.body.description !== "string"
    || pending.body.description.length < 1 || pending.body.description.length > 255
    || !validAmount(pending.body.amount) || !validBaseline
    || (pending.body.vendor !== undefined && (typeof pending.body.vendor !== "string" || pending.body.vendor.length > 150))
    || (scope.kind === "expense" && (!Number.isSafeInteger(pending.body.categoryId) || Number(pending.body.categoryId) <= 0))
    || (scope.kind === "sales" && (pending.body.categoryId !== undefined || pending.body.vendor !== undefined))
    || (pending.confirmedRecord !== undefined && !validRecord(pending.confirmedRecord, scope))) {
    throw new ManualCreateCorruptError(value);
  }
  return pending;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error(STORAGE_ERROR)); return; }
    let refused = false;
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => {
      if (refused) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(new Error(STORAGE_ERROR));
    request.onblocked = () => { refused = true; reject(new Error(STORAGE_ERROR)); };
  });
}

// One read/write transaction prevents two tabs from replacing or deleting each other's intent.
async function transact<T>(scope: ManualCreateScope, update: (pending: PendingManualCreate | null) => {
  value: T; next?: PendingManualCreate | null;
}, corruptFingerprint?: string, readDeleted = false): Promise<T> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = db.transaction(STORE, "readwrite", { durability: "strict" }); }
    catch { db.close(); reject(new Error(STORAGE_ERROR)); return; }
    const store = transaction.objectStore(STORE);
    const key = manualCreateScopeKey(scope);
    const ownerRequest = store.get(deletedOwnerKey(scope.ownerId));
    let result: T;
    let failure: unknown;
    ownerRequest.onsuccess = () => {
      if (ownerRequest.result !== undefined) {
        if (readDeleted) { result = update(null).value; return; }
        failure = new Error("This account was deleted. Its save recovery cannot be recreated.");
        transaction.abort();
        return;
      }
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          let pending: PendingManualCreate | null;
          try { pending = decode(request.result, scope); }
          catch (error) {
            if (!(error instanceof ManualCreateCorruptError) || corruptFingerprint === undefined || error.fingerprint !== corruptFingerprint) throw error;
            pending = null;
          }
          const change = update(pending);
          result = change.value;
          if (change.next === null) store.delete(key);
          else if (change.next !== undefined) store.put(change.next, key);
        } catch (error) { failure = error; transaction.abort(); }
      };
    };
    transaction.oncomplete = () => { db.close(); resolve(result); };
    transaction.onerror = transaction.onabort = () => { db.close(); reject(failure ?? new Error(STORAGE_ERROR)); };
  });
}

export function readPendingManualCreate(scope: ManualCreateScope) {
  return transact(scope, (pending) => ({ value: pending }), undefined, true);
}

export async function clearManualRecordRecoveryForOwner(ownerId: number): Promise<void> {
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) throw new Error("The deleted account's identity could not be verified.");
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = db.transaction(STORE, "readwrite", { durability: "strict" }); }
    catch { db.close(); reject(new Error(STORAGE_ERROR)); return; }
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = transaction.onabort = () => { db.close(); reject(new Error("This browser could not clear the deleted account's save recovery.")); };
    try {
      const store = transaction.objectStore(STORE);
      // The marker also prevents a late response in another tab from restoring private drafts.
      store.put(true, deletedOwnerKey(ownerId));
      const prefix = `${ownerId}:`;
      const request = store.openCursor();
      request.onsuccess = () => {
        try {
          const cursor = request.result;
          if (!cursor) return;
          if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) cursor.delete();
          cursor.continue();
        } catch { transaction.abort(); }
      };
    } catch {
      transaction.abort();
    }
  });
}

export function clearPendingManualCreate(scope: ManualCreateScope, key: string) {
  return transact(scope, (pending) => {
    if (pending && pending.body.idempotencyKey !== key) throw new Error("Another save needs review. Reopen this form before continuing.");
    return { value: undefined, next: null };
  });
}

export function repairCorruptManualCreate(scope: ManualCreateScope, fingerprint: string) {
  return transact(scope, (pending) => {
    if (pending) throw new Error("This recovery changed in another tab. Reopen the form before resolving it.");
    return { value: undefined, next: null };
  }, fingerprint);
}

function definitelyRejected(error: unknown): boolean {
  if (!isAxiosError(error)) return false;
  const status = error.response?.status;
  const code = (error.response?.data as { code?: string } | undefined)?.code;
  return status !== undefined && status >= 400 && status < 500 && status !== 408
    && code !== "MANUAL_CREATE_KEY_CONFLICT" && code !== "MANUAL_CREATE_RECORD_DELETED";
}

export interface ManualCreateResult {
  record: RecordItem;
  pending: PendingManualCreate;
  cleanupPending: boolean;
}

export async function performManualRecordCreate(scope: ManualCreateScope, payload: ManualCreatePayload, options: {
  signal: AbortSignal;
  expectedKey?: string;
  requireFresh?: boolean;
  account?: ServerStateAccount | null;
  isCurrent: () => boolean;
  onPending?: (pending: PendingManualCreate) => void;
}): Promise<ManualCreateResult> {
  const pending = await transact(scope, (existing) => {
    if (options.signal.aborted || !options.isCurrent()) throw new Error("This save belongs to a previous account or business. Reopen the form.");
    if (options.expectedKey && existing?.body.idempotencyKey !== options.expectedKey) {
      throw new Error("This save was resolved in another tab. Check your records before starting a separate save.");
    }
    if (options.requireFresh && existing) throw new Error("Another save needs review. Open the Add form for this business and resolve it before restoring this record.");
    const intent: PendingManualCreate = existing ?? {
      version: 1, scope, body: { ...payload, idempotencyKey: randomId() }, dispatchCount: 0,
    };
    if (existing) decode(intent, scope);
    else {
      try { decode(intent, scope); }
      catch { throw new Error("Check the record's date, description, category and amount before saving. Amounts need no more than two decimal places."); }
    }
    if (intent.body.businessProfileId !== scope.businessProfileId) throw new Error("Choose this record's business before saving.");
    const next = intent.confirmedRecord ? intent : { ...intent, dispatchCount: intent.dispatchCount + 1 };
    return { value: next, next };
  });
  options.onPending?.(pending);
  let record = pending.confirmedRecord;
  if (!record) {
    try {
      if (options.signal.aborted || !options.isCurrent()) throw new Error("This save belongs to a previous account or business. Reopen the form.");
      const { data } = await api.post<RecordItem>(`/records/${scope.kind === "expense" ? "expenses" : "sales"}`, pending.body, {
        signal: options.signal,
        manualCreateAccount: options.account ?? captureServerStateAccount(),
      });
      if (!validRecord(data, scope)) throw new Error("FinSight's save response could not be confirmed. Check your records or retry the original save.");
      record = { ...data, type: scope.kind };
    } catch (error) {
      if (pending.dispatchCount === 1 && definitelyRejected(error)) {
        await transact(scope, (current) => ({
          value: undefined,
          ...(current?.body.idempotencyKey === pending.body.idempotencyKey && current.dispatchCount === 1 && !current.confirmedRecord ? { next: null } : {}),
        })).catch(() => undefined);
      }
      throw error;
    }
  }
  const confirmed = { ...pending, confirmedRecord: record };
  try {
    await transact(scope, (current) => {
      if (current && current.body.idempotencyKey !== pending.body.idempotencyKey) {
        throw new Error("Another save needs review.");
      }
      return { value: undefined, next: confirmed };
    });
    await clearPendingManualCreate(scope, pending.body.idempotencyKey);
    return { record, pending: confirmed, cleanupPending: false };
  } catch {
    return { record, pending: confirmed, cleanupPending: true };
  }
}
