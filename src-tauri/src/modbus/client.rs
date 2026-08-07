//! Transport-agnostic Modbus client. Owns the live `tokio-modbus` `Context`
//! and translates its nested `Result<Result<T, ExceptionCode>, Error>` into
//! the three outcomes the poll loop cares about: a value, a protocol
//! exception (device is alive, keep polling), or a dead transport (fatal,
//! stop the task). See `docs/03-architecture.md#threading-model`.

use std::time::Duration;

use tokio::time::timeout;
use tokio_modbus::client::tcp;
use tokio_modbus::client::{Context, Reader};
use tokio_modbus::slave::{Slave, SlaveContext};
use tokio_modbus::ExceptionCode;

use super::types::{FunctionCode, TcpConfig, WireAddress};
use crate::error::{exception_name_and_hint, AppError};

/// Outcome of a single read. Distinguishes "device answered with an error"
/// (not fatal — keep polling) from "the transport is dead" (fatal — the poll
/// task must stop).
pub enum ReadError {
    Exception {
        code: u8,
        name: String,
        hint: String,
    },
    Timeout,
    Transport(String),
}

fn exception_code_to_u8(code: ExceptionCode) -> u8 {
    u8::from(code)
}

pub struct ModbusClient {
    ctx: Context,
    timeout: Duration,
}

impl ModbusClient {
    pub async fn connect_tcp(config: &TcpConfig) -> Result<Self, AppError> {
        let addr_str = format!("{}:{}", config.host, config.port);
        let socket_addr = tokio::net::lookup_host(&addr_str)
            .await
            .map_err(|e| AppError::TcpConnect {
                host: config.host.clone(),
                port: config.port,
                reason: e.to_string(),
            })?
            .next()
            .ok_or_else(|| AppError::TcpConnect {
                host: config.host.clone(),
                port: config.port,
                reason: "couldn't resolve host".to_string(),
            })?;

        let connect_timeout = Duration::from_millis(config.timeout_ms);
        let ctx = timeout(
            connect_timeout,
            tcp::connect_slave(socket_addr, Slave(config.unit_id)),
        )
        .await
        .map_err(|_| AppError::TcpConnect {
            host: config.host.clone(),
            port: config.port,
            reason: "connection timed out".to_string(),
        })?
        .map_err(|e| AppError::TcpConnect {
            host: config.host.clone(),
            port: config.port,
            reason: e.to_string(),
        })?;

        Ok(Self {
            ctx,
            timeout: connect_timeout,
        })
    }

    pub fn set_unit_id(&mut self, unit_id: u8) {
        self.ctx.set_slave(Slave(unit_id));
    }

    /// Reads `quantity` registers of the given function starting at `start`,
    /// against `unit_id` (applied before the call, so unit ID changes take
    /// effect with no reconnect).
    pub async fn read_registers(
        &mut self,
        function: FunctionCode,
        start: WireAddress,
        quantity: u16,
        unit_id: u8,
    ) -> Result<Vec<u16>, ReadError> {
        self.set_unit_id(unit_id);

        let call = async {
            match function {
                FunctionCode::ReadHoldingRegisters => {
                    self.ctx.read_holding_registers(start, quantity).await
                }
                FunctionCode::ReadInputRegisters => {
                    self.ctx.read_input_registers(start, quantity).await
                }
                _ => Err(tokio_modbus::Error::Transport(std::io::Error::other(
                    "unsupported read function",
                ))),
            }
        };

        match timeout(self.timeout, call).await {
            Err(_) => Err(ReadError::Timeout),
            Ok(Err(tokio_modbus::Error::Transport(e))) => Err(ReadError::Transport(e.to_string())),
            Ok(Err(tokio_modbus::Error::Protocol(e))) => Err(ReadError::Transport(e.to_string())),
            Ok(Ok(Err(exception))) => {
                let code = exception_code_to_u8(exception);
                let (name, hint) = exception_name_and_hint(code, function as u8, start, unit_id);
                Err(ReadError::Exception { code, name, hint })
            }
            Ok(Ok(Ok(values))) => Ok(values),
        }
    }

    pub async fn disconnect(mut self) {
        use tokio_modbus::client::Client;
        let _ = self.ctx.disconnect().await;
    }
}
