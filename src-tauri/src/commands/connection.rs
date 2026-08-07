use tauri::State;

use crate::error::AppError;
use crate::modbus::client::ModbusClient;
use crate::modbus::poll::ScannerSession;
use crate::modbus::types::{ConnectionInfo, ConnectionStatus, TcpConfig, Transport};
use crate::modbus::validate::validate_tcp_config;
use crate::AppState;

#[tauri::command]
pub async fn tcp_connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    config: TcpConfig,
) -> Result<ConnectionInfo, AppError> {
    validate_tcp_config(&config)?;

    let client = ModbusClient::connect_tcp(&config).await?;

    let mut guard = state.scanner.lock().await;
    if let Some(existing) = guard.take() {
        existing.shutdown().await;
    }

    let session_id = state
        .next_session_id
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let summary = format!("{}:{} (unit {})", config.host, config.port, config.unit_id);
    let session = ScannerSession::spawn(app, session_id, Transport::Tcp, summary.clone(), client);

    let info = ConnectionInfo {
        session_id,
        transport: Transport::Tcp,
        summary,
    };
    *guard = Some(session);
    Ok(info)
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>) -> Result<(), AppError> {
    let mut guard = state.scanner.lock().await;
    if let Some(session) = guard.take() {
        session.shutdown().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn connection_status(state: State<'_, AppState>) -> Result<ConnectionStatus, AppError> {
    let guard = state.scanner.lock().await;
    Ok(match guard.as_ref() {
        Some(session) => ConnectionStatus::Connected {
            since: session.since,
            transport: session.transport,
            summary: session.summary.clone(),
        },
        None => ConnectionStatus::Disconnected,
    })
}
