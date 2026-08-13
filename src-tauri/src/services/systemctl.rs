//! The only place in the app that talks to systemd.
//!
//! Two rules hold this module together:
//!
//! 1. **Read freely, write narrowly.** `show` and `journalctl` need no
//!    privilege. The only mutating verbs are `start` and `stop` — never
//!    `enable`, `disable`, `mask` or anything that edits a unit file. Making a
//!    service permanently disabled is the operator's job in a terminal; we only
//!    read the result back out of `UnitFileState`.
//! 2. **Never spawn off Linux.** Every entry point goes through
//!    [`ensure_linux`] first, so a macOS or Windows build cannot reach a
//!    process spawn even if the UI gate were bypassed.
//!
//! Parsing is kept as free functions so it stays unit-tested on every platform,
//! not just the one that can run the real binary.

use std::collections::HashMap;
use std::process::Stdio;

use tokio::process::{Child, Command};

use crate::error::{humanize_systemctl_error, AppError};

/// Asked for by name, and parsed back out of `Key=Value` lines. Deliberately
/// not `--value`: that prints bare values in property order, so one missing
/// property silently shifts every field by one.
const SHOW_PROPERTIES: &str = "Id,Description,LoadState,ActiveState,SubState,UnitFileState";

/// Unit suffixes systemd understands. A name without one of these gets
/// `.service` appended, because that's what an operator means when they type
/// `meter-poll`.
const UNIT_SUFFIXES: &[&str] = &[
    "service",
    "socket",
    "timer",
    "target",
    "mount",
    "automount",
    "path",
    "slice",
    "scope",
    "device",
    "swap",
];

/// How many recent lines the log view opens with.
pub const LOG_HISTORY_LINES: u32 = 200;

/// What the system reports about one unit.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UnitInfo {
    pub id: String,
    pub description: String,
    pub load_state: String,
    pub active_state: String,
    pub sub_state: String,
    pub unit_file_state: String,
}

impl UnitInfo {
    /// systemd reports `LoadState=not-found` for a name it doesn't know. That
    /// is the single check behind the Validate button.
    pub fn exists(&self) -> bool {
        !self.load_state.is_empty() && self.load_state != "not-found"
    }

    /// True when the operator has deliberately taken this unit out of service
    /// at the OS level. The auto-restart task must leave these alone.
    pub fn is_held_by_operator(&self) -> bool {
        matches!(self.unit_file_state.as_str(), "disabled" | "masked")
            || self.load_state == "masked"
    }
}

/// The two verbs the app is allowed to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceAction {
    Start,
    Stop,
}

impl ServiceAction {
    pub fn verb(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
        }
    }
}

/// The guard that makes "Linux only" true in the binary, not just in the UI.
pub fn ensure_linux() -> Result<(), AppError> {
    if cfg!(target_os = "linux") {
        Ok(())
    } else {
        Err(AppError::Unsupported {
            message: "Service control is available on Linux only.".to_string(),
        })
    }
}

/// Normalise what the operator typed into the Configure box: one or many names
/// separated by commas, in any spacing, with or without the `.service` suffix.
/// Order is preserved and duplicates dropped so the list reads back the way it
/// was typed.
pub fn normalize_unit_names(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for piece in raw.split([',', '\n']) {
        let name = piece.trim();
        if name.is_empty() {
            continue;
        }
        let full = with_unit_suffix(name);
        if !out.contains(&full) {
            out.push(full);
        }
    }
    out
}

fn with_unit_suffix(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((_, suffix)) if UNIT_SUFFIXES.contains(&suffix) => name.to_string(),
        _ => format!("{name}.service"),
    }
}

/// Reject anything that isn't a plausible unit name before it reaches a
/// process argument. Nothing is passed through a shell, so this is not an
/// injection defence — it's how a typo becomes a clear message instead of a
/// confusing systemd error.
pub fn validate_unit_name(unit: &str) -> Result<(), AppError> {
    if unit.is_empty() || unit.len() > 255 {
        return Err(AppError::InvalidConfig(format!(
            "'{unit}' isn't a usable service name."
        )));
    }
    let ok = unit
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '@' | ':' | '\\'));
    if !ok {
        return Err(AppError::InvalidConfig(format!(
            "'{unit}' contains characters that aren't allowed in a service name."
        )));
    }
    Ok(())
}

