//! User meter library: JSON files under the OS app-data directory.
//!
//! Every profile in the app is owned by the user — created in the editor or
//! imported from a colleague's pack. There is no built-in catalogue, so this
//! module is the single source of meters.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Utc;
use tauri::{AppHandle, Manager};

use crate::error::AppError;
use crate::modbus::types::{
    ImportResolution, MeterImportChoice, MeterImportItem, MeterImportPreview, MeterImportStatus,
    MeterPack, MeterProfile, MeterSource,
};
use crate::modbus::validate::validate_meter_profile;

const USER_DIR_NAME: &str = "meters";
const PACK_KIND: &str = "meter-pack";
const PACK_VERSION: u32 = 1;

pub struct MeterLibrary {
    dir: PathBuf,
    /// User + imported profiles, keyed by id.
    user: HashMap<String, MeterProfile>,
}

impl MeterLibrary {
    pub fn load(app: &AppHandle) -> Result<Self, AppError> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| AppError::InvalidConfig(format!("can't resolve app data dir — {e}")))?
            .join(USER_DIR_NAME);
        fs::create_dir_all(&dir).map_err(|e| {
            AppError::InvalidConfig(format!(
                "can't create meter library folder at {} — {e}",
                dir.display()
            ))
        })?;

        let mut user = HashMap::new();
        let entries = fs::read_dir(&dir).map_err(|e| {
            AppError::InvalidConfig(format!(
                "can't read meter library at {} — {e}",
                dir.display()
            ))
        })?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            match load_profile_file(&path) {
                Ok(profile) => {
                    user.insert(profile.id.clone(), profile);
                }
                Err(err) => {
                    tracing::warn!("skipping bad meter file {}: {err}", path.display());
                }
            }
        }

        Ok(Self { dir, user })
    }

    pub fn list(&self) -> Vec<MeterProfile> {
        let mut out: Vec<MeterProfile> = self.user.values().cloned().collect();
        out.sort_by(|a, b| {
            a.brand
                .to_lowercase()
                .cmp(&b.brand.to_lowercase())
                .then_with(|| a.model.to_lowercase().cmp(&b.model.to_lowercase()))
                .then_with(|| a.id.cmp(&b.id))
        });
        out
    }

    pub fn get(&self, id: &str) -> Option<MeterProfile> {
        self.user.get(id).cloned()
    }

    pub fn save(&mut self, profile: MeterProfile) -> Result<MeterProfile, AppError> {
        validate_meter_profile(&profile)?;
        write_profile_file(&self.dir, &profile)?;
        self.user.insert(profile.id.clone(), profile.clone());
        Ok(profile)
    }

    pub fn delete(&mut self, id: &str) -> Result<(), AppError> {
        if !self.user.contains_key(id) {
            return Err(AppError::InvalidConfig(format!("no meter with id '{id}'")));
        }
        let path = self.dir.join(format!("{id}.json"));
        if path.exists() {
            fs::remove_file(&path).map_err(|e| {
                AppError::InvalidConfig(format!("can't delete meter file {} — {e}", path.display()))
            })?;
        }
        self.user.remove(id);
        Ok(())
    }

    pub fn duplicate(&mut self, id: &str, new_id: &str) -> Result<MeterProfile, AppError> {
        let new_id = new_id.trim();
        if new_id.is_empty() {
            return Err(AppError::InvalidConfig(
                "new meter id can't be empty".to_string(),
            ));
        }
        if self.get(new_id).is_some() {
            return Err(AppError::InvalidConfig(format!(
                "a meter with id '{new_id}' already exists"
            )));
        }
        let mut profile = self
            .get(id)
            .ok_or_else(|| AppError::InvalidConfig(format!("no meter with id '{id}'")))?;
        profile.id = new_id.to_string();
        profile.source = MeterSource::User;
        profile.model = format!("{} (copy)", profile.model);
        self.save(profile)
    }

    pub fn export_pack(&self, ids: &[String]) -> Result<String, AppError> {
        let mut profiles = Vec::with_capacity(ids.len());
        for id in ids {
            let mut p = self
                .get(id)
                .ok_or_else(|| AppError::InvalidConfig(format!("no meter with id '{id}'")))?;
            // Exported packs don't carry local source; importers re-tag.
            p.source = MeterSource::User;
            profiles.push(p);
        }
        if profiles.is_empty() {
            return Err(AppError::InvalidConfig(
                "pick at least one meter to export".to_string(),
            ));
        }
        let pack = MeterPack {
            version: PACK_VERSION,
            kind: PACK_KIND.to_string(),
            exported_by: Some(format!("ModbusOpen {}", env!("CARGO_PKG_VERSION"))),
            exported_at: Some(Utc::now()),
            profiles,
        };
        serde_json::to_string_pretty(&pack)
            .map_err(|e| AppError::InvalidConfig(format!("can't serialize meter pack — {e}")))
    }

    pub fn write_export(&self, ids: &[String], path: &Path) -> Result<String, AppError> {
        let json = self.export_pack(ids)?;
        fs::write(path, json.as_bytes()).map_err(|e| {
            AppError::InvalidConfig(format!("can't write export to {} — {e}", path.display()))
        })?;
        Ok(path.display().to_string())
    }

    pub fn preview_import(&self, path: &Path) -> Result<MeterImportPreview, AppError> {
        let text = fs::read_to_string(path).map_err(|e| {
            AppError::InvalidConfig(format!("can't read import file {} — {e}", path.display()))
        })?;
        let profiles = parse_import_payload(&text)?;
        let mut items = Vec::with_capacity(profiles.len());
        for mut profile in profiles {
            match validate_meter_profile(&profile) {
                Ok(()) => {
                    let status = if self.user.contains_key(&profile.id) {
                        MeterImportStatus::DuplicateId
                    } else {
                        MeterImportStatus::New
                    };
                    // Tag as imported for display in the preview.
                    profile.source = MeterSource::Imported {
                        from: path
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or("import")
                            .to_string(),
                    };
                    items.push(MeterImportItem {
                        profile,
                        status,
                        message: None,
                    });
                }
                Err(e) => {
                    items.push(MeterImportItem {
                        profile,
                        status: MeterImportStatus::Invalid,
                        message: Some(e.to_string()),
                    });
                }
            }
        }
        Ok(MeterImportPreview {
            path: path.display().to_string(),
            items,
        })
    }

    pub fn commit_import(
        &mut self,
        path: &Path,
        choices: &[MeterImportChoice],
    ) -> Result<Vec<MeterProfile>, AppError> {
        let preview = self.preview_import(path)?;
        let choice_map: HashMap<&str, &MeterImportChoice> =
            choices.iter().map(|c| (c.profile_id.as_str(), c)).collect();

        let mut saved = Vec::new();
        for item in preview.items {
            if item.status == MeterImportStatus::Invalid {
                continue;
            }
            let mut profile = item.profile;
            let original_id = profile.id.clone();

            if item.status == MeterImportStatus::DuplicateId {
                let choice = choice_map.get(original_id.as_str());
                let resolution = choice
                    .map(|c| c.resolution)
                    .unwrap_or(ImportResolution::Skip);
                match resolution {
                    ImportResolution::Skip => continue,
                    // Overwrite keeps the id; `save` replaces the file on disk.
                    ImportResolution::Overwrite => {}
                    ImportResolution::Rename => {
                        let new_id = choice
                            .and_then(|c| c.new_id.as_deref())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| unique_id(&profile.id, |id| self.get(id).is_some()));
                        if self.get(&new_id).is_some() {
                            return Err(AppError::InvalidConfig(format!(
                                "rename target '{new_id}' already exists"
                            )));
                        }
                        profile.id = new_id;
                    }
                }
            }

            profile.source = MeterSource::Imported {
                from: path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("import")
                    .to_string(),
            };
            let stored = self.save(profile)?;
            saved.push(stored);
        }
        Ok(saved)
    }
}

