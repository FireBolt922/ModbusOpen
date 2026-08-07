# 05 — Data model

Rust is the source of truth. TypeScript mirrors it in `src/lib/types.ts`. When you change one,
change the other in the same commit and say so in the message.

---

## Core enums

```rust
pub enum Transport { Tcp, Rtu }

pub enum FunctionCode {
    ReadCoils            = 0x01,
    ReadDiscreteInputs   = 0x02,
    ReadHoldingRegisters = 0x03,
    ReadInputRegisters   = 0x04,
    WriteSingleCoil      = 0x05,
    WriteSingleRegister  = 0x06,
    WriteMultipleCoils   = 0x0F,
    WriteMultipleRegisters = 0x10,
}

pub enum DataType {
    Bool,
    Uint16, Int16, Hex16, Binary16,
    Uint32, Int32, Float32,
    Uint64, Int64, Float64,
    String,          // n registers, 2 ASCII chars each
}

/// Byte/word arrangement for multi-register values. See reference/data-types-word-order.md.
pub enum WordOrder {
    Abcd,   // big-endian            — the "standard"
    Cdab,   // word-swapped          — very common; what the existing meters use
    Badc,   // byte-swapped
    Dcba,   // fully reversed / little-endian
}

pub struct DataFormat {
    pub data_type: DataType,
    pub word_order: WordOrder,
    pub scale: f64,      // multiply after decode; default 1.0
    pub offset: f64,     // add after scaling; default 0.0
}
```

`scale` and `offset` exist because a huge share of real devices report `voltage × 10` or
`power_factor × 100` as integers — see the VFD profile. Without it, users do mental arithmetic on
every reading.

## Addressing

```rust
/// ALWAYS the 0-based wire address. Never store 1-based internally.
pub type WireAddress = u16;

pub enum AddressBase { ZeroBased, OneBased }
```

**The rule, restated because it causes more bugs than anything else:** internally 0-based, always.
Convert at the display layer only. Holding register `40001` in vendor documentation is wire address
`0`. Vendors are inconsistent about whether their docs mean `40001`, `4x0001`, or `0` — which is
exactly why the UI shows both columns side by side.

## Connection

```rust
pub struct TcpConfig {
    pub host: String,
    pub port: u16,          // 502
    pub unit_id: u8,        // 1
    pub timeout_ms: u64,    // 1000
    pub retries: u8,        // 1
}

pub struct RtuConfig {
    pub port: String,             // "/dev/ttyUSB0", "COM3"
    pub baud_rate: u32,           // 9600
    pub data_bits: u8,            // 8
    pub parity: Parity,           // None
    pub stop_bits: u8,            // 1
    pub unit_id: u8,              // 1
    pub timeout_ms: u64,          // 1000
    pub retries: u8,              // 1
    pub inter_frame_delay_us: Option<u32>,  // None = auto (3.5 char times)
}

pub enum Parity { None, Even, Odd }

pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected { since: DateTime<Utc>, transport: Transport, summary: String },
    Error { message: String, at: DateTime<Utc> },
}

pub struct SerialPortInfo {
    pub port_name: String,        // "/dev/tty.usbserial-A50285BI"
    pub description: Option<String>,  // "FTDI FT232R USB UART"
    pub manufacturer: Option<String>,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}
```

## Polling

```rust
pub struct PollConfig {
    pub unit_id: u8,
    pub function: FunctionCode,
    pub start_address: WireAddress,
    pub quantity: u16,
    pub interval_ms: u64,        // 1000
    pub format: DataFormat,      // default for the block
}

pub struct PollResult {
    pub session_id: u64,
    pub sequence: u64,
    pub timestamp: DateTime<Utc>,
    pub latency_ms: f64,
    pub registers: Vec<DecodedRegister>,
    pub stats: PollStats,
}

pub struct DecodedRegister {
    pub address: WireAddress,
    pub span: u8,                 // registers consumed: 1, 2, or 4
    pub raw: Vec<u16>,
    pub value: TypedValue,
    pub decode_error: Option<String>,
}

pub enum TypedValue {
    Bool(bool),
    Int(i64),
    Uint(u64),
    Float(f64),
    Text(String),
    Invalid,       // e.g. NaN float — show raw hex and say so, never fabricate a number
}

pub struct PollStats {
    pub tx_count: u64,
    pub rx_count: u64,
    pub error_count: u64,
    pub timeout_count: u64,
    pub latency_min_ms: f64,
    pub latency_avg_ms: f64,
    pub latency_max_ms: f64,
    pub actual_rate_hz: f64,
    pub last_error: Option<String>,
}
```

`TypedValue::Invalid` matters. When a float32 decodes to NaN — usually because the word order is
wrong or the register is unpopulated — showing "NaN" or "0" is a lie. Show the raw hex with a
marker instead.

## Frame log

```rust
pub struct FrameLogEntry {
    pub session_id: u64,
    pub timestamp: DateTime<Utc>,
    pub direction: Direction,        // Tx | Rx
    pub bytes: Vec<u8>,
    pub annotation: Option<FrameAnnotation>,
    pub rtt_ms: Option<f64>,         // Rx only
}

pub struct FrameAnnotation {
    pub unit_id: u8,
    pub function: u8,
    pub is_exception: bool,
    pub exception_code: Option<u8>,
    pub fields: Vec<FieldSpan>,      // { label, byte_offset, byte_len } — drives the hex underlines
}
```

Ring buffer, capped at 10,000 entries.

## Simulator

