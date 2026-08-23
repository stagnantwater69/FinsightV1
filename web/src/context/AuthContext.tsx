import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { supabase } from "../lib/supabaseClient";
import { api, setSessionExpiredHandler } from "../lib/api";
import type { LoginInput, Profile, RegisterInput, UpdateProfileInput, UserPreferences } from "../lib/types";

interface AuthContextValue {
  profile: Profile | null;
  loading: boolean;
  /** True when the session ended on its own rather than by the user logging out. */
  sessionExpired: boolean;
  login: (input: LoginInput) => Promise<void>;
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
  /** Ends every session on every device, not just this browser's. */
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
      setProfile(null);
      setPreferences(null);
      void supabase.auth.signOut();
    });
    return () => setSessionExpiredHandler(null);
  }, []);

  useEffect(() => {
    let active = true;

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
        if (!active) return;
        if (data.session) {
          const me = await fetchProfile();
          setProfile(me);
          // A failed /auth/me leaves `profile` null and the app on the login
          // screen, so there is nothing to hold preferences for.
          if (me) setPreferences(me.preferences ?? DEFAULT_PREFERENCES);
        }
      })
      .catch((err) => {
        console.error("Could not read the stored session:", err);
        if (active) setProfile(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const { data: subscription } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setProfile(null);
        setPreferences(null);
      }
    });

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  async function login(input: LoginInput) {
    const { data } = await api.post<{ profile: Profile; session: { access_token: string; refresh_token: string } }>(
      "/auth/login",
      input
    );
    await supabase.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
    setSessionExpired(false);
    setProfile(data.profile);
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
    void api
      .get<Profile>("/auth/me")
      .then(({ data: me }) => setPreferences(me.preferences ?? DEFAULT_PREFERENCES))
      .catch(() => setPreferences(DEFAULT_PREFERENCES));
  }

  async function register(input: RegisterInput) {
    const { data } = await api.post<{ message: string }>("/auth/register", { ...input, platform: "web" });
    return data;
  }

  async function logout() {
    // Local scope: this browser only. "Log out everywhere" is a separate,
    // deliberate action — see below.
    await api.post("/auth/logout").catch(() => undefined);
    await supabase.auth.signOut();
    setSessionExpired(false);
    setProfile(null);
    setPreferences(null);
  }

  async function logoutEverywhere() {
    await api.post("/auth/logout-all").catch(() => undefined);
    await supabase.auth.signOut();
    setSessionExpired(false);
    setProfile(null);
    setPreferences(null);
  }

  async function updateProfile(input: UpdateProfileInput) {
    const { data } = await api.patch<Profile>("/auth/me", input);
    setProfile(data);
  }

  async function updatePreferences(patch: Partial<UserPreferences>) {
    const previous = preferences;
    setPreferences((prev) => ({ ...(prev ?? DEFAULT_PREFERENCES), ...patch }));
    try {
      const { data } = await api.patch<UserPreferences>("/auth/me/preferences", patch);
      // The response is the whole preferences object, not the echo of the
      // patch — so this also picks up anything another device changed.
      setPreferences(data);
    } catch (err) {
      setPreferences(previous);
      throw err;
    }
  }

  async function uploadAvatar(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    const { data } = await api.post<Profile>("/auth/me/avatar", formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    setProfile(data);
  }

  return (
    <AuthContext.Provider
      value={{
        profile,
        loading,
        sessionExpired,
        login,
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
