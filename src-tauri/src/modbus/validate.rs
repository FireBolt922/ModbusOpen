//! Client-side validation, run before anything touches the wire. Every check
//! here saves a full timeout and gives a better message than the resulting
//! remote exception would. See `docs/reference/function-codes.md`.

use super::types::{PollConfig, TcpConfig};
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
}
