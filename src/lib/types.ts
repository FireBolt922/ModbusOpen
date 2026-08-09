// Hand-maintained mirror of Rust types in src-tauri/src/modbus/types.rs
// and error.rs. When either side changes, update both in the same commit.

export type SerialPortInfo = {
  portName: string;
  portType: "USB" | "Bluetooth" | "PCI" | "Unknown";
  manufacturer: string | null;
  product: string | null;
};

export type Transport = "tcp" | "rtu";

export type FunctionCode =
  | "read_coils"
  | "read_discrete_inputs"
  | "read_holding_registers"
  | "read_input_registers"
  | "write_single_coil"
  | "write_single_register"
  | "write_multiple_coils"
  | "write_multiple_registers";

export type DataType =
  | "bool"
  | "uint16"
  | "int16"
  | "hex16"
  | "binary16"
  | "uint32"
  | "int32"
  | "float32"
  | "uint64"
  | "int64"
  | "float64"
  | "string";

export type WordOrder = "abcd" | "cdab" | "badc" | "dcba";

export type AddressBase = "zero_based" | "one_based";

export type DataFormat = {
  dataType: DataType;
  wordOrder: WordOrder;
  scale: number;
  offset: number;
};

export type TcpConfig = {
  host: string;
  port: number;
  unitId: number;
  timeoutMs: number;
  retries: number;
};

export type Parity = "none" | "even" | "odd";

export type RtuConfig = {
  port: string;
  baudRate: number;
  dataBits: number;
  parity: Parity;
  stopBits: number;
  unitId: number;
  timeoutMs: number;
  retries: number;
  /** null = auto (3.5 character times per the RTU spec). */
  interFrameDelayUs: number | null;
};

export type ConnectionInfo = {
  sessionId: number;
  transport: Transport;
  summary: string;
};

export type ConnectionStatus =
  | { state: "disconnected" }
  | { state: "connecting" }
  | {
      state: "connected";
      since: string;
      transport: Transport;
      summary: string;
    }
  | { state: "error"; message: string; at: string };

/**
 * One Modbus read request. A request covers a contiguous run of registers up
 * to the function's limit, so a meter with parameters far apart needs several.
 */
export type ReadBlock = {
  function: FunctionCode;
  startAddress: number;
  quantity: number;
};

export type PollConfig = {
  unitId: number;
  /** Issued in order, once per cycle. Raw scanning is the one-element case. */
  blocks: ReadBlock[];
  intervalMs: number;
  /** How the raw register table decodes what comes back. */
  format: DataFormat;
};

export type TypedValue =
  | { kind: "bool"; value: boolean }
  | { kind: "int"; value: number }
  | { kind: "uint"; value: number }
  | { kind: "float"; value: number }
  | { kind: "text"; value: string }
  | { kind: "invalid" };

export type DecodedRegister = {
  address: number;
  span: number;
  raw: number[];
  value: TypedValue;
  decodeError: string | null;
};

export type PollStats = {
  txCount: number;
  rxCount: number;
  errorCount: number;
  timeoutCount: number;
  latencyMinMs: number;
  latencyAvgMs: number;
  latencyMaxMs: number;
  actualRateHz: number;
  lastError: string | null;
};

export type PollResult = {
  sessionId: number;
  sequence: number;
  timestamp: string;
  latencyMs: number;
  registers: DecodedRegister[];
  stats: PollStats;
};

export type PollErrorEvent = {
  sessionId: number;
  message: string;
  stats: PollStats;
};

export type ConnectionLostEvent = {
  sessionId: number;
  message: string;
};

export type Direction = "tx" | "rx";

export type FrameAnnotation = {
  unitId: number;
  function: number;
  isException: boolean;
  exceptionCode: number | null;
};

export type FrameLogEntry = {
  sessionId: number;
  timestamp: string;
  direction: Direction;
  bytes: number[];
  unitId: number;
  function: number;
  isException: boolean;
  exceptionCode: number | null;
  rttMs: number | null;
  annotation: FrameAnnotation | null;
};

