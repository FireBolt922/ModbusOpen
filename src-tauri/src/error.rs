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

    #[error("Bad reply — {reason}")]
    BadFrame { reason: String },

    /// The transport dropped and the session is parked, waiting for a
    /// reconnect. Carries the already-humanised reason it went down, so it
    /// prints as-is rather than nesting inside another sentence.
    #[error("{message}")]
    LinkDown { message: String },

    #[error("{0}")]
    InvalidConfig(String),

    #[error("Not connected")]
    NotConnected,

    /// A feature that only exists on one platform was reached on another.
    #[error("{message}")]
    Unsupported { message: String },

    /// A `systemctl start`/`stop` didn't take. `action` is the verb, so the
    /// sentence reads "Can't stop meter-poll.service — …".
    #[error("Can't {action} {unit} — {reason}")]
    ServiceControl {
        action: String,
        unit: String,
        reason: String,
    },

    /// The shared 30-minute unlock has expired (or was never entered).
    #[error("Enter the configuration password to do that.")]
    Locked,
}

/// Map a serialport / OS open error to an actionable sentence. Never surface a
/// bare errno — controls engineers need the fix, not the C constant.
pub fn map_serial_open_error(port: &str, err: impl std::fmt::Display) -> AppError {
    AppError::SerialOpen {
        port: port.to_string(),
        reason: humanize_serial_error(&err.to_string()),
    }
}

/// Turn a mid-session transport failure into a sentence naming the likeliest
/// cause. Split by transport because the same errno means different things:
/// a broken pipe on RS-485 is an unplugged adapter, on TCP it's the device
/// hanging up — very often because it accepts only one client and somebody
/// else already has it.
pub fn humanize_link_error(transport: crate::modbus::types::Transport, raw: &str) -> String {
    use crate::modbus::types::Transport;

    if matches!(transport, Transport::Rtu) {
        return humanize_serial_error(raw);
    }

    let lower = raw.to_lowercase();
    if lower.contains("reset")
        || lower.contains("broken pipe")
        || lower.contains("eof")
        || lower.contains("aborted")
        || lower.contains("not connected")
        || lower.contains("closed")
    {
        return "the device closed the connection. Many Modbus TCP devices and gateways \
                accept only one client at a time — close the other program that's polling \
                it, then reconnect."
            .to_string();
    }
    if lower.contains("unreachable") || lower.contains("timed out") {
        return "the device is no longer reachable — check the network, the cable, and \
                whether the device is still powered."
            .to_string();
    }
    raw.trim().to_string()
}

/// Turn a mid-session serial I/O failure (USB unplug, port gone, etc.) into
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

/// A reply arrived but it wasn't usable — bad CRC, or a header that belongs to
/// somebody else's request. The link is still open, so this must never read as
/// "connection lost": the usual cause is a second master on the same bus, or
/// two programs sharing one device.
pub fn humanize_frame_error(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("crc") {
        return "checksum failed — the frame arrived garbled. Check baud rate, parity and \
                wiring, and whether another program is polling the same bus."
            .to_string();
    }
    if lower.contains("mismatching headers")
        || lower.contains("mismatching function codes")
        || lower.contains("invalid data")
    {
        return "the reply didn't match the request — another program is probably talking to \
                this device at the same time. Close it, or poll from one master only."
            .to_string();
    }
    raw.trim().to_string()
}