fn load_profile_file(path: &Path) -> Result<MeterProfile, AppError> {
    let text = fs::read_to_string(path)
        .map_err(|e| AppError::InvalidConfig(format!("can't read {} — {e}", path.display())))?;
    let profile: MeterProfile = serde_json::from_str(&text).map_err(|e| {
        AppError::InvalidConfig(format!(
            "meter file {} isn't valid JSON — {e}",
            path.display()
        ))
    })?;
    validate_meter_profile(&profile)?;
    Ok(profile)
}

fn write_profile_file(dir: &Path, profile: &MeterProfile) -> Result<(), AppError> {
    let path = dir.join(format!("{}.json", profile.id));
    let json = serde_json::to_string_pretty(profile).map_err(|e| {
        AppError::InvalidConfig(format!("can't serialize meter '{}' — {e}", profile.id))
    })?;
    fs::write(&path, json.as_bytes())
        .map_err(|e| AppError::InvalidConfig(format!("can't write {} — {e}", path.display())))?;
    Ok(())
}

fn parse_import_payload(text: &str) -> Result<Vec<MeterProfile>, AppError> {
    // Accept either a pack envelope or a bare single profile.
    if let Ok(pack) = serde_json::from_str::<MeterPack>(text) {
        if pack.kind != PACK_KIND && pack.kind != "profile" {
            return Err(AppError::InvalidConfig(format!(
                "unsupported pack kind '{}' — expected '{PACK_KIND}'",
                pack.kind
            )));
        }
        if pack.profiles.is_empty() {
            return Err(AppError::InvalidConfig(
                "import file contains no meter profiles".to_string(),
            ));
        }
        return Ok(pack.profiles);
    }
    if let Ok(profile) = serde_json::from_str::<MeterProfile>(text) {
        return Ok(vec![profile]);
    }
    Err(AppError::InvalidConfig(
        "import file isn't a meter pack or a single meter profile — check the JSON".to_string(),
    ))
}

