//! Thin IPC surface for Linux service control.
//!
//! Every command here validates, delegates to `crate::services`, and maps
//! errors — no process handling and no parsing lives in this file.
//!
//! Start and stop are open. The unlock check is enforced on this side of the
//! boundary, not in the UI, and only on the commands that change *which*
//! services are monitored — so the 30-minute window has one source of truth.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, State};
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::modbus::types::{ServiceStatus, ServiceValidation, ServicesConfig, UnlockState};
use crate::services::manager::{self, ServiceManager};
use crate::services::systemctl::{self, ServiceAction};
use crate::AppState;

/// Run `f` against the lazily-loaded manager, holding the lock only for the
/// duration of the closure.
async fn with_manager<T, F>(app: &AppHandle, state: &AppState, f: F) -> Result<T, AppError>
where
    F: FnOnce(&mut ServiceManager) -> Result<T, AppError>,
{
    let mut guard = state.services.lock().await;
    let mgr = manager::ensure_manager(app, &mut guard)?;
    f(mgr)
}

/// Whether this build can control services at all. Sync and infallible so the
/// UI can gate the whole screen on it before anything else is attempted.
#[tauri::command]
pub fn services_supported() -> bool {
    cfg!(target_os = "linux")
}

/// The OS name, so the "Linux only" screen can say what this machine actually
/// is rather than leaving the user to guess why the feature is missing.
#[tauri::command]
pub fn services_platform() -> String {
    std::env::consts::OS.to_string()
}

