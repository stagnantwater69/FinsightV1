// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const createClient = vi.hoisted(() => vi.fn(() => ({ auth: { stopAutoRefresh: vi.fn() } })));
vi.mock("@supabase/supabase-js", () => ({ createClient }));

beforeEach(() => {
  vi.resetModules();
  createClient.mockClear();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", "public-test-key");
});

describe("authentication client isolation", () => {
  it("keeps URL credentials out of the main session and never persists recovery tokens", async () => {
    const { createRecoveryClient } = await import("./supabaseClient");
    createRecoveryClient();
    expect(createClient).toHaveBeenNthCalledWith(1, expect.any(String), "public-test-key", {
      auth: expect.objectContaining({ detectSessionInUrl: false }),
    });
    expect(createClient).toHaveBeenNthCalledWith(2, expect.any(String), "public-test-key", {
      auth: expect.objectContaining({
        detectSessionInUrl: false, persistSession: true, autoRefreshToken: false,
        storageKey: "finsight-recovery-ephemeral",
      }),
    });
  });

  it("persists only the Google PKCE verifier across redirect and holds session credentials in memory", async () => {
    const { createGoogleAuthClient, disposeIsolatedAuthClient } = await import("./supabaseClient");
    const first = createGoogleAuthClient();
    expect(createGoogleAuthClient()).toBe(first);
    expect(createClient).toHaveBeenCalledTimes(2);
    const options = (createClient.mock.calls as unknown as Array<[string, string, {
      auth: { flowType: string; detectSessionInUrl: boolean; storageKey: string; storage: {
        getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void;
      } };
    }]>)[1][2];
    expect(options.auth.flowType).toBe("pkce");
    expect(options.auth.detectSessionInUrl).toBe(false);
    const verifierKey = `${options.auth.storageKey}-code-verifier`;
    options.auth.storage.setItem(verifierKey, "secret-verifier");
    options.auth.storage.setItem(options.auth.storageKey, "access-and-refresh-tokens");
    expect(window.sessionStorage.getItem(verifierKey)).toBe("secret-verifier");
    expect(window.sessionStorage.getItem(options.auth.storageKey)).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(options.auth.storage.getItem(options.auth.storageKey)).toBe("access-and-refresh-tokens");
    disposeIsolatedAuthClient(first);
    expect(window.sessionStorage.length).toBe(0);
    expect(options.auth.storage.getItem(options.auth.storageKey)).toBeNull();
  });
});
