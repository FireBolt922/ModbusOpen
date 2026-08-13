//! Session state for service control: the shared unlock, the auto-restart
//! deadlines, the status watcher, and the log tails.
//!
//! The invariant that shapes this file: **the lock is never held across a
//! process spawn.** Every task collects what it needs, drops the guard, shells
//! out, then re-locks to record the result. A three-second status tick that
//! held the mutex through a `systemctl` call would stall every command behind
//! it.

use std::collections::HashMap;
use std::path::PathBuf;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::error::AppError;
use crate::modbus::types::{
    ServiceLogEvent, ServiceStatus, ServiceStatusEvent, ServicesConfig, UnlockState,
};
use crate::services::config::{self, RestartDeadlines};
use crate::services::systemctl::{self, ServiceAction, UnitInfo};
use crate::AppState;

/// Hard-coded at the customer's request. It is an operational guard against a
/// mis-click, not a secret: anyone with the binary can read it. Everything it
/// protects is reversible and auditable, and the polkit rule is what actually
/// bounds the app's authority on the machine.
const CONFIG_PASSWORD: &str = "Inizent@098";

/// One entry of the password buys 30 minutes of Configure.
pub const UNLOCK_MINUTES: i64 = 30;

/// A stopped service comes back by itself after this long. The whole point of
/// the feature: an operator who stops capture and walks away doesn't lose the
/// afternoon's data.
pub const AUTO_RESTART_MINUTES: i64 = 30;

/// If the automatic restart itself fails, try again this soon rather than
/// giving up (or hammering it every tick).
const AUTO_RESTART_RETRY_SECONDS: i64 = 60;

/// How often the auto-restart task looks for due deadlines.
const RESTART_TICK_SECONDS: u64 = 15;

/// How often the View screen is pushed a fresh status list.
const STATUS_TICK_SECONDS: u64 = 3;

/// Log lines are coalesced into one event per window. A unit logging thousands
/// of lines a second must not become thousands of IPC messages a second.
const LOG_BATCH_MILLIS: u64 = 100;

pub const EVENT_SERVICE_STATUS: &str = "service-status";
pub const EVENT_SERVICE_LOG: &str = "service-log";

pub struct BackgroundSession {
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

impl BackgroundSession {
    /// Cancel **and await**, per the session rules — returning before the task
    /// has actually stopped is how you end up with two watchers emitting.
    pub async fn shutdown(self) {
        self.cancel.cancel();
        let _ = self.task.await;
    }
}

pub struct ServiceManager {
    dir: PathBuf,
    config: ServicesConfig,
    deadlines: RestartDeadlines,
    unlock_until: Option<DateTime<Utc>>,
    watcher: Option<(u64, BackgroundSession)>,
    log_tails: HashMap<u64, BackgroundSession>,
}

impl ServiceManager {
    pub fn load(app: &AppHandle) -> Result<Self, AppError> {
        let dir = config::services_dir(app)?;
        let config = config::load_config(&dir);
        let deadlines = config::load_deadlines(&dir);
        Ok(Self {
            dir,
            config,
            deadlines,
            unlock_until: None,
            watcher: None,
            log_tails: HashMap::new(),
        })
    }

    // -- unlock ----------------------------------------------------------

    pub fn unlock(&mut self, password: &str) -> Result<UnlockState, AppError> {
        if !constant_time_eq(password.as_bytes(), CONFIG_PASSWORD.as_bytes()) {
            return Err(AppError::InvalidConfig(
                "That password isn't right.".to_string(),
            ));
        }
        self.unlock_until = Some(Utc::now() + ChronoDuration::minutes(UNLOCK_MINUTES));
        Ok(self.unlock_state())
    }

    pub fn lock(&mut self) {
        self.unlock_until = None;
    }

    pub fn unlock_state(&self) -> UnlockState {
        match self.unlock_until {
            Some(at) if at > Utc::now() => UnlockState {
                unlocked: true,
                expires_at: Some(at),
            },
            _ => UnlockState {
                unlocked: false,
                expires_at: None,
            },
        }
    }

    /// Every protected command goes through this. The check lives in Rust so
    /// the 30 minutes has one source of truth and the UI can't drift from it.
    pub fn require_unlocked(&self) -> Result<(), AppError> {
        if self.unlock_state().unlocked {
            Ok(())
        } else {
            Err(AppError::Locked)
        }
    }

    // -- configuration ---------------------------------------------------

    pub fn config(&self) -> ServicesConfig {
        self.config.clone()
    }

    pub fn units(&self) -> Vec<String> {
        self.config
            .services
            .iter()
            .map(|s| s.unit.clone())
            .collect()
    }

