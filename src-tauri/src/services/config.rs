//! Persistence for the service-control feature, under the OS app-data dir.
//!
//! Two small JSON files, following the same conventions as
//! `crate::meters::library`: resolve `app_data_dir()`, create the folder, and
//! treat an unreadable file as "nothing saved yet" with a `tracing::warn!`
//! rather than refusing to start. A corrupt config must never lock the
//! operator out of the screen that fixes it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::modbus::types::ServicesConfig;

const DIR_NAME: &str = "services";
const CONFIG_FILE: &str = "config.json";
const HOLDS_FILE: &str = "holds.json";

/// Current schema version of `config.json`.
pub const CONFIG_VERSION: u32 = 1;

/// Unit name -> the instant it should be started again. Written on every stop
/// so a forgotten service still comes back after an app restart.
pub type RestartDeadlines = HashMap<String, DateTime<Utc>>;

pub fn services_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidConfig(format!("can't resolve app data dir — {e}")))?
        .join(DIR_NAME);
    fs::create_dir_all(&dir).map_err(|e| {
        AppError::InvalidConfig(format!(
            "can't create the services folder at {} — {e}",
            dir.display()
        ))
    })?;
    Ok(dir)
}

pub fn load_config(dir: &Path) -> ServicesConfig {
    let path = dir.join(CONFIG_FILE);
    if !path.exists() {
        return ServicesConfig {
            version: CONFIG_VERSION,
            services: Vec::new(),
        };
    }
    match fs::read_to_string(&path)
        .map_err(|e| e.to_string())
        .and_then(|text| serde_json::from_str::<ServicesConfig>(&text).map_err(|e| e.to_string()))
    {
        Ok(mut config) => {
            config.version = CONFIG_VERSION;
            config
        }
        Err(err) => {
            tracing::warn!(
                "ignoring unreadable service config at {}: {err}",
                path.display()
            );
            ServicesConfig {
                version: CONFIG_VERSION,
                services: Vec::new(),
            }
        }
    }
}

pub fn save_config(dir: &Path, config: &ServicesConfig) -> Result<(), AppError> {
    write_json(&dir.join(CONFIG_FILE), config, "service configuration")
}

pub fn load_deadlines(dir: &Path) -> RestartDeadlines {
    let path = dir.join(HOLDS_FILE);
    if !path.exists() {
        return RestartDeadlines::new();
    }
    match fs::read_to_string(&path)
        .map_err(|e| e.to_string())
        .and_then(|text| serde_json::from_str::<RestartDeadlines>(&text).map_err(|e| e.to_string()))
    {
        Ok(map) => map,
        Err(err) => {
            tracing::warn!(
                "ignoring unreadable restart deadlines at {}: {err}",
                path.display()
            );
            RestartDeadlines::new()
        }
    }
}

pub fn save_deadlines(dir: &Path, deadlines: &RestartDeadlines) -> Result<(), AppError> {
    write_json(&dir.join(HOLDS_FILE), deadlines, "restart deadlines")
}

fn write_json<T: serde::Serialize>(path: &Path, value: &T, what: &str) -> Result<(), AppError> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|e| AppError::InvalidConfig(format!("can't encode the {what} — {e}")))?;
    fs::write(path, text).map_err(|e| {
        AppError::InvalidConfig(format!("can't save the {what} to {} — {e}", path.display()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modbus::types::{ServiceEntry, ServiceSubcategory};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("modbusopen-services-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_missing_config_reads_as_empty_not_an_error() {
        let dir = temp_dir("missing");
        let config = load_config(&dir);
        assert_eq!(config.version, CONFIG_VERSION);
        assert!(config.services.is_empty());
    }

    #[test]
    fn config_round_trips() {
        let dir = temp_dir("roundtrip");
        let config = ServicesConfig {
            version: CONFIG_VERSION,
            services: vec![ServiceEntry {
                unit: "meter-poll.service".to_string(),
                description: "Meter capture".to_string(),
                category: "Meters".to_string(),
                subcategory: ServiceSubcategory::Sync,
            }],
        };
        save_config(&dir, &config).unwrap();
        assert_eq!(load_config(&dir), config);
    }

    /// A hand-mangled file must not take the Configure screen down with it —
    /// that screen is the only way to repair the list.
    #[test]
    fn a_corrupt_config_degrades_to_empty() {
        let dir = temp_dir("corrupt");
        fs::write(dir.join(CONFIG_FILE), "{ not json").unwrap();
        assert!(load_config(&dir).services.is_empty());
    }

    #[test]
    fn deadlines_round_trip_and_degrade_safely() {
        let dir = temp_dir("holds");
        let mut deadlines = RestartDeadlines::new();
        deadlines.insert("meter-poll.service".to_string(), Utc::now());
        save_deadlines(&dir, &deadlines).unwrap();
        assert_eq!(load_deadlines(&dir).len(), 1);

        fs::write(dir.join(HOLDS_FILE), "nonsense").unwrap();
        assert!(load_deadlines(&dir).is_empty());
    }
}
