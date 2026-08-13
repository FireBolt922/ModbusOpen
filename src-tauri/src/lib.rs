mod commands;
mod error;
mod meters;
mod modbus;
mod services;

use std::sync::atomic::AtomicU64;

use meters::library::MeterLibrary;
use modbus::poll::ScannerSession;
use modbus::server::SimulatorServer;
use services::manager::ServiceManager;
use tokio::sync::Mutex;

/// `tokio::sync::Mutex`, not `std::sync::Mutex` — the guard is held across
/// `.await` when spawning/shutting down a session.
pub struct AppState {
    pub scanner: Mutex<Option<ScannerSession>>,
    pub simulator: Mutex<Option<SimulatorServer>>,
    /// Lazy-loaded user meter library (JSON under the OS app-data dir).
    pub meters: Mutex<Option<MeterLibrary>>,
    /// Lazy-loaded Linux service control state. Stays `None` on other
    /// platforms — nothing ever loads it there.
    pub services: Mutex<Option<ServiceManager>>,
    pub next_session_id: AtomicU64,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            scanner: Mutex::new(None),
            simulator: Mutex::new(None),
            meters: Mutex::new(None),
            services: Mutex::new(None),
            next_session_id: AtomicU64::new(1),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(|app| {
            // Reconcile any service the operator stopped before the app was
            // last closed: a hold that has since expired is started right
            // away, one that hasn't resumes counting down. Without this, a
            // "stop for 30 minutes" turns into "stopped until someone
            // notices" the moment the app is restarted.
            if cfg!(target_os = "linux") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = services::manager::run_auto_restart_pass(&handle).await {
                        tracing::warn!("startup service reconcile failed: {err}");
                    }
                    services::manager::spawn_auto_restart(handle);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::serial::list_serial_ports,
            commands::connection::tcp_connect,
            commands::connection::rtu_connect,
            commands::connection::reconnect,
            commands::connection::disconnect,
            commands::connection::connection_status,
            commands::poll::set_poll_config,
            commands::poll::start_poll,
            commands::poll::stop_poll,
            commands::poll::reset_poll_stats,
            commands::poll::read_once,
            commands::write::write_single_coil,
            commands::write::write_single_register,
            commands::write::write_multiple_coils,
            commands::write::write_multiple_registers,
            commands::write::write_typed,
            commands::simulator::sim_start,
            commands::simulator::sim_stop,
            commands::simulator::sim_snapshot,
            commands::simulator::sim_write_register,
            commands::simulator::sim_write_coil,
            commands::meters::list_meter_profiles,
            commands::meters::get_meter_profile,
            commands::meters::save_meter_profile,
            commands::meters::delete_meter_profile,
            commands::meters::duplicate_meter_profile,
            commands::meters::export_meter_profiles,
            commands::meters::preview_meter_import,
            commands::meters::commit_meter_import,
            commands::meters::meter_profile_to_simulator,
            commands::meters::meter_read_plan,
            commands::meters::decode_meter_points,
            commands::meters::decode_tag_values,
            commands::services::services_supported,
            commands::services::services_platform,
            commands::services::services_unlock,
            commands::services::services_unlock_state,
            commands::services::services_lock,
            commands::services::get_services_config,
            commands::services::save_services_config,
            commands::services::validate_service_units,
            commands::services::list_monitored_services,
            commands::services::start_service,
            commands::services::stop_service,
            commands::services::services_watch_start,
            commands::services::services_watch_stop,
            commands::services::service_logs_open,
            commands::services::service_logs_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