    pub fn save_config(
        &mut self,
        mut incoming: ServicesConfig,
    ) -> Result<ServicesConfig, AppError> {
        incoming.version = config::CONFIG_VERSION;

        let mut seen: Vec<String> = Vec::new();
        for entry in &mut incoming.services {
            entry.unit = entry.unit.trim().to_string();
            systemctl::validate_unit_name(&entry.unit)?;
            if seen.contains(&entry.unit) {
                return Err(AppError::InvalidConfig(format!(
                    "{} is in the list twice. Each service can only be added once.",
                    entry.unit
                )));
            }
            seen.push(entry.unit.clone());
            entry.description = entry.description.trim().to_string();
            entry.category = entry.category.trim().to_string();
        }

        config::save_config(&self.dir, &incoming)?;
        self.config = incoming.clone();

        // Deadlines for units that are no longer monitored would otherwise sit
        // in the file forever, restarting something nobody is watching.
        self.deadlines.retain(|unit, _| seen.contains(unit));
        let _ = config::save_deadlines(&self.dir, &self.deadlines);

        Ok(incoming)
    }

    // -- restart deadlines -----------------------------------------------

    pub fn deadline_for(&self, unit: &str) -> Option<DateTime<Utc>> {
        self.deadlines.get(unit).copied()
    }

    pub fn deadlines(&self) -> RestartDeadlines {
        self.deadlines.clone()
    }

    pub fn arm_restart(&mut self, unit: &str) {
        self.deadlines.insert(
            unit.to_string(),
            Utc::now() + ChronoDuration::minutes(AUTO_RESTART_MINUTES),
        );
        self.persist_deadlines();
    }

    pub fn retry_restart_soon(&mut self, unit: &str) {
        self.deadlines.insert(
            unit.to_string(),
            Utc::now() + ChronoDuration::seconds(AUTO_RESTART_RETRY_SECONDS),
        );
        self.persist_deadlines();
    }

    pub fn clear_restart(&mut self, unit: &str) {
        if self.deadlines.remove(unit).is_some() {
            self.persist_deadlines();
        }
    }

    fn persist_deadlines(&self) {
        if let Err(err) = config::save_deadlines(&self.dir, &self.deadlines) {
            // Losing the file costs us the cross-restart guarantee, not the
            // in-memory timer, so this is a warning rather than a failure.
            tracing::warn!("couldn't save restart deadlines: {err}");
        }
    }

    // -- background sessions ---------------------------------------------

    pub fn watcher_id(&self) -> Option<u64> {
        self.watcher.as_ref().map(|(id, _)| *id)
    }

    pub fn set_watcher(&mut self, id: u64, cancel: CancellationToken, task: JoinHandle<()>) {
        self.watcher = Some((id, BackgroundSession { cancel, task }));
    }

    pub fn take_watcher(&mut self) -> Option<BackgroundSession> {
        self.watcher.take().map(|(_, session)| session)
    }

    pub fn add_log_tail(&mut self, id: u64, cancel: CancellationToken, task: JoinHandle<()>) {
        self.log_tails
            .insert(id, BackgroundSession { cancel, task });
    }

    pub fn take_log_tail(&mut self, id: u64) -> Option<BackgroundSession> {
        self.log_tails.remove(&id)
    }

    pub fn take_all_log_tails(&mut self) -> Vec<BackgroundSession> {
        self.log_tails.drain().map(|(_, s)| s).collect()
    }
}

/// Which deadlines have come due. Split out as a free function over an
/// injected `now` so the 30-minute arithmetic is testable without waiting 30
/// minutes.
pub fn due_units(deadlines: &RestartDeadlines, now: DateTime<Utc>) -> Vec<String> {
    let mut due: Vec<String> = deadlines
        .iter()
        .filter(|(_, at)| **at <= now)
        .map(|(unit, _)| unit.clone())
        .collect();
    due.sort();
    due
}

/// Not a security boundary — the password is in the binary — but comparing
/// without an early return keeps the check honest and costs nothing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ---------------------------------------------------------------------------
// Shared read path
// ---------------------------------------------------------------------------

/// Join the configured entries with what the system reports right now.
///
/// Locks twice, briefly, with the `systemctl` call in between and the mutex
/// released — see the module note.
pub async fn collect_status(app: &AppHandle) -> Result<Vec<ServiceStatus>, AppError> {
    systemctl::ensure_linux()?;

    let state = app.state::<AppState>();
    let (entries, deadlines) = {
        let mut guard = state.services.lock().await;
        let manager = ensure_manager(app, &mut guard)?;
        (manager.config().services, manager.deadlines())
    };

    if entries.is_empty() {
        return Ok(Vec::new());
    }

    let units: Vec<String> = entries.iter().map(|e| e.unit.clone()).collect();
    let live = systemctl::show_units(&units).await?;

    Ok(entries
        .into_iter()
        .map(|entry| {
            let info = live.get(&entry.unit).cloned().unwrap_or_default();
            let description = if entry.description.is_empty() {
                info.description.clone()
            } else {
                entry.description.clone()
            };
            ServiceStatus {
                unit: entry.unit.clone(),
                description,
                category: entry.category,
                subcategory: entry.subcategory,
                load_state: info.load_state,
                active_state: info.active_state,
                sub_state: info.sub_state,
                unit_file_state: info.unit_file_state,
                auto_start_at: deadlines.get(&entry.unit).copied(),
            }
        })
        .collect())
}

/// Status for one unit, used to answer start/stop immediately rather than
/// making the UI wait for the next tick.
pub async fn status_for(app: &AppHandle, unit: &str) -> Result<ServiceStatus, AppError> {
    collect_status(app)
        .await?
        .into_iter()
        .find(|s| s.unit == unit)
        .ok_or_else(|| {
            AppError::InvalidConfig(format!(
                "{unit} isn't in the monitored list. Add it on the Configure tab."
            ))
        })
}

/// Lazily hydrate the manager, exactly like `commands::meters::with_library`.
pub fn ensure_manager<'a>(
    app: &AppHandle,
    guard: &'a mut Option<ServiceManager>,
) -> Result<&'a mut ServiceManager, AppError> {
    if guard.is_none() {
        *guard = Some(ServiceManager::load(app)?);
    }
    match guard.as_mut() {
        Some(manager) => Ok(manager),
        // Unreachable, but the repo bans `expect` outside tests.
        None => Err(AppError::InvalidConfig(
            "the service manager failed to load.".to_string(),
        )),
    }
}

