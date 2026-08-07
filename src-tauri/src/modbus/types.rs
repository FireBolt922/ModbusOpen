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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollConfig {
    pub unit_id: u8,
    pub function: FunctionCode,
    pub start_address: WireAddress,
    pub quantity: u16,
    pub interval_ms: u64,
    pub format: DataFormat,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedRegister {
    pub address: WireAddress,
    pub span: u8,
    pub raw: Vec<u16>,
    pub value: TypedValue,
    pub decode_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum TypedValue {
    Bool(bool),
    Int(i64),
    Uint(u64),
    Float(f64),
    Text(String),
    Invalid,
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
