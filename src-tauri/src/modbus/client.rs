//! Transport-agnostic Modbus client. Owns the live `tokio-modbus` `Context`
//! and translates its nested `Result<Result<T, ExceptionCode>, Error>` into
//! the three outcomes the poll loop cares about: a value, a protocol
//! exception (device is alive, keep polling), or a dead transport (fatal,
//! stop the task). See `docs/03-architecture.md#threading-model`.

use std::time::Duration;

use tokio::time::{sleep, timeout};
use tokio_modbus::client::rtu;
use tokio_modbus::client::tcp;
use tokio_modbus::client::{Context, Reader, Writer};
use tokio_modbus::slave::{Slave, SlaveContext};
use tokio_modbus::ExceptionCode;
use tokio_serial::{DataBits, FlowControl, Parity as SerialParity, SerialPortBuilderExt, StopBits};

use super::types::{FunctionCode, Parity, RtuConfig, TcpConfig, Transport, WireAddress};
use crate::error::{
    exception_name_and_hint, humanize_serial_error, map_serial_open_error, AppError,
};

/// Outcome of a single read/write. Distinguishes "device answered with an
/// error" (not fatal — keep polling) from "the transport is dead" (fatal —
/// stop the task).
#[derive(Debug)]
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

/// 3.5 character times at 11 bits/char, clamped per the RTU spec above 19200.
/// See `docs/reference/serial-timing.md`.
pub fn auto_inter_frame_delay_us(baud_rate: u32) -> u32 {
    if baud_rate == 0 {
        return 1750;
    }
    if baud_rate > 19_200 {
        return 1750;
    }
    let char_time_us = 11.0 * 1_000_000.0 / f64::from(baud_rate);
    (3.5 * char_time_us).ceil() as u32
}

fn map_data_bits(n: u8) -> Result<DataBits, AppError> {
    match n {
        5 => Ok(DataBits::Five),
        6 => Ok(DataBits::Six),
        7 => Ok(DataBits::Seven),
        8 => Ok(DataBits::Eight),
        _ => Err(AppError::InvalidConfig(format!(
            "data bits must be 5–8, got {n}"
        ))),
    }
}

fn map_parity(p: Parity) -> SerialParity {
    match p {
        Parity::None => SerialParity::None,
        Parity::Even => SerialParity::Even,
        Parity::Odd => SerialParity::Odd,
    }
}

fn map_stop_bits(n: u8) -> Result<StopBits, AppError> {
    match n {
        1 => Ok(StopBits::One),
        2 => Ok(StopBits::Two),
        _ => Err(AppError::InvalidConfig(format!(
            "stop bits must be 1 or 2, got {n}"
        ))),
    }
}

