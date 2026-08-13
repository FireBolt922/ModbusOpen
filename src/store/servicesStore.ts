import { create } from "zustand";
import type {
  ServiceStatus,
  ServiceSubcategory,
  ServicesConfig,
  UnlockState,
} from "@/lib/types";

/** Ring buffer cap for the log view — a chatty unit must not grow forever. */
const MAX_LOG_LINES = 5000;

export const LOCKED: UnlockState = { unlocked: false };

export const EMPTY_CONFIG: ServicesConfig = { version: 1, services: [] };

type ServicesState = {
  /** null until services_supported() has answered. */
  supported: boolean | null;
  /** OS name, so the Linux-only notice can name this machine. */
  platform: string;

  unlock: UnlockState;
  config: ServicesConfig;
  services: ServiceStatus[];
  /** True once the first status list has arrived, so the empty state is honest. */
  servicesLoaded: boolean;

  /** Which half of the View screen is showing. Capture is the default. */
  subcategory: ServiceSubcategory;
  /** Category names to show; empty means "all". */
  categoryFilter: string[];

  /** Session id of the live status watcher; events from any other are stale. */
  watchSessionId: number | null;

  /** Open log panel, if any. */
  logSessionId: number | null;
  logUnit: string | null;
  logLines: string[];
  logPaused: boolean;

  setSupported: (supported: boolean, platform: string) => void;
  setUnlock: (unlock: UnlockState) => void;
  setConfig: (config: ServicesConfig) => void;
  setServices: (services: ServiceStatus[]) => void;
  setSubcategory: (subcategory: ServiceSubcategory) => void;
  toggleCategory: (category: string) => void;
  clearCategoryFilter: () => void;
  setWatchSessionId: (id: number | null) => void;

  openLog: (sessionId: number, unit: string) => void;
  closeLog: () => void;
  setLogPaused: (paused: boolean) => void;

  /** Session-guarded appliers — stale events are dropped, never rendered. */
  applyStatus: (sessionId: number, services: ServiceStatus[]) => void;
  applyLog: (sessionId: number, lines: string[]) => void;

  resetSession: () => void;
};

export const useServicesStore = create<ServicesState>((set, get) => ({
  supported: null,
  platform: "",

  unlock: LOCKED,
  config: EMPTY_CONFIG,
  services: [],
  servicesLoaded: false,

  subcategory: "capture",
  categoryFilter: [],

  watchSessionId: null,

  logSessionId: null,
  logUnit: null,
  logLines: [],
  logPaused: false,

  setSupported: (supported, platform) => set({ supported, platform }),
  setUnlock: (unlock) => set({ unlock }),
  setConfig: (config) => set({ config }),
  setServices: (services) => set({ services, servicesLoaded: true }),
  setSubcategory: (subcategory) => set({ subcategory }),

  toggleCategory: (category) =>
    set((s) => ({
      categoryFilter: s.categoryFilter.includes(category)
        ? s.categoryFilter.filter((c) => c !== category)
        : [...s.categoryFilter, category],
    })),
  clearCategoryFilter: () => set({ categoryFilter: [] }),
  setWatchSessionId: (watchSessionId) => set({ watchSessionId }),

  openLog: (logSessionId, logUnit) =>
    set({ logSessionId, logUnit, logLines: [], logPaused: false }),
  closeLog: () =>
    set({
      logSessionId: null,
      logUnit: null,
      logLines: [],
      logPaused: false,
    }),
  setLogPaused: (logPaused) => set({ logPaused }),

  applyStatus: (sessionId, services) => {
    if (get().watchSessionId !== sessionId) return;
    set({ services, servicesLoaded: true });
  },

  applyLog: (sessionId, lines) => {
    const state = get();
    if (state.logSessionId !== sessionId) return;
    // Pausing freezes the view but keeps the tail running, so resuming shows
    // what happened rather than a gap.
    if (state.logPaused) return;
    const next = [...state.logLines, ...lines];
    set({
      logLines:
        next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next,
    });
  },

  resetSession: () =>
    set({
      services: [],
      servicesLoaded: false,
      watchSessionId: null,
      logSessionId: null,
      logUnit: null,
      logLines: [],
      logPaused: false,
    }),
}));