/// Parse the output of `systemctl show a.service b.service --property=…`.
///
/// systemd prints one `Key=Value` block per unit, separated by a blank line.
/// Values can themselves contain `=` (descriptions routinely do), so only the
/// first one splits. `requested` is used as a positional fallback for the rare
/// block that comes back without an `Id`.
pub fn parse_show_output(stdout: &str, requested: &[String]) -> HashMap<String, UnitInfo> {
    let mut out = HashMap::new();

    for (index, block) in stdout
        .split("\n\n")
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .enumerate()
    {
        let mut info = UnitInfo::default();
        for line in block.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let value = value.trim_end_matches('\r').to_string();
            match key {
                "Id" => info.id = value,
                "Description" => info.description = value,
                "LoadState" => info.load_state = value,
                "ActiveState" => info.active_state = value,
                "SubState" => info.sub_state = value,
                "UnitFileState" => info.unit_file_state = value,
                _ => {}
            }
        }

        if info.id.is_empty() {
            match requested.get(index) {
                Some(name) => info.id = name.clone(),
                None => continue,
            }
        }
        out.insert(info.id.clone(), info);
    }

    out
}

/// One process call for every monitored unit, rather than one per unit — a
/// site with thirty services would otherwise spawn thirty processes every
/// three-second tick.
pub async fn show_units(units: &[String]) -> Result<HashMap<String, UnitInfo>, AppError> {
    ensure_linux()?;
    if units.is_empty() {
        return Ok(HashMap::new());
    }
    for unit in units {
        validate_unit_name(unit)?;
    }

    let output = Command::new("systemctl")
        .arg("show")
        .args(units)
        .arg(format!("--property={SHOW_PROPERTIES}"))
        .arg("--no-pager")
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| AppError::ServiceControl {
            action: "read".to_string(),
            unit: units.join(", "),
            reason: humanize_systemctl_error("", &e.to_string()),
        })?;

    // `show` exits non-zero for an unknown unit but still prints a usable
    // block for it, so the exit code is not treated as fatal here — the caller
    // reads `LoadState` instead.
    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() && !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::ServiceControl {
            action: "read".to_string(),
            unit: units.join(", "),
            reason: humanize_systemctl_error("", &stderr),
        });
    }

    Ok(parse_show_output(&stdout, units))
}

/// Start or stop one unit. Privilege comes from the polkit rule shipped with
/// the package — see `packaging/linux/polkit/`. Without it this fails with an
/// authentication error, which [`humanize_systemctl_error`] turns into setup
/// instructions.
pub async fn control_unit(action: ServiceAction, unit: &str) -> Result<(), AppError> {
    ensure_linux()?;
    validate_unit_name(unit)?;

    let output = Command::new("systemctl")
        .arg(action.verb())
        .arg(unit)
        .arg("--no-ask-password")
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| AppError::ServiceControl {
            action: action.verb().to_string(),
            unit: unit.to_string(),
            reason: humanize_systemctl_error(unit, &e.to_string()),
        })?;

    if output.status.success() {
        return Ok(());
    }

    let mut raw = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if raw.is_empty() {
        raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    }
    Err(AppError::ServiceControl {
        action: action.verb().to_string(),
        unit: unit.to_string(),
        reason: humanize_systemctl_error(unit, &raw),
    })
}

/// Spawn `journalctl` following one unit, with history already in the buffer.
///
/// The caller owns the returned [`Child`] and **must** kill it when the log
/// panel closes — an orphaned `journalctl -f` lives as long as the app does.
pub fn spawn_log_tail(unit: &str) -> Result<Child, AppError> {
    ensure_linux()?;
    validate_unit_name(unit)?;

    Command::new("journalctl")
        .arg("-u")
        .arg(unit)
        .arg("-n")
        .arg(LOG_HISTORY_LINES.to_string())
        .arg("-f")
        .arg("--output=short-iso")
        .arg("--no-pager")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::ServiceControl {
            action: "read logs for".to_string(),
            unit: unit.to_string(),
            reason: humanize_systemctl_error(unit, &e.to_string()),
        })
}