pub struct ModbusClient {
    ctx: Context,
    timeout: Duration,
    /// Silence before the next frame (RTU). Zero for TCP.
    inter_frame_delay: Duration,
    first_frame: bool,
    pub transport: Transport,
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
            inter_frame_delay: Duration::ZERO,
            first_frame: true,
            transport: Transport::Tcp,
        })
    }

    pub async fn connect_rtu(config: &RtuConfig) -> Result<Self, AppError> {
        let data_bits = map_data_bits(config.data_bits)?;
        let stop_bits = map_stop_bits(config.stop_bits)?;
        let delay_us = config
            .inter_frame_delay_us
            .unwrap_or_else(|| auto_inter_frame_delay_us(config.baud_rate));

        // Must open on the Tokio runtime — SerialStream wraps AsyncFd.
        let builder = tokio_serial::new(&config.port, config.baud_rate)
            .data_bits(data_bits)
            .parity(map_parity(config.parity))
            .stop_bits(stop_bits)
            .flow_control(FlowControl::None)
            .timeout(Duration::from_millis(config.timeout_ms));

        let stream = builder
            .open_native_async()
            .map_err(|e| map_serial_open_error(&config.port, e))?;

        let ctx = rtu::attach_slave(stream, Slave(config.unit_id));

        Ok(Self {
            ctx,
            timeout: Duration::from_millis(config.timeout_ms),
            inter_frame_delay: Duration::from_micros(u64::from(delay_us)),
            first_frame: true,
            transport: Transport::Rtu,
        })
    }

    pub fn set_unit_id(&mut self, unit_id: u8) {
        self.ctx.set_slave(Slave(unit_id));
    }

    async fn maybe_inter_frame_delay(&mut self) {
        if self.inter_frame_delay.is_zero() {
            return;
        }
        if self.first_frame {
            self.first_frame = false;
            return;
        }
        sleep(self.inter_frame_delay).await;
    }

    fn map_modbus_result<T>(
        result: Result<Result<T, ExceptionCode>, tokio_modbus::Error>,
        function: FunctionCode,
        start: WireAddress,
        unit_id: u8,
    ) -> Result<T, ReadError> {
        match result {
            Err(tokio_modbus::Error::Transport(e)) => {
                Err(ReadError::Transport(humanize_serial_error(&e.to_string())))
            }
            Err(tokio_modbus::Error::Protocol(e)) => {
                Err(ReadError::Transport(humanize_serial_error(&e.to_string())))
            }
            Ok(Err(exception)) => {
                let code = exception_code_to_u8(exception);
                let (name, hint) = exception_name_and_hint(code, function as u8, start, unit_id);
                Err(ReadError::Exception { code, name, hint })
            }
            Ok(Ok(values)) => Ok(values),
        }
    }

    /// Reads holding/input registers (FC03/FC04).
    pub async fn read_registers(
        &mut self,
        function: FunctionCode,
        start: WireAddress,
        quantity: u16,
        unit_id: u8,
    ) -> Result<Vec<u16>, ReadError> {
        self.set_unit_id(unit_id);
        self.maybe_inter_frame_delay().await;

        let call = async {
            match function {
                FunctionCode::ReadHoldingRegisters => {
                    self.ctx.read_holding_registers(start, quantity).await
                }
                FunctionCode::ReadInputRegisters => {
                    self.ctx.read_input_registers(start, quantity).await
                }
                _ => Err(tokio_modbus::Error::Transport(std::io::Error::other(
                    "not a register-read function",
                ))),
            }
        };

        match timeout(self.timeout, call).await {
            Err(_) => Err(ReadError::Timeout),
            Ok(result) => Self::map_modbus_result(result, function, start, unit_id),
        }
    }

    /// Reads coils / discrete inputs (FC01/FC02). Bits packed LSB-first in
    /// the response — already unpacked by tokio-modbus into `Vec<bool>`.
    pub async fn read_bits(
        &mut self,
        function: FunctionCode,
        start: WireAddress,
        quantity: u16,
        unit_id: u8,
    ) -> Result<Vec<bool>, ReadError> {
        self.set_unit_id(unit_id);
        self.maybe_inter_frame_delay().await;

        let call = async {
            match function {
                FunctionCode::ReadCoils => self.ctx.read_coils(start, quantity).await,
                FunctionCode::ReadDiscreteInputs => {
                    self.ctx.read_discrete_inputs(start, quantity).await
                }
                _ => Err(tokio_modbus::Error::Transport(std::io::Error::other(
                    "not a bit-read function",
                ))),
            }
        };

        match timeout(self.timeout, call).await {
            Err(_) => Err(ReadError::Timeout),
            Ok(result) => Self::map_modbus_result(result, function, start, unit_id),
        }
    }

    pub async fn write_single_coil(
        &mut self,
        address: WireAddress,
        value: bool,
        unit_id: u8,
    ) -> Result<(), ReadError> {
        self.set_unit_id(unit_id);
        self.maybe_inter_frame_delay().await;
        let call = self.ctx.write_single_coil(address, value);
        match timeout(self.timeout, call).await {
            Err(_) => Err(ReadError::Timeout),
            Ok(result) => {
                Self::map_modbus_result(result, FunctionCode::WriteSingleCoil, address, unit_id)
            }
        }
    }

    pub async fn write_single_register(
        &mut self,
        address: WireAddress,
        value: u16,
        unit_id: u8,
    ) -> Result<(), ReadError> {
        self.set_unit_id(unit_id);
        self.maybe_inter_frame_delay().await;
        let call = self.ctx.write_single_register(address, value);
        match timeout(self.timeout, call).await {
            Err(_) => Err(ReadError::Timeout),
            Ok(result) => {
                Self::map_modbus_result(result, FunctionCode::WriteSingleRegister, address, unit_id)
            }
        }
    }

    pub async fn write_multiple_coils(
        &mut self,
        address: WireAddress,
        values: &[bool],
        unit_id: u8,
    ) -> Result<(), ReadError> {
        self.set_unit_id(unit_id);
        self.maybe_inter_frame_delay().await;
        let call = self.ctx.write_multiple_coils(address, values);
        match timeout(self.timeout, call).await {
            Err(_) => Err(ReadError::Timeout),
            Ok(result) => {
                Self::map_modbus_result(result, FunctionCode::WriteMultipleCoils, address, unit_id)
            }
        }
    }

    pub async fn write_multiple_registers(
        &mut self,
        address: WireAddress,
        values: &[u16],
        unit_id: u8,
    ) -> Result<(), ReadError> {
        self.set_unit_id(unit_id);
        self.maybe_inter_frame_delay().await;
        let call = self.ctx.write_multiple_registers(address, values);
        match timeout(self.timeout, call).await {
            Err(_) => Err(ReadError::Timeout),
            Ok(result) => Self::map_modbus_result(
                result,
                FunctionCode::WriteMultipleRegisters,
                address,
                unit_id,
            ),
        }
    }

    pub async fn disconnect(mut self) {
        use tokio_modbus::client::Client;
        let _ = self.ctx.disconnect().await;
    }
}

