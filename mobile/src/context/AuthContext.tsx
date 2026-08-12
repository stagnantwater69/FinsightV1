import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "../lib/api";
import { supabase } from "../lib/supabase";
import type { BusinessProfile, LoginInput, Profile, RegisterInput, UpdateProfileInput } from "../lib/types";

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
}

const AuthContext = createContext<AuthValue | undefined>(undefined);

async function fetchProfile(): Promise<Profile | null> {
  try {
    return await api.get<Profile>("/auth/me");
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const bootstrapProfiles = useRef<Promise<BusinessProfile[]> | null>(null);

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
      } finally {
        if (active) setLoading(false);
      }
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        bootstrapProfiles.current = null;
        setProfile(null);
      }
    });

    return () => {
      active = false;
      bootstrapProfiles.current = null;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function applySession(session: { access_token: string; refresh_token: string }, p: Profile) {
    // The backend returns the session; hand it to supabase-js so it persists it
    // to the keystore and takes over refreshing.
    await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    setProfile(p);
  }

  async function login(input: LoginInput) {
    const data = await api.post<{ profile: Profile; session: { access_token: string; refresh_token: string } }>(
      "/auth/login",
      input
    );
    await applySession(data.session, data.profile);
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
    await supabase.auth.signOut();
    // Nothing fetched under the old token may survive into the next session.
    bootstrapProfiles.current = null;
    setProfile(null);
  }

  async function updateProfile(input: UpdateProfileInput) {
    setProfile(await api.patch<Profile>("/auth/me", input));
  }

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
        register,
        logout,
        logoutEverywhere,
        updateProfile,
        changePassword,
        setProfileFromServer: setProfile,
        takeBootstrapProfiles,
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
