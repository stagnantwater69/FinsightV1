import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { supabase } from "../lib/supabaseClient";
import { api, setSessionExpiredHandler } from "../lib/api";
import { beginServerStateSession, endServerStateSession } from "../lib/serverStateCache";
import { clearChatSendRecovery } from "../lib/chatSendRecovery";
import { clearReceiptReviewDrafts } from "../lib/receiptReviewDraft";
import type { LoginInput, Profile, RegisterInput, UpdateProfileInput, UserPreferences } from "../lib/types";

interface AuthContextValue {
  profile: Profile | null;
  loading: boolean;
  /** True when the session ended on its own rather than by the user logging out. */
  sessionExpired: boolean;
  login: (input: LoginInput) => Promise<void>;
  /**
   * Installs a session this app did NOT get from the login form.
   *
   * The email-confirmation link already carries a proved-identity token pair,
   * and the backend hands back the profile alongside it — so asking that
   * person to type their password again would be asking them to re-prove
   * something they just proved. This is the only other door in: it takes
   * credentials the caller has already verified against the backend and
   * finishes the sign-in exactly as `login` does.
   */
  adoptSession: (input: { accessToken: string; refreshToken: string; profile: Profile }) => Promise<void>;
  /**
   * Returns what to tell the visitor; it does NOT sign them in.
   *
   * Registration is now only a request: the account is pending until its
   * address is confirmed, so there is no session to install and the caller's
   * job is to render a "check your email" state rather than to navigate into
   * the app.
   */
  register: (input: RegisterInput) => Promise<{ message: string }>;
  logout: () => Promise<void>;
  /** Revokes every refresh session and clears this browser after confirmation. */
  logoutEverywhere: () => Promise<void>;
  updateProfile: (input: UpdateProfileInput) => Promise<void>;
  uploadAvatar: (file: File) => Promise<void>;
  /**
   * Account-level preferences — the settings screen, the dashboard greeting
   * and the product tour all read these, and they all read THIS copy.
   *
   * Never null: an account whose preferences have not arrived yet reads as the
   * defaults, so no caller has to branch on a loading state to decide whether
   * to render. `preferencesLoaded` exists for the one caller that genuinely
   * must wait — the tour, which cannot safely reconcile local progress against
   * an answer it does not have yet.
   */
  preferences: UserPreferences;
  preferencesLoaded: boolean;
  /**
   * Writes a PARTIAL preference change, optimistically.
   *
   * Applied in memory first so a switch moves under the finger, then sent; a
   * failure puts the previous value back and rethrows, so the caller can say
   * so. The partial is not a convenience — the tour and the settings toggles
   * write different fields from different places, and a whole-object write
   * from either would clobber the other.
   */
  updatePreferences: (patch: Partial<UserPreferences>) => Promise<void>;
}

/**
 * What an account looks like before its preferences arrive, and what a brand
 * new one gets. The mascot greeting defaults ON: it is the dashboard's opening
 * line today, and a preference that has not loaded yet must not read as "the
 * owner turned this off".
 */
