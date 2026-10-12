export const SERVER_STATE_MAX_ENTRIES = 80;
export const SERVER_STATE_STALE_TIME_MS = 30_000;
export const SERVER_STATE_CACHE_TIME_MS = 5 * 60_000;

export interface ServerStateScope {
  resource: string;
  businessProfileId: number | string | null;
  period?: unknown;
  filters?: unknown;
  sort?: unknown;
  pagination?: unknown;
  params?: unknown;
  tags?: readonly string[];
}

export interface ServerStateSnapshot<T> {
  data: T;
  stale: boolean;
  updatedAt: number;
}

export interface ServerStateQueryOptions {
  signal?: AbortSignal;
  staleTimeMs?: number;
  cacheTimeMs?: number;
  force?: boolean;
}

interface CacheEntry {
  data: unknown;
  updatedAt: number;
  staleAt: number;
  expiresAt: number;
  scope: ServerStateScope;
}

interface InFlightRequest {
  controller: AbortController;
  consumers: Set<symbol>;
  promise: Promise<unknown>;
  scope: ServerStateScope;
  settled: boolean;
}

interface SessionScope {
  userId: string;
  generation: number;
}

export interface ServerStateInvalidation {
  businessProfileId?: number | string | null;
  resourcePrefix?: string;
  resourcePrefixes?: readonly string[];
  tags?: readonly string[];
}

export type ServerStateCacheEvent =
  | { type: "clear" }
  | { type: "invalidate"; target: ServerStateInvalidation };

const entries = new Map<string, CacheEntry>();
const inFlight = new Map<string, InFlightRequest>();
const listeners = new Set<(event: ServerStateCacheEvent) => void>();
let activeSession: SessionScope | null = null;
let sessionGeneration = 0;
let cacheRevision = 0;

function normalized(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URLSearchParams) {
    return [...value.entries()].sort(([left], [right]) => left.localeCompare(right));
  }
  if (Array.isArray(value)) return value.map(normalized);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalized(item)]),
    );
  }
  return String(value);
}

function keyFor(scope: ServerStateScope): string | null {
  if (!activeSession) return null;
  return JSON.stringify(
    normalized({
      session: activeSession,
      resource: scope.resource,
      businessProfileId: scope.businessProfileId,
      period: scope.period,
      filters: scope.filters,
      sort: scope.sort,
      pagination: scope.pagination,
      params: scope.params,
    }),
  );
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") return new DOMException("The request was aborted", "AbortError");
  const error = new Error("The request was aborted");
  error.name = "AbortError";
  return error;
}

function clearEntriesAndRequests() {
  cacheRevision += 1;
  entries.clear();
  for (const request of inFlight.values()) request.controller.abort();
  inFlight.clear();
}

function publish(event: ServerStateCacheEvent) {
  for (const listener of [...listeners]) listener(event);
}

/** Start an isolated in-memory cache namespace after authentication succeeds. */
export function beginServerStateSession(userId: number | string) {
  clearEntriesAndRequests();
  sessionGeneration += 1;
  activeSession = { userId: String(userId), generation: sessionGeneration };
  publish({ type: "clear" });
}

/** Clear sensitive data before a session is removed or expires. */
export function endServerStateSession() {
  clearEntriesAndRequests();
  sessionGeneration += 1;
  activeSession = null;
  publish({ type: "clear" });
}

export function clearServerStateCache() {
  clearEntriesAndRequests();
  publish({ type: "clear" });
}

function prune(now: number) {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
  while (entries.size > SERVER_STATE_MAX_ENTRIES) {
    const oldest = entries.keys().next().value as string | undefined;
    if (!oldest) break;
    entries.delete(oldest);
  }
}

export function peekServerState<T>(scope: ServerStateScope, now = Date.now()): ServerStateSnapshot<T> | null {
  const key = keyFor(scope);
  if (!key) return null;
  const entry = entries.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    entries.delete(key);
    return null;
  }

  // Refresh insertion order so the entry cap behaves as an LRU bound.
  entries.delete(key);
  entries.set(key, entry);
  return { data: entry.data as T, stale: entry.staleAt <= now, updatedAt: entry.updatedAt };
}