fn unique_id(base: &str, taken: impl Fn(&str) -> bool) -> String {
    let mut n = 2u32;
    loop {
        let candidate = format!("{base}-{n}");
        if !taken(&candidate) {
            return candidate;
        }
        n += 1;
        if n > 10_000 {
            return format!("{base}-{}", Utc::now().timestamp());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modbus::types::{
        DataFormat, DataType, FunctionCode, MeterPoint, MeterPointGroup, WordOrder,
    };
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn sample_profile(id: &str) -> MeterProfile {
        MeterProfile {
            id: id.into(),
            brand: "Test".into(),
            model: "Model".into(),
            description: String::new(),
            source: MeterSource::User,
            function: FunctionCode::ReadHoldingRegisters,
            default_unit_id: 1,
            suggested_rtu: None,
            points: vec![MeterPoint {
                key: "p1".into(),
                label: "P1".into(),
                address: 0,
                format: DataFormat {
                    data_type: DataType::Uint16,
                    word_order: WordOrder::Cdab,
                    scale: 1.0,
                    offset: 0.0,
                },
                unit: String::new(),
                function: None,
                group: MeterPointGroup::Other,
                unverified: true,
                sim_behavior: None,
                sim_initial: None,
            }],
        }
    }

    /// A private directory per library.
    ///
    /// The timestamp alone isn't unique: the clock's resolution is coarse
    /// enough that two libraries created back to back land in the same folder,
    /// and then one test's `remove_dir_all` deletes another's meters. The
    /// counter is what actually guarantees separation.
    fn temp_lib() -> (MeterLibrary, PathBuf) {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("modbusopen-meters-{stamp}-{n}"));
        fs::create_dir_all(&dir).unwrap();
        (
            MeterLibrary {
                dir: dir.clone(),
                user: HashMap::new(),
            },
            dir,
        )
    }

    #[test]
    fn save_list_delete_round_trip() {
        let (mut lib, dir) = temp_lib();
        let p = lib.save(sample_profile("mine")).unwrap();
        assert_eq!(p.id, "mine");
        assert!(lib.list().iter().any(|x| x.id == "mine"));
        lib.delete("mine").unwrap();
        assert!(!lib.user.contains_key("mine"));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn deleting_a_meter_that_isnt_there_says_so() {
        let (mut lib, dir) = temp_lib();
        assert!(lib.delete("never-existed").is_err());
        let _ = fs::remove_dir_all(dir);
    }

    /// The share path in one test: build a meter, export the pack a colleague
    /// would receive, and import it into an empty library.
    #[test]
    fn a_pack_exported_here_imports_into_an_empty_library() {
        let (mut lib, dir) = temp_lib();
        lib.save(sample_profile("shared")).unwrap();
        let pack_path = dir.join("shared.mbmeter.json");
        lib.write_export(&["shared".into()], &pack_path).unwrap();

        let (mut colleague, other_dir) = temp_lib();
        assert!(colleague.list().is_empty());
        let preview = colleague.preview_import(&pack_path).unwrap();
        assert_eq!(preview.items[0].status, MeterImportStatus::New);
        let saved = colleague.commit_import(&pack_path, &[]).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].id, "shared");
        // Imported meters are tagged with where they came from, so the library
        // can tell "mine" from "someone sent me this".
        assert!(matches!(saved[0].source, MeterSource::Imported { .. }));
        assert_eq!(colleague.list().len(), 1);
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(other_dir);
    }

    #[test]
    fn export_import_round_trip() {
        let (mut lib, dir) = temp_lib();
        lib.save(sample_profile("alpha")).unwrap();
        let json = lib.export_pack(&["alpha".into()]).unwrap();
        let pack: MeterPack = serde_json::from_str(&json).unwrap();
        assert_eq!(pack.kind, PACK_KIND);
        assert_eq!(pack.profiles.len(), 1);

        let import_path = dir.join("pack.mbmeter.json");
        fs::write(&import_path, json).unwrap();

        // Import as new id after delete
        lib.delete("alpha").unwrap();
        let preview = lib.preview_import(&import_path).unwrap();
        assert_eq!(preview.items.len(), 1);
        assert_eq!(preview.items[0].status, MeterImportStatus::New);
        let saved = lib.commit_import(&import_path, &[]).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].id, "alpha");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn import_duplicate_skip_and_rename() {
        let (mut lib, dir) = temp_lib();
        lib.save(sample_profile("alpha")).unwrap();
        let json = lib.export_pack(&["alpha".into()]).unwrap();
        let import_path = dir.join("pack.json");
        fs::write(&import_path, json).unwrap();

        // Skip
        let saved = lib
            .commit_import(
                &import_path,
                &[MeterImportChoice {
                    profile_id: "alpha".into(),
                    resolution: ImportResolution::Skip,
                    new_id: None,
                }],
            )
            .unwrap();
        assert!(saved.is_empty());

        // Rename
        let saved = lib
            .commit_import(
                &import_path,
                &[MeterImportChoice {
                    profile_id: "alpha".into(),
                    resolution: ImportResolution::Rename,
                    new_id: Some("alpha-2".into()),
                }],
            )
            .unwrap();
        assert_eq!(saved[0].id, "alpha-2");
        let _ = fs::remove_dir_all(dir);
    }

    /// Overwrite replaces the meter under the same id — the one resolution
    /// that must not quietly leave the old map in place.
    #[test]
    fn import_overwrite_replaces_the_existing_meter() {
        let (mut lib, dir) = temp_lib();
        lib.save(sample_profile("alpha")).unwrap();

        let mut incoming = sample_profile("alpha");
        incoming.model = "Revised".into();
        let pack = MeterPack {
            version: PACK_VERSION,
            kind: PACK_KIND.into(),
            exported_by: None,
            exported_at: None,
            profiles: vec![incoming],
        };
        let import_path = dir.join("alpha.json");
        fs::write(&import_path, serde_json::to_string(&pack).unwrap()).unwrap();

        let saved = lib
            .commit_import(
                &import_path,
                &[MeterImportChoice {
                    profile_id: "alpha".into(),
                    resolution: ImportResolution::Overwrite,
                    new_id: None,
                }],
            )
            .unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].id, "alpha");
        assert_eq!(lib.get("alpha").unwrap().model, "Revised");
        assert_eq!(
            lib.list().len(),
            1,
            "overwrite must not leave a second copy"
        );
        let _ = fs::remove_dir_all(dir);
    }

    /// A profile file that was hand-edited to a path-traversing id must not be
    /// loadable — `load` skips it rather than letting it name a file outside
    /// the library folder later.
    #[test]
    fn a_profile_with_a_bad_id_is_rejected_on_save() {
        let (mut lib, dir) = temp_lib();
        let mut bad = sample_profile("ok");
        bad.id = "../escape".into();
        assert!(lib.save(bad).is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
