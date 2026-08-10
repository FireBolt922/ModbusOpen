//! Client-side validation, run before anything touches the wire. Every check
//! here saves a full timeout and gives a better message than the resulting
//! remote exception would. See `docs/reference/function-codes.md`.

use super::types::{MeterProfile, PollConfig, RtuConfig, SimulatorConfig, TagBehavior, TcpConfig};
use crate::error::AppError;

pub fn validate_tcp_config(config: &TcpConfig) -> Result<(), AppError> {
    if config.host.trim().is_empty() {
        return Err(AppError::InvalidConfig("host can't be empty".to_string()));
    }
    validate_unit_id(config.unit_id)?;
    if config.timeout_ms == 0 {
        return Err(AppError::InvalidConfig(
            "timeout must be greater than 0 ms".to_string(),
        ));
    }
    Ok(())
}

pub fn validate_rtu_config(config: &RtuConfig) -> Result<(), AppError> {
    if config.port.trim().is_empty() {
        return Err(AppError::InvalidConfig(
            "serial port can't be empty — pick a port from the list".to_string(),
        ));
    }
    validate_unit_id(config.unit_id)?;
    if config.timeout_ms == 0 {
        return Err(AppError::InvalidConfig(
            "timeout must be greater than 0 ms".to_string(),
        ));
    }
    // RTU requires 8 data bits (ASCII mode uses 7; we don't support ASCII).
    if config.data_bits != 8 {
        return Err(AppError::InvalidConfig(format!(
            "Modbus RTU requires 8 data bits, got {}",
            config.data_bits
        )));
    }
    if config.stop_bits != 1 && config.stop_bits != 2 {
        return Err(AppError::InvalidConfig(format!(
            "stop bits must be 1 or 2, got {}",
            config.stop_bits
        )));
    }
    if config.baud_rate == 0 {
        return Err(AppError::InvalidConfig(
            "baud rate must be greater than 0".to_string(),
        ));
    }
    Ok(())
}

pub fn validate_unit_id(unit_id: u8) -> Result<(), AppError> {
    if !(1..=247).contains(&unit_id) {
        return Err(AppError::InvalidConfig(format!(
            "unit ID {unit_id} out of range — must be 1-247"
        )));
    }
    Ok(())
}

pub fn validate_poll_config(config: &PollConfig) -> Result<(), AppError> {
    validate_unit_id(config.unit_id)?;

    if config.blocks.is_empty() {
        return Err(AppError::InvalidConfig(
            "a poll needs at least one read request".to_string(),
        ));
    }

    for block in &config.blocks {
        let max = block.function.max_quantity();
        if block.quantity == 0 || block.quantity > max {
            return Err(AppError::InvalidConfig(format!(
                "{:?} allows 1-{max} registers per request, got {}",
                block.function, block.quantity
            )));
        }

        if (block.start_address as u32) + (block.quantity as u32) > 0x1_0000 {
            return Err(AppError::InvalidConfig(
                "start address + quantity exceeds the 16-bit address space".to_string(),
            ));
        }
    }

    if config.interval_ms == 0 {
        return Err(AppError::InvalidConfig(
            "poll interval must be greater than 0 ms".to_string(),
        ));
    }

    Ok(())
}

pub fn validate_simulator_config(config: &SimulatorConfig) -> Result<(), AppError> {
    if config.tcp_port == 0 {
        return Err(AppError::InvalidConfig(
            "TCP port must be between 1-65535".to_string(),
        ));
    }
    if config.slaves.is_empty() {
        return Err(AppError::InvalidConfig(
            "add at least one slave ID".to_string(),
        ));
    }

    let mut seen = std::collections::HashSet::new();
    for slave in &config.slaves {
        validate_unit_id(slave.unit_id)?;
        if !seen.insert(slave.unit_id) {
            return Err(AppError::InvalidConfig(format!(
                "unit ID {} is used by more than one slave",
                slave.unit_id
            )));
        }
        if slave.coil_count == 0
            && slave.discrete_count == 0
            && slave.input_register_count == 0
            && slave.holding_register_count == 0
        {
            return Err(AppError::InvalidConfig(format!(
                "slave {} has no registers or coils — give it at least one block",
                slave.unit_id
            )));
        }

        for tag in &slave.tags {
            if tag.format.data_type == crate::modbus::types::DataType::String {
                return Err(AppError::InvalidConfig(format!(
                    "tag '{}': string tags can't be animated",
                    tag.name
                )));
            }
            if !crate::modbus::animate::tag_fits(
                tag.address,
                tag.format.data_type,
                slave.holding_register_count,
            ) {
                return Err(AppError::InvalidConfig(format!(
                    "tag '{}' at address {} doesn't fit in slave {}'s {}-register holding block",
                    tag.name, tag.address, slave.unit_id, slave.holding_register_count
                )));
            }
            match tag.behavior {
                TagBehavior::Random { min, max } | TagBehavior::Ramp { min, max, .. } => {
                    if min >= max {
                        return Err(AppError::InvalidConfig(format!(
                            "tag '{}': min must be less than max",
                            tag.name
                        )));
                    }
                }
                TagBehavior::Sine { min, max, period_s } => {
                    if min >= max {
                        return Err(AppError::InvalidConfig(format!(
                            "tag '{}': min must be less than max",
                            tag.name
                        )));
                    }
                    if period_s <= 0.0 {
                        return Err(AppError::InvalidConfig(format!(
                            "tag '{}': period must be greater than 0 seconds",
                            tag.name
                        )));
                    }
                }
                TagBehavior::Static | TagBehavior::Counter { .. } => {}
            }
        }
    }

    if config.slaves.iter().any(|s| !s.tags.is_empty()) && config.tick_ms == 0 {
        return Err(AppError::InvalidConfig(
            "animation tick interval must be greater than 0 ms".to_string(),
        ));
    }

    Ok(())
}

