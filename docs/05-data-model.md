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

The original design used a `"kind": "profile"` envelope for simulator and scanner register maps.
The current app does not ship or auto-load files from the repository's `profiles/` directory;
that directory contains example `.mbmeter.json` packs for users to import manually. Imported
profiles are user-owned and live under the OS app-data `meters/` directory. See
[Meter pack (shareable)](#meter-pack-shareable) for the current import format and
[reference/device-profiles.md](reference/device-profiles.md) for the example register maps.

The JSON shape below is retained as a design reference; it does not describe files that the app
loads automatically.

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

    #[error("Bad reply — {reason}")]
    BadFrame { reason: String },

    #[error("{message}")]
    LinkDown { message: String },

    #[error("{0}")]
    InvalidConfig(String),

    #[error("Not connected")]
    NotConnected,

    // Service control
    #[error("{message}")]
    Unsupported { message: String },

    #[error("Can't {action} {unit} — {reason}")]
    ServiceControl { action: String, unit: String, reason: String },

    #[error("Enter the configuration password to do that.")]
    Locked,
}
```

### Recoverable vs fatal

The split matters more than the wording: it decides whether a session survives.

| Outcome | Examples | What happens |
|---|---|---|
| `ModbusException` | Illegal data address, device busy | Poll continues; error line updates |
| `Timeout` | No reply within `timeout_ms` | Poll continues |
| `BadFrame` | CRC failure, header/function-code mismatch | Poll continues — a garbled or foreign reply means the wire is alive. Usually a second master on the bus, or two programs on one device |
| `ConnectionLost` | Socket reset, peer hung up, port unplugged | Polling pauses, the port is **released**, the session is parked. The workspace keeps the config and offers Reconnect |
| `LinkDown` | Any request issued while parked | Rejected with the reason the link went down |
| `Unsupported` | Any service command on macOS/Windows | The Services screen renders a Linux-only notice instead of the tabs. Never reached in normal use — `services_supported()` gates the screen |
| `ServiceControl` | `systemctl` refused or the unit failed to come up | Shown inline on the View screen; the service list keeps updating |
| `Locked` | Stop or a config save after the 30-minute unlock lapsed | The unlock dialog opens and the action resumes once it succeeds |

A parked session is reopened by the `reconnect` command, which rebuilds the transport from the
`ConnectSpec` the session was created with and resumes polling if it was running. The session id,
poll config, meter selection and counters all survive. **Never** navigate the user back to the
setup form on a transport failure — that throws away the setup they need to retry.

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

## Meter pack (shareable)

Envelope for one or many meter profiles (`.mbmeter.json`) — the file you hand a colleague:

```json
{
  "version": 1,
  "kind": "meter-pack",
  "exportedBy": "ModbusOpen 0.1.0",
  "exportedAt": "2026-08-07T10:00:00Z",
  "profiles": [ /* MeterProfile[] — see modbus/types.rs MeterProfile */ ]
}
```

Every meter is user-owned: profiles live as one JSON file per meter under the OS app-data
`meters/` directory, named `<id>.json`. The id is validated as a slug (letters, digits, `-`,
`_`) so an imported pack can't name a file outside that folder.

### A profile has no block

A `MeterProfile` is a list of parameters, each with its own 0-based wire address, format, and
optionally its own function code. It does **not** carry a start address and a register count.

That's deliberate. A Modbus request can only fetch a contiguous run of registers, up to 125 for
FC03/FC04 — so a meter whose parameters sit at 100, 400 and 3000 can't be described by one
block at all. Asking the user for a block meant either dropping the far parameters or refusing
the meter. `modbus::meters::plan_reads` instead derives the requests from the parameters:

- group by effective function code (a point's own, else the profile's),
- sort by address,
- extend the current request while the run stays inside the function's limit and the gap to the
  next parameter is at most `MAX_WASTED_REGISTERS` (32) — a few spare registers are cheaper than
  another round trip,
- otherwise start a new request.

The result is a `ReadBlock[]`, which is exactly what `PollConfig.blocks` holds. The editor shows
that plan and the poll engine executes it, so there is one answer to "how is this meter read".

### Poll config

`PollConfig` carries `blocks: ReadBlock[]` rather than a single start/quantity. Raw scanning is
the one-element case; one poll cycle issues every block in order and merges them into a single
`PollResult`. If any request in a cycle fails, the cycle fails — a table showing three of four
groups with the fourth silently missing is worse than an error.

Because a result can have gaps, meter decoding takes `AddressedWord[]` (address/value pairs)
rather than a contiguous array, and reports any parameter whose registers weren't in the last
poll instead of decoding it from zeros.

On import, an id that already exists is reported as `duplicate_id` and the importer chooses
per profile: `rename`, `overwrite`, or `skip`. `source` is optional in the file (defaults to
`user`) and is re-tagged to `imported` on the way in, so the library can show where a meter
came from.


## Service control (Linux only)

Types behind the Services screen. See `docs/04-ux-flows.md#services` for the screens and
`src-tauri/src/services/` for the implementation.