/// Take the child's stdout so the batching task in `manager.rs` can read it,
/// without that task needing to know how the child was built.
pub fn take_stdout(child: &mut Child, unit: &str) -> Result<tokio::process::ChildStdout, AppError> {
    child.stdout.take().ok_or_else(|| AppError::ServiceControl {
        action: "read logs for".to_string(),
        unit: unit.to_string(),
        reason: "the log reader started without an output stream.".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from a real `systemctl show`, including the two cases that
    /// break naive parsers: a description containing `=`, and a unit the
    /// system has never heard of.
    const SHOW_FIXTURE: &str = "\
Id=meter-poll.service
Description=Meter capture poller (mode=fast)
LoadState=loaded
ActiveState=active
SubState=running
UnitFileState=enabled

Id=mqtt-bridge.service
Description=MQTT bridge
LoadState=loaded
ActiveState=inactive
SubState=dead
UnitFileState=disabled

Id=nope.service
Description=nope.service
LoadState=not-found
ActiveState=inactive
SubState=dead
";

    #[test]
    fn parses_every_block_and_keeps_equals_signs_in_descriptions() {
        let requested = vec![
            "meter-poll.service".to_string(),
            "mqtt-bridge.service".to_string(),
            "nope.service".to_string(),
        ];
        let map = parse_show_output(SHOW_FIXTURE, &requested);

        assert_eq!(map.len(), 3);
        let poll = &map["meter-poll.service"];
        assert_eq!(poll.description, "Meter capture poller (mode=fast)");
        assert_eq!(poll.active_state, "active");
        assert_eq!(poll.unit_file_state, "enabled");
        assert!(poll.exists());
        assert!(!poll.is_held_by_operator());
    }

    #[test]
    fn a_missing_unit_is_detected_by_load_state() {
        let requested = vec![
            "meter-poll.service".to_string(),
            "mqtt-bridge.service".to_string(),
            "nope.service".to_string(),
        ];
        let map = parse_show_output(SHOW_FIXTURE, &requested);
        assert!(!map["nope.service"].exists());
    }

    /// A disabled unit is the operator saying "leave this down". The
    /// auto-restart task keys off exactly this.
    #[test]
    fn disabled_and_masked_count_as_operator_held() {
        let requested = vec![
            "meter-poll.service".to_string(),
            "mqtt-bridge.service".to_string(),
            "nope.service".to_string(),
        ];
        let map = parse_show_output(SHOW_FIXTURE, &requested);
        assert!(map["mqtt-bridge.service"].is_held_by_operator());

        let masked = parse_show_output(
            "Id=x.service\nLoadState=masked\nUnitFileState=masked\n",
            &["x.service".to_string()],
        );
        assert!(masked["x.service"].is_held_by_operator());
    }

    /// systemd omits `Id` in some versions when the unit is unknown; fall back
    /// to the position in the request rather than dropping the unit silently.
    #[test]
    fn a_block_without_an_id_falls_back_to_the_requested_name() {
        let map = parse_show_output(
            "LoadState=not-found\nActiveState=inactive\n",
            &["ghost.service".to_string()],
        );
        assert!(map.contains_key("ghost.service"));
        assert!(!map["ghost.service"].exists());
    }

    #[test]
    fn comma_lists_are_split_trimmed_suffixed_and_deduped() {
        let got =
            normalize_unit_names("  meter-poll , mqtt-bridge.service ,, meter-poll,\n sync.timer ");
        assert_eq!(
            got,
            vec![
                "meter-poll.service".to_string(),
                "mqtt-bridge.service".to_string(),
                "sync.timer".to_string(),
            ]
        );
    }

    /// A dotted name whose suffix isn't a unit type is still a service —
    /// `com.example.agent` is a real-world naming style.
    #[test]
    fn a_dotted_name_that_is_not_a_unit_type_still_gets_service() {
        assert_eq!(
            normalize_unit_names("com.example.agent"),
            vec!["com.example.agent.service".to_string()]
        );
    }

    #[test]
    fn empty_input_yields_no_units() {
        assert!(normalize_unit_names("  , ,\n ").is_empty());
    }

    #[test]
    fn template_units_and_hyphens_are_accepted_but_paths_are_not() {
        assert!(validate_unit_name("getty@tty1.service").is_ok());
        assert!(validate_unit_name("meter-poll_2.service").is_ok());
        assert!(validate_unit_name("../../etc/passwd").is_err());
        assert!(validate_unit_name("foo bar.service").is_err());
        assert!(validate_unit_name("").is_err());
    }

    /// The platform gate is a hard guarantee, so assert it both ways.
    #[test]
    fn the_linux_gate_matches_the_build_target() {
        if cfg!(target_os = "linux") {
            assert!(ensure_linux().is_ok());
        } else {
            let err = ensure_linux().unwrap_err();
            assert!(err.to_string().contains("Linux only"), "got: {err}");
        }
    }
}
