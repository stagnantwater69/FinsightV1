import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { useAuth } from "./AuthContext";
import type { BusinessProfile, BusinessProfileInput } from "../lib/types";

interface BusinessProfileContextValue {
  profiles: BusinessProfile[];
  selected: BusinessProfile | null;
  loading: boolean;
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

  async function refresh() {
    setLoading(true);
    try {
      const { data } = await api.get<BusinessProfile[]>("/business-profiles");
      setProfiles(data);
      setSelectedId((current) => {
        if (current && data.some((p) => p.id === current)) return current;
        return data[0]?.id ?? null;
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!user) {
      setProfiles([]);
      setSelectedId(null);
      setLoading(false);
      return;
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  async function createProfile(input: BusinessProfileInput) {
    const { data } = await api.post<BusinessProfile>("/business-profiles", input);
    setProfiles((prev) => [...prev, data]);
    setSelectedId(data.id);
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
