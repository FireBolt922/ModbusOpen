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

/// Map a serialport / OS open error to an actionable sentence. Never surface a
/// bare errno — controls engineers need the fix, not the C constant.
pub fn map_serial_open_error(port: &str, err: impl std::fmt::Display) -> AppError {
    AppError::SerialOpen {
        port: port.to_string(),
        reason: humanize_serial_error(&err.to_string()),
    }
}

/// Turn a mid-session transport I/O failure (USB unplug, port gone, etc.) into
/// something the footer can show.
pub fn humanize_serial_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("permission denied") || lower.contains("os error 13") {
        return "permission denied — add your user to the 'dialout' group, then log out and back in."
            .to_string();
    }
    if lower.contains("device busy")
        || lower.contains("resource busy")
        || lower.contains("already open")
        || lower.contains("access is denied")
        || lower.contains("os error 16")
        || lower.contains("os error 5")
    {
        return "port is busy — another program is using it. Close the other app and try again."
            .to_string();
    }
    if lower.contains("no such file")
        || lower.contains("not found")
        || lower.contains("does not exist")
        || lower.contains("the system cannot find")
        || lower.contains("os error 2")
        || lower.contains("broken pipe")
        || lower.contains("device not configured")
        || lower.contains("i/o error")
    {
        return "port vanished — was the USB adapter unplugged?".to_string();
    }
    // Last resort: keep the OS text but still wrap it in SerialOpen's sentence.
    raw.trim().to_string()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_denied_mentions_dialout() {
        let err = map_serial_open_error("/dev/ttyUSB0", "Permission denied (os error 13)");
        let msg = err.to_string();
        assert!(msg.contains("dialout"), "expected dialout hint, got: {msg}");
        assert!(!msg.contains("os error 13"), "raw errno leaked: {msg}");
    }

    #[test]
    fn port_busy_is_actionable() {
        let err = map_serial_open_error("/dev/ttyUSB0", "Device or resource busy (os error 16)");
        let msg = err.to_string();
        assert!(msg.contains("busy"), "got: {msg}");
    }

    #[test]
    fn vanished_port_mentions_unplug() {
        let err = map_serial_open_error("/dev/ttyUSB0", "No such file or directory (os error 2)");
        let msg = err.to_string();
        assert!(
            msg.contains("unplugged") || msg.contains("vanished"),
            "got: {msg}"
        );
    }
}
