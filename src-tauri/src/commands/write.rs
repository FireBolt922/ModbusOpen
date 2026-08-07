use tauri::State;
use tokio::sync::oneshot;

use crate::error::AppError;
use crate::modbus::poll::PollCommand;
use crate::modbus::types::{DataFormat, TypedValue, WireAddress, WriteRequest, WriteResult};
use crate::AppState;

async fn dispatch_write(
    state: &State<'_, AppState>,
    request: WriteRequest,
) -> Result<WriteResult, AppError> {
    let guard = state.scanner.lock().await;
    let session = guard.as_ref().ok_or(AppError::NotConnected)?;
    let (tx, rx) = oneshot::channel();
    session.send(PollCommand::Write(request, tx)).await?;
    rx.await.map_err(|_| AppError::ConnectionLost {
        reason: "poll task stopped before responding".to_string(),
    })?
}

#[tauri::command]
pub async fn write_single_coil(
    state: State<'_, AppState>,
    unit_id: u8,
    address: WireAddress,
    value: bool,
) -> Result<WriteResult, AppError> {
    dispatch_write(
        &state,
        WriteRequest::SingleCoil {
            unit_id,
            address,
            value,
        },
    )
    .await
}

#[tauri::command]
pub async fn write_single_register(
    state: State<'_, AppState>,
    unit_id: u8,
    address: WireAddress,
    value: u16,
) -> Result<WriteResult, AppError> {
    dispatch_write(
        &state,
        WriteRequest::SingleRegister {
            unit_id,
            address,
            value,
        },
    )
    .await
}

#[tauri::command]
pub async fn write_multiple_coils(
    state: State<'_, AppState>,
    unit_id: u8,
    address: WireAddress,
    values: Vec<bool>,
) -> Result<WriteResult, AppError> {
    if values.is_empty() {
        return Err(AppError::InvalidConfig(
            "write multiple coils needs at least one value".to_string(),
        ));
    }
    if values.len() > 1968 {
        return Err(AppError::InvalidConfig(
            "FC15 allows at most 1968 coils per request".to_string(),
        ));
    }
    dispatch_write(
        &state,
        WriteRequest::MultipleCoils {
            unit_id,
            address,
            values,
        },
    )
    .await
}

#[tauri::command]
pub async fn write_multiple_registers(
    state: State<'_, AppState>,
    unit_id: u8,
    address: WireAddress,
    values: Vec<u16>,
) -> Result<WriteResult, AppError> {
    if values.is_empty() {
        return Err(AppError::InvalidConfig(
            "write multiple registers needs at least one value".to_string(),
        ));
    }
    if values.len() > 123 {
        return Err(AppError::InvalidConfig(
            "FC16 allows at most 123 registers per request".to_string(),
        ));
    }
    dispatch_write(
        &state,
        WriteRequest::MultipleRegisters {
            unit_id,
            address,
            values,
        },
    )
    .await
}

/// Encode a typed value (float32, int32, …) then pick FC06 or FC16 automatically.
#[tauri::command]
pub async fn write_typed(
    state: State<'_, AppState>,
    unit_id: u8,
    address: WireAddress,
    value: TypedValue,
    format: DataFormat,
) -> Result<WriteResult, AppError> {
    dispatch_write(
        &state,
        WriteRequest::Typed {
            unit_id,
            address,
            value,
            format,
        },
    )
    .await
}
