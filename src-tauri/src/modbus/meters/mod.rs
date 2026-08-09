//! Turning a meter profile into something the simulator can serve.
//!
//! Profiles themselves are user-owned data — they live on disk under
//! `meters::library`, not in this binary. This module only holds the
//! profile -> simulator-config conversion, which is protocol-shaped and
//! belongs next to the rest of `modbus`.

use super::types::{
    FunctionCode, MeterPoint, MeterProfile, ReadBlock, SimulatorConfig, SlaveSimConfig, TagConfig,
};

/// How many unwanted registers a single request may drag along before it's
/// cheaper to issue a second request instead.
///
/// Two parameters 4 registers apart belong in one request — the gap costs 8
/// bytes on the wire, a second request costs a whole round trip (and on RTU,
/// a 3.5-character silent interval on either side of it). Two parameters 900
/// registers apart obviously don't. The line has to sit somewhere; 32 keeps a
/// realistic instantaneous-values group intact while still splitting the
/// energy registers a thousand addresses away into their own request.
const MAX_WASTED_REGISTERS: u32 = 32;

/// The read function a parameter actually uses: its own override, or the
/// profile's default.
pub fn point_function(profile: &MeterProfile, point: &MeterPoint) -> FunctionCode {
    point.function.unwrap_or(profile.function)
}

/// Work out the Modbus requests needed to read every parameter of a meter.
///
/// This is the answer to "what if a few parameters are far enough apart that a
/// single call won't reach them" — nothing is dropped and nobody has to pick a
/// block by hand. Parameters are grouped by function code, sorted by address,
/// and packed into the fewest requests that respect two hard limits (the
/// function's max quantity, the 16-bit address space) and one judgement call
/// (`MAX_WASTED_REGISTERS`).
///
/// The result is deterministic and ordered by function then address, so the
/// editor can show the same plan the poll engine will execute.
pub fn plan_reads(profile: &MeterProfile) -> Vec<ReadBlock> {
    // Group by function code, preserving first-seen order so the plan reads
    // the way the parameter list does.
    let mut groups: Vec<(FunctionCode, Vec<&MeterPoint>)> = Vec::new();
    for point in &profile.points {
        let function = point_function(profile, point);
        match groups.iter_mut().find(|(f, _)| *f == function) {
            Some((_, list)) => list.push(point),
            None => groups.push((function, vec![point])),
        }
    }

    let mut plan = Vec::new();
    for (function, mut points) in groups {
        points.sort_by_key(|p| p.address);
        let max_quantity = function.max_quantity() as u32;

        let mut start: u32 = 0;
        let mut end: u32 = 0; // exclusive; 0 == no open block
        let mut open = false;

        for point in points {
            let span = point.format.data_type.register_span().max(1) as u32;
            let addr = point.address as u32;
            let point_end = (addr + span).min(0x1_0000);

            if open {
                let gap = addr.saturating_sub(end);
                let fits = point_end - start <= max_quantity;
                if fits && gap <= MAX_WASTED_REGISTERS {
                    end = end.max(point_end);
                    continue;
                }
                plan.push(ReadBlock {
                    function,
                    start_address: start as u16,
                    quantity: (end - start) as u16,
                });
            }
            start = addr;
            end = point_end;
            open = true;
        }

        if open {
            plan.push(ReadBlock {
                function,
                start_address: start as u16,
                quantity: (end - start) as u16,
            });
        }
    }
    plan
}

