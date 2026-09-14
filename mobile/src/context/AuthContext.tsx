import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorMessage, setSessionEndedHandler, type SessionEndReason } from "../lib/api";
import { supabase } from "../lib/supabase";
import { commitPreferences, DEFAULT_PREFERENCES } from "../lib/preferences";
import { clearReceiptScannerCache } from "../lib/receiptScannerCache";
import type {
  BusinessProfile,
  LoginInput,
  Profile,
  RegisterInput,
  UpdateProfileInput,
  UserPreferences,
} from "../lib/types";

/**
 * Session state.
 *
 * Same flow as web — the backend owns registration and login, Supabase owns the
 * session — but the session lands in the device keystore rather than
 * localStorage (see lib/supabase.ts).
 */
interface AuthValue {
  profile: Profile | null;
  loading: boolean;
  login: (input: LoginInput) => Promise<void>;
  /**
   * Signs the owner in from a session somebody else already established.
   *
   * WHY THIS IS NOT `login` WITH DIFFERENT ARGUMENTS: there is nothing left to
   * authenticate. Confirming an email and exchanging a handoff code both end
   * with the backend handing back a real session and the profile it belongs
   * to, and asking for a password at that point would be asking someone to
   * prove again what they just proved through their inbox. It is the SAME tail
   * `login` runs — keystore, profile, preferences — so the two can never drift
   * into signing people in differently.
   */
  adoptSession: (
    session: { access_token: string; refresh_token: string },
    profile: Profile,
  ) => Promise<void>;
  /**
   * Returns what to tell the owner; it does NOT sign them in.
   *
   * Registration is now only a request: the account stays pending until its
   * address is confirmed, so there is no session to store and the caller's job
   * is to render a "check your email" state rather than to enter the app.
   */
  register: (input: RegisterInput) => Promise<{ message: string }>;
  /** Signs out this phone only. */
  logout: () => Promise<void>;
  /** Ends every session on every device, including this one. */
  logoutEverywhere: () => Promise<void>;
  updateProfile: (input: UpdateProfileInput) => Promise<void>;
  /**
   * Replaces the cached profile with one the server just returned.
   *
   * Used by the avatar upload, which POSTs multipart and gets the updated
   * profile back — re-fetching /auth/me afterwards would be a second round
   * trip for data already in hand.
   */
  setProfileFromServer: (updated: Profile) => void;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  /**
   * Hands over the business-profile list that was fetched *alongside*
   * /auth/me during the cold-start bootstrap — or null when there is none.
   *
   * WHY THIS EXISTS: /business-profiles needs nothing that /auth/me returns.
   * It takes no arguments and no query params, and the server scopes it by
   * the bearer token (`requireAuth` → `req.user!.id`), so waiting for the
   * profile before asking for it was a round trip spent for nothing. The two
   * are now issued together. BusinessProfileProvider still mounts only after
   * the session is known good, by which point that second request is already
   * in flight; this is how it collects the answer instead of asking again.
   *
   * Consumed once. The second caller — and every caller after a logout —
   * gets null and fetches normally, so a list can never outlive the session
   * it was fetched for.
   */
  takeBootstrapProfiles: () => Promise<BusinessProfile[]> | null;
  /**
   * Account-level preferences — Settings, Home's greeting panel and the
   * product tour all read these, and they all read THIS copy.
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
   * Writes a PARTIAL preference change, optimistically; rejects, having put
   * the previous value back, if the account refuses it. See lib/preferences.ts
   * for why it is partial and why it rolls back.
   */
  updatePreferences: (patch: Partial<UserPreferences>) => Promise<void>;
  /**
   * Why the app signed the owner out without being asked, or null.
   *
   * Read by the login screen, which is the only place it can be shown: by the
   * time it is set the authenticated shell has already been replaced. Cleared
   * by the next successful sign-in.
   */
  sessionEnded: SessionEndReason | null;
}

const AuthContext = createContext<AuthValue | undefined>(undefined);

// A stale LAN address must not make a stored session hold the launch screen
// until Android's TCP stack eventually gives up. This only bounds the cold-
// start identity check; ordinary requests keep their endpoint-appropriate
// lifetimes, and uploads retain their separate two-minute timeout.
const BOOTSTRAP_PROFILE_TIMEOUT_MS = 10_000;

