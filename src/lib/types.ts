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

/**
 * The transport dropped. The session survives on the Rust side — polling is
 * paused and the port released until the UI calls `reconnect()`.
 */
export type ConnectionLostEvent = {
  sessionId: number;
  message: string;
};

export type ReconnectResult = {
  sessionId: number;
  /** True if polling was running when the link dropped, so it resumed. */
  polling: boolean;
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

// ---------------------------------------------------------------------------
// Service control (Linux only)
// Mirrors src-tauri/src/modbus/types.rs — see docs/05-data-model.md.
// ---------------------------------------------------------------------------

/** Top-level split on the View screen. Capture is the default. */
export type ServiceSubcategory = "capture" | "sync";

/** One monitored unit as configured on the Configure tab. */
export type ServiceEntry = {
  /** Full unit name including the suffix, e.g. "meter-poll.service". */
  unit: string;
  description: string;
  /** Free text; empty means "Uncategorised". */
  category: string;
  subcategory: ServiceSubcategory;
};

export type ServicesConfig = {
  version: number;
  services: ServiceEntry[];
};

/** A configured entry joined with what the system currently reports. */
export type ServiceStatus = {
  unit: string;
  description: string;
  category: string;
  subcategory: ServiceSubcategory;
  /** "loaded" | "not-found" | "masked" | "error" */
  loadState: string;
  /** "active" | "inactive" | "failed" | "activating" | "deactivating" */
  activeState: string;
  /** "running" | "dead" | "exited" | … */
  subState: string;
  /**
   * "enabled" | "disabled" | "static" | "masked", or empty. Read-only: the app
   * never writes it. A "disabled" unit is one the operator deliberately took
   * down in a terminal, and auto-restart leaves it alone.
   */
  unitFileState: string;
  /** RFC3339. Set while a stop is being held; the service returns at this time. */
  autoStartAt?: string;
};

export type ServiceValidation = {
  unit: string;
  valid: boolean;
  /** The unit's own Description, when the system knows it. */
  description?: string;
  message: string;
};

/** The 30-minute unlock that gates the Configure tab. */
export type UnlockState = {
  unlocked: boolean;
  /** RFC3339. */
  expiresAt?: string;
};

export type ServiceStatusEvent = {
  sessionId: number;
  services: ServiceStatus[];
};

export type ServiceLogEvent = {
  sessionId: number;
  unit: string;
  /** Batched — never one event per line. */
  lines: string[];
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
  | { kind: "BadFrame"; message: { reason: string } }
  | { kind: "LinkDown"; message: { message: string } }
  | { kind: "InvalidConfig"; message: string }
  | { kind: "NotConnected" }
  | { kind: "Unsupported"; message: { message: string } }
  | {
      kind: "ServiceControl";
      message: { action: string; unit: string; reason: string };
    }
  | { kind: "Locked" };
