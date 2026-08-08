import { create } from "zustand";
import type { MeterProfile } from "@/lib/types";

type MeterState = {
  profiles: MeterProfile[];
  loaded: boolean;
  /** Selected profile id in the scanner workspace, or null for raw mode. */
  activeProfileId: string | null;
  /** When true, RegisterTable shows named parameters instead of raw rows. */
  parameterView: boolean;

  setProfiles: (profiles: MeterProfile[]) => void;
  setLoaded: (v: boolean) => void;
  setActiveProfileId: (id: string | null) => void;
  setParameterView: (v: boolean) => void;
  activeProfile: () => MeterProfile | null;
};

export const useMeterStore = create<MeterState>((set, get) => ({
  profiles: [],
  loaded: false,
  activeProfileId: null,
  parameterView: true,

  setProfiles: (profiles) => set({ profiles, loaded: true }),
  setLoaded: (loaded) => set({ loaded }),
  setActiveProfileId: (activeProfileId) => set({ activeProfileId }),
  setParameterView: (parameterView) => set({ parameterView }),
  activeProfile: () => {
    const { activeProfileId, profiles } = get();
    if (!activeProfileId) return null;
    return profiles.find((p) => p.id === activeProfileId) ?? null;
  },
}));
