import React from "react";
import { Text } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react-native";
import type { Profile } from "../../src/lib/types";
import * as fixtures from "./support/fixtures";

const getSession = vi.fn();
const signOut = vi.fn();
let authEvent: ((event: string) => void) | null = null;
vi.mock("../../src/lib/supabase", () => ({
  API_BASE_URL: "http://localhost:4000/api/v1",
  supabase: { auth: {
    getSession, signOut,
    refreshSession: vi.fn(),
    setSession: vi.fn(async () => ({ error: null })),
    onAuthStateChange: vi.fn((callback: (event: string) => void) => {
      authEvent = callback;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    }),
  } },
}));
vi.mock("../../src/lib/receiptScannerCache", () => ({ clearReceiptScannerCache: vi.fn(async () => 0) }));
const { AuthProvider, useAuth } = await import("../../src/context/AuthContext");
const { BusinessProfileProvider, useBusinessProfiles } = await import("../../src/context/BusinessProfileContext");

const account: Profile = {
  id: 1, firstName: "Synthetic", middleName: null, lastName: "Owner", email: "owner@example.test",
  phoneNumber: null, avatarUrl: null, status: "ACTIVE", createdAt: "2026-01-01T00:00:00.000Z",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function reply(body: unknown) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body } as Response;
}
function BusinessProbe() {
  const business = useBusinessProfiles();
  return <Text>{business.selected?.name ?? (business.loading ? "Loading businesses" : "No business")}</Text>;
}
function AccountProbe() {
  const auth = useAuth();
  return auth.profile
    ? <BusinessProfileProvider><BusinessProbe /></BusinessProfileProvider>
    : <Text>{auth.loading ? "Restoring account" : "Signed out"}</Text>;
}

const originalFetch = globalThis.fetch;
beforeEach(() => {
  authEvent = null;
  getSession.mockReset().mockResolvedValue({ data: { session: { access_token: "synthetic-account" } }, error: null });
  signOut.mockReset().mockResolvedValue({ error: null });
});
afterEach(async () => { await cleanup(); globalThis.fetch = originalFetch; });

describe("auth bootstrap through the real mobile transport", () => {
  it.each(["profile first", "businesses first"])("keeps the parallel business handoff when %s", async (order) => {
    const me = deferred<Response>();
    const businesses = deferred<Response>();
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      if (String(url).endsWith("/auth/me")) return me.promise;
      if (String(url).endsWith("/business-profiles")) return businesses.promise;
      if (String(url).includes("/records/categories")) return Promise.resolve(reply(fixtures.categories));
      throw new Error(`Unexpected local request ${String(url)}`);
    }) as typeof fetch;
    const q = await render(<AuthProvider><AccountProbe /></AuthProvider>);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    if (order === "profile first") {
      await act(() => me.resolve(reply(account)));
      await waitFor(() => expect(q.getByText("Loading businesses")).toBeTruthy());
      await act(() => businesses.resolve(reply([fixtures.businessProfile])));
    } else {
      await act(() => businesses.resolve(reply([fixtures.businessProfile])));
      expect(q.getByText("Restoring account")).toBeTruthy();
      await act(() => me.resolve(reply(account)));
    }
    await waitFor(() => expect(q.getByText(fixtures.businessProfile.name)).toBeTruthy());
    expect(vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => String(url).endsWith("/business-profiles"))).toHaveLength(1);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("drops both late bootstrap results after signout", async () => {
    const me = deferred<Response>();
    const businesses = deferred<Response>();
    globalThis.fetch = vi.fn((url: string | URL | Request) => String(url).endsWith("/auth/me") ? me.promise : businesses.promise) as typeof fetch;
    const q = await render(<AuthProvider><AccountProbe /></AuthProvider>);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    await act(() => { authEvent?.("SIGNED_OUT"); me.resolve(reply(account)); businesses.resolve(reply([fixtures.businessProfile])); });
    await waitFor(() => expect(q.getByText("Signed out")).toBeTruthy());
    expect(q.queryByText(fixtures.businessProfile.name)).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
