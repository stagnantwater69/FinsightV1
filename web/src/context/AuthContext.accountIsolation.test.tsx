// @vitest-environment jsdom
import { act } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, UserPreferences } from "../lib/types";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  setSession: vi.fn(),
  authChange: { value: null as ((event: string) => void) | null },
  expired: { value: null as (() => void) | null },
}));

vi.mock("../lib/api", () => ({
  api: {
    get: (...args: unknown[]) => mocks.get(...args),
    patch: (...args: unknown[]) => mocks.patch(...args),
    post: vi.fn(async () => ({ data: {} })),
  },
  setSessionExpiredHandler: (handler: (() => void) | null) => { mocks.expired.value = handler; },
}));

vi.mock("../lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "account-a" } } })),
      onAuthStateChange: vi.fn((callback: (event: string) => void) => {
        mocks.authChange.value = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      setSession: (...args: unknown[]) => mocks.setSession(...args),
      signOut: vi.fn(async () => ({})),
    },
  },
}));

const { AuthProvider, useAuth } = await import("./AuthContext");
const { serverStateCacheStats } = await import("../lib/serverStateCache");

const preferences = (showDashboardMascotMessage: boolean): UserPreferences => ({
  showDashboardMascotMessage,
  tourStatus: null,
  tourStep: null,
  tourAlwaysShow: false,
});

const profile = (id: number, email: string, prefs: UserPreferences): Profile => ({
  id,
  firstName: id === 1 ? "Account A" : "Account B",
  middleName: null,
  lastName: "Owner",
  email,
  phoneNumber: null,
  status: "ACTIVE",
  avatarUrl: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  preferences: prefs,
});

const accountA = profile(1, "a@example.com", preferences(true));
const accountB = profile(2, "b@example.com", preferences(false));

let auth!: ReturnType<typeof useAuth>;

function Probe() {
  auth = useAuth();
  return (
    <div>
      <span>{auth.profile?.email ?? "signed-out"}</span>
      <span>{auth.preferences.showDashboardMascotMessage ? "mascot-on" : "mascot-off"}</span>
    </div>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.patch.mockReset();
  mocks.setSession.mockReset().mockResolvedValue({ data: {}, error: null });
  mocks.authChange.value = null;
  mocks.get.mockImplementation(async (path: string) => {
    if (path === "/auth/me") return { data: accountA };
    throw new Error(`unexpected GET ${path}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderAccountA() {
  render(<AuthProvider><Probe /></AuthProvider>);
  await screen.findByText("a@example.com");
}

async function switchToAccountB() {
  mocks.get.mockImplementation(async (path: string) => {
    if (path === "/auth/me") return { data: accountB };
    throw new Error(`unexpected GET ${path}`);
  });
  await act(async () => {
    await auth.adoptSession({
      accessToken: "account-b-access",
      refreshToken: "account-b-refresh",
      profile: accountB,
    });
  });
  await screen.findByText("b@example.com");
}

describe("AuthContext account-generation isolation", () => {
  it.each(["logout", "signed out", "expired"])("clears only chat recovery storage when the session ends through %s", async (ending) => {
    await renderAccountA();
    sessionStorage.setItem("finsight.pendingChatSend.1.1", JSON.stringify({ body: { question: "Private draft" } }));
    sessionStorage.setItem("finsight.pendingChatSend.2.2", JSON.stringify({ body: { question: "Older account draft" } }));
    sessionStorage.setItem("unrelated-visit-setting", "keep");
    await act(async () => {
      if (ending === "logout") await auth.logout();
      else if (ending === "signed out") mocks.authChange.value?.("SIGNED_OUT");
      else mocks.expired.value?.();
    });
    expect(sessionStorage.getItem("finsight.pendingChatSend.1.1")).toBeNull();
    expect(sessionStorage.getItem("finsight.pendingChatSend.2.2")).toBeNull();
    expect(sessionStorage.getItem("unrelated-visit-setting")).toBe("keep");
    expect(screen.getByText("signed-out")).toBeInTheDocument();
  });

  it("keeps the current account when installing another session returns a provider error", async () => {
    await renderAccountA();
    mocks.setSession.mockResolvedValueOnce({ data: { session: null }, error: new Error("Session refused") });
    await act(async () => {
      await expect(auth.adoptSession({
        accessToken: "bad-token", refreshToken: "bad-refresh", profile: accountB,
      })).rejects.toThrow("Session refused");
    });
    expect(screen.getByText("a@example.com")).toBeInTheDocument();
    expect(screen.queryByText("b@example.com")).not.toBeInTheDocument();
    expect(serverStateCacheStats().activeUserId).toBe(String(accountA.id));
  });

  it("drops account A's late profile response after account B becomes active", async () => {
    await renderAccountA();
    const latePatch = deferred<{ data: Profile }>();
    mocks.patch.mockReturnValueOnce(latePatch.promise);

    let pending!: Promise<void>;
    act(() => {
      pending = auth.updateProfile({ firstName: "Account A changed" });
    });
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    await switchToAccountB();

    await act(async () => {
      latePatch.resolve({ data: { ...accountA, firstName: "Account A changed" } });
      await pending;
    });

    expect(screen.getByText("b@example.com")).toBeInTheDocument();
    expect(serverStateCacheStats().activeUserId).toBe(String(accountB.id));
  });

  it("does not let account A's failed preference write roll back account B", async () => {
    await renderAccountA();
    const latePatch = deferred<{ data: UserPreferences }>();
    mocks.patch.mockReturnValueOnce(latePatch.promise);

    let pending!: Promise<void>;
    act(() => {
      pending = auth.updatePreferences({ showDashboardMascotMessage: false });
    });
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    await switchToAccountB();

    await act(async () => {
      latePatch.reject(new Error("account A write failed late"));
      await pending.catch(() => undefined);
    });

    expect(screen.getByText("b@example.com")).toBeInTheDocument();
    expect(screen.getByText("mascot-off")).toBeInTheDocument();
    expect(serverStateCacheStats().activeUserId).toBe(String(accountB.id));
  });

  it("does not resurrect a cold-start account after a signed-out event", async () => {
    const lateProfile = deferred<{ data: Profile }>();
    mocks.get.mockImplementation((path: string) => {
      if (path === "/auth/me") return lateProfile.promise;
      throw new Error(`unexpected GET ${path}`);
    });

    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(mocks.authChange.value).not.toBeNull());
    await act(async () => {
      mocks.authChange.value?.("SIGNED_OUT");
      lateProfile.resolve({ data: accountA });
      await lateProfile.promise;
    });

    await waitFor(() => expect(screen.getByText("signed-out")).toBeInTheDocument());
    expect(serverStateCacheStats().activeUserId).toBeNull();
  });
});
