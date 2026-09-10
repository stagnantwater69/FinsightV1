/**
 * A v4 UUID that also exists over plain HTTP.
 *
 * `crypto.randomUUID` is gated on a secure context, so on a LAN or staging
 * host served over `http://` it is simply `undefined` — the call threw a
 * TypeError and took the whole action down with it. That is how CSV import
 * became unusable outside localhost: the key is minted the moment a file is
 * chosen, so the page broke before the owner could do anything at all.
 *
 * The order below is deliberate. `randomUUID` first (the real thing where it
 * is available), then `getRandomValues` — which is NOT secure-context gated
 * and so covers plain HTTP with the same quality of randomness — and only
 * then `Math.random`, for an environment with no Web Crypto at all.
 *
 * The output shape is identical in all three cases: a canonical 36-character
 * v4 UUID. Callers using it as an idempotency key can keep treating it as an
 * opaque unique string, and the backend's `min(8).max(100)` bound is met by
 * every branch.
 */
export function randomId(): string {
  const c: Crypto | undefined = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;

  if (typeof c?.randomUUID === "function") {
    return c.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  // Version 4 and the RFC 4122 variant bits, same as randomUUID produces.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) hex.push(bytes[i].toString(16).padStart(2, "0"));

  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}