pub fn validate_meter_profile(profile: &MeterProfile) -> Result<(), AppError> {
    if profile.id.trim().is_empty() {
        return Err(AppError::InvalidConfig(
            "meter profile id can't be empty".to_string(),
        ));
    }
    // The id becomes a filename under the meter library folder, and an imported
    // pack controls it entirely. Restrict it to a slug so a shared file can't
    // escape the folder (`../../…`) or collide with a device path.
    if !profile
        .id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::InvalidConfig(format!(
            "meter id '{}' must use only letters, digits, '-' and '_' (e.g. 'my-meter')",
            profile.id
        )));
    }
    if profile.brand.trim().is_empty() {
        return Err(AppError::InvalidConfig(
            "meter brand can't be empty".to_string(),
        ));
    }
    if profile.model.trim().is_empty() {
        return Err(AppError::InvalidConfig(
            "meter model can't be empty".to_string(),
        ));
    }
    validate_unit_id(profile.default_unit_id)?;

    if profile.points.is_empty() {
        return Err(AppError::InvalidConfig(
            "meter profile must have at least one parameter".to_string(),
        ));
    }

    // Which parameter owns each register, so two of them can't decode from
    // partly the same bytes. A 2-register value typed at 6, 7 and 8 reads as
    // plausible garbage rather than an error, which is far worse than a
    // rejected profile.
    let mut owner: std::collections::HashMap<(u8, u32), &str> = std::collections::HashMap::new();
    let mut keys = std::collections::HashSet::new();
    for point in &profile.points {
        if point.key.trim().is_empty() {
            return Err(AppError::InvalidConfig(
                "parameter key can't be empty".to_string(),
            ));
        }
        if !keys.insert(point.key.clone()) {
            return Err(AppError::InvalidConfig(format!(
                "duplicate parameter key '{}'",
                point.key
            )));
        }
        if point.label.trim().is_empty() {
            return Err(AppError::InvalidConfig(format!(
                "parameter '{}' needs a label",
                point.key
            )));
        }
        let span = point.format.data_type.register_span();
        if span == 0 {
            return Err(AppError::InvalidConfig(format!(
                "parameter '{}': string data type isn't supported in meter profiles",
                point.key
            )));
        }
        let function = point.function.unwrap_or(profile.function);
        let max = function.max_quantity();
        if span as u16 > max {
            return Err(AppError::InvalidConfig(format!(
                "parameter '{}' needs {span} registers but {function:?} allows only {max} per request",
                point.key
            )));
        }
        let point_end = point.address as u32 + span as u32;
        if point_end > 0x1_0000 {
            return Err(AppError::InvalidConfig(format!(
                "parameter '{}' at address {} (span {span}) runs past the end of the 16-bit address space",
                point.key, point.address
            )));
        }
        let fc = function as u8;
        for reg in point.address as u32..point_end {
            if let Some(prev) = owner.insert((fc, reg), &point.key) {
                return Err(AppError::InvalidConfig(format!(
                    "parameters '{}' and '{}' both cover register {reg} — check their addresses and data types",
                    prev, point.key
                )));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modbus::types::ReadBlock;
    use crate::modbus::types::{DataFormat, FunctionCode};

    fn base_config() -> PollConfig {
        PollConfig {
            unit_id: 1,
            blocks: vec![ReadBlock {
                function: FunctionCode::ReadHoldingRegisters,
                start_address: 100,
                quantity: 10,
            }],
            interval_ms: 1000,
            format: DataFormat::default(),
        }
    }

    #[test]
    fn rejects_fc03_over_125_registers() {
        let mut cfg = base_config();
        cfg.blocks[0].quantity = 126;
        assert!(validate_poll_config(&cfg).is_err());
    }

    #[test]
    fn accepts_fc03_at_125_registers() {
        let mut cfg = base_config();
        cfg.blocks[0].quantity = 125;
        assert!(validate_poll_config(&cfg).is_ok());
    }

    #[test]
    fn rejects_zero_quantity() {
        let mut cfg = base_config();
        cfg.blocks[0].quantity = 0;
        assert!(validate_poll_config(&cfg).is_err());
    }

    #[test]
    fn rejects_unit_id_out_of_range() {
        assert!(validate_unit_id(0).is_err());
        assert!(validate_unit_id(248).is_err());
        assert!(validate_unit_id(1).is_ok());
        assert!(validate_unit_id(247).is_ok());
    }

    #[test]
    fn rejects_address_space_wraparound() {
        let mut cfg = base_config();
        cfg.blocks[0].start_address = 65530;
        cfg.blocks[0].quantity = 10;
        assert!(validate_poll_config(&cfg).is_err());
    }

    #[test]
    fn rtu_rejects_empty_port_and_non_eight_data_bits() {
        use crate::modbus::types::Parity;
        let mut cfg = RtuConfig {
            port: String::new(),
            baud_rate: 9600,
            data_bits: 8,
            parity: Parity::None,
            stop_bits: 1,
            unit_id: 1,
            timeout_ms: 1000,
            retries: 1,
            inter_frame_delay_us: None,
        };
        assert!(validate_rtu_config(&cfg).is_err());
        cfg.port = "/dev/ttyUSB0".into();
        cfg.data_bits = 7;
        assert!(validate_rtu_config(&cfg).is_err());
        cfg.data_bits = 8;
        assert!(validate_rtu_config(&cfg).is_ok());
    }

    fn base_simulator_config() -> SimulatorConfig {
        use crate::modbus::types::SlaveSimConfig;
        SimulatorConfig {
            tcp_port: 5021,
            tick_ms: 1000,
            slaves: vec![SlaveSimConfig {
                unit_id: 1,
                coil_count: 8,
                discrete_count: 8,
                input_register_count: 0,
                holding_register_count: 50,
                tags: Vec::new(),
            }],
        }
    }

    fn base_tag(behavior: TagBehavior) -> crate::modbus::types::TagConfig {
        use crate::modbus::types::{DataFormat, DataType, WordOrder};
        crate::modbus::types::TagConfig {
            name: "test".into(),
            address: 0,
            format: DataFormat {
                data_type: DataType::Uint16,
                word_order: WordOrder::Cdab,
                scale: 1.0,
                offset: 0.0,
            },
            behavior,
            initial_value: 0.0,
        }
    }

    #[test]
    fn accepts_a_well_formed_tag() {
        let mut cfg = base_simulator_config();
        cfg.slaves[0]
            .tags
            .push(base_tag(TagBehavior::Counter { step: 1.0 }));
        assert!(validate_simulator_config(&cfg).is_ok());
    }

    #[test]
    fn rejects_a_tag_whose_span_overruns_the_holding_block() {
        let mut cfg = base_simulator_config();
        cfg.slaves[0].holding_register_count = 1;
        let mut tag = base_tag(TagBehavior::Static);
        tag.format.data_type = crate::modbus::types::DataType::Float32; // needs 2 regs
        cfg.slaves[0].tags.push(tag);
        assert!(validate_simulator_config(&cfg).is_err());
    }

    #[test]
    fn rejects_random_with_min_not_less_than_max() {
        let mut cfg = base_simulator_config();
        cfg.slaves[0].tags.push(base_tag(TagBehavior::Random {
            min: 10.0,
            max: 10.0,
        }));
        assert!(validate_simulator_config(&cfg).is_err());
    }

    #[test]
    fn rejects_sine_with_zero_period() {
        let mut cfg = base_simulator_config();
        cfg.slaves[0].tags.push(base_tag(TagBehavior::Sine {
            min: 0.0,
            max: 10.0,
            period_s: 0.0,
        }));
        assert!(validate_simulator_config(&cfg).is_err());
    }

    #[test]
    fn rejects_zero_tick_ms_when_tags_are_present() {
        let mut cfg = base_simulator_config();
        cfg.slaves[0]
            .tags
            .push(base_tag(TagBehavior::Counter { step: 1.0 }));
        cfg.tick_ms = 0;
        assert!(validate_simulator_config(&cfg).is_err());
    }

    #[test]
    fn accepts_a_single_well_formed_slave() {
        assert!(validate_simulator_config(&base_simulator_config()).is_ok());
    }

    #[test]
    fn rejects_no_slaves() {
        let mut cfg = base_simulator_config();
        cfg.slaves.clear();
        assert!(validate_simulator_config(&cfg).is_err());
    }

    #[test]
    fn rejects_duplicate_unit_ids() {
        let mut cfg = base_simulator_config();
        cfg.slaves.push(cfg.slaves[0].clone());
        assert!(validate_simulator_config(&cfg).is_err());
    }

    #[test]
    fn rejects_a_slave_with_no_blocks() {
        let mut cfg = base_simulator_config();
        cfg.slaves[0].coil_count = 0;
        cfg.slaves[0].discrete_count = 0;
        cfg.slaves[0].holding_register_count = 0;
        assert!(validate_simulator_config(&cfg).is_err());
    }

    #[test]
    fn rejects_zero_tcp_port() {
        let mut cfg = base_simulator_config();
        cfg.tcp_port = 0;
        assert!(validate_simulator_config(&cfg).is_err());
    }

    fn base_meter() -> MeterProfile {
        use crate::modbus::types::{
            DataFormat, DataType, MeterPoint, MeterPointGroup, MeterSource, WordOrder,
        };
        MeterProfile {
            id: "test-meter".into(),
            brand: "Test".into(),
            model: "T1".into(),
            description: String::new(),
            source: MeterSource::User,
            function: FunctionCode::ReadHoldingRegisters,
            default_unit_id: 1,
            suggested_rtu: None,
            points: vec![MeterPoint {
                key: "active_power".into(),
                label: "Active Power".into(),
                address: 100,
                format: DataFormat {
                    data_type: DataType::Float32,
                    word_order: WordOrder::Cdab,
                    scale: 1.0,
                    offset: 0.0,
                },
                unit: "kW".into(),
                function: None,
                group: MeterPointGroup::Instantaneous,
                unverified: false,
                sim_behavior: None,
                sim_initial: None,
            }],
        }
    }

    #[test]
    fn accepts_a_well_formed_meter_profile() {
        assert!(validate_meter_profile(&base_meter()).is_ok());
    }

    /// A parameter far from the others is legal now — the read planner gives
    /// it its own request. This is exactly the case the old block model
    /// rejected, and the reason the editor no longer asks for a block.
    #[test]
    fn accepts_a_parameter_far_from_the_others() {
        let mut p = base_meter();
        let mut far = p.points[0].clone();
        far.key = "run_hours".into();
        far.label = "Run hours".into();
        far.address = 40_000;
        p.points.push(far);
        assert!(validate_meter_profile(&p).is_ok());
    }

    /// Two parameters must not decode from the same bytes. A 2-register value
    /// at 100 and another at 101 read as plausible garbage, not an error.
    #[test]
    fn rejects_parameters_that_share_a_register() {
        let mut p = base_meter();
        let mut overlapping = p.points[0].clone();
        overlapping.key = "other".into();
        overlapping.label = "Other".into();
        overlapping.address = p.points[0].address + 1; // float32 spans 2
        p.points.push(overlapping);
        assert!(validate_meter_profile(&p).is_err());
    }

    /// The same address behind a different function code is a different
    /// register, so it must not be reported as a collision.
    #[test]
    fn allows_the_same_address_on_a_different_function_code() {
        let mut p = base_meter();
        let mut other = p.points[0].clone();
        other.key = "same_address_input".into();
        other.label = "Input side".into();
        other.function = Some(FunctionCode::ReadInputRegisters);
        p.points.push(other);
        assert!(validate_meter_profile(&p).is_ok());
    }

    /// The id becomes a filename, and an imported `.mbmeter.json` controls it.
    /// A shared file must not be able to write outside the meter library.
    #[test]
    fn rejects_ids_that_could_escape_the_library_folder() {
        for bad in [
            "../../../../tmp/pwned",
            "..",
            "a/b",
            "a\\b",
            "meter.json",
            "with space",
            "trailing.",
        ] {
            let mut p = base_meter();
            p.id = bad.to_string();
            assert!(
                validate_meter_profile(&p).is_err(),
                "id {bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn accepts_ordinary_slug_ids() {
        for good in ["my-meter", "schneider-pm-5320", "meter_2", "abc123"] {
            let mut p = base_meter();
            p.id = good.to_string();
            assert!(
                validate_meter_profile(&p).is_ok(),
                "id {good:?} should be accepted"
            );
        }
    }

    #[test]
    fn rejects_a_parameter_running_past_the_end_of_the_address_space() {
        let mut p = base_meter();
        p.points[0].address = 65_535; // float32 needs two registers
        assert!(validate_meter_profile(&p).is_err());
    }

    #[test]
    fn rejects_duplicate_point_keys() {
        let mut p = base_meter();
        p.points.push(p.points[0].clone());
        assert!(validate_meter_profile(&p).is_err());
    }
}