function attachConsumer<T>(key: string, request: InFlightRequest, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted || request.controller.signal.aborted) return Promise.reject(abortError());
  const consumer = Symbol(key);
  request.consumers.add(consumer);

  return new Promise<T>((resolve, reject) => {
    const release = () => {
      signal?.removeEventListener("abort", onAbort);
      request.controller.signal.removeEventListener("abort", onSharedAbort);
      request.consumers.delete(consumer);
      if (!request.settled && request.consumers.size === 0 && inFlight.get(key) === request) {
        inFlight.delete(key);
        request.controller.abort();
      }
    };
    const onAbort = () => {
      release();
      reject(abortError());
    };
    const onSharedAbort = () => {
      release();
      reject(abortError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    request.controller.signal.addEventListener("abort", onSharedAbort, { once: true });
    request.promise.then(
      (data) => {
        release();
        resolve(data as T);
      },
      (error: unknown) => {
        release();
        reject(error);
      },
    );
  });
}

/** Deduplicate one scoped read and retain it only in memory for a short window. */
export async function queryServerState<T>(
  scope: ServerStateScope,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: ServerStateQueryOptions = {},
): Promise<T> {
  const key = keyFor(scope);
  if (!key) {
    const controller = new AbortController();
    if (options.signal?.aborted) throw abortError();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      return await fetcher(controller.signal);
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  const now = Date.now();
  const cached = peekServerState<T>(scope, now);
  if (!options.force && cached && !cached.stale) return cached.data;

  let request = inFlight.get(key);
  if (!request) {
    const controller = new AbortController();
    const requestSession = activeSession;
    const requestRevision = cacheRevision;
    const staleTimeMs = options.staleTimeMs ?? SERVER_STATE_STALE_TIME_MS;
    const cacheTimeMs = Math.max(staleTimeMs, options.cacheTimeMs ?? SERVER_STATE_CACHE_TIME_MS);
    request = {
      controller,
      consumers: new Set(),
      scope,
      settled: false,
      promise: Promise.resolve(),
    };
    const currentRequest = request;
    request.promise = fetcher(controller.signal)
      .then((data) => {
        if (
          activeSession === requestSession &&
          cacheRevision === requestRevision &&
          inFlight.get(key) === currentRequest
        ) {
          const updatedAt = Date.now();
          entries.delete(key);
          entries.set(key, {
            data,
            updatedAt,
            staleAt: updatedAt + staleTimeMs,
            expiresAt: updatedAt + cacheTimeMs,
            scope,
          });
          prune(updatedAt);
        }
        return data;
      })
      .finally(() => {
        currentRequest.settled = true;
        if (inFlight.get(key) === currentRequest) inFlight.delete(key);
      });
    inFlight.set(key, request);
  }

  return attachConsumer<T>(key, request, options.signal);
}

function matchesInvalidation(scope: ServerStateScope, target: ServerStateInvalidation): boolean {
  if (target.businessProfileId !== undefined && scope.businessProfileId !== target.businessProfileId) return false;
  if (target.resourcePrefix && !scope.resource.startsWith(target.resourcePrefix)) return false;
  if (target.resourcePrefixes?.length && !target.resourcePrefixes.some((prefix) => scope.resource.startsWith(prefix))) {
    return false;
  }
  if (target.tags?.length && !target.tags.some((tag) => scope.tags?.includes(tag))) return false;
  return true;
}

export function isServerStateAffected(
  scope: ServerStateScope,
  target: ServerStateInvalidation,
): boolean {
  return matchesInvalidation(scope, target);
}

/** Remove affected data after a mutation without touching another session. */
export function invalidateServerState(target: ServerStateInvalidation = {}) {
  for (const [key, entry] of entries) {
    if (matchesInvalidation(entry.scope, target)) entries.delete(key);
  }
  for (const [key, request] of inFlight) {
    if (!matchesInvalidation(request.scope, target)) continue;
    request.controller.abort();
    inFlight.delete(key);
  }
  publish({ type: "invalidate", target });
}

export function subscribeToServerState(
  listener: (event: ServerStateCacheEvent) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function serverStateCacheStats() {
  return { entries: entries.size, inFlight: inFlight.size, activeUserId: activeSession?.userId ?? null };
}
