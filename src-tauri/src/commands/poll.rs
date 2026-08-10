use tauri::State;
use tokio::sync::oneshot;

use crate::error::AppError;
use crate::modbus::poll::PollCommand;
use crate::modbus::types::{PollConfig, PollResult};
use crate::modbus::validate::validate_poll_config;
use crate::AppState;

#[tauri::command]
pub async fn set_poll_config(
    state: State<'_, AppState>,
    config: PollConfig,
) -> Result<(), AppError> {
    validate_poll_config(&config)?;
    let guard = state.scanner.lock().await;
    let session = guard.as_ref().ok_or(AppError::NotConnected)?;
    session.send(PollCommand::SetConfig(config)).await
}

#[tauri::command]
pub async fn start_poll(state: State<'_, AppState>) -> Result<(), AppError> {
    let guard = state.scanner.lock().await;
    let session = guard.as_ref().ok_or(AppError::NotConnected)?;
    session.send(PollCommand::Start).await
}

#[tauri::command]
pub async fn stop_poll(state: State<'_, AppState>) -> Result<(), AppError> {
    let guard = state.scanner.lock().await;
    let session = guard.as_ref().ok_or(AppError::NotConnected)?;
    session.send(PollCommand::Stop).await
}

/// Zero the session's TX/RX/error/latency counters. The connection and the
/// poll loop keep running — this only clears what the stats bar shows.
#[tauri::command]
pub async fn reset_poll_stats(state: State<'_, AppState>) -> Result<(), AppError> {
    let guard = state.scanner.lock().await;
    let session = guard.as_ref().ok_or(AppError::NotConnected)?;
    session.send(PollCommand::ResetStats).await
}

#[tauri::command]
pub async fn read_once(
    state: State<'_, AppState>,
    config: PollConfig,
) -> Result<PollResult, AppError> {
    validate_poll_config(&config)?;
    let guard = state.scanner.lock().await;
    let session = guard.as_ref().ok_or(AppError::NotConnected)?;

    let (tx, rx) = oneshot::channel();
    session.send(PollCommand::ReadOnce(config, tx)).await?;
    rx.await.map_err(|_| AppError::ConnectionLost {
        reason: "poll task stopped before responding".to_string(),
    })?
}