```rust
pub struct SimulatorConfig {
    pub transport: SimTransport,
    pub slaves: Vec<SlaveConfig>,
}

pub enum SimTransport {
    Tcp { bind_addr: String, port: u16 },     // "0.0.0.0", 502
    Rtu { port: String, baud_rate: u32, data_bits: u8, parity: Parity, stop_bits: u8 },
}

pub struct SlaveConfig {
    pub unit_id: u8,
    pub name: String,
    pub blocks: Vec<BlockConfig>,
    pub tags: Vec<TagConfig>,
}

pub struct BlockConfig {
    pub kind: BlockKind,          // Coils | DiscreteInputs | InputRegisters | HoldingRegisters
    pub start_address: WireAddress,
    pub count: u16,
    pub initial_value: u16,       // 0
}

pub struct TagConfig {
    pub name: String,
    pub block: BlockKind,
    pub address: WireAddress,
    pub format: DataFormat,       // type + word order determine how many registers it fills
    pub behaviour: Behaviour,
    pub update_ms: u64,           // 1000
}

pub enum Behaviour {
    Static  { value: f64 },
    Random  { min: f64, max: f64 },
    Ramp    { min: f64, max: f64, step: f64 },
    Sine    { min: f64, max: f64, period_s: f64 },
    Counter { start: f64, step: f64 },
}
```

`Behaviour` was designed backwards from the existing simulator scripts: `Random` covers
`random.uniform(145.0, 155.0)`, `Counter` covers the run-hours and totalizer patterns, `Static`
covers the fixed VFD register block. Fault/alarm injection (the VFD script's cycling behaviour) is
deliberately **not** in v1 — it goes to the [backlog](backlog.md) as a `Sequence` behaviour.

## Session file — `.mbopen`

JSON. Versioned from day one so v2 can read v1 files.

```json
{
  "version": 1,
  "kind": "scanner",
  "name": "L&T meter — panel 3",
  "created_at": "2026-08-07T10:14:00Z",
  "connection": {
    "transport": "tcp",
    "host": "192.168.1.69",
    "port": 502,
    "unit_id": 1,
    "timeout_ms": 1000,
    "retries": 1
  },
  "poll": {
    "function": 3,
    "start_address": 100,
    "quantity": 120,
    "interval_ms": 1000,
    "format": { "data_type": "float32", "word_order": "cdab", "scale": 1.0, "offset": 0.0 }
  },
  "address_base": "one_based",
  "row_overrides": [
    { "address": 216, "format": { "data_type": "uint32", "word_order": "cdab" }, "name": "Run Hours" }
  ],
  "names": { "100": "Active Power", "108": "Reactive Power", "116": "Power Factor" }
}
```

## Device profile

Same envelope, `"kind": "profile"`. Ships in `profiles/`, loadable by the simulator, and its
`names` map can also be applied to the scanner's table — so a profile does double duty as a
register-map annotation. See [reference/device-profiles.md](reference/device-profiles.md) for the
three real profiles.

```json
{
  "version": 1,
  "kind": "profile",
  "name": "L&T electrical meter",
  "description": "L&T 4-quadrant energy meter, float32 CDAB, holding registers from 100",
  "slave": {
    "unit_id": 1,
    "blocks": [
      { "kind": "holding_registers", "start_address": 100, "count": 120, "initial_value": 0 }
    ],
    "tags": [
      { "name": "Active Power",  "block": "holding_registers", "address": 100,
        "format": { "data_type": "float32", "word_order": "cdab" },
        "behaviour": { "type": "random", "min": 145.0, "max": 155.0 }, "update_ms": 1000 },
      { "name": "Run Hours",     "block": "holding_registers", "address": 216,
        "format": { "data_type": "uint32", "word_order": "cdab" },
        "behaviour": { "type": "counter", "start": 100, "step": 1 }, "update_ms": 3600000 }
    ]
  }
}
```

## Errors

```rust
#[derive(thiserror::Error, Debug, serde::Serialize)]
pub enum AppError {
    #[error("Can't reach {host}:{port} — {reason}")]
    TcpConnect { host: String, port: u16, reason: String },

    #[error("Can't open {port} — {reason}")]
    SerialOpen { port: String, reason: String },

    #[error("No response from unit {unit_id} within {timeout_ms} ms ({attempts} attempts)")]
    Timeout { unit_id: u8, timeout_ms: u64, attempts: u8 },

    #[error("{name} ({code:02}) — {hint}")]
    ModbusException { code: u8, name: String, hint: String },

    #[error("Connection lost — {reason}")]
    ConnectionLost { reason: String },

    #[error("{0}")]
    InvalidConfig(String),

    #[error("Not connected")]
    NotConnected,
}
```

Every variant carries enough structure for the UI to render a heading plus an actionable hint.
`ModbusException` in particular must map code → name → *what to try*:

| Code | Name | Hint |
|---|---|---|
| 01 | Illegal Function | This device doesn't support FC{n}. Try FC03 or FC04. |
| 02 | Illegal Data Address | No register at {addr}. Check the start address and the addressing base (0- vs 1-based). |
| 03 | Illegal Data Value | The device rejected the value or the quantity. FC03 allows at most 125 registers per request. |
| 04 | Slave Device Failure | The device hit an internal error. Check its own diagnostics. |
| 05 | Acknowledge | The device accepted the request but needs more time. |
| 06 | Slave Device Busy | The device is busy. Increase the poll interval and retry. |
| 0B | Gateway Target Failed | The gateway reached but got no reply from unit {unit}. Check the downstream serial bus. |