export type WriteResult = {
  sessionId: number;
  latencyMs: number;
  function: FunctionCode;
  address: number;
  quantity: number;
};

export type TagBehavior =
  | { kind: "static" }
  | { kind: "random"; min: number; max: number }
  | { kind: "ramp"; min: number; max: number; step: number }
  | { kind: "sine"; min: number; max: number; periodS: number }
  | { kind: "counter"; step: number };

/** Only holding-register tags are animatable in v1 — see modbus/animate.rs. */
export type TagConfig = {
  name: string;
  address: number;
  format: DataFormat;
  behavior: TagBehavior;
  initialValue: number;
};

export type SlaveSimConfig = {
  unitId: number;
  coilCount: number;
  discreteCount: number;
  inputRegisterCount: number;
  holdingRegisterCount: number;
  tags: TagConfig[];
};

export type SimulatorConfig = {
  tcpPort: number;
  slaves: SlaveSimConfig[];
  tickMs: number;
};

export type SimulatorInfo = {
  sessionId: number;
  tcpPort: number;
};

export type SlaveSnapshot = {
  unitId: number;
  coils: boolean[];
  discreteInputs: boolean[];
  inputRegisters: number[];
  holdingRegisters: number[];
};

export type SimulatorSnapshot = {
  sessionId: number;
  tcpPort: number;
  slaves: SlaveSnapshot[];
};

// ---------------------------------------------------------------------------
// Meter profiles (hand-maintained mirror of Rust types)
// ---------------------------------------------------------------------------

export type MeterPointGroup =
  | "instantaneous"
  | "energy"
  | "harmonics"
  | "diagnostics"
  | "other";

export type MeterSource =
  | { kind: "user" }
  | { kind: "imported"; from: string };

export type RtuDefaults = {
  baudRate: number;
  dataBits: number;
  parity: Parity;
  stopBits: number;
};

/** One register's raw value at a known address. */
export type AddressedWord = {
  address: number;
  value: number;
};

export type MeterPoint = {
  key: string;
  label: string;
  address: number;
  format: DataFormat;
  unit: string;
  /** Overrides the profile's function code for this parameter only. */
  function?: FunctionCode;
  group: MeterPointGroup;
  unverified: boolean;
  simBehavior?: TagBehavior;
  simInitial?: number;
};

export type MeterProfile = {
  id: string;
  brand: string;
  model: string;
  description: string;
  source: MeterSource;
  /** Read function for any parameter that doesn't override it. */
  function: FunctionCode;
  defaultUnitId: number;
  suggestedRtu?: RtuDefaults;
  points: MeterPoint[];
};

export type MeterImportStatus = "new" | "duplicate_id" | "invalid";

export type MeterImportItem = {
  profile: MeterProfile;
  status: MeterImportStatus;
  message?: string;
};

export type MeterImportPreview = {
  path: string;
  items: MeterImportItem[];
};

export type ImportResolution = "rename" | "overwrite" | "skip";

export type MeterImportChoice = {
  profileId: string;
  resolution: ImportResolution;
  newId?: string;
};

/** Mirrors src-tauri/src/error.rs::AppError (serde adjacently tagged). */
export type AppError =
  | { kind: "SerialPortList"; message: string }
  | {
      kind: "TcpConnect";
      message: { host: string; port: number; reason: string };
    }
  | { kind: "SerialOpen"; message: { port: string; reason: string } }
  | {
      kind: "Timeout";
      message: { unit_id: number; timeout_ms: number; attempts: number };
    }
  | {
      kind: "ModbusException";
      message: { code: number; name: string; hint: string };
    }
  | { kind: "ConnectionLost"; message: { reason: string } }
  | { kind: "InvalidConfig"; message: string }
  | { kind: "NotConnected" };
