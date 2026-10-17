import type { ManualRecordIntent, ManualRecordScope } from "./manualRecordRecovery";

const DATABASE = "finsight.manual-record-recovery.v1";
const STORE = "requests";
const keyFor = (scope: ManualRecordScope) => `${scope.ownerId}:${scope.businessProfileId}:${scope.kind}`;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("This browser cannot store recovery safely. Nothing was sent.")); return; }
    const request = indexedDB.open(DATABASE, 1);
    let refused = false;
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onerror = () => reject(request.error ?? new Error("Browser recovery storage is unavailable."));
    request.onblocked = () => { refused = true; reject(new Error("Browser recovery storage is blocked. Close other FinSight tabs and try again.")); };
    request.onsuccess = () => { if (refused) request.result.close(); else resolve(request.result); };
  });
}

/** The read and conditional write share one transaction across browser tabs. */
export async function webManualRecordTransaction<T>(scope: ManualRecordScope, change: (value: unknown | null) => { result: T; value?: ManualRecordIntent | null }, readonly = false): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = database.transaction(STORE, readonly ? "readonly" : "readwrite", { durability: "strict" }); }
    catch (error) { database.close(); reject(error); return; }
    let result: T;
    let failure: unknown;
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onabort = () => { database.close(); reject(failure ?? transaction.error ?? new Error("Browser recovery could not be committed.")); };
    transaction.onerror = () => { failure ??= transaction.error; };
    const store = transaction.objectStore(STORE);
    const request = store.get(keyFor(scope));
    request.onsuccess = () => {
      try {
        const next = change(request.result ?? null);
        result = next.result;
        if (next.value === null) store.delete(keyFor(scope));
        else if (next.value !== undefined) store.put(next.value, keyFor(scope));
      } catch (error) { failure = error; transaction.abort(); }
    };
  });
}

export async function clearWebManualRecordOwner(ownerId: number): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = database.transaction(STORE, "readwrite", { durability: "strict" }); }
    catch (error) { database.close(); reject(error); return; }
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("Browser recovery could not be cleared.")); };
    const request = transaction.objectStore(STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (String(cursor.key).startsWith(`${ownerId}:`)) cursor.delete();
      cursor.continue();
    };
  });
}
