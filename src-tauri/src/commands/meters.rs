use std::path::PathBuf;

use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::meters::library::MeterLibrary;
use crate::modbus::meters::{plan_reads, profile_to_simulator_config};
use crate::modbus::types::{
    AddressedWord, DecodedRegister, MeterImportChoice, MeterImportPreview, MeterProfile, ReadBlock,
    SimulatorConfig, TagConfig, TypedValue,
};
use crate::modbus::validate::validate_meter_profile;
use crate::AppState;

/// Lazily load the user meter library into AppState.
async fn with_library<T, F>(app: &AppHandle, state: &AppState, f: F) -> Result<T, AppError>
where
    F: FnOnce(&mut MeterLibrary) -> Result<T, AppError>,
{
    let mut guard = state.meters.lock().await;
    if guard.is_none() {
        let lib = MeterLibrary::load(app)?;
        *guard = Some(lib);
    }
    f(guard.as_mut().expect("just loaded"))
}

#[tauri::command]
pub async fn list_meter_profiles(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<MeterProfile>, AppError> {
    with_library(&app, &state, |lib| Ok(lib.list())).await
}

#[tauri::command]
pub async fn get_meter_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<MeterProfile, AppError> {
    with_library(&app, &state, |lib| {
        lib.get(&id)
            .ok_or_else(|| AppError::InvalidConfig(format!("no meter with id '{id}'")))
    })
    .await
}

#[tauri::command]
pub async fn save_meter_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: MeterProfile,
) -> Result<MeterProfile, AppError> {
    with_library(&app, &state, |lib| lib.save(profile)).await
}

#[tauri::command]
pub async fn delete_meter_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    with_library(&app, &state, |lib| lib.delete(&id)).await
}

#[tauri::command]
pub async fn duplicate_meter_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    new_id: String,
) -> Result<MeterProfile, AppError> {
    with_library(&app, &state, |lib| lib.duplicate(&id, &new_id)).await
}

#[tauri::command]
pub async fn export_meter_profiles(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<String>,
    path: String,
) -> Result<String, AppError> {
    with_library(&app, &state, |lib| {
        lib.write_export(&ids, &PathBuf::from(path))
    })
    .await
}

#[tauri::command]
pub async fn preview_meter_import(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<MeterImportPreview, AppError> {
    with_library(&app, &state, |lib| lib.preview_import(&PathBuf::from(path))).await
}

#[tauri::command]
pub async fn commit_meter_import(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    resolutions: Vec<MeterImportChoice>,
) -> Result<Vec<MeterProfile>, AppError> {
    with_library(&app, &state, |lib| {
        lib.commit_import(&PathBuf::from(path), &resolutions)
    })
    .await
}

/// Build a simulator config from a saved meter profile.
#[tauri::command]
pub async fn meter_profile_to_simulator(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    tcp_port: u16,
    tick_ms: u64,
) -> Result<SimulatorConfig, AppError> {
    let profile = with_library(&app, &state, |lib| {
        lib.get(&id)
            .ok_or_else(|| AppError::InvalidConfig(format!("no meter with id '{id}'")))
    })
    .await?;
    validate_meter_profile(&profile)?;
    let cfg = profile_to_simulator_config(&profile, tcp_port, tick_ms);
    crate::modbus::validate::validate_simulator_config(&cfg)?;
    Ok(cfg)
}

/// The Modbus requests needed to read this meter once.
///
/// The editor shows this back to the user, and the scanner uses it as the poll
/// plan, so both are looking at exactly what the poll engine will execute.
#[tauri::command]
pub fn meter_read_plan(profile: MeterProfile) -> Result<Vec<ReadBlock>, AppError> {
    validate_meter_profile(&profile)?;
    Ok(plan_reads(&profile))
}

/// Decode named meter points out of whatever the last poll actually returned.
///
/// Takes address/word pairs rather than a block, because a meter can be read
/// in several requests with gaps between them — there is no single contiguous
/// array to index into. A parameter whose registers weren't all in the last
/// poll is reported as such rather than decoded from zeros.
#[tauri::command]
pub fn decode_meter_points(
    profile: MeterProfile,
    words: Vec<AddressedWord>,
) -> Result<Vec<DecodedRegister>, AppError> {
    validate_meter_profile(&profile)?;
    let available: std::collections::HashMap<u16, u16> =
        words.into_iter().map(|w| (w.address, w.value)).collect();

    let mut out = Vec::with_capacity(profile.points.len());
    for point in &profile.points {
        let span = point.format.data_type.register_span() as usize;
        let mut chunk = Vec::with_capacity(span);
        let mut missing = false;
        for i in 0..span {
            match point
                .address
                .checked_add(i as u16)
                .and_then(|a| available.get(&a))
            {
                Some(word) => chunk.push(*word),
                None => {
                    missing = true;
                    break;
                }
            }
        }
        if missing {
            out.push(DecodedRegister {
                address: point.address,
                span: span as u8,
                raw: vec![],
                value: TypedValue::Invalid,
                decode_error: Some(
                    "not in the last poll — this parameter's registers weren't read".to_string(),
                ),
            });
            continue;
        }
        let (value, decode_error) = crate::modbus::codec::decode(&chunk, &point.format);
        out.push(DecodedRegister {
            address: point.address,
            span: span as u8,
            raw: chunk,
            value,
            decode_error,
        });
    }
    Ok(out)
}

/// Decode a simulator slave's animated tags out of its holding-register
/// snapshot, so the simulator can show engineering values (231.4 V) next to
/// the raw words instead of hex alone. Registers are indexed from address 0,
/// which is how `SlaveSnapshot` carries them.
#[tauri::command]
pub fn decode_tag_values(
    registers: Vec<u16>,
    tags: Vec<TagConfig>,
) -> Result<Vec<DecodedRegister>, AppError> {
    let mut out = Vec::with_capacity(tags.len());
    for tag in &tags {
        let span = tag.format.data_type.register_span() as usize;
        let start = tag.address as usize;
        let end = start.saturating_add(span);
        if span == 0 || end > registers.len() {
            out.push(DecodedRegister {
                address: tag.address,
                span: span as u8,
                raw: vec![],
                value: TypedValue::Invalid,
                decode_error: Some(format!(
                    "tag '{}' at {} needs {span} register(s); the slave has {}",
                    tag.name,
                    tag.address,
                    registers.len()
                )),
            });
            continue;
        }
        let chunk = &registers[start..end];
        let (value, decode_error) = crate::modbus::codec::decode(chunk, &tag.format);
        out.push(DecodedRegister {
            address: tag.address,
            span: span as u8,
            raw: chunk.to_vec(),
            value,
            decode_error,
        });
    }
    Ok(out)
}
