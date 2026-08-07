use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::error::{exception_name_and_hint, AppError};
use crate::modbus::server::SimulatorServer;
use crate::modbus::store::{ModbusStore, SlaveLayout};
use crate::modbus::types::{SimulatorConfig, SimulatorInfo, SimulatorSnapshot, TagConfig};
use crate::modbus::validate::validate_simulator_config;
use crate::AppState;

fn layouts_from_config(config: &SimulatorConfig) -> Vec<(u8, SlaveLayout)> {
    config
        .slaves
        .iter()
        .map(|s| {
            (
                s.unit_id,
                SlaveLayout {
                    coil_count: s.coil_count,
                    discrete_count: s.discrete_count,
                    input_register_count: s.input_register_count,
                    holding_register_count: s.holding_register_count,
                },
            )
        })
        .collect()
}

fn tags_from_config(config: &SimulatorConfig) -> Vec<(u8, TagConfig)> {
    config
        .slaves
        .iter()
        .flat_map(|s| s.tags.iter().map(move |t| (s.unit_id, t.clone())))
        .collect()
}

fn map_store_error(
    err: tokio_modbus::ExceptionCode,
    function: u8,
    addr: u16,
    unit_id: u8,
) -> AppError {
    let code = u8::from(err);
    let (name, hint) = exception_name_and_hint(code, function, addr, unit_id);
    AppError::ModbusException { code, name, hint }
}

#[tauri::command]
pub async fn sim_start(
    app: AppHandle,
    state: State<'_, AppState>,
    config: SimulatorConfig,
) -> Result<SimulatorInfo, AppError> {
    validate_simulator_config(&config)?;

    let mut guard = state.simulator.lock().await;
    if let Some(existing) = guard.take() {
        existing.shutdown().await;
    }

    let store = Arc::new(ModbusStore::new());
    store.reset(&layouts_from_config(&config));

    let session_id = state.next_session_id.fetch_add(1, Ordering::SeqCst);
    let addr = format!("0.0.0.0:{}", config.tcp_port)
        .parse()
        .map_err(|_| AppError::InvalidConfig("invalid TCP port".to_string()))?;

    let mut server = SimulatorServer::bind(addr, store, app.clone(), session_id)
        .await
        .map_err(|e| {
            AppError::InvalidConfig(format!("can't listen on port {} — {e}", config.tcp_port))
        })?;
    server.start_animation(app, tags_from_config(&config), config.tick_ms);

    let info = SimulatorInfo {
        session_id: server.session_id(),
        tcp_port: server.tcp_port(),
    };
    *guard = Some(server);
    Ok(info)
}

#[tauri::command]
pub async fn sim_stop(state: State<'_, AppState>) -> Result<(), AppError> {
    let mut guard = state.simulator.lock().await;
    if let Some(server) = guard.take() {
        server.shutdown().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn sim_snapshot(state: State<'_, AppState>) -> Result<SimulatorSnapshot, AppError> {
    let guard = state.simulator.lock().await;
    let server = guard.as_ref().ok_or(AppError::NotConnected)?;
    Ok(server.snapshot())
}

/// Manual edit from the live table — writes straight into the datastore, the
/// same path a connected master's FC06 would take. `sim-update` fires from
/// inside the server only on writes that arrive over the wire, so this
/// command emits it itself too.
#[tauri::command]
pub async fn sim_write_register(
    app: AppHandle,
    state: State<'_, AppState>,
    unit_id: u8,
    address: u16,
    value: u16,
) -> Result<SimulatorSnapshot, AppError> {
    use tauri::Emitter;

    let guard = state.simulator.lock().await;
    let server = guard.as_ref().ok_or(AppError::NotConnected)?;
    server
        .store()
        .write_single_register(unit_id, address, value)
        .map_err(|e| map_store_error(e, 0x06, address, unit_id))?;
    let snapshot = server.snapshot();
    let _ = app.emit("sim-update", &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub async fn sim_write_coil(
    app: AppHandle,
    state: State<'_, AppState>,
    unit_id: u8,
    address: u16,
    value: bool,
) -> Result<SimulatorSnapshot, AppError> {
    use tauri::Emitter;

    let guard = state.simulator.lock().await;
    let server = guard.as_ref().ok_or(AppError::NotConnected)?;
    server
        .store()
        .write_single_coil(unit_id, address, value)
        .map_err(|e| map_store_error(e, 0x05, address, unit_id))?;
    let snapshot = server.snapshot();
    let _ = app.emit("sim-update", &snapshot);
    Ok(snapshot)
}
