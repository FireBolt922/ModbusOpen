//! Turning a meter profile into something the simulator can serve.
//!
//! Profiles themselves are user-owned data — they live on disk under
//! `meters::library`, not in this binary. This module only holds the
//! profile -> simulator-config conversion, which is protocol-shaped and
//! belongs next to the rest of `modbus`.

use super::types::{MeterProfile, SimulatorConfig, SlaveSimConfig, TagConfig};

/// Convert a meter profile into a single-slave simulator config that covers
/// the profile's register block and animates points that declare
/// `sim_behavior`. Addresses are absolute wire addresses; the block is sized
/// so the highest address+span fits (from wire 0).
pub fn profile_to_simulator_config(
    profile: &MeterProfile,
    tcp_port: u16,
    tick_ms: u64,
) -> SimulatorConfig {
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

    SimulatorConfig {
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
pub(crate) mod test_support {
    use crate::modbus::types::{
        DataFormat, DataType, FunctionCode, MeterPoint, MeterPointGroup, MeterProfile, MeterSource,
        TagBehavior, WordOrder,
    };

    /// A profile shaped like one a user would build in the editor: a block
    /// that doesn't start at zero, mixed data types, and a scaled integer.
    pub fn sample_profile(id: &str, function: FunctionCode) -> MeterProfile {
        MeterProfile {
            id: id.into(),
            brand: "Acme".into(),
            model: "Custom 1".into(),
            description: "Hand-built in the meter editor".into(),
            source: MeterSource::User,
            function,
            block_start: 100,
            block_count: 10,
            default_unit_id: 1,
            suggested_rtu: None,
            points: vec![
                MeterPoint {
                    key: "voltage".into(),
                    label: "Voltage".into(),
                    address: 100,
                    format: DataFormat {
                        data_type: DataType::Float32,
                        word_order: WordOrder::Cdab,
                        scale: 1.0,
                        offset: 0.0,
                    },
                    unit: "V".into(),
                    group: MeterPointGroup::Instantaneous,
                    unverified: true,
                    sim_behavior: Some(TagBehavior::Random {
                        min: 228.0,
                        max: 242.0,
                    }),
                    sim_initial: Some(230.0),
                },
                // Scaled uint16: raw 7 at scale 0.1 is 0.7 A. This is the case
                // that reads as a dead tag when scaling is applied twice.
                MeterPoint {
                    key: "current".into(),
                    label: "Current".into(),
                    address: 102,
                    format: DataFormat {
                        data_type: DataType::Uint16,
                        word_order: WordOrder::Cdab,
                        scale: 0.1,
                        offset: 0.0,
                    },
                    unit: "A".into(),
                    group: MeterPointGroup::Instantaneous,
                    unverified: true,
                    sim_behavior: Some(TagBehavior::Random { min: 0.5, max: 9.0 }),
                    sim_initial: Some(0.7),
                },
                MeterPoint {
                    key: "energy".into(),
                    label: "Energy".into(),
                    address: 104,
                    format: DataFormat {
                        data_type: DataType::Uint32,
                        word_order: WordOrder::Cdab,
                        scale: 1.0,
                        offset: 0.0,
                    },
                    unit: "kWh".into(),
                    group: MeterPointGroup::Energy,
                    unverified: true,
                    sim_behavior: Some(TagBehavior::Counter { step: 1.0 }),
                    sim_initial: Some(1000.0),
                },
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::sample_profile;
    use super::*;
    use crate::modbus::types::FunctionCode;

    #[test]
    fn config_covers_the_whole_block_and_carries_animated_points() {
        let profile = sample_profile("mine", FunctionCode::ReadHoldingRegisters);
        let cfg = profile_to_simulator_config(&profile, 5021, 1000);
        assert_eq!(cfg.slaves.len(), 1);
        let slave = &cfg.slaves[0];
        assert_eq!(slave.unit_id, profile.default_unit_id);
        // Block is 100..110; the store is indexed from 0, so it must be >= 110.
        assert!(slave.holding_register_count >= 110);
        assert_eq!(slave.input_register_count, slave.holding_register_count);
        assert_eq!(slave.tags.len(), 3);
    }

    /// A point past the declared block still has to be served — the editor
    /// validates this, but a hand-edited import can widen the map.
    #[test]
    fn block_is_widened_to_fit_a_point_past_its_end() {
        let mut profile = sample_profile("wide", FunctionCode::ReadHoldingRegisters);
        profile.block_count = 2;
        let cfg = profile_to_simulator_config(&profile, 0, 500);
        assert!(cfg.slaves[0].holding_register_count >= 106);
    }

    /// Points with no `sim_behavior` produce no tags — the simulator would
    /// serve zeros for them, which is why the editor defaults every new
    /// parameter to an animated behaviour.
    #[test]
    fn points_without_sim_behavior_produce_no_tags() {
        let mut profile = sample_profile("static", FunctionCode::ReadHoldingRegisters);
        for p in &mut profile.points {
            p.sim_behavior = None;
        }
        let cfg = profile_to_simulator_config(&profile, 0, 500);
        assert!(cfg.slaves[0].tags.is_empty());
    }
}
