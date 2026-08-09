import { create } from "zustand";
import type {
  SimulatorConfig,
  SimulatorInfo,
  SimulatorSnapshot,
  SlaveSimConfig,
  TagConfig,
} from "@/lib/types";

export const DEFAULT_TAG_CONFIG: TagConfig = {
  name: "tag",
  address: 0,
  format: { dataType: "uint16", wordOrder: "cdab", scale: 1, offset: 0 },
  behavior: { kind: "static" },
  initialValue: 0,
};

export const DEFAULT_SLAVE_CONFIG: SlaveSimConfig = {
  unitId: 1,
  coilCount: 16,
  discreteCount: 16,
  inputRegisterCount: 0,
  holdingRegisterCount: 50,
  tags: [],
};

export const DEFAULT_SIMULATOR_CONFIG: SimulatorConfig = {
  tcpPort: 5021,
  tickMs: 1000,
  slaves: [{ ...DEFAULT_SLAVE_CONFIG }],
};

type SimulatorState = {
  config: SimulatorConfig;
  info: SimulatorInfo | null;
  starting: boolean;
  snapshot: SimulatorSnapshot | null;

  setConfig: (patch: Partial<SimulatorConfig>) => void;
  replaceConfig: (config: SimulatorConfig) => void;
  addSlave: () => void;
  removeSlave: (unitId: number) => void;
  updateSlave: (unitId: number, patch: Partial<SlaveSimConfig>) => void;
  addTag: (unitId: number) => void;
  removeTag: (unitId: number, index: number) => void;
  updateTag: (unitId: number, index: number, patch: Partial<TagConfig>) => void;
  setStarting: (v: boolean) => void;
  setInfo: (info: SimulatorInfo | null) => void;
  applySnapshot: (snapshot: SimulatorSnapshot) => void;
  resetSession: () => void;
};

export const useSimulatorStore = create<SimulatorState>((set, get) => ({
  config: {
    tcpPort: DEFAULT_SIMULATOR_CONFIG.tcpPort,
    tickMs: DEFAULT_SIMULATOR_CONFIG.tickMs,
    slaves: [{ ...DEFAULT_SLAVE_CONFIG }],
  },
  info: null,
  starting: false,
  snapshot: null,

  setConfig: (patch) => set((s) => ({ config: { ...s.config, ...patch } })),
  replaceConfig: (config) => set({ config }),

  addSlave: () =>
    set((s) => {
      const usedIds = new Set(s.config.slaves.map((sl) => sl.unitId));
      let nextId = 1;
      while (usedIds.has(nextId) && nextId < 247) nextId += 1;
      return {
        config: {
          ...s.config,
          slaves: [
            ...s.config.slaves,
            { ...DEFAULT_SLAVE_CONFIG, unitId: nextId, tags: [] },
          ],
        },
      };
    }),

  removeSlave: (unitId) =>
    set((s) => ({
      config: {
        ...s.config,
        slaves: s.config.slaves.filter((sl) => sl.unitId !== unitId),
      },
    })),

  updateSlave: (unitId, patch) =>
    set((s) => ({
      config: {
        ...s.config,
        slaves: s.config.slaves.map((sl) =>
          sl.unitId === unitId ? { ...sl, ...patch } : sl,
        ),
      },
    })),

  addTag: (unitId) =>
    set((s) => ({
      config: {
        ...s.config,
        slaves: s.config.slaves.map((sl) =>
          sl.unitId === unitId
            ? { ...sl, tags: [...sl.tags, { ...DEFAULT_TAG_CONFIG }] }
            : sl,
        ),
      },
    })),

  removeTag: (unitId, index) =>
    set((s) => ({
      config: {
        ...s.config,
        slaves: s.config.slaves.map((sl) =>
          sl.unitId === unitId
            ? { ...sl, tags: sl.tags.filter((_, i) => i !== index) }
            : sl,
        ),
      },
    })),

  updateTag: (unitId, index, patch) =>
    set((s) => ({
      config: {
        ...s.config,
        slaves: s.config.slaves.map((sl) =>
          sl.unitId === unitId
            ? {
                ...sl,
                tags: sl.tags.map((t, i) =>
                  i === index ? { ...t, ...patch } : t,
                ),
              }
            : sl,
        ),
      },
    })),

  setStarting: (starting) => set({ starting }),

  setInfo: (info) => set({ info, starting: false }),

  applySnapshot: (snapshot) => {
    const info = get().info;
    if (!info || info.sessionId !== snapshot.sessionId) return;
    set({ snapshot });
  },

  resetSession: () => set({ info: null, starting: false, snapshot: null }),
}));
