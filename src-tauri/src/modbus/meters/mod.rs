//! Built-in meter profile library. Profiles are JSON data next to this module
//! so they stay reviewable and the meter-profile skill has an obvious place to
//! add the next one.

use std::sync::OnceLock;

use super::types::{MeterProfile, MeterSource};
use super::validate::validate_meter_profile;

const BUILTIN_JSON: &[&str] = &[
    include_str!("builtin/compact-schneider.json"),
    include_str!("builtin/digi-250.json"),
    include_str!("builtin/digi-620.json"),
    include_str!("builtin/digi-720.json"),
    include_str!("builtin/elmeasure.json"),
    include_str!("builtin/emfis-hpl-vie.json"),
    include_str!("builtin/flow-meter.json"),
    include_str!("builtin/goblin-trinity.json"),
    include_str!("builtin/icd-mfm-9012.json"),
    include_str!("builtin/l-t-vega.json"),
    include_str!("builtin/lt-electrical-meter.json"),
    include_str!("builtin/meatrol-me-337.json"),
    include_str!("builtin/pm130-plus.json"),
    include_str!("builtin/quasar.json"),
    include_str!("builtin/rish-delta-energy-nx.json"),
    include_str!("builtin/rish-em1330.json"),
    include_str!("builtin/rish-lm-1360.json"),
    include_str!("builtin/rish-master-3430.json"),
    include_str!("builtin/rish-master-3440.json"),
    include_str!("builtin/schneider-6300.json"),
    include_str!("builtin/schneider-6400.json"),
    include_str!("builtin/schneider-6433.json"),
    include_str!("builtin/schneider-6433h.json"),
    include_str!("builtin/schneider-6436h.json"),
    include_str!("builtin/schneider-em-1200.json"),
    include_str!("builtin/schneider-em-7230.json"),
    include_str!("builtin/schneider-pm-5320.json"),
    include_str!("builtin/schneider.json"),
    include_str!("builtin/secure-elite-100.json"),
    include_str!("builtin/secure-elite-440-abs.json"),
    include_str!("builtin/secure-elite-440.json"),
    include_str!("builtin/selec-383a.json"),
    include_str!("builtin/selec-384.json"),
    include_str!("builtin/selec-386.json"),
    include_str!("builtin/selec-mfm384rc.json"),
    include_str!("builtin/selec.json"),
    include_str!("builtin/siemens-7kt0310.json"),
    include_str!("builtin/siemens-pac3200.json"),
    include_str!("builtin/socomec-a40.json"),
    include_str!("builtin/trinity-nf-29.json"),
    include_str!("builtin/vfd.json"),
];

fn parse_builtin(json: &str) -> MeterProfile {
    let mut profile: MeterProfile =
        serde_json::from_str(json).expect("built-in meter profile JSON must parse");
    // Always force BuiltIn source regardless of file content.
    profile.source = MeterSource::BuiltIn;
    validate_meter_profile(&profile)
        .unwrap_or_else(|e| panic!("built-in profile '{}' invalid: {e}", profile.id));
    profile
}

/// All built-in profiles, parsed and validated once.
pub fn builtin_profiles() -> &'static [MeterProfile] {
    static PROFILES: OnceLock<Vec<MeterProfile>> = OnceLock::new();
    PROFILES.get_or_init(|| BUILTIN_JSON.iter().map(|j| parse_builtin(j)).collect())
}

pub fn builtin_by_id(id: &str) -> Option<&'static MeterProfile> {
    builtin_profiles().iter().find(|p| p.id == id)
}

