export type ServerStateQuery = Record<string, unknown>;

export const SERVER_STATE_STALE_MS = 60_000;
export const SERVER_STATE_CACHE_MS = 10 * 60_000;
export const SERVER_STATE_MAX_ENTRIES = 64;

export interface ServerStateSnapshot<T> {
  key: string | null;
  data: T;
  updatedAt: number;
  stale: boolean;
}

interface CacheEntry<T> extends ServerStateSnapshot<T> {
  key: string;
  path: string;
  query: ServerStateQuery;
  staleAt: number;
  expiresAt: number;
}

interface InFlightEntry<T> {
  path: string;
  query: ServerStateQuery;
  promise: Promise<ServerStateSnapshot<T>>;
}

export interface ServerStateInvalidation {
  pathPrefixes?: string[];
  businessProfileId?: string | number;
}

export interface ServerStateMutationScope {
  businessProfileId: string | number;
}

type CacheEvent =
  | { type: "clear" }
  | ({ type: "invalidate" } & ServerStateInvalidation);

const entries = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, InFlightEntry<unknown>>();
const listeners = new Set<(event: CacheEvent) => void>();

let activeSessionScope: string | null = null;
let sessionSequence = 0;
let cacheGeneration = 0;

function stableValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
      .join(",")}}`;
  }
  if (typeof value === "string") return `s:${JSON.stringify(value)}`;
  if (typeof value === "number") return `n:${String(value)}`;
  if (typeof value === "boolean") return `b:${value ? "1" : "0"}`;
  return `${typeof value}:${String(value)}`;
}

function canonicalQuery(query: ServerStateQuery = {}): string {
  return Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(stableValue(value))}`)
    .join("&");
}

export function beginServerStateSession(userId: string | number): void {
  cacheGeneration += 1;
  entries.clear();
  inFlight.clear();
  activeSessionScope = `user:${String(userId)}|session:${++sessionSequence}`;
  for (const listener of listeners) listener({ type: "clear" });
}

export function clearServerStateCache(): void {
  cacheGeneration += 1;
  entries.clear();
  inFlight.clear();
  activeSessionScope = null;
  for (const listener of listeners) listener({ type: "clear" });
}

export function createServerStateIdentity(path: string, query: ServerStateQuery = {}): string {
  return `GET|${path}|${canonicalQuery(query)}`;
}

export function createServerStateKey(path: string, query: ServerStateQuery = {}): string | null {
  if (!activeSessionScope) return null;
  return `${activeSessionScope}|${createServerStateIdentity(path, query)}`;
}

function pruneExpired(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
}

function touch(key: string, entry: CacheEntry<unknown>): void {
  entries.delete(key);
  entries.set(key, entry);
}

function trimToLimit(): void {
  while (entries.size > SERVER_STATE_MAX_ENTRIES) {
    const oldestKey = entries.keys().next().value as string | undefined;
    if (!oldestKey) return;
    entries.delete(oldestKey);
  }
}

export function peekServerState<T>(
  path: string,
  query: ServerStateQuery = {},
  now = Date.now(),
): ServerStateSnapshot<T> | null {
  const key = createServerStateKey(path, query);
  if (!key) return null;
  pruneExpired(now);
  const entry = entries.get(key) as CacheEntry<T> | undefined;
  if (!entry) return null;
  touch(key, entry as CacheEntry<unknown>);
  return {
    key,
    data: entry.data,
    updatedAt: entry.updatedAt,
    stale: now >= entry.staleAt,
  };
}

export async function fetchServerState<T>({
  path,
  query = {},
  fetcher,
  force = false,
  staleTimeMs = SERVER_STATE_STALE_MS,
  cacheTimeMs = SERVER_STATE_CACHE_MS,
}: {
  path: string;
  query?: ServerStateQuery;
  fetcher: () => Promise<T>;
  force?: boolean;
  staleTimeMs?: number;
  cacheTimeMs?: number;
}): Promise<ServerStateSnapshot<T>> {
  const key = createServerStateKey(path, query);
  if (!key) {
    const data = await fetcher();
    return { key: null, data, updatedAt: Date.now(), stale: false };
  }

  const cached = peekServerState<T>(path, query);
  if (!force && cached && !cached.stale) return cached;

  const pending = inFlight.get(key) as InFlightEntry<T> | undefined;
  if (pending) return pending.promise;

  const generation = cacheGeneration;
  const scope = activeSessionScope;
  let promise: Promise<ServerStateSnapshot<T>>;
  promise = fetcher()
    .then((data) => {
      const updatedAt = Date.now();
      const snapshot: ServerStateSnapshot<T> = { key, data, updatedAt, stale: false };
      if (
        cacheGeneration === generation &&
        activeSessionScope === scope &&
        inFlight.get(key)?.promise === promise
      ) {
        entries.set(key, {
          ...snapshot,
          key,
          path,
          query: { ...query },
          staleAt: updatedAt + Math.max(0, staleTimeMs),
          expiresAt: updatedAt + Math.max(staleTimeMs, cacheTimeMs),
        });
        trimToLimit();
      }
      return snapshot;
    })
    .finally(() => {
      if (inFlight.get(key)?.promise === promise) inFlight.delete(key);
    });

  inFlight.set(key, { path, query: { ...query }, promise } as InFlightEntry<unknown>);
  return promise;
}

