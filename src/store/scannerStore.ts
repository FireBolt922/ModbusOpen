import { create } from "zustand";
import type {
  ConnectionInfo,
  DecodedRegister,
  PollConfig,
  PollStats,
  TcpConfig,
} from "@/lib/types";

export const DEFAULT_TCP_CONFIG: TcpConfig = {
  host: "127.0.0.1",
  port: 5020,
  unitId: 1,
  timeoutMs: 1000,
  retries: 1,
};

export const DEFAULT_POLL_CONFIG: PollConfig = {
  unitId: 1,
  function: "read_holding_registers",
  startAddress: 100,
  quantity: 8,
  intervalMs: 1000,
  format: {
    dataType: "float32",
    wordOrder: "cdab",
    scale: 1,
    offset: 0,
  },
};

const EMPTY_STATS: PollStats = {
  txCount: 0,
  rxCount: 0,
  errorCount: 0,
  timeoutCount: 0,
  latencyMinMs: 0,
  latencyAvgMs: 0,
  latencyMaxMs: 0,
  actualRateHz: 0,
  lastError: null,
};

type ScannerState = {
  tcpConfig: TcpConfig;
  pollConfig: PollConfig;
  connection: ConnectionInfo | null;
  connecting: boolean;
  polling: boolean;
  rows: DecodedRegister[];
  rowsStale: boolean;
  stats: PollStats;
  lastError: string | null;
  lastSequence: number;

  setTcpConfig: (patch: Partial<TcpConfig>) => void;
  setPollConfigLocal: (patch: Partial<PollConfig>) => void;
  setConnecting: (v: boolean) => void;
  setConnection: (info: ConnectionInfo | null) => void;
  setPolling: (v: boolean) => void;
  applyPollResult: (
    sessionId: number,
    registers: DecodedRegister[],
    stats: PollStats,
    sequence: number,
  ) => void;
  applyPollError: (
    sessionId: number,
    message: string,
    stats: PollStats,
  ) => void;
  applyConnectionLost: (sessionId: number, message: string) => void;
  resetSession: () => void;
};

export const useScannerStore = create<ScannerState>((set, get) => ({
  tcpConfig: { ...DEFAULT_TCP_CONFIG },
  pollConfig: { ...DEFAULT_POLL_CONFIG },
  connection: null,
  connecting: false,
  polling: false,
  rows: [],
  rowsStale: false,
  stats: { ...EMPTY_STATS },
  lastError: null,
  lastSequence: 0,

  setTcpConfig: (patch) =>
    set((s) => ({ tcpConfig: { ...s.tcpConfig, ...patch } })),

  setPollConfigLocal: (patch) =>
    set((s) => {
      const next = { ...s.pollConfig, ...patch };
      if (patch.format) {
        next.format = { ...s.pollConfig.format, ...patch.format };
      }
      // Keep unit ID on the TCP form in sync when changed mid-poll.
      if (patch.unitId !== undefined) {
        return {
          pollConfig: next,
          tcpConfig: { ...s.tcpConfig, unitId: patch.unitId },
        };
      }
      return { pollConfig: next };
    }),

  setConnecting: (connecting) => set({ connecting }),

  setConnection: (connection) =>
    set({
      connection,
      connecting: false,
      ...(connection
        ? {
            lastError: null,
            rows: [],
            rowsStale: false,
            stats: { ...EMPTY_STATS },
            lastSequence: 0,
            pollConfig: {
              ...get().pollConfig,
              unitId: get().tcpConfig.unitId,
            },
          }
        : {}),
    }),

  setPolling: (polling) => set({ polling }),

  applyPollResult: (sessionId, registers, stats, sequence) => {
    const conn = get().connection;
    if (!conn || conn.sessionId !== sessionId) return;
    set({
      rows: registers,
      rowsStale: false,
      stats,
      lastError: stats.lastError,
      lastSequence: sequence,
    });
  },

  applyPollError: (sessionId, message, stats) => {
    const conn = get().connection;
    if (!conn || conn.sessionId !== sessionId) return;
    set({
      rowsStale: true,
      stats,
      lastError: message,
    });
  },

  applyConnectionLost: (sessionId, message) => {
    const conn = get().connection;
    if (!conn || conn.sessionId !== sessionId) return;
    set({
      connection: null,
      polling: false,
      rowsStale: true,
      lastError: message,
    });
  },

  resetSession: () =>
    set({
      connection: null,
      connecting: false,
      polling: false,
      rows: [],
      rowsStale: false,
      stats: { ...EMPTY_STATS },
      lastError: null,
      lastSequence: 0,
    }),
}));
