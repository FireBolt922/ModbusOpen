mod commands;
mod error;
mod modbus;

use std::sync::atomic::AtomicU64;

use modbus::poll::ScannerSession;
use tokio::sync::Mutex;

/// `tokio::sync::Mutex`, not `std::sync::Mutex` — the guard is held across
/// `.await` when spawning/shutting down a session.
pub struct AppState {
    pub scanner: Mutex<Option<ScannerSession>>,
    pub next_session_id: AtomicU64,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            scanner: Mutex::new(None),
            next_session_id: AtomicU64::new(1),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::serial::list_serial_ports,
            commands::connection::tcp_connect,
            commands::connection::rtu_connect,
            commands::connection::disconnect,
            commands::connection::connection_status,
            commands::poll::set_poll_config,
            commands::poll::start_poll,
            commands::poll::stop_poll,
            commands::poll::read_once,
            commands::write::write_single_coil,
            commands::write::write_single_register,
            commands::write::write_multiple_coils,
            commands::write::write_multiple_registers,
            commands::write::write_typed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
