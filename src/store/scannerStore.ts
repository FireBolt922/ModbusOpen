import { create } from "zustand";
import type {
  ConnectionInfo,
  DecodedRegister,
  PollConfig,
  PollStats,
  RtuConfig,
  TcpConfig,
  Transport,
} from "@/lib/types";

export const DEFAULT_TCP_CONFIG: TcpConfig = {
  host: "127.0.0.1",
  port: 5020,
  unitId: 1,
  timeoutMs: 1000,
  retries: 1,
};

export const DEFAULT_RTU_CONFIG: RtuConfig = {
  port: "",
  baudRate: 9600,
  dataBits: 8,
  // 8-E-1 is what the Modbus serial spec actually mandates. 8-N-1 is more
  // common on shipping hardware, so it's the very next option in the picker.
  parity: "even",
  stopBits: 1,
  unitId: 1,
  timeoutMs: 1000,
  retries: 1,
  interFrameDelayUs: null,
};

export const DEFAULT_POLL_CONFIG: PollConfig = {
  unitId: 1,
  blocks: [
    {
      function: "read_holding_registers",
      startAddress: 100,
      quantity: 8,
    },
  ],
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
  preferredTransport: Transport | null;
  tcpConfig: TcpConfig;
  rtuConfig: RtuConfig;
  pollConfig: PollConfig;
  connection: ConnectionInfo | null;
  connecting: boolean;
  polling: boolean;
  rows: DecodedRegister[];
  rowsStale: boolean;
  stats: PollStats;
  lastError: string | null;
  /**
   * Failures since the last good response. One timeout on a busy line is
   * noise; a run of them means the device is gone, and the stats bar says so.
   */
  consecutiveErrors: number;
  lastSequence: number;

  setPreferredTransport: (t: Transport | null) => void;
  setTcpConfig: (patch: Partial<TcpConfig>) => void;
  setRtuConfig: (patch: Partial<RtuConfig>) => void;
  setPollConfigLocal: (patch: Partial<PollConfig>) => void;
  setConnecting: (v: boolean) => void;
  setConnection: (info: ConnectionInfo | null, unitId?: number) => void;
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
  clearStats: () => void;
  resetSession: () => void;
};

export const useScannerStore = create<ScannerState>((set, get) => ({
  preferredTransport: null,
  tcpConfig: { ...DEFAULT_TCP_CONFIG },
  rtuConfig: { ...DEFAULT_RTU_CONFIG },
  pollConfig: { ...DEFAULT_POLL_CONFIG },
  connection: null,
  connecting: false,
  polling: false,
  rows: [],
  rowsStale: false,
  stats: { ...EMPTY_STATS },
  lastError: null,
  consecutiveErrors: 0,
  lastSequence: 0,

  setPreferredTransport: (preferredTransport) => set({ preferredTransport }),

  setTcpConfig: (patch) =>
    set((s) => ({ tcpConfig: { ...s.tcpConfig, ...patch } })),

  setRtuConfig: (patch) =>
    set((s) => ({ rtuConfig: { ...s.rtuConfig, ...patch } })),

  setPollConfigLocal: (patch) =>
    set((s) => {
      const next = { ...s.pollConfig, ...patch };
      if (patch.format) {
        next.format = { ...s.pollConfig.format, ...patch.format };
      }
      // Keep unit ID on both connect forms in sync when changed mid-poll.
      if (patch.unitId !== undefined) {
        return {
          pollConfig: next,
          tcpConfig: { ...s.tcpConfig, unitId: patch.unitId },
          rtuConfig: { ...s.rtuConfig, unitId: patch.unitId },
        };
      }
      return { pollConfig: next };
    }),

  setConnecting: (connecting) => set({ connecting }),

  setConnection: (connection, unitId) =>
    set({
      connection,
      connecting: false,
      ...(connection
        ? {
            lastError: null,
            rows: [],
            rowsStale: false,
            stats: { ...EMPTY_STATS },
            consecutiveErrors: 0,
            lastSequence: 0,
            pollConfig: {
              ...get().pollConfig,
              unitId:
                unitId ??
                (connection.transport === "rtu"
                  ? get().rtuConfig.unitId
                  : get().tcpConfig.unitId),
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
      // Data is flowing again — the old failure is history, not news.
      lastError: null,
      consecutiveErrors: 0,
      lastSequence: sequence,
    });
  },

  applyPollError: (sessionId, message, stats) => {
    const conn = get().connection;
    if (!conn || conn.sessionId !== sessionId) return;
    set((s) => ({
      rowsStale: true,
      stats,
      lastError: message,
      consecutiveErrors: s.consecutiveErrors + 1,
    }));
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

  /** Zero the counters and drop the stale error line, keeping the session. */
  clearStats: () =>
    set({
      stats: { ...EMPTY_STATS },
      lastError: null,
      consecutiveErrors: 0,
    }),

  resetSession: () =>
    set({
      connection: null,
      connecting: false,
      polling: false,
      rows: [],
      rowsStale: false,
      stats: { ...EMPTY_STATS },
      lastError: null,
      consecutiveErrors: 0,
      lastSequence: 0,
    }),
}));