async function fetchProfile(): Promise<Profile | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BOOTSTRAP_PROFILE_TIMEOUT_MS);
  try {
    return await api.get<Profile>("/auth/me", undefined, controller.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  // `null` is "not loaded", which is why this is not simply seeded with the
  // defaults — the tour has to be able to tell the two apart before it decides
  // whether to take over someone's screen.
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [sessionEnded, setSessionEnded] = useState<SessionEndReason | null>(null);
  const bootstrapProfiles = useRef<Promise<BusinessProfile[]> | null>(null);

  /*
   * Whether there was a session to lose, read at the moment the transport
   * reports one ending. A ref rather than the state itself because the handler
   * below is registered once and would otherwise close over `profile` as it
   * stood on mount — which is always null.
   */
  const signedInRef = useRef(false);
  signedInRef.current = profile !== null;

  /**
   * What the app does about a session the server has already ended.
   *
   * CLEARING `profile` IS THE NAVIGATION. App.tsx renders AuthStack the moment
   * there is no profile, so the redirect is one line here instead of a check at
   * every call site, and no navigator has to be reachable from the transport.
   *
   * THE ANNOUNCEMENT IS CONDITIONAL, the sign-out is not. A 401 during the
   * cold-start /auth/me is just "this stored token is no longer any good" — the
   * owner was never signed in this session and telling them their session
   * expired would be a lie — but the dead token must still leave the keystore.
   *
   * NO LOOP ON THE AUTH SCREENS. Every request the signed-out shell can make is
   * a credential check (`CREDENTIAL_ENDPOINTS`), so their 401s never reach this
   * at all; and when it does run with nothing signed in it sets no state, so
   * there is no re-render to trigger it again.
   */
  useEffect(() => {
    setSessionEndedHandler((reason) => {
      if (signedInRef.current) setSessionEnded(reason);
      bootstrapProfiles.current = null;
      setProfile(null);
      setPreferences(null);
      void supabase.auth.signOut();
      void clearReceiptScannerCache();
    });
    return () => setSessionEndedHandler(null);
  }, []);

  const takeBootstrapProfiles = useCallback(() => {
    const pending = bootstrapProfiles.current;
    bootstrapProfiles.current = null;
    return pending;
  }, []);

  useEffect(() => {
    let active = true;

    // Restoring from the keystore is async and can be slow on a cold start, so
    // the splash/loading state is held until it resolves rather than briefly
    // showing Login to an already-signed-in user.
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!active || !data.session) return;

        // Issued here and deliberately NOT awaited. The gate below waits on
        // /auth/me alone, so the two requests overlap and the shell appears
        // after the slower of the two rather than after both in series.
        const profiles = api.get<BusinessProfile[]>("/business-profiles");
        // This result is dropped whenever the session turns out to be
        // unusable. A dropped rejection with no handler attached would be
        // reported as an unhandled one, so it gets a handler immediately;
        // the original promise still rejects for its real consumer.
        profiles.catch(() => undefined);

        const me = await fetchProfile();
        if (!active || !me) return;

        // Handed over only once /auth/me has said who the token belongs to.
        // If it failed, `me` is null, the app shows Login, and the list is
        // discarded unread — there is no state in which business data is
        // shown to someone the app could not identify.
        bootstrapProfiles.current = profiles;
        setProfile(me);
        // Preferences ride on /auth/me, so the cold start pays nothing extra
        // for them.
        setPreferences(me.preferences ?? DEFAULT_PREFERENCES);
      } finally {
        if (active) setLoading(false);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        bootstrapProfiles.current = null;
        setProfile(null);
        setPreferences(null);
        void clearReceiptScannerCache();
      }
    });

    return () => {
      active = false;
      bootstrapProfiles.current = null;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function adoptSession(session: { access_token: string; refresh_token: string }, p: Profile) {
    // The backend returns the session; hand it to supabase-js so it persists it
    // to the keystore and takes over refreshing.
    await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    setProfile(p);
    // The banner on the login screen has done its job the moment a sign-in
    // succeeds; leaving it set would show it again on the next sign-out.
    setSessionEnded(null);
    /*
     * POST /auth/login answers with the identity block only — preferences ride
     * on GET /auth/me, and web does the same rather than widening the login
     * response both clients ship against.
     *
     * Deliberately not awaited: nothing on the first screen after sign-in is
     * blocked on a preference, and making the owner wait an extra round trip
     * to get past the login form would be paying for the wrong thing. The one
     * caller that must wait checks `preferencesLoaded`.
     */
    void api
      .get<Profile>("/auth/me")
      .then((me) => setPreferences(me.preferences ?? DEFAULT_PREFERENCES))
      .catch(() => setPreferences(DEFAULT_PREFERENCES));
  }

  async function login(input: LoginInput) {
    const data = await api.post<{ profile: Profile; session: { access_token: string; refresh_token: string } }>(
      "/auth/login",
      input
    );
    await adoptSession(data.session, data.profile);
  }

  async function register(input: RegisterInput) {
    return api.post<{ message: string }>("/auth/register", { ...input, platform: "mobile" });
  }

  /**
   * Signs out THIS PHONE. `logoutEverywhere` is the other one.
   *
   * These were a single action with global scope, so tapping "Log out" here
   * also ended the session on the tablet behind the shop counter, silently and
   * with nothing on either screen to explain it. Two actions, so the two
   * intentions can be told apart and the destructive one has to be chosen.
   */
  async function logout() {
    try {
      await api.post("/auth/logout");
    } catch {
      // A failed server-side logout must not strand the user in a signed-in
      // shell — clear the local session regardless.
    }
    await clearLocalSession();
  }

  async function logoutEverywhere() {
    try {
      await api.post("/auth/logout-all");
    } catch {
      // Same reasoning as logout(): the local session goes either way.
    }
    await clearLocalSession();
  }

  async function clearLocalSession() {
    await clearReceiptScannerCache();
    await supabase.auth.signOut();
    // Nothing fetched under the old token may survive into the next session.
    bootstrapProfiles.current = null;
    setProfile(null);
    setPreferences(null);
    // Cleared LAST, and deliberately. Logging out with an already-dead token
    // makes POST /auth/logout answer 401, which sets this on the way past — and
    // an owner who tapped "Log out" must not then be told their session expired
    // as though something had gone wrong.
    setSessionEnded(null);
  }

  async function updateProfile(input: UpdateProfileInput) {
    setProfile(await api.patch<Profile>("/auth/me", input));
  }

  /*
   * STABLE IDENTITY, deliberately — hence the ref rather than reading
   * `preferences` from the closure.
   *
   * TourContext holds this in a `useCallback` and lists that callback in an
   * effect's dependencies. A function rebuilt on every render would change
   * that dependency every time a preference write re-rendered this provider,
   * which is a PATCH per render for as long as the tour is on screen. The ref
   * carries the current value in without putting it in the identity.
   */
  const preferencesRef = useRef<UserPreferences | null>(null);
  preferencesRef.current = preferences;

  const updatePreferences = useCallback(async (patch: Partial<UserPreferences>) => {
    await commitPreferences({
      current: preferencesRef.current,
      patch,
      apply: setPreferences,
      // The response is the whole preferences object rather than an echo of
      // the patch, so this also picks up anything another device changed.
      send: (body) => api.patch<UserPreferences>("/auth/me/preferences", body),
    });
  }, []);

  /**
   * Changes the password and STAYS SIGNED IN. Other devices are signed out.
   *
   * This used to sign the phone out, on the stated belief that Supabase
   * invalidates existing sessions when the password is rotated through the
   * admin API. It does not — so the belief was inverted in practice: every
   * other device stayed signed in, and the only session that ended was the one
   * belonging to the person who had just proved they knew the current password.
   *
   * The backend now revokes the others explicitly and deliberately leaves this
   * one alone, and web does exactly the same. The policy is stated in the
   * server's response message, which the caller shows.
   */
  async function changePassword(currentPassword: string, newPassword: string) {
    await api.post("/auth/change-password", { currentPassword, newPassword });
  }

  return (
    <AuthContext.Provider
      value={{
        profile,
        loading,
        login,
        adoptSession,
        register,
        logout,
        logoutEverywhere,
        updateProfile,
        changePassword,
        setProfileFromServer: setProfile,
        takeBootstrapProfiles,
        preferences: preferences ?? DEFAULT_PREFERENCES,
        preferencesLoaded: preferences !== null,
        updatePreferences,
        sessionEnded,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export { errorMessage };