// ---------------------------------------------------------------------------
// Background tasks
// ---------------------------------------------------------------------------

/// Push the full status list to the View screen on a fixed tick.
///
/// The UI is forbidden from `setInterval`-polling a command, so the cadence
/// lives here. Every payload carries the session id and the store drops
/// anything that doesn't match, so a stale watcher can't repaint a new screen.
pub fn spawn_status_watcher(
    app: AppHandle,
    session_id: u64,
    cancel: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(STATUS_TICK_SECONDS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return,
                _ = ticker.tick() => {}
            }
            match collect_status(&app).await {
                Ok(services) => {
                    let _ = app.emit(
                        EVENT_SERVICE_STATUS,
                        &ServiceStatusEvent {
                            session_id,
                            services,
                        },
                    );
                }
                Err(err) => {
                    tracing::warn!("service status tick failed: {err}");
                }
            }
        }
    })
}

/// The self-healing half of the feature: bring back anything whose 30 minutes
/// is up, unless the operator has since disabled or masked it.
pub fn spawn_auto_restart(app: AppHandle) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker =
            tokio::time::interval(std::time::Duration::from_secs(RESTART_TICK_SECONDS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            if let Err(err) = run_auto_restart_pass(&app).await {
                tracing::warn!("auto-restart pass failed: {err}");
            }
        }
    })
}

/// One pass of the auto-restart loop. Also called once at startup so a
/// deadline that expired while the app was closed fires immediately.
pub async fn run_auto_restart_pass(app: &AppHandle) -> Result<(), AppError> {
    systemctl::ensure_linux()?;

    let state = app.state::<AppState>();
    let due = {
        let mut guard = state.services.lock().await;
        let manager = ensure_manager(app, &mut guard)?;
        due_units(&manager.deadlines(), Utc::now())
    };
    if due.is_empty() {
        return Ok(());
    }

    let live = systemctl::show_units(&due).await.unwrap_or_default();

    for unit in due {
        let info = live.get(&unit).cloned().unwrap_or_default();
        if should_skip_restart(&info) {
            tracing::info!("{unit} was disabled or masked by the operator — leaving it stopped");
            lock_and(app, |m| m.clear_restart(&unit)).await?;
            continue;
        }

        match systemctl::control_unit(ServiceAction::Start, &unit).await {
            Ok(()) => {
                tracing::info!("{unit} restarted automatically after its hold expired");
                lock_and(app, |m| m.clear_restart(&unit)).await?;
            }
            Err(err) => {
                tracing::warn!("couldn't auto-restart {unit}: {err} — retrying shortly");
                lock_and(app, |m| m.retry_restart_soon(&unit)).await?;
            }
        }
    }

    Ok(())
}

/// A unit the operator disabled (or masked) in a terminal is one they meant to
/// keep down. It is also the case where the unit no longer exists at all.
fn should_skip_restart(info: &UnitInfo) -> bool {
    !info.exists() || info.is_held_by_operator()
}

async fn lock_and<F>(app: &AppHandle, f: F) -> Result<(), AppError>
where
    F: FnOnce(&mut ServiceManager),
{
    let state = app.state::<AppState>();
    let mut guard = state.services.lock().await;
    let manager = ensure_manager(app, &mut guard)?;
    f(manager);
    Ok(())
}