function matchesInvalidation(
  path: string,
  query: ServerStateQuery,
  invalidation: ServerStateInvalidation,
): boolean {
  if (invalidation.pathPrefixes?.length && !invalidation.pathPrefixes.some((prefix) => path.startsWith(prefix))) {
    return false;
  }
  if (invalidation.businessProfileId === undefined) return true;
  const scopedBusinessProfileId = query.businessProfileId ?? businessProfileIdFromPath(path);
  return String(scopedBusinessProfileId) === String(invalidation.businessProfileId);
}

export function isServerStateAffected(
  path: string,
  query: ServerStateQuery,
  invalidation: ServerStateInvalidation,
): boolean {
  return matchesInvalidation(path, query, invalidation);
}

export function invalidateServerState(invalidation: ServerStateInvalidation = {}): void {
  for (const [key, entry] of entries) {
    if (matchesInvalidation(entry.path, entry.query, invalidation)) entries.delete(key);
  }
  for (const [key, request] of inFlight) {
    if (matchesInvalidation(request.path, request.query, invalidation)) inFlight.delete(key);
  }
  for (const listener of listeners) listener({ type: "invalidate", ...invalidation });
}

export function invalidateRecordDerivedServerState(
  businessProfileId?: string | number,
): void {
  const financialPositionPrefix = businessProfileId === undefined
    ? "/business-profiles/"
    : `/business-profiles/${encodeURIComponent(String(businessProfileId))}/financial-position`;
  invalidateServerState({
    businessProfileId,
    // A record can raise a notification (a large expense, a possible
    // duplicate), so the list is cleared with the records, as web does.
    pathPrefixes: ["/records", "/dashboard", "/insights", "/notifications", financialPositionPrefix],
  });
}

export function subscribeToServerState(listener: (event: CacheEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function businessProfileIdFrom(body: unknown): string | number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { businessProfileId?: unknown }).businessProfileId;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function businessProfileIdFromPath(path: string): number | undefined {
  const match = path.match(/^\/business-profiles\/(\d+)(?:\/|$)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function invalidateServerStateForMutation(
  method: string,
  path: string,
  body?: unknown,
  scope?: ServerStateMutationScope,
  response?: unknown,
): void {
  if (method === "GET") return;
  const businessProfileId =
    scope?.businessProfileId ?? businessProfileIdFrom(body) ?? businessProfileIdFromPath(path);

  const recordChanged =
    /^\/records\/(expenses|sales)(\/|$)/.test(path) ||
    path === "/records/duplicates/resolve" ||
    path === "/records/csv-imports/confirm" ||
    /^\/records\/receipts\/[^/]+\/confirm$/.test(path);
  const processingStatus =
    response && typeof response === "object"
      ? (response as { processingStatus?: unknown }).processingStatus
      : undefined;
  if (
    path === "/records/csv-imports/confirm" &&
    (processingStatus === "PENDING" || processingStatus === "PROCESSING")
  ) return;
  if (recordChanged) {
    invalidateRecordDerivedServerState(businessProfileId);
    return;
  }

  if (path.startsWith("/records/categories")) {
    invalidateServerState({ businessProfileId, pathPrefixes: ["/dashboard", "/insights"] });
    return;
  }

  if (path.startsWith("/insights/findings")) {
    invalidateServerState({
      businessProfileId,
      pathPrefixes: ["/insights/findings", "/dashboard/summary", "/insights/expense-overview"],
    });
    return;
  }

  if (path.startsWith("/insights/recurring-")) {
    invalidateServerState({
      businessProfileId,
      pathPrefixes: ["/insights/recurring-", "/insights/findings", "/notifications", "/dashboard"],
    });
    return;
  }

  if (path.startsWith("/notifications")) {
    invalidateServerState({ businessProfileId, pathPrefixes: ["/notifications", "/dashboard"] });
    return;
  }

  if (path.startsWith("/insights/reduction-opportunities/feedback")) {
    invalidateServerState({ businessProfileId, pathPrefixes: ["/insights/reduction-opportunities"] });
    return;
  }

  if (path.startsWith("/business-profiles/")) {
    invalidateServerState({ businessProfileId });
  }
}

export function getServerStateCacheStats(): { entries: number; inFlight: number; scoped: boolean } {
  return { entries: entries.size, inFlight: inFlight.size, scoped: activeSessionScope !== null };
}