#[cfg(test)]
mod smoke {
    use super::*;
    use crate::modbus::codec::decode_block;
    use crate::modbus::types::{DataFormat, DataType, TypedValue, WordOrder};

    /// Live smoke against `testrig/slave.py` on :5020. Skips quietly if the
    /// slave isn't running so `cargo test` stays green offline.
    #[tokio::test]
    async fn tcp_read_float32_cdab_against_local_slave() {
        let config = TcpConfig {
            host: "127.0.0.1".into(),
            port: 5020,
            unit_id: 1,
            timeout_ms: 1000,
            retries: 1,
        };
        let mut client = match ModbusClient::connect_tcp(&config).await {
            Ok(c) => c,
            Err(_) => {
                eprintln!("skipping: no slave on 127.0.0.1:5020");
                return;
            }
        };

        let regs = client
            .read_registers(FunctionCode::ReadHoldingRegisters, 100, 8, 1)
            .await
            .expect("read unit 1");
        let format = DataFormat {
            data_type: DataType::Float32,
            word_order: WordOrder::Cdab,
            scale: 1.0,
            offset: 0.0,
        };
        let rows = decode_block(&regs, 100, &format);
        assert_eq!(rows.len(), 4);
        match &rows[0].value {
            TypedValue::Float(v) => assert!((v - 231.0).abs() < 0.01, "voltage={v}"),
            other => panic!("expected float, got {other:?}"),
        }
        match &rows[3].value {
            TypedValue::Float(v) => assert!((v - 0.975).abs() < 0.001, "pf={v}"),
            other => panic!("expected float, got {other:?}"),
        }

        // Unit 2: every register is 7 — proves mid-session unit-ID switch.
        let regs2 = client
            .read_registers(FunctionCode::ReadHoldingRegisters, 0, 4, 2)
            .await
            .expect("read unit 2");
        assert_eq!(regs2, vec![7, 7, 7, 7]);

        client.disconnect().await;
    }

    #[test]
    fn inter_frame_delay_matches_serial_timing_doc() {
        // 9600 → 3.5 × 11/9600 s ≈ 4.01 ms
        assert_eq!(auto_inter_frame_delay_us(9600), 4011);
        // 19200 → ≈ 2.01 ms
        assert_eq!(auto_inter_frame_delay_us(19200), 2006);
        // Above 19200 the spec fixes t3.5 at 1.75 ms
        assert_eq!(auto_inter_frame_delay_us(38400), 1750);
        assert_eq!(auto_inter_frame_delay_us(115_200), 1750);
    }
}
