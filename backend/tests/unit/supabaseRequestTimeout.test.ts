import { afterEach, describe, expect, it, vi } from "vitest";

import { createBoundedFetch, SUPABASE_REQUEST_TIMEOUT_MS, supabaseAdmin } from "../../src/config/supabase";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("supabase request timeout", () => {
  it("aborts a request that never answers, as an ordinary error", async () => {
    // A server that accepted the connection and then went quiet — the shape
    // that used to hold the worker's single pass for undici's ~300s default.
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }));

    await expect(createBoundedFetch(25)("https://example.test/object")).rejects.toThrow(
      /exceeded 25ms and was aborted/,
    );
  });

  it("leaves a caller's own abort as its own error", async () => {
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }));

    const controller = new AbortController();
    const pending = createBoundedFetch(10_000)("https://example.test/object", { signal: controller.signal });
    controller.abort(new Error("caller gave up"));
    await expect(pending).rejects.toThrow("caller gave up");
  });

  it("bounds the real client's calls and surfaces the failure as { error }", async () => {
    let seen: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => {
      seen = init?.signal;
      return Promise.reject(new Error("connection reset"));
    });

    const result = await supabaseAdmin.storage.from("receipts").download("profile/receipt.jpg");

    // The deadline has to reach the client that actually talks to Storage,
    // not just exist in this module.
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(SUPABASE_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SUPABASE_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    // storage-js reports it the way every caller here already handles.
    expect(result.error).toBeTruthy();
    expect(result.data).toBeNull();
  });
});
