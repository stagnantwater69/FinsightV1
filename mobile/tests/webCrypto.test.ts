import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  getRandomValues: vi.fn((array: Uint8Array) => array.fill(7)),
  digest: vi.fn(() => Promise.resolve(new ArrayBuffer(32))),
}));

const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "crypto", original);
});

describe("ensureWebCrypto", () => {
  it("fills in the two calls PKCE needs when the runtime has no Web Crypto (Hermes)", async () => {
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
    const { ensureWebCrypto } = await import("../src/lib/webCrypto");
    ensureWebCrypto();
    const c = globalThis.crypto as unknown as {
      getRandomValues: (a: Uint8Array) => Uint8Array;
      subtle: { digest: (alg: string, data: Uint8Array) => Promise<ArrayBuffer> };
    };
    expect(Array.from(c.getRandomValues(new Uint8Array(3)))).toEqual([7, 7, 7]);
    await expect(c.subtle.digest("SHA-256", new Uint8Array(1))).resolves.toBeInstanceOf(ArrayBuffer);
    await expect(c.subtle.digest("SHA-1", new Uint8Array(1))).rejects.toThrow("Unsupported digest");
  });

  it("leaves a runtime that already has Web Crypto exactly as it was", async () => {
    const getRandomValues = vi.fn();
    const digest = vi.fn();
    Object.defineProperty(globalThis, "crypto", { value: { getRandomValues, subtle: { digest } }, configurable: true, writable: true });
    const { ensureWebCrypto } = await import("../src/lib/webCrypto");
    ensureWebCrypto();
    expect(globalThis.crypto.getRandomValues).toBe(getRandomValues);
    expect(globalThis.crypto.subtle.digest).toBe(digest);
  });
});
