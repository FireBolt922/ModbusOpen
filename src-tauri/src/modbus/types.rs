use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// ALWAYS the 0-based wire address. Never store 1-based internally — convert
/// at the display layer only.
pub type WireAddress = u16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    Tcp,
    Rtu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FunctionCode {
    ReadCoils = 0x01,
    ReadDiscreteInputs = 0x02,
    ReadHoldingRegisters = 0x03,
    ReadInputRegisters = 0x04,
    WriteSingleCoil = 0x05,
    WriteSingleRegister = 0x06,
    WriteMultipleCoils = 0x0F,
    WriteMultipleRegisters = 0x10,
}

impl FunctionCode {
    /// Max quantity per request, per `docs/reference/function-codes.md`.
    pub fn max_quantity(self) -> u16 {
        match self {
            FunctionCode::ReadCoils | FunctionCode::ReadDiscreteInputs => 2000,
            FunctionCode::ReadHoldingRegisters | FunctionCode::ReadInputRegisters => 125,
            FunctionCode::WriteMultipleCoils => 1968,
            FunctionCode::WriteMultipleRegisters => 123,
            FunctionCode::WriteSingleCoil | FunctionCode::WriteSingleRegister => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataType {
    Bool,
    Uint16,
    Int16,
    Hex16,
    Binary16,
    Uint32,
    Int32,
    Float32,
    Uint64,
    Int64,
    Float64,
    String,
}

impl DataType {
    /// Registers consumed by one value of this type. `String` is variable-length
    /// and handled separately by callers.
    pub fn register_span(self) -> u8 {
        match self {
            DataType::Bool
            | DataType::Uint16
            | DataType::Int16
            | DataType::Hex16
            | DataType::Binary16 => 1,
            DataType::Uint32 | DataType::Int32 | DataType::Float32 => 2,
            DataType::Uint64 | DataType::Int64 | DataType::Float64 => 4,
            DataType::String => 0,
        }
    }

    /// True for the IEEE-754 types, which carry a fractional part. Integer
    /// registers quantise, so callers that generate or check values need to
    /// know which side of that line a type sits on.
    pub fn is_float(self) -> bool {
        matches!(self, DataType::Float32 | DataType::Float64)
    }
}

/// Byte/word arrangement for multi-register values.
/// See `docs/reference/data-types-word-order.md`. `Cdab` is the default in
/// this shop — it's what the existing meters use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WordOrder {
    Abcd,
    Cdab,
    Badc,
    Dcba,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFormat {
    pub data_type: DataType,
    pub word_order: WordOrder,
    pub scale: f64,
    pub offset: f64,
}

impl Default for DataFormat {
    fn default() -> Self {
        Self {
            data_type: DataType::Uint16,
            word_order: WordOrder::Cdab,
            scale: 1.0,
            offset: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AddressBase {
    ZeroBased,
    OneBased,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpConfig {
    pub host: String,
    pub port: u16,
    pub unit_id: u8,
    pub timeout_ms: u64,
    pub retries: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Parity {
    None,
    Even,
    Odd,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RtuConfig {
    pub port: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: Parity,
    pub stop_bits: u8,
    pub unit_id: u8,
    pub timeout_ms: u64,
    pub retries: u8,
    pub inter_frame_delay_us: Option<u32>,
}

// `Connecting` and `Error` are part of the documented IPC contract
// (docs/05-data-model.md) — RTU connects in M2 surface `Connecting` while
// the port opens, and a session that dies mid-poll surfaces `Error` instead
// of silently reverting to `Disconnected`. Not constructed yet in M1.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected {
        since: DateTime<Utc>,
        transport: Transport,
        summary: String,
    },
    Error {
        message: String,
        at: DateTime<Utc>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub session_id: u64,
    pub transport: Transport,
    pub summary: String,
}

/// One Modbus read request: a function code, a start address, and how many
/// items to ask for.
///
/// A request can only cover a contiguous run of registers, and only up to the
/// function's limit. A meter whose parameters sit at 100, 400 and 3000 is
/// therefore three requests, not one — which is why a poll carries a list of
/// these rather than a single start/quantity pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadBlock {
    pub function: FunctionCode,
    pub start_address: WireAddress,
    pub quantity: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollConfig {
    pub unit_id: u8,
    /// The requests issued, in order, once per poll cycle. Always at least
    /// one; raw scanning is the one-element case.
    pub blocks: Vec<ReadBlock>,
    pub interval_ms: u64,
    /// How the raw register table decodes what comes back. Meter parameters
    /// carry their own format and are decoded per point instead.
    pub format: DataFormat,
}

impl PollConfig {
    /// The first request. Raw mode has exactly one, and the parts of the UI
    /// that predate multi-block reads (the write panel's default address, the
    /// bit-mode check) are asking about that one.
    pub fn first_block(&self) -> ReadBlock {
        self.blocks.first().copied().unwrap_or(ReadBlock {
            function: FunctionCode::ReadHoldingRegisters,
            start_address: 0,
            quantity: 1,
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollResult {
    pub session_id: u64,
    pub sequence: u64,
    pub timestamp: DateTime<Utc>,
    pub latency_ms: f64,
    pub registers: Vec<DecodedRegister>,
    pub stats: PollStats,
}

/// One register's worth of raw data at a known address.
///
/// A poll that issued several requests comes back as a set of these rather
/// than one array, since the addresses in between were never read.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressedWord {
    pub address: WireAddress,
    pub value: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedRegister {
    pub address: WireAddress,
    pub span: u8,
    pub raw: Vec<u16>,
    pub value: TypedValue,
    pub decode_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum TypedValue {
    Bool(bool),
    Int(i64),
    Uint(u64),
    Float(f64),
    Text(String),
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Tx,
    Rx,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameAnnotation {
    pub unit_id: u8,
    pub function: u8,
    pub is_exception: bool,
    pub exception_code: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameLogEntry {
    pub session_id: u64,
    pub timestamp: DateTime<Utc>,
    pub direction: Direction,
    pub bytes: Vec<u8>,
    pub unit_id: u8,
    pub function: u8,
    pub is_exception: bool,
    pub exception_code: Option<u8>,
    pub rtt_ms: Option<f64>,
    pub annotation: Option<FrameAnnotation>,
}

/// A write the UI asks the poll task to perform (serialized on the same
/// channel as polls so RTU never interleaves two transactions).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum WriteRequest {
    SingleCoil {
        unit_id: u8,
        address: WireAddress,
        value: bool,
    },
    SingleRegister {
        unit_id: u8,
        address: WireAddress,
        value: u16,
    },
    MultipleCoils {
        unit_id: u8,
        address: WireAddress,
        values: Vec<bool>,
    },
    MultipleRegisters {
        unit_id: u8,
        address: WireAddress,
        values: Vec<u16>,
    },
    Typed {
        unit_id: u8,
        address: WireAddress,
        value: TypedValue,
        format: DataFormat,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub session_id: u64,
    pub latency_ms: f64,
    pub function: FunctionCode,
    pub address: WireAddress,
    pub quantity: u16,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
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

/// Transient poll failure — poll continues. Carries `session_id` so the UI can
/// drop events from a torn-down connection, and `stats` so the footer stays live.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollErrorEvent {
    pub session_id: u64,
    pub message: String,
    pub stats: PollStats,
}

/// Fatal transport failure — the poll task is stopping.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionLostEvent {
    pub session_id: u64,
    pub message: String,
}

/// How a tag's value evolves on each animation tick. `Ramp` bounces between
/// `min` and `max` (triangle wave, not sawtooth) so it never has a
/// discontinuous jump; `Sine`'s phase is driven by wall-clock time since the
/// simulator started, not tick count, so it stays correct across
/// interval/tick-rate changes.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TagBehavior {
    Static,
    #[serde(rename_all = "camelCase")]
    Random {
        min: f64,
        max: f64,
    },
    #[serde(rename_all = "camelCase")]
    Ramp {
        min: f64,
        max: f64,
        step: f64,
    },
    #[serde(rename_all = "camelCase")]
    Sine {
        min: f64,
        max: f64,
        period_s: f64,
    },
    #[serde(rename_all = "camelCase")]
    Counter {
        step: f64,
    },
}

/// An animated value within a slave's holding-register block. Coils/
/// discretes/input registers aren't animatable in v1 — every documented
/// device profile (docs/reference/device-profiles.md) is holding-register
/// based, and `String` isn't a valid tag type (`codec::encode` doesn't
/// support encoding a random/ramping string).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagConfig {
    pub name: String,
    pub address: WireAddress,
    pub format: DataFormat,
    pub behavior: TagBehavior,
    pub initial_value: f64,
}

/// One slave's register/coil block sizes, as configured from the UI —
/// `sim_start` zero-fills each block to these counts. See
/// `modbus::store::SlaveLayout` for the internal (non-wire) equivalent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlaveSimConfig {
    pub unit_id: u8,
    pub coil_count: u16,
    pub discrete_count: u16,
    pub input_register_count: u16,
    pub holding_register_count: u16,
    pub tags: Vec<TagConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulatorConfig {
    pub tcp_port: u16,
    pub slaves: Vec<SlaveSimConfig>,
    /// How often animated tags tick. Ignored if no slave has any tags.
    pub tick_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulatorInfo {
    pub session_id: u64,
    pub tcp_port: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlaveSnapshot {
    pub unit_id: u8,
    pub coils: Vec<bool>,
    pub discrete_inputs: Vec<bool>,
    pub input_registers: Vec<u16>,
    pub holding_registers: Vec<u16>,
}

/// `sim_snapshot`'s return value and the `sim-update` event payload —
/// carries `session_id` so a stale event from a torn-down simulator session
/// gets dropped by the UI instead of corrupting a new session's table.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulatorSnapshot {
    pub session_id: u64,
    pub tcp_port: u16,
    pub slaves: Vec<SlaveSnapshot>,
}

// ---------------------------------------------------------------------------
// Meter profiles — user-built named register maps (scanner + shareable packs)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeterPointGroup {
    Instantaneous,
    Energy,
    Harmonics,
    Diagnostics,
    Other,
}

/// Where a profile came from. Every meter is user-owned — either built in the
/// editor or imported from a shared pack — so this is provenance for display,
/// not a permission level.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MeterSource {
    #[default]
    User,
    #[serde(rename_all = "camelCase")]
    Imported { from: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RtuDefaults {
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: Parity,
    pub stop_bits: u8,
}

impl Default for RtuDefaults {
    fn default() -> Self {
        // Firmware field default: 9600 8-E-1.
        Self {
            baud_rate: 9600,
            data_bits: 8,
            parity: Parity::Even,
            stop_bits: 1,
        }
    }
}

/// One named parameter inside a meter map. Address is always 0-based wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterPoint {
    pub key: String,
    pub label: String,
    pub address: WireAddress,
    pub format: DataFormat,
    #[serde(default)]
    pub unit: String,
    /// Which read function this parameter lives behind. Almost every meter
    /// answers on one function, so this defaults to the profile's; a device
    /// that splits input and holding registers sets it per parameter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub function: Option<FunctionCode>,
    #[serde(default = "default_point_group")]
    pub group: MeterPointGroup,
    #[serde(default)]
    pub unverified: bool,
    /// Optional simulator animation when this profile is loaded as a slave.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sim_behavior: Option<TagBehavior>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sim_initial: Option<f64>,
}

fn default_point_group() -> MeterPointGroup {
    MeterPointGroup::Instantaneous
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterProfile {
    pub id: String,
    pub brand: String,
    pub model: String,
    #[serde(default)]
    pub description: String,
    /// Optional in the file so a hand-written profile can be imported as-is.
    #[serde(default)]
    pub source: MeterSource,
    /// The read function used by any parameter that doesn't override it.
    pub function: FunctionCode,
    pub default_unit_id: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_rtu: Option<RtuDefaults>,
    pub points: Vec<MeterPoint>,
}

/// Shareable export envelope (one or many profiles).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterPack {
    pub version: u32,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exported_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exported_at: Option<DateTime<Utc>>,
    pub profiles: Vec<MeterProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeterImportStatus {
    New,
    DuplicateId,
    Invalid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterImportItem {
    pub profile: MeterProfile,
    pub status: MeterImportStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterImportPreview {
    pub path: String,
    pub items: Vec<MeterImportItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportResolution {
    Rename,
    Overwrite,
    Skip,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterImportChoice {
    pub profile_id: String,
    pub resolution: ImportResolution,
    /// Required when resolution is Rename.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_id: Option<String>,
}
