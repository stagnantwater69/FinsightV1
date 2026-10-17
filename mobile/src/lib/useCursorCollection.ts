import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";

type CursorPage<T, C> = { items: T[]; nextCursor: C | null };
type FrontPage<T, C> = { data: CursorPage<T, C> | null; lastUpdatedAt: number | null; refreshing: boolean };

export function useCursorCollection<T, C extends string | number>(
  front: FrontPage<T, C>,
  path: string,
  query: Record<string, string | number | boolean | undefined>,
  scope: string,
  cursorParam: string,
  itemKey: (item: T) => string,
  include: (item: T) => boolean = () => true,
) {
  const [, redraw] = useState(0);
  const sessionRef = useRef<{
    scope: string; anchor: typeof front.data; updatedAt: number | null; wasRefreshing: boolean;
    pages: CursorPage<T, C>[]; seen: Set<C>; loading: boolean; error: string | null; blocked: boolean;
  } | null>(null);
  const previous = sessionRef.current;
  if (!previous || previous.scope !== scope || previous.anchor !== front.data || previous.updatedAt !== front.lastUpdatedAt || (front.refreshing && !previous.wasRefreshing)) {
    sessionRef.current = { scope, anchor: front.data, updatedAt: front.lastUpdatedAt, wasRefreshing: front.refreshing, pages: [], seen: new Set(), loading: false, error: null, blocked: false };
  }
  const session = sessionRef.current!;
  session.wasRefreshing = front.refreshing;
  useEffect(() => () => { sessionRef.current = null; }, []);

  const read = () => {
    const pages = session.anchor ? [session.anchor, ...session.pages] : [];
    const ids = new Set<string>();
    const items = pages.flatMap((page) => page.items).filter((item) => {
      const id = itemKey(item);
      if (ids.has(id)) return false;
      ids.add(id);
      return include(item);
    });
    return { items, ready: session.anchor !== null, cursor: pages.at(-1)?.nextCursor ?? null, loading: session.loading, error: session.error, blocked: session.blocked };
  };

  const loadNext = async (): Promise<boolean> => {
    const cursor = read().cursor;
    if (cursor === null || session.loading || session.blocked || front.refreshing) return false;
    session.loading = true;
    session.error = null;
    redraw((n) => n + 1);
    try {
      const page = await api.get<CursorPage<T, C>>(path, { ...query, [cursorParam]: cursor });
      if (sessionRef.current !== session) return false;
      if (page.nextCursor !== null && (page.nextCursor === cursor || session.seen.has(page.nextCursor))) {
        session.blocked = true;
        throw new Error("The next page did not advance. Refresh this list before continuing.");
      }
      session.seen.add(cursor);
      session.pages.push(page);
      return true;
    } catch (err) {
      if (sessionRef.current === session) session.error = errorMessage(err);
      return false;
    } finally {
      if (sessionRef.current === session) {
        session.loading = false;
        redraw((n) => n + 1);
      }
    }
  };
  return { read, loadNext, session };
}
