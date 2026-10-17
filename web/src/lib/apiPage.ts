export function apiPage<T>(value: { items: T[]; nextCursor: string | null } | T[]) {
  return Array.isArray(value) ? { items: value, nextCursor: null } : value;
}
