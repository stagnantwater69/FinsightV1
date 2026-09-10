import { afterEach, describe, expect, it, vi } from "vitest";

import { randomId } from "./uuid";

/**
 * The CSV importer's replay token, on a page served over plain HTTP.
 *
 * `crypto.randomUUID` is secure-context-only, so on any `http://` host it is
 * simply missing and calling it throws. That call sat in the CSV importer's
 * file-selection handler, which is the first thing an owner does on that
 * page — so choosing a file did nothing at all outside localhost/HTTPS, with
 * a TypeError in a console they will never open.
 *
 * These assert the fallback produces the same KIND of value, not a specific
 * one: it is an opaque unique string the server stores as an idempotency key,
 * and its only requirements are v4 shape, uniqueness, and existing.
 */

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("randomId", () => {
  it("uses crypto.randomUUID when the page has a secure context", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-2222-4333-8444-555555555555" });
    expect(randomId()).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("still returns a v4 uuid when randomUUID is missing (plain HTTP)", () => {
    // Exactly what a browser exposes over http://: Web Crypto is present,
    // `randomUUID` is not.
    const getRandomValues = (array: Uint8Array) => {
      for (let i = 0; i < array.length; i++) array[i] = (i * 37 + 11) % 256;
      return array;
    };
    vi.stubGlobal("crypto", { getRandomValues });

    expect(randomId()).toMatch(V4);
  });

  it("still returns a v4 uuid with no Web Crypto at all", () => {
    vi.stubGlobal("crypto", undefined);
    expect(randomId()).toMatch(V4);
  });

  it("does not repeat itself, so one import cannot replay another", () => {
    vi.stubGlobal("crypto", undefined);
    const ids = new Set(Array.from({ length: 200 }, () => randomId()));
    expect(ids.size).toBe(200);
  });

  it("meets the length bound the confirm endpoint validates (8..100)", () => {
    vi.stubGlobal("crypto", undefined);
    const id = randomId();
    expect(id.length).toBe(36);
  });
});