/// Follow one unit's journal, batching lines so a chatty service can't flood
/// the IPC channel. The child is killed when this task ends — `kill_on_drop`
/// plus an explicit `start_kill` on cancellation.
pub fn spawn_log_tail(
    app: AppHandle,
    session_id: u64,
    unit: String,
    mut child: tokio::process::Child,
    stdout: tokio::process::ChildStdout,
    cancel: CancellationToken,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let (tx, mut rx) = mpsc::channel::<String>(1024);

        let reader_cancel = cancel.clone();
        let reader = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                tokio::select! {
                    _ = reader_cancel.cancelled() => return,
                    next = lines.next_line() => match next {
                        Ok(Some(line)) => {
                            if tx.send(line).await.is_err() {
                                return;
                            }
                        }
                        // EOF or a read error: journalctl went away.
                        _ => return,
                    }
                }
            }
        });

        let mut batch: Vec<String> = Vec::new();
        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(LOG_BATCH_MILLIS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        loop {
            tokio::select! {
                _ = cancel.cancelled() => break,
                received = rx.recv() => match received {
                    Some(line) => batch.push(line),
                    None => break,
                },
                _ = ticker.tick() => {
                    if !batch.is_empty() {
                        let lines = std::mem::take(&mut batch);
                        let _ = app.emit(
                            EVENT_SERVICE_LOG,
                            &ServiceLogEvent { session_id, unit: unit.clone(), lines },
                        );
                    }
                }
            }
        }

        if !batch.is_empty() {
            let _ = app.emit(
                EVENT_SERVICE_LOG,
                &ServiceLogEvent {
                    session_id,
                    unit: unit.clone(),
                    lines: batch,
                },
            );
        }

        cancel.cancel();
        let _ = child.start_kill();
        let _ = child.wait().await;
        let _ = reader.await;
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(minutes: i64) -> DateTime<Utc> {
        Utc::now() + ChronoDuration::minutes(minutes)
    }

    #[test]
    fn only_expired_deadlines_come_due() {
        let mut deadlines = RestartDeadlines::new();
        deadlines.insert("past.service".to_string(), at(-1));
        deadlines.insert("future.service".to_string(), at(10));
        deadlines.insert("exactly-now.service".to_string(), Utc::now());

        let due = due_units(&deadlines, Utc::now());
        assert!(due.contains(&"past.service".to_string()));
        assert!(due.contains(&"exactly-now.service".to_string()));
        assert!(!due.contains(&"future.service".to_string()));
    }

    /// The cross-restart guarantee: a deadline that expired while the app was
    /// closed must fire on the very first pass, not 30 minutes later.
    #[test]
    fn a_deadline_that_expired_while_closed_is_due_immediately() {
        let mut deadlines = RestartDeadlines::new();
        deadlines.insert("stale.service".to_string(), at(-600));
        assert_eq!(due_units(&deadlines, Utc::now()), vec!["stale.service"]);
    }

    #[test]
    fn an_operator_disabled_unit_is_left_alone() {
        let disabled = UnitInfo {
            load_state: "loaded".to_string(),
            unit_file_state: "disabled".to_string(),
            ..Default::default()
        };
        let masked = UnitInfo {
            load_state: "masked".to_string(),
            unit_file_state: "masked".to_string(),
            ..Default::default()
        };
        let enabled = UnitInfo {
            load_state: "loaded".to_string(),
            unit_file_state: "enabled".to_string(),
            ..Default::default()
        };
        let gone = UnitInfo {
            load_state: "not-found".to_string(),
            ..Default::default()
        };

        assert!(should_skip_restart(&disabled));
        assert!(should_skip_restart(&masked));
        assert!(should_skip_restart(&gone));
        assert!(!should_skip_restart(&enabled));
    }

    /// A `static` unit has no install state to speak of but is perfectly
    /// startable — it must not be mistaken for one the operator held down.
    #[test]
    fn a_static_unit_is_still_restarted() {
        let unit = UnitInfo {
            load_state: "loaded".to_string(),
            unit_file_state: "static".to_string(),
            ..Default::default()
        };
        assert!(!should_skip_restart(&unit));
    }

    #[test]
    fn the_password_check_rejects_near_misses() {
        assert!(constant_time_eq(b"Inizent@098", CONFIG_PASSWORD.as_bytes()));
        assert!(!constant_time_eq(
            b"inizent@098",
            CONFIG_PASSWORD.as_bytes()
        ));
        assert!(!constant_time_eq(
            b"Inizent@0980",
            CONFIG_PASSWORD.as_bytes()
        ));
        assert!(!constant_time_eq(b"", CONFIG_PASSWORD.as_bytes()));
    }
}
