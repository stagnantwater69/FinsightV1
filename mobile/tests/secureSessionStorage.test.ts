import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ values: new Map<string, string>(), failSet: "" }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => native.values.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    // SecureStore's limit is in bytes; this is the check the adapter must pass.
    if (Buffer.byteLength(value, "utf8") > 2048) throw new Error("Native value exceeds byte limit");
    if (native.failSet && key === native.failSet) throw new Error("Synthetic storage failure");
    native.values.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    native.values.delete(key);
  },
}));

import { secureStoreAdapter, splitUtf8 } from "../src/lib/secureSessionStorage";

const KEY = "sb-test-auth-token";

/** A session-shaped value whose user object is mostly multi-byte text. */
function session(name: string, repeat: number) {
  return JSON.stringify({ access_token: "a".repeat(300), user: { user_metadata: { firstName: name.repeat(repeat) } } });
}

beforeEach(() => {
  native.values.clear();
  native.failSet = "";
});

describe("splitUtf8", () => {
  it("keeps every piece within the byte budget and loses nothing", () => {
    const value = "Peña ₱ 🧾 ".repeat(400);
    const pieces = splitUtf8(value, 1800);

    expect(pieces.join("")).toBe(value);
    for (const piece of pieces) expect(Buffer.byteLength(piece, "utf8")).toBeLessThanOrEqual(1800);
  });

  it("never splits a surrogate pair", () => {
    const pieces = splitUtf8("🧾".repeat(1000), 1801);
    for (const piece of pieces) expect(piece).toBe(Buffer.from(piece, "utf8").toString("utf8"));
  });
});

describe("secureStoreAdapter", () => {
  it("round-trips a session whose characters are wider than one byte", async () => {
    // Under 1,800 characters but over 2,048 bytes: one chunk by length, too big by size.
    const value = session("ñ", 1_100);
    expect(value.length).toBeLessThan(2048);
    expect(Buffer.byteLength(value, "utf8")).toBeGreaterThan(2048);

    await secureStoreAdapter.setItem(KEY, value);

    expect(await secureStoreAdapter.getItem(KEY)).toBe(value);
  });

  it("reads an interrupted rewrite as no session, not as a truncated one", async () => {
    await secureStoreAdapter.setItem(KEY, session("x", 2_000));
    expect(native.values.get(KEY)).toBe("__chunks__:2");

    native.failSet = `${KEY}.2`;
    await expect(secureStoreAdapter.setItem(KEY, session("x", 4_000))).rejects.toThrow();

    expect(await secureStoreAdapter.getItem(KEY)).toBeNull();
  });

  it("removes every chunk on sign-out", async () => {
    await secureStoreAdapter.setItem(KEY, session("é", 3_000));
    await secureStoreAdapter.removeItem(KEY);

    expect([...native.values.keys()]).toEqual([]);
  });
});
