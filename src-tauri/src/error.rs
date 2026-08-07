use serde::Serialize;

/// Every fallible command returns this. Variants map to a sentence a controls
/// engineer can act on — never a raw errno or a `Debug`-formatted Rust error.
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("{0}")]
    SerialPortList(String),

    #[error("Can't reach {host}:{port} — {reason}")]
    TcpConnect {
        host: String,
        port: u16,
        reason: String,
    },

    #[error("Can't open {port} — {reason}")]
    SerialOpen { port: String, reason: String },

    #[error("No response from unit {unit_id} within {timeout_ms} ms ({attempts} attempts)")]
    Timeout {
        unit_id: u8,
        timeout_ms: u64,
        attempts: u8,
    },

    #[error("{name} ({code:02}) — {hint}")]
    ModbusException {
        code: u8,
        name: String,
        hint: String,
    },

    #[error("Connection lost — {reason}")]
    ConnectionLost { reason: String },

    #[error("{0}")]
    InvalidConfig(String),

    #[error("Not connected")]
    NotConnected,
}

/// Maps a Modbus exception code to a human name and an actionable hint. See
/// `docs/05-data-model.md#errors` and `docs/reference/function-codes.md`.
pub fn exception_name_and_hint(code: u8, function: u8, addr: u16, unit_id: u8) -> (String, String) {
    match code {
        0x01 => (
            "Illegal Function".to_string(),
            format!("This device doesn't support FC{function}. Try FC03 or FC04."),
        ),
        0x02 => (
            "Illegal Data Address".to_string(),
            format!(
                "No register at {addr}. Check the start address and the addressing base (0- vs 1-based)."
            ),
        ),
        0x03 => (
            "Illegal Data Value".to_string(),
            "The device rejected the value or the quantity. FC03 allows at most 125 registers per request."
                .to_string(),
        ),
        0x04 => (
            "Slave Device Failure".to_string(),
            "The device hit an internal error. Check its own diagnostics.".to_string(),
        ),
        0x05 => (
            "Acknowledge".to_string(),
            "The device accepted the request but needs more time.".to_string(),
        ),
        0x06 => (
            "Slave Device Busy".to_string(),
            "The device is busy. Increase the poll interval and retry.".to_string(),
        ),
        0x0B => (
            "Gateway Target Failed".to_string(),
            format!("The gateway reached but got no reply from unit {unit_id}. Check the downstream serial bus."),
        ),
        other => (
            format!("Unknown Exception ({other:02x})"),
            "Unrecognized exception code — check the device's documentation.".to_string(),
        ),
    }
}
