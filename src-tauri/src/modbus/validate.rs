//! Client-side validation, run before anything touches the wire. Every check
//! here saves a full timeout and gives a better message than the resulting
//! remote exception would. See `docs/reference/function-codes.md`.

use super::types::{PollConfig, RtuConfig, SimulatorConfig, TcpConfig};
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

    let max = config.function.max_quantity();
    if config.quantity == 0 || config.quantity > max {
        return Err(AppError::InvalidConfig(format!(
            "{:?} allows 1-{max} registers per request, got {}",
            config.function, config.quantity
        )));
    }

    if (config.start_address as u32) + (config.quantity as u32) > 0x1_0000 {
        return Err(AppError::InvalidConfig(
            "start address + quantity exceeds the 16-bit address space".to_string(),
        ));
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
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modbus::types::{DataFormat, FunctionCode};

    fn base_config() -> PollConfig {
        PollConfig {
            unit_id: 1,
            function: FunctionCode::ReadHoldingRegisters,
            start_address: 100,
            quantity: 10,
            interval_ms: 1000,
            format: DataFormat::default(),
        }
    }

    #[test]
    fn rejects_fc03_over_125_registers() {
        let mut cfg = base_config();
        cfg.quantity = 126;
        assert!(validate_poll_config(&cfg).is_err());
    }

    #[test]
    fn accepts_fc03_at_125_registers() {
        let mut cfg = base_config();
        cfg.quantity = 125;
        assert!(validate_poll_config(&cfg).is_ok());
    }

    #[test]
    fn rejects_zero_quantity() {
        let mut cfg = base_config();
        cfg.quantity = 0;
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
        cfg.start_address = 65530;
        cfg.quantity = 10;
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
            slaves: vec![SlaveSimConfig {
                unit_id: 1,
                coil_count: 8,
                discrete_count: 8,
                input_register_count: 0,
                holding_register_count: 50,
            }],
        }
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
}