```rust
pub enum ServiceSubcategory { Capture, Sync }   // snake_case on the wire

pub struct ServiceEntry {          // what we persist
    pub unit: String,              // full name, e.g. "meter-poll.service"
    pub description: String,       // the operator's words; falls back to the unit's own
    pub category: String,          // free text; empty renders as "Uncategorised"
    pub subcategory: ServiceSubcategory,
}

pub struct ServicesConfig { pub version: u32, pub services: Vec<ServiceEntry> }

pub struct ServiceStatus {         // an entry joined with what the system reports
    pub unit: String,
    pub description: String,
    pub category: String,
    pub subcategory: ServiceSubcategory,
    pub load_state: String,        // loaded | not-found | masked | error
    pub active_state: String,      // active | inactive | failed | activating | deactivating
    pub sub_state: String,         // running | dead | exited | …
    pub unit_file_state: String,   // enabled | disabled | static | masked | ""
    pub auto_start_at: Option<DateTime<Utc>>,   // set while a stop is being held
}

pub struct ServiceValidation { pub unit: String, pub valid: bool,
                               pub description: Option<String>, pub message: String }

pub struct UnlockState { pub unlocked: bool, pub expires_at: Option<DateTime<Utc>> }

pub struct ServiceStatusEvent { pub session_id: u64, pub services: Vec<ServiceStatus> }
pub struct ServiceLogEvent { pub session_id: u64, pub unit: String, pub lines: Vec<String> }
```

### What the app is and isn't allowed to do

The app runs exactly two mutating commands: `systemctl start` and `systemctl stop`. It never
runs `enable`, `disable`, `mask`, or edits a unit file. Everything else it knows comes from
`systemctl show` and `journalctl`.

That is a deliberate boundary, not an omission. Taking a service down for good is a lasting
change to the machine, so it stays a deliberate act by a person with a terminal — the Configure
tab hands over `sudo systemctl disable --now <unit>` and reads the result back out of
`unit_file_state`. Nothing this app does can leave a site in a state its own admins can't
explain from their shell history.

### The 30-minute hold

`stop_service` is not "off", it's "off for 30 minutes". It writes a deadline to
`<app-data>/services/holds.json` and a background task starts the unit again when the deadline
passes. This is the whole point of the feature: an operator who stops capture to swap a meter
and then gets pulled away does not lose the afternoon's data.

Two things cancel a hold: a manual Start, and the operator disabling or masking the unit
themselves — `unit_file_state` of `disabled` or `masked` means "I meant it", and the task
leaves those alone. A failed automatic restart re-arms 60 seconds later rather than giving up.

Deadlines survive an app restart. On launch, an expired deadline fires immediately and an
unexpired one resumes counting down. They do **not** need to survive a reboot: the units are
`enabled`, so systemd starts them itself.

### The unlock

One password (hard-coded, at the customer's request) buys 30 minutes of the Configure tab.
Start and Stop are always free — View is open to anyone at the machine. The safety on Stop is
the 30-minute return plus a confirmation dialog, not a gate.

The expiry is owned by Rust and enforced in `commands/services.rs` on `save_services_config`,
not in the UI, so there is one source of truth and a stale screen can't talk the backend into
changing the monitored list. The password is an operational guard against a mis-click, **not**
a secret: it ships in the binary, and the real bound on the app's authority is the polkit rule
in `packaging/linux/polkit/`.
