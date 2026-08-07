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

export type PollConfig = {
  unitId: number;
  function: FunctionCode;
  startAddress: number;
  quantity: number;
  intervalMs: number;
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

export type SlaveSimConfig = {
  unitId: number;
  coilCount: number;
  discreteCount: number;
  inputRegisterCount: number;
  holdingRegisterCount: number;
};

export type SimulatorConfig = {
  tcpPort: number;
  slaves: SlaveSimConfig[];
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