/// Turn `systemctl`'s stderr into a sentence naming the fix.
///
/// The one that matters most is the polkit case: if the rule shipped with the
/// package isn't installed, every stop fails with "Interactive authentication
/// required" — which tells an operator nothing. Name the actual remedy.
pub fn humanize_systemctl_error(unit: &str, raw: &str) -> String {
    let lower = raw.to_lowercase();
    let short = unit.trim_end_matches(".service");

    if lower.contains("interactive authentication required")
        || lower.contains("access denied")
        || lower.contains("not authorized")
        || lower.contains("permission denied")
    {
        return "this machine isn't set up to let ModbusOpen control services. Add your \
                user to the 'modbusopen' group, reinstall the package so its permission \
                rule is in place, then log out and back in."
            .to_string();
    }
    if lower.contains("not found") || lower.contains("no such unit") {
        return format!(
            "there's no service called {short} on this machine. Check the exact name on the \
             Configure tab."
        );
    }
    if lower.contains("is masked") {
        return format!(
            "{short} is masked, so it can't be started until somebody runs \
             `sudo systemctl unmask {unit}` in a terminal."
        );
    }
    if lower.contains("job for") || lower.contains("failed with result") || lower.contains("see '")
    {
        return format!("{short} didn't come up. Open its logs to see why.");
    }
    if lower.contains("connection refused") || lower.contains("failed to connect to bus") {
        return "the system service manager isn't reachable. Is this a systemd machine?"
            .to_string();
    }

    let trimmed = raw.trim();
    if trimmed.is_empty() {
        "the system service manager rejected the request without saying why.".to_string()
    } else {
        trimmed.to_string()
    }
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

    /// The reported bug in one assertion: a garbled frame must not be phrased
    /// — or classified — as a lost connection.
    #[test]
    fn a_bad_checksum_reads_as_a_bad_frame_not_a_lost_link() {
        let msg = humanize_frame_error("Invalid CRC: expected = 0x1234, actual = 0x5678");
        assert!(msg.contains("checksum"), "got: {msg}");
        assert!(
            !msg.to_lowercase().contains("connection lost"),
            "got: {msg}"
        );
    }

    #[test]
    fn a_foreign_reply_points_at_the_other_program() {
        let msg = humanize_frame_error("mismatching headers: transaction id Ok(..)");
        assert!(msg.contains("another program"), "got: {msg}");
    }

    #[test]
    fn a_tcp_hangup_names_the_single_client_limit() {
        let msg = humanize_link_error(
            crate::modbus::types::Transport::Tcp,
            "Connection reset by peer (os error 54)",
        );
        assert!(msg.contains("one client at a time"), "got: {msg}");
        assert!(!msg.contains("os error"), "raw errno leaked: {msg}");
    }

    /// Same errno, different transport, different cause — RS-485 keeps the
    /// unplugged-adapter wording rather than talking about TCP clients.
    #[test]
    fn the_same_errno_reads_differently_on_serial() {
        let msg = humanize_link_error(
            crate::modbus::types::Transport::Rtu,
            "Broken pipe (os error 32)",
        );
        assert!(msg.contains("unplugged"), "got: {msg}");
    }

    /// The polkit rule is the one piece of setup a site can get wrong, so the
    /// message has to name it rather than echo D-Bus jargon.
    #[test]
    fn missing_polkit_rule_names_the_group_and_the_reinstall() {
        let msg = humanize_systemctl_error(
            "meter-poll.service",
            "Failed to stop meter-poll.service: Interactive authentication required.",
        );
        assert!(msg.contains("modbusopen"), "got: {msg}");
        assert!(msg.contains("log out"), "got: {msg}");
        assert!(
            !msg.to_lowercase().contains("interactive authentication"),
            "raw D-Bus text leaked: {msg}"
        );
    }

    #[test]
    fn unknown_unit_points_back_at_configure() {
        let msg = humanize_systemctl_error(
            "nope.service",
            "Failed to start nope.service: Unit nope.service not found.",
        );
        assert!(msg.contains("nope"), "got: {msg}");
        assert!(msg.contains("Configure"), "got: {msg}");
    }

    #[test]
    fn a_unit_that_wont_start_sends_you_to_the_logs() {
        let msg = humanize_systemctl_error(
            "meter-poll.service",
            "Job for meter-poll.service failed because the control process exited with error code.",
        );
        assert!(msg.contains("logs"), "got: {msg}");
    }

    #[test]
    fn a_masked_unit_hands_over_the_unmask_command() {
        let msg = humanize_systemctl_error(
            "sync.service",
            "Failed to start sync.service: Unit sync.service is masked.",
        );
        assert!(msg.contains("unmask sync.service"), "got: {msg}");
    }

    /// Empty stderr still has to produce a sentence — never a bare blank.
    #[test]
    fn a_silent_failure_still_says_something() {
        let msg = humanize_systemctl_error("x.service", "   ");
        assert!(!msg.trim().is_empty());
        assert!(msg.contains("without saying why"), "got: {msg}");
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