#[tauri::command]
pub async fn services_unlock(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> Result<UnlockState, AppError> {
    systemctl::ensure_linux()?;
    with_manager(&app, &state, |m| m.unlock(&password)).await
}

#[tauri::command]
pub async fn services_unlock_state(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UnlockState, AppError> {
    systemctl::ensure_linux()?;
    with_manager(&app, &state, |m| Ok(m.unlock_state())).await
}

#[tauri::command]
pub async fn services_lock(app: AppHandle, state: State<'_, AppState>) -> Result<(), AppError> {
    systemctl::ensure_linux()?;
    with_manager(&app, &state, |m| {
        m.lock();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn get_services_config(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ServicesConfig, AppError> {
    systemctl::ensure_linux()?;
    with_manager(&app, &state, |m| Ok(m.config())).await
}

#[tauri::command]
pub async fn save_services_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: ServicesConfig,
) -> Result<ServicesConfig, AppError> {
    systemctl::ensure_linux()?;
    with_manager(&app, &state, |m| {
        m.require_unlocked()?;
        m.save_config(config)
    })
    .await
}

/// Check one or many names typed into the Configure box. Accepts a
/// comma-separated list so a whole rack of services can be added at once.
#[tauri::command]
pub async fn validate_service_units(names: String) -> Result<Vec<ServiceValidation>, AppError> {
    systemctl::ensure_linux()?;

    let units = systemctl::normalize_unit_names(&names);
    if units.is_empty() {
        return Ok(Vec::new());
    }

    // A malformed name shouldn't fail the whole batch — report it per-row so
    // the operator can see which of ten entries was the typo.
    let mut malformed: Vec<ServiceValidation> = Vec::new();
    let mut checkable: Vec<String> = Vec::new();
    for unit in units {
        match systemctl::validate_unit_name(&unit) {
            Ok(()) => checkable.push(unit),
            Err(err) => malformed.push(ServiceValidation {
                unit,
                valid: false,
                description: None,
                message: err.to_string(),
            }),
        }
    }

    let live = systemctl::show_units(&checkable).await?;
    let mut out: Vec<ServiceValidation> = checkable
        .into_iter()
        .map(|unit| match live.get(&unit) {
            Some(info) if info.exists() => ServiceValidation {
                unit: unit.clone(),
                valid: true,
                description: (!info.description.is_empty()).then(|| info.description.clone()),
                message: format!("Found — currently {}.", info.active_state),
            },
            _ => ServiceValidation {
                unit: unit.clone(),
                valid: false,
                description: None,
                message: format!(
                    "There's no service called {} on this machine. Check the exact name.",
                    unit.trim_end_matches(".service")
                ),
            },
        })
        .collect();
    out.append(&mut malformed);

    Ok(out)
}

/// One-shot list, used when the View screen mounts so it has something to draw
/// before the watcher's first tick.
#[tauri::command]
pub async fn list_monitored_services(app: AppHandle) -> Result<Vec<ServiceStatus>, AppError> {
    manager::collect_status(&app).await
}

/// Start and stop are both open on the View tab — no password.
///
/// The safety here is not a gate, it's the 30-minute return: a stop can't
/// silently become permanent, so making an operator hunt for a password to
/// take a service down (and again to put it back) would buy nothing but
/// friction. The UI confirms the stop and says what will happen. Changing
/// *which* services are monitored is the privileged act, and that still needs
/// the password — see [`save_services_config`].
#[tauri::command]
pub async fn start_service(
    app: AppHandle,
    state: State<'_, AppState>,
    unit: String,
) -> Result<ServiceStatus, AppError> {
    systemctl::ensure_linux()?;
    systemctl::control_unit(ServiceAction::Start, &unit).await?;

    // A manual start settles the question — drop any pending auto-restart.
    with_manager(&app, &state, |m| {
        m.clear_restart(&unit);
        Ok(())
    })
    .await?;

    manager::status_for(&app, &unit).await
}

/// Stop the unit and arm its 30-minute return.
#[tauri::command]
pub async fn stop_service(
    app: AppHandle,
    state: State<'_, AppState>,
    unit: String,
) -> Result<ServiceStatus, AppError> {
    systemctl::ensure_linux()?;

    systemctl::control_unit(ServiceAction::Stop, &unit).await?;
    with_manager(&app, &state, |m| {
        m.arm_restart(&unit);
        Ok(())
    })
    .await?;

    manager::status_for(&app, &unit).await
}

/// Start pushing `service-status` events. Returns the session id the UI must
/// match against; anything else is a stale watcher and gets dropped.
#[tauri::command]
pub async fn services_watch_start(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<u64, AppError> {
    systemctl::ensure_linux()?;

    // Replace rather than stack: remounting the View tab must not leave two
    // watchers emitting at once.
    let existing = {
        let mut guard = state.services.lock().await;
        let mgr = manager::ensure_manager(&app, &mut guard)?;
        mgr.take_watcher()
    };
    if let Some(session) = existing {
        session.shutdown().await;
    }

    let session_id = state.next_session_id.fetch_add(1, Ordering::SeqCst);
    let cancel = CancellationToken::new();
    let task = manager::spawn_status_watcher(app.clone(), session_id, cancel.clone());

    let mut guard = state.services.lock().await;
    let mgr = manager::ensure_manager(&app, &mut guard)?;
    mgr.set_watcher(session_id, cancel, task);
    Ok(session_id)
}

#[tauri::command]
pub async fn services_watch_stop(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let existing = {
        let mut guard = state.services.lock().await;
        let mgr = manager::ensure_manager(&app, &mut guard)?;
        mgr.take_watcher()
    };
    if let Some(session) = existing {
        session.shutdown().await;
    }
    Ok(())
}

/// Open a live journal tail for one unit. The caller **must** pair this with
/// [`service_logs_close`] — an abandoned `journalctl -f` outlives the panel.
#[tauri::command]
pub async fn service_logs_open(
    app: AppHandle,
    state: State<'_, AppState>,
    unit: String,
) -> Result<u64, AppError> {
    systemctl::ensure_linux()?;

    let mut child = systemctl::spawn_log_tail(&unit)?;
    let stdout = systemctl::take_stdout(&mut child, &unit)?;

    let session_id = state.next_session_id.fetch_add(1, Ordering::SeqCst);
    let cancel = CancellationToken::new();
    let task =
        manager::spawn_log_tail(app.clone(), session_id, unit, child, stdout, cancel.clone());

    let mut guard = state.services.lock().await;
    let mgr = manager::ensure_manager(&app, &mut guard)?;
    mgr.add_log_tail(session_id, cancel, task);
    Ok(session_id)
}

#[tauri::command]
pub async fn service_logs_close(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: u64,
) -> Result<(), AppError> {
    let existing = {
        let mut guard = state.services.lock().await;
        let mgr = manager::ensure_manager(&app, &mut guard)?;
        mgr.take_log_tail(session_id)
    };
    if let Some(session) = existing {
        session.shutdown().await;
    }
    Ok(())
}