/// Convert a meter profile into a single-slave simulator config that covers
/// every parameter and animates the ones that declare `sim_behavior`.
///
/// The store is indexed from wire 0, so it's sized to the highest address plus
/// its span — a meter whose parameters sit at 100 and 3000 gets a store that
/// reaches 3000, with the untouched middle reading as zeros.
pub fn profile_to_simulator_config(
    profile: &MeterProfile,
    tcp_port: u16,
    tick_ms: u64,
) -> SimulatorConfig {
    let mut max_end = 0u32;
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

    /// A profile shaped like one a user would build in the editor: addresses
    /// that don't start at zero, mixed data types, a scaled integer, and one
    /// parameter far enough away to need its own request.
    pub fn sample_profile(id: &str, function: FunctionCode) -> MeterProfile {
        MeterProfile {
            id: id.into(),
            brand: "Acme".into(),
            model: "Custom 1".into(),
            description: "Hand-built in the meter editor".into(),
            source: MeterSource::User,
            function,
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
                    function: None,
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
                    function: None,
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
                    function: None,
                    group: MeterPointGroup::Energy,
                    unverified: true,
                    sim_behavior: Some(TagBehavior::Counter { step: 1.0 }),
                    sim_initial: Some(1000.0),
                },
                // Far out of reach of the others: this is the parameter the
                // old single-block model silently dropped.
                MeterPoint {
                    key: "run_hours".into(),
                    label: "Run hours".into(),
                    address: 3000,
                    format: DataFormat {
                        data_type: DataType::Uint32,
                        word_order: WordOrder::Cdab,
                        scale: 1.0,
                        offset: 0.0,
                    },
                    unit: "h".into(),
                    function: None,
                    group: MeterPointGroup::Diagnostics,
                    unverified: true,
                    sim_behavior: Some(TagBehavior::Counter { step: 1.0 }),
                    sim_initial: Some(500.0),
                },
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::sample_profile;
    use super::*;
    use crate::modbus::types::{DataType, FunctionCode};

    fn holding(profile: &MeterProfile) -> Vec<ReadBlock> {
        plan_reads(profile)
    }

    #[test]
    fn config_covers_every_parameter_and_carries_animated_points() {
        let profile = sample_profile("mine", FunctionCode::ReadHoldingRegisters);
        let cfg = profile_to_simulator_config(&profile, 5021, 1000);
        assert_eq!(cfg.slaves.len(), 1);
        let slave = &cfg.slaves[0];
        assert_eq!(slave.unit_id, profile.default_unit_id);
        // The store is indexed from 0 and the furthest parameter is a uint32
        // at 3000, so it has to reach 3002.
        assert!(slave.holding_register_count >= 3002);
        assert_eq!(slave.input_register_count, slave.holding_register_count);
        assert_eq!(slave.tags.len(), 4);
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

    // ---- read planning ----

    /// The whole point of the planner: a parameter a thousand registers away
    /// gets its own request instead of being dropped or forcing an illegal
    /// 2900-register read.
    #[test]
    fn a_far_away_parameter_gets_its_own_request() {
        let profile = sample_profile("mine", FunctionCode::ReadHoldingRegisters);
        let plan = holding(&profile);
        assert_eq!(plan.len(), 2, "expected two requests, got {plan:?}");
        assert_eq!(plan[0].start_address, 100);
        assert_eq!(plan[0].quantity, 6); // 100..106
        assert_eq!(plan[1].start_address, 3000);
        assert_eq!(plan[1].quantity, 2);
        for block in &plan {
            assert!(block.quantity <= block.function.max_quantity());
        }
    }

    /// Neighbours belong together — a separate request per parameter would
    /// turn a 6-register read into three round trips.
    #[test]
    fn near_neighbours_share_one_request() {
        let mut profile = sample_profile("near", FunctionCode::ReadHoldingRegisters);
        profile.points.retain(|p| p.address < 1000);
        let plan = holding(&profile);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].start_address, 100);
        assert_eq!(plan[0].quantity, 6);
    }

    /// The 125-register limit is a hard protocol bound: a run of parameters
    /// wider than that must split even with no gap to split on. Exceeding it
    /// is what returns Illegal Data Value from a real device.
    #[test]
    fn a_run_wider_than_the_function_limit_is_split() {
        let mut profile = sample_profile("wide", FunctionCode::ReadHoldingRegisters);
        profile.points.clear();
        let mut template =
            sample_profile("t", FunctionCode::ReadHoldingRegisters).points[0].clone();
        template.format.data_type = DataType::Uint16;
        // 200 parameters, one per register, contiguous from 0.
        for i in 0..200u16 {
            let mut p = template.clone();
            p.key = format!("p{i}");
            p.label = format!("P{i}");
            p.address = i;
            profile.points.push(p);
        }
        let plan = holding(&profile);
        assert!(plan.len() >= 2, "200 contiguous registers must split");
        for block in &plan {
            assert!(
                block.quantity <= 125,
                "block {block:?} exceeds the FC03 limit"
            );
        }
        // Every parameter is still covered.
        for i in 0..200u16 {
            assert!(
                plan.iter()
                    .any(|b| i >= b.start_address && i < b.start_address + b.quantity),
                "register {i} is not covered by {plan:?}"
            );
        }
    }

    /// A device that keeps some values in input registers and others in
    /// holding registers needs a request per function code.
    #[test]
    fn each_function_code_gets_its_own_requests() {
        let mut profile = sample_profile("mixed", FunctionCode::ReadHoldingRegisters);
        profile.points.retain(|p| p.address < 1000);
        profile.points[1].function = Some(FunctionCode::ReadInputRegisters);
        let plan = holding(&profile);
        assert_eq!(plan.len(), 2, "{plan:?}");
        assert!(plan
            .iter()
            .any(|b| b.function == FunctionCode::ReadInputRegisters));
        assert!(plan
            .iter()
            .any(|b| b.function == FunctionCode::ReadHoldingRegisters));
    }

    #[test]
    fn a_single_parameter_is_a_single_request_of_its_own_span() {
        let mut profile = sample_profile("one", FunctionCode::ReadHoldingRegisters);
        profile.points.truncate(1);
        let plan = holding(&profile);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].start_address, 100);
        assert_eq!(plan[0].quantity, 2); // float32
    }

    #[test]
    fn no_parameters_means_no_requests() {
        let mut profile = sample_profile("empty", FunctionCode::ReadHoldingRegisters);
        profile.points.clear();
        assert!(plan_reads(&profile).is_empty());
    }

    /// Every parameter must be readable from the plan — this is the property
    /// the old model broke.
    #[test]
    fn every_parameter_is_covered_by_some_request() {
        let profile = sample_profile("cover", FunctionCode::ReadHoldingRegisters);
        let plan = plan_reads(&profile);
        for point in &profile.points {
            let span = point.format.data_type.register_span() as u32;
            let function = point_function(&profile, point);
            let covered = plan.iter().any(|b| {
                b.function == function
                    && point.address as u32 >= b.start_address as u32
                    && point.address as u32 + span <= b.start_address as u32 + b.quantity as u32
            });
            assert!(covered, "'{}' at {} uncovered", point.key, point.address);
        }
    }
}
