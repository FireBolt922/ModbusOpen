use tauri::State;

use crate::error::AppError;
use crate::modbus::client::ModbusClient;
use crate::modbus::poll::ScannerSession;
use crate::modbus::types::{
    ConnectionInfo, ConnectionStatus, Parity, RtuConfig, TcpConfig, Transport,
};
use crate::modbus::validate::{validate_rtu_config, validate_tcp_config};
use crate::AppState;

fn parity_label(p: Parity) -> char {
    match p {
        Parity::None => 'N',
        Parity::Even => 'E',
        Parity::Odd => 'O',
    }
}

async fn install_session(
    app: tauri::AppHandle,
    state: &State<'_, AppState>,
    transport: Transport,
    summary: String,
    client: ModbusClient,
) -> ConnectionInfo {
    let mut guard = state.scanner.lock().await;
    if let Some(existing) = guard.take() {
        existing.shutdown().await;
    }

    let session_id = state
        .next_session_id
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let session = ScannerSession::spawn(app, session_id, transport, summary.clone(), client);
    let info = ConnectionInfo {
        session_id,
        transport,
        summary,
    };
    *guard = Some(session);
    info
}

#[tauri::command]
pub async fn tcp_connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    config: TcpConfig,
) -> Result<ConnectionInfo, AppError> {
    validate_tcp_config(&config)?;

    let client = ModbusClient::connect_tcp(&config).await?;
    let summary = format!("{}:{} (unit {})", config.host, config.port, config.unit_id);
    Ok(install_session(app, &state, Transport::Tcp, summary, client).await)
}

#[tauri::command]
pub async fn rtu_connect(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    config: RtuConfig,
) -> Result<ConnectionInfo, AppError> {
    validate_rtu_config(&config)?;

    let client = ModbusClient::connect_rtu(&config).await?;
    let summary = format!(
        "{} {} {}{}{} (unit {})",
        config.port,
        config.baud_rate,
        config.data_bits,
        parity_label(config.parity),
        config.stop_bits,
        config.unit_id
    );
    Ok(install_session(app, &state, Transport::Rtu, summary, client).await)
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