/// Convert a meter profile into a single-slave simulator config that covers
/// the profile's holding-register block and animates points that declare
/// `sim_behavior`. Addresses are absolute wire addresses; the holding block
/// is sized so the highest address+span fits (from wire 0).
pub fn profile_to_simulator_config(
    profile: &MeterProfile,
    tcp_port: u16,
    tick_ms: u64,
) -> super::types::SimulatorConfig {
    use super::types::{SlaveSimConfig, TagConfig};

    let mut max_end = profile.block_start as u32 + profile.block_count as u32;
    let mut tags = Vec::new();
    for point in &profile.points {
        let span = point.format.data_type.register_span() as u32;
        max_end = max_end.max(point.address as u32 + span);
        if let Some(behavior) = point.sim_behavior {
            tags.push(TagConfig {
                name: point.label.clone(),
                address: point.address,
                format: point.format,
                behavior,
                initial_value: point.sim_initial.unwrap_or(0.0),
            });
        }
    }
    let holding = max_end.min(0x1_0000) as u16;

    super::types::SimulatorConfig {
        tcp_port,
        tick_ms,
        slaves: vec![SlaveSimConfig {
            unit_id: profile.default_unit_id,
            coil_count: 0,
            discrete_count: 0,
            // FC04 profiles read input registers; animation mirrors every tag
            // into both blocks, so size them the same or those reads hit an
            // empty block and come back as exception 02.
            input_register_count: holding,
            holding_register_count: holding,
            tags,
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modbus::types::MeterPointGroup;

    #[test]
    fn every_builtin_parses_and_validates() {
        let profiles = builtin_profiles();
        assert!(!profiles.is_empty());
        let mut ids = std::collections::HashSet::new();
        for p in profiles {
            assert!(ids.insert(p.id.clone()), "duplicate built-in id {}", p.id);
            assert!(matches!(p.source, MeterSource::BuiltIn));
            // The name promised this and never delivered it.
            crate::modbus::validate::validate_meter_profile(p)
                .unwrap_or_else(|e| panic!("built-in {} fails validation: {e}", p.id));
        }
    }

    /// The block must be readable in one request and must actually cover every
    /// point. A hardcoded count silently truncated 30% of the library before.
    #[test]
    fn every_builtin_block_is_one_request_and_covers_its_points() {
        for p in builtin_profiles() {
            let max = p.function.max_quantity();
            assert!(
                p.block_count >= 1 && p.block_count <= max,
                "{}: block count {} exceeds the {:?} limit of {max}",
                p.id,
                p.block_count,
                p.function
            );
            let block_end = p.block_start as u32 + p.block_count as u32;
            for pt in &p.points {
                let end = pt.address as u32 + pt.format.data_type.register_span() as u32;
                assert!(
                    pt.address as u32 >= p.block_start as u32 && end <= block_end,
                    "{}: point '{}' at {} (span {}) is outside block [{}, {})",
                    p.id,
                    pt.key,
                    pt.address,
                    pt.format.data_type.register_span(),
                    p.block_start,
                    block_end
                );
            }
        }
    }

    /// A tag's simulated range must survive its own register format.
    ///
    /// A 0.95 power factor written into a uint16 lands as 0, and a value past
    /// a type's range wraps — either way the simulator shows a number that
    /// isn't the one it generated, which is indistinguishable from a decoding
    /// bug when you're staring at the table.
    #[test]
    fn simulated_ranges_round_trip_through_their_own_format() {
        use crate::modbus::codec::{decode, encode};
        use crate::modbus::types::{DataType, TagBehavior, TypedValue};

        for p in builtin_profiles() {
            for pt in &p.points {
                let Some(behavior) = pt.sim_behavior else {
                    continue;
                };
                let probe = match behavior {
                    TagBehavior::Random { min, max } => (min + max) / 2.0,
                    TagBehavior::Counter { .. } => pt.sim_initial.unwrap_or(1.0),
                    _ => continue,
                };
                // Engineering units (0.97 PF, 0.7 A). A scaled integer register
                // must be written as Float so encode can undo the scale; an
                // identity-scale integer still takes Uint/Int.
                let scaled = pt.format.scale != 1.0 || pt.format.offset != 0.0;
                let typed = match pt.format.data_type {
                    DataType::Float32 | DataType::Float64 => TypedValue::Float(probe),
                    DataType::Uint16 | DataType::Uint32 | DataType::Uint64 if scaled => {
                        TypedValue::Float(probe)
                    }
                    DataType::Int16 | DataType::Int32 | DataType::Int64 if scaled => {
                        TypedValue::Float(probe)
                    }
                    DataType::Uint16 | DataType::Uint32 | DataType::Uint64 => {
                        TypedValue::Uint(probe as u64)
                    }
                    _ => TypedValue::Int(probe as i64),
                };
                let regs = encode(&typed, &pt.format)
                    .unwrap_or_else(|e| panic!("{}: '{}' can't encode {probe}: {e}", p.id, pt.key));
                let (back, err) = decode(&regs, &pt.format);
                assert!(
                    err.is_none(),
                    "{}: '{}' decode of {probe} failed: {err:?}",
                    p.id,
                    pt.key
                );
                let got = match back {
                    TypedValue::Float(value) => value,
                    TypedValue::Int(value) => value as f64,
                    TypedValue::Uint(value) => value as f64,
                    other => panic!("{}: '{}' decoded as {other:?}", p.id, pt.key),
                };
                // Scaled integers decode back to Float(engineering); unscaled
                // integers stay integral.
                let expected = if pt.format.data_type.is_float() || scaled {
                    probe
                } else {
                    (probe as i64) as f64
                };
                assert!(
                    (got - expected).abs() <= expected.abs() * 1e-3 + 1.0,
                    "{}: '{}' simulates {probe} but reads back {got} as {:?} {:?}",
                    p.id,
                    pt.key,
                    pt.format.data_type,
                    pt.format.word_order
                );
            }
        }
    }

    /// Two points must not share a register.
    ///
    /// Exact-address collisions come from the firmware maps; *overlaps* come
    /// from typing a parameter wider than its spacing allows — a 2-register
    /// value at addresses 6, 7 and 8 makes three parameters decode from partly
    /// the same bytes, which reads as plausible garbage rather than an error.
    #[test]
    fn no_builtin_has_points_sharing_a_register() {
        for p in builtin_profiles() {
            let mut owner: std::collections::HashMap<u32, &str> = std::collections::HashMap::new();
            for pt in &p.points {
                let span = pt.format.data_type.register_span() as u32;
                for reg in pt.address as u32..pt.address as u32 + span {
                    if let Some(prev) = owner.insert(reg, &pt.key) {
                        panic!(
                            "{}: '{}' (at {}, span {}) and '{}' both cover register {}",
                            p.id, pt.key, pt.address, span, prev, reg
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn lt_profile_matches_device_profiles_ground_truth() {
        let lt = builtin_by_id("lt-electrical-meter").expect("L&T profile");
        assert_eq!(lt.block_start, 100);
        assert_eq!(lt.block_count, 120);
        assert_eq!(lt.default_unit_id, 1);
        // docs/reference/device-profiles.md table
        let expected: &[(&str, u16)] = &[
            ("active_power", 100),
            ("reactive_power", 108),
            ("power_factor", 116),
            ("demand_total", 124),
            ("frequency", 132),
            ("voltage_average", 148),
            ("current_total", 150),
            ("energy_received", 158),
            ("vah_received", 160),
            ("run_hours", 216),
        ];
        assert_eq!(lt.points.len(), expected.len());
        for (key, addr) in expected {
            let p = lt.points.iter().find(|x| x.key == *key).unwrap();
            assert_eq!(p.address, *addr, "{key}");
            assert!(!p.unverified, "{key} should be verified");
        }
        let run = lt.points.iter().find(|p| p.key == "run_hours").unwrap();
        assert_eq!(run.format.data_type, crate::modbus::types::DataType::Uint32);
        assert_eq!(run.group, MeterPointGroup::Diagnostics);
    }

    #[test]
    fn vfd_and_flow_ship() {
        assert!(builtin_by_id("vfd").is_some());
        let flow = builtin_by_id("flow-meter").unwrap();
        assert_eq!(flow.default_unit_id, 2);
        assert_eq!(flow.block_start, 0);
        assert_eq!(flow.block_count, 4);
    }

    #[test]
    fn lt_simulator_config_covers_block() {
        let lt = builtin_by_id("lt-electrical-meter").unwrap();
        let cfg = profile_to_simulator_config(lt, 5021, 1000);
        assert_eq!(cfg.slaves.len(), 1);
        assert!(cfg.slaves[0].holding_register_count >= 220);
        assert!(!cfg.slaves[0].tags.is_empty());
    }
}