export const DEFAULT_PREFERENCES: UserPreferences = {
  showDashboardMascotMessage: true,
  tourStatus: null,
  tourStep: null,
  tourAlwaysShow: false,
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

interface AccountSessionGuard {
  generation: number;
  userId: number | null;
}

async function fetchProfile(): Promise<Profile | null> {
  try {
    const { data } = await api.get<Profile>("/auth/me");
    return data;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  // `null` is "not loaded", which is why this is not simply seeded with the
  // defaults — the tour has to be able to tell the two apart.
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const sessionGenerationRef = useRef(0);
  const expectedUserIdRef = useRef<number | null>(null);
  const accountRequestControllersRef = useRef(new Set<AbortController>());

  const replaceExpectedAccount = useCallback((userId: number | null): AccountSessionGuard => {
    for (const controller of accountRequestControllersRef.current) controller.abort();
    accountRequestControllersRef.current.clear();
    const generation = ++sessionGenerationRef.current;
    expectedUserIdRef.current = userId;
    return { generation, userId };
  }, []);

  const captureExpectedAccount = useCallback((): AccountSessionGuard => ({
    generation: sessionGenerationRef.current,
    userId: expectedUserIdRef.current,
  }), []);

  const accountIsCurrent = useCallback((guard: AccountSessionGuard): boolean => (
    sessionGenerationRef.current === guard.generation && expectedUserIdRef.current === guard.userId
  ), []);

  const beginAccountRequest = useCallback((): AbortController => {
    const controller = new AbortController();
    accountRequestControllersRef.current.add(controller);
    return controller;
  }, []);

  const finishAccountRequest = useCallback((controller: AbortController) => {
    accountRequestControllersRef.current.delete(controller);
  }, []);

  /*
   * Clearing `profile` is what performs the redirect: ProtectedRoute renders
   * <Navigate to="/login"> the moment there is no profile, so the expiry is
   * handled once here instead of at every call site, and it stays a
   * client-side navigation.
   */
  const signedInRef = useRef(false);
  signedInRef.current = profile !== null;

  useEffect(() => {
    setSessionExpiredHandler(() => {
      // Only announce an expiry to someone who was actually signed in. A 401
      // during the initial profile fetch is just "not logged in", and telling a
      // first-time visitor their session expired would be a lie.
      if (signedInRef.current) setSessionExpired(true);
      clearChatSendRecovery();
      clearReceiptReviewDrafts();
      replaceExpectedAccount(null);
      endServerStateSession();
      setProfile(null);
      setPreferences(null);
      void supabase.auth.signOut({ scope: "local" });
    });
    return () => setSessionExpiredHandler(null);
  }, [replaceExpectedAccount]);

  useEffect(() => {
    let active = true;
    const bootstrapGuard = replaceExpectedAccount(null);
    endServerStateSession();

    /*
     * `loading` MUST end up false on every path, including the failing ones.
     *
     * It gates the whole app: `/` renders null while loading and ProtectedRoute
     * renders "Loading…", so a rejected getSession() — an unreachable Supabase
     * project, a corrupt token in localStorage — used to leave the entire site
     * blank forever with nothing on screen to say why. Treating a failed
     * session read as "signed out" is the honest outcome: we could not
     * establish who the user is, so the app should offer them the login screen
     * rather than hang.
     */
    supabase.auth
      .getSession()
      .then(async ({ data }) => {
        if (!active || !accountIsCurrent(bootstrapGuard)) return;
        if (data.session) {
          const me = await fetchProfile();
          if (!active || !accountIsCurrent(bootstrapGuard) || !me) return;
          replaceExpectedAccount(me.id);
          beginServerStateSession(me.id);
          setProfile(me);
          // A failed /auth/me leaves `profile` null and the app on the login
          // screen, so there is nothing to hold preferences for.
          setPreferences(me.preferences ?? DEFAULT_PREFERENCES);
        }
      })
      .catch((err) => {
        console.error("Could not read the stored session:", err);
        if (active && accountIsCurrent(bootstrapGuard)) setProfile(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const { data: subscription } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        clearChatSendRecovery();
        clearReceiptReviewDrafts();
        replaceExpectedAccount(null);
        endServerStateSession();
        setProfile(null);
        setPreferences(null);
      }
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, [accountIsCurrent, replaceExpectedAccount]);

  /*
   * The shared tail of every sign-in, whatever proved the identity.
   *
   * Shared rather than copied because the ORDER matters and is easy to get
   * subtly wrong on a second write: the Supabase session has to be in place
   * before `profile` is set, or a route guard can wave the owner through a
   * render earlier than api.ts has a bearer token to send.
   */
  async function installSession(
    tokens: { accessToken: string; refreshToken: string },
    nextProfile: Profile
  ) {
    const previousUserId = expectedUserIdRef.current;
    const installGuard = replaceExpectedAccount(nextProfile.id);
    endServerStateSession();
    try {
      const result = await supabase.auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });
      if (result?.error) throw result.error;
    } catch (err) {
      if (accountIsCurrent(installGuard)) {
        replaceExpectedAccount(previousUserId);
        if (previousUserId === null) endServerStateSession();
        else beginServerStateSession(previousUserId);
      }
      throw err;
    }
    if (!accountIsCurrent(installGuard)) return;
    beginServerStateSession(nextProfile.id);
    setSessionExpired(false);
    setPreferences(null);
    setProfile(nextProfile);
    /*
     * POST /auth/login answers with the identity block only — preferences ride
     * on GET /auth/me. Fetched here rather than widening the login response,
     * because mobile ships against that response's current shape.
     *
     * Deliberately not awaited: nothing on the first screen after sign-in is
     * blocked on a preference, and making the owner wait an extra round trip
     * to get past the login form would be paying for the wrong thing. Callers
     * that must wait check `preferencesLoaded`.
     */
    const preferencesController = beginAccountRequest();
    void api
      .get<Profile>("/auth/me", { signal: preferencesController.signal })
      .then(({ data: me }) => {
        if (accountIsCurrent(installGuard) && me.id === installGuard.userId) {
          setPreferences(me.preferences ?? DEFAULT_PREFERENCES);
        }
      })
      .catch(() => {
        if (accountIsCurrent(installGuard)) setPreferences(DEFAULT_PREFERENCES);
      })
      .finally(() => finishAccountRequest(preferencesController));
  }

  async function login(input: LoginInput) {
    const { data } = await api.post<{ profile: Profile; session: { access_token: string; refresh_token: string } }>(
      "/auth/login",
      input
    );
    await installSession(
      { accessToken: data.session.access_token, refreshToken: data.session.refresh_token },
      data.profile
    );
  }

  async function adoptSession(input: { accessToken: string; refreshToken: string; profile: Profile }) {
    await installSession({ accessToken: input.accessToken, refreshToken: input.refreshToken }, input.profile);
  }

  async function register(input: RegisterInput) {
    const { data } = await api.post<{ message: string }>("/auth/register", { ...input, platform: "web" });
    return data;
  }

  async function logout() {
    clearChatSendRecovery();
    clearReceiptReviewDrafts();
    replaceExpectedAccount(null);
    endServerStateSession();
    // Local scope: this browser only. "Log out everywhere" is a separate,
    // deliberate action — see below.
    await api.post("/auth/logout").catch(() => undefined);
    if (expectedUserIdRef.current !== null) return;
    await supabase.auth.signOut({ scope: "local" });
    if (expectedUserIdRef.current !== null) return;
    setSessionExpired(false);
    setProfile(null);
    setPreferences(null);
  }

  async function logoutEverywhere() {
    const previousUserId = expectedUserIdRef.current;
    const logoutGuard = replaceExpectedAccount(null);
    endServerStateSession();
    // Do not clear this browser until the server confirms remote revocation.
    try {
      await api.post("/auth/logout-all");
    } catch (err) {
      if (accountIsCurrent(logoutGuard)) {
        replaceExpectedAccount(previousUserId);
        if (previousUserId !== null) beginServerStateSession(previousUserId);
      }
      throw err;
    }
    if (!accountIsCurrent(logoutGuard)) return;
    clearChatSendRecovery();
    clearReceiptReviewDrafts();
    // Remote revocation is authoritative, so local cleanup is best-effort.
    await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    if (expectedUserIdRef.current !== null) return;
    setSessionExpired(false);
    setProfile(null);
    setPreferences(null);
  }

  async function updateProfile(input: UpdateProfileInput) {
    const account = captureExpectedAccount();
    if (account.userId === null) return;
    const controller = beginAccountRequest();
    try {
      const { data } = await api.patch<Profile>("/auth/me", input, { signal: controller.signal });
      if (account.userId !== null && accountIsCurrent(account) && data.id === account.userId) {
        setProfile(data);
      }
    } finally {
      finishAccountRequest(controller);
    }
  }

  /*
   * IDENTITY IS PART OF THE CONTRACT HERE, not an optimisation.
   *
   * Consumers put this function in dependency arrays — TourContext builds its
   * `persist` callback from it, and an effect calls that callback whenever it
   * changes. Declared as a plain function it was a NEW function on every
   * render of this provider, and it sets state on this provider, so the two
   * fed each other: persist → setPreferences → re-render → new
   * updatePreferences → new persist → the effect fires again. On the dashboard
   * with the guided tour open that ran until React gave up with "Maximum
   * update depth exceeded" (surfacing inside the recharts panels, which were
   * only the deepest thing subscribed), while firing a PATCH per turn of the
   * loop.
   *
   * So: `useCallback` with no dependencies, and the rollback value read from a
   * ref rather than closed over, because a dependency on `preferences` would
   * change identity on every write and rebuild exactly the same cycle.
   */
  const preferencesRef = useRef<UserPreferences | null>(null);
  preferencesRef.current = preferences;

  const updatePreferences = useCallback(async (patch: Partial<UserPreferences>) => {
    const account = captureExpectedAccount();
    if (account.userId === null) return;
    const controller = beginAccountRequest();
    const previous = preferencesRef.current;
    setPreferences((prev) => ({ ...(prev ?? DEFAULT_PREFERENCES), ...patch }));
    try {
      const { data } = await api.patch<UserPreferences>("/auth/me/preferences", patch, {
        signal: controller.signal,
      });
      // The response is the whole preferences object, not the echo of the
      // patch — so this also picks up anything another device changed.
      if (accountIsCurrent(account)) setPreferences(data);
    } catch (err) {
      if (accountIsCurrent(account)) setPreferences(previous);
      throw err;
    } finally {
      finishAccountRequest(controller);
    }
  }, [accountIsCurrent, beginAccountRequest, captureExpectedAccount, finishAccountRequest]);

  async function uploadAvatar(file: File) {
    const account = captureExpectedAccount();
    if (account.userId === null) return;
    const controller = beginAccountRequest();
    const formData = new FormData();
    formData.append("file", file);
    try {
      const { data } = await api.post<Profile>("/auth/me/avatar", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        signal: controller.signal,
      });
      if (account.userId !== null && accountIsCurrent(account) && data.id === account.userId) {
        setProfile(data);
      }
    } finally {
      finishAccountRequest(controller);
    }
  }

  return (
    <AuthContext.Provider
      value={{
        profile,
        loading,
        sessionExpired,
        login,
        adoptSession,
        register,
        logout,
        logoutEverywhere,
        updateProfile,
        uploadAvatar,
        preferences: preferences ?? DEFAULT_PREFERENCES,
        preferencesLoaded: preferences !== null,
        updatePreferences,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
