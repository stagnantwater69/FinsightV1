import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { getErrorMessage } from "../lib/errors";
import { useAuth } from "./AuthContext";
import type { BusinessProfile, BusinessProfileInput } from "../lib/types";

interface BusinessProfileContextValue {
  profiles: BusinessProfile[];
  selected: BusinessProfile | null;
  loading: boolean;
  /**
   * Why the list is empty, when it is empty because the request failed rather
   * than because this owner has no businesses.
   *
   * Those two states used to be indistinguishable: `refresh()` had no `catch`,
   * so a dropped connection left `profiles` at `[]` and the app read that as
   * "brand-new owner" — an established owner with three businesses was sent
   * into the setup wizard and invited to create a fourth. The mobile client
   * fixed the same bug the same way; see mobile/src/context/BusinessProfileContext.tsx.
   *
   * `null` therefore means "the last load succeeded", which is what every
   * empty-list gate must check before concluding the owner has no business.
   */
  error: string | null;
  selectProfile: (id: number) => void;
  createProfile: (input: BusinessProfileInput) => Promise<BusinessProfile>;
  updateProfile: (id: number, input: Partial<BusinessProfileInput>) => Promise<BusinessProfile>;
  uploadLogo: (id: number, file: File) => Promise<BusinessProfile>;
  archiveProfile: (id: number) => Promise<void>;
  restoreProfile: (id: number) => Promise<void>;
  /** Fetches archived profiles on demand — they are not kept in `profiles`. */
  listArchived: () => Promise<BusinessProfile[]>;
  refresh: () => Promise<void>;
}

const BusinessProfileContext = createContext<BusinessProfileContextValue | undefined>(undefined);

export function BusinessProfileProvider({ children }: { children: ReactNode }) {
  const { profile: user } = useAuth();
  const [profiles, setProfiles] = useState<BusinessProfile[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const { data } = await api.get<BusinessProfile[]>("/business-profiles");
      setProfiles(data);
      setSelectedId((current) => {
        if (current && data.some((p) => p.id === current)) return current;
        return data[0]?.id ?? null;
      });
      setError(null);
    } catch (err) {
      // Recorded for the screens AND rethrown: `archiveProfile` and
      // `restoreProfile` await `refresh()` and report their own failure, so
      // swallowing it here would leave them claiming success on a failed
      // reload. The list itself is left alone — a failed refresh must not
      // blank out figures the owner is already looking at.
      setError(getErrorMessage(err));
      throw err;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!user) {
      setProfiles([]);
      setSelectedId(null);
      setError(null);
      setLoading(false);
      return;
    }
    // The reason is already in `error` by the time this settles; the catch is
    // here so a failed load is a message on screen rather than an unhandled
    // rejection in the console.
    refresh().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function createProfile(input: BusinessProfileInput) {
    const { data } = await api.post<BusinessProfile>("/business-profiles", input);
    setProfiles((prev) => [...prev, data]);
    setSelectedId(data.id);
    // A successful write proves the list on screen is current again.
    setError(null);
    return data;
  }

  async function updateProfile(id: number, input: Partial<BusinessProfileInput>) {
    const { data } = await api.patch<BusinessProfile>(`/business-profiles/${id}`, input);
    setProfiles((prev) => prev.map((p) => (p.id === id ? data : p)));
    return data;
  }

  async function uploadLogo(id: number, file: File) {
    const formData = new FormData();
    formData.append("file", file);
    const { data } = await api.post<BusinessProfile>(`/business-profiles/${id}/logo`, formData, {
      headers: { "Content-Type": "multipart/form-data" },
    });
    setProfiles((prev) => prev.map((p) => (p.id === id ? data : p)));
    return data;
  }

  // Archiving can remove the currently-selected business, so the list is
  // reloaded and the selection allowed to fall back to whatever remains.
  async function archiveProfile(id: number) {
    await api.post(`/business-profiles/${id}/archive`);
    await refresh();
  }

  async function restoreProfile(id: number) {
    await api.post(`/business-profiles/${id}/restore`);
    await refresh();
  }

  async function listArchived() {
    const { data } = await api.get<BusinessProfile[]>("/business-profiles", {
      params: { includeArchived: "true" },
    });
    return data.filter((p) => p.isArchived);
  }

  function selectProfile(id: number) {
    setSelectedId(id);
  }

  const selected = profiles.find((p) => p.id === selectedId) ?? null;

  return (
    <BusinessProfileContext.Provider
      value={{
        profiles,
        selected,
        loading,
        error,
        selectProfile,
        createProfile,
        updateProfile,
        uploadLogo,
        archiveProfile,
        restoreProfile,
        listArchived,
        refresh,
      }}
    >
      {children}
    </BusinessProfileContext.Provider>
  );
}

export function useBusinessProfiles() {
  const ctx = useContext(BusinessProfileContext);
  if (!ctx) {
    throw new Error("useBusinessProfiles must be used within a BusinessProfileProvider");
  }
  return ctx;
}
