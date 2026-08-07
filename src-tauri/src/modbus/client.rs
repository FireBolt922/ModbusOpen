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
    /// Mirrors tokio-modbus's own TCP transaction-id counter (starts at 0,
    /// wraps, increments once per request regardless of outcome) so the
    /// frame log can show the real on-wire transaction id instead of a
    /// fabricated one. Meaningless for RTU (no MBAP header) but harmless.
    next_tid: u16,
    last_tid: u16,
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
            next_tid: 0,
            last_tid: 0,
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
            next_tid: 0,
            last_tid: 0,
        })
    }

    pub fn set_unit_id(&mut self, unit_id: u8) {
        self.ctx.set_slave(Slave(unit_id));
    }

    /// The TCP transaction id used by the request just issued — call right
    /// after a read/write method returns. Matches tokio-modbus's own counter
    /// exactly (see `client.rs` doc comment on `next_tid`); meaningless for RTU.
    pub fn last_tid(&self) -> u16 {
        self.last_tid
    }

    /// Allocate the next transaction id, mirroring tokio-modbus's generator:
    /// one id per request issued, regardless of success/failure/timeout.
    fn alloc_tid(&mut self) {
        self.last_tid = self.next_tid;
        self.next_tid = self.next_tid.wrapping_add(1);
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
        self.alloc_tid();

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
        self.alloc_tid();

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
        self.alloc_tid();
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
        self.alloc_tid();
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
        self.alloc_tid();
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
        self.alloc_tid();
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

    /// Nothing listens on this port — connect must fail fast with a clear
    /// error, not hang. Doesn't need the test rig running.
    #[tokio::test]
    async fn connection_refused_returns_a_clear_error_quickly() {
        let config = TcpConfig {
            host: "127.0.0.1".into(),
            port: 19_999,
            unit_id: 1,
            timeout_ms: 2000,
            retries: 1,
        };
        let started = std::time::Instant::now();
        let result = ModbusClient::connect_tcp(&config).await;
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "connection-refused should fail well under the configured timeout, took {:?}",
            started.elapsed()
        );
        match result {
            Err(AppError::TcpConnect { host, port, .. }) => {
                assert_eq!(host, "127.0.0.1");
                assert_eq!(port, 19_999);
            }
            Ok(_) => panic!("expected connection-refused to fail, got Ok"),
            Err(other) => panic!("expected AppError::TcpConnect, got {other:?}"),
        }
    }

    /// 10.255.255.1 is a reserved, non-routable address on this LAN, so the
    /// SYN is silently dropped — connect must still bail out at our own
    /// `timeout_ms`, not hang indefinitely.
    #[tokio::test]
    async fn connect_times_out_instead_of_hanging_on_an_unroutable_host() {
        let config = TcpConfig {
            host: "10.255.255.1".into(),
            port: 502,
            unit_id: 1,
            timeout_ms: 300,
            retries: 1,
        };
        let started = std::time::Instant::now();
        let result =
            tokio::time::timeout(Duration::from_secs(5), ModbusClient::connect_tcp(&config))
                .await
                .expect("connect_tcp must return on its own — it must not hang past timeout_ms");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "should bail out around timeout_ms=300, took {:?}",
            started.elapsed()
        );
        match result {
            Err(AppError::TcpConnect { .. }) => {}
            Ok(_) => panic!("expected an unroutable host to fail, got Ok"),
            Err(other) => panic!("expected AppError::TcpConnect, got {other:?}"),
        }
    }

    /// `testrig/slave.py` only serves unit ids 1 and 2 — polling unit 99
    /// must surface a clear error quickly, not hang or crash the app.
    #[tokio::test]
    async fn wrong_unit_id_produces_a_clear_error_not_a_hang() {
        let config = TcpConfig {
            host: "127.0.0.1".into(),
            port: 5020,
            unit_id: 99,
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
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            client.read_registers(FunctionCode::ReadHoldingRegisters, 0, 4, 99),
        )
        .await
        .expect("a read for an unserved unit id must not hang");
        assert!(
            matches!(
                result,
                Err(ReadError::Exception { .. }) | Err(ReadError::Timeout)
            ),
            "expected a clear exception or timeout for an unknown unit id, got {result:?}"
        );
    }

    /// Simulates a mid-poll network drop: proxy a real connection to the
    /// test slave, do one successful read through it, then sever the
    /// connection (like a cable pull) and confirm the next read fails
    /// cleanly within `timeout_ms` instead of hanging forever.
    #[tokio::test]
    async fn mid_poll_disconnect_fails_cleanly_not_a_hang() {
        use tokio::net::{TcpListener, TcpStream};

        if TcpStream::connect("127.0.0.1:5020").await.is_err() {
            eprintln!("skipping: no slave on 127.0.0.1:5020");
            return;
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_addr = listener.local_addr().unwrap();

        let proxy_task = tokio::spawn(async move {
            let (mut client_sock, _) = listener.accept().await.unwrap();
            let mut server_sock = TcpStream::connect("127.0.0.1:5020").await.unwrap();
            let (mut cr, mut cw) = client_sock.split();
            let (mut sr, mut sw) = server_sock.split();
            let _ = tokio::select! {
                r = tokio::io::copy(&mut cr, &mut sw) => r,
                r = tokio::io::copy(&mut sr, &mut cw) => r,
            };
        });

        let config = TcpConfig {
            host: proxy_addr.ip().to_string(),
            port: proxy_addr.port(),
            unit_id: 1,
            timeout_ms: 500,
            retries: 1,
        };
        let mut client = ModbusClient::connect_tcp(&config)
            .await
            .expect("connect through the proxy");
        client
            .read_registers(FunctionCode::ReadHoldingRegisters, 100, 8, 1)
            .await
            .expect("first read through the proxy should succeed like a normal poll");

        // Sever the connection — closes both proxy-side sockets, like a
        // cable pull or the slave process dying mid-poll.
        proxy_task.abort();
        let _ = proxy_task.await;

        let result = tokio::time::timeout(
            Duration::from_secs(3),
            client.read_registers(FunctionCode::ReadHoldingRegisters, 100, 8, 1),
        )
        .await
        .expect("a read after a mid-poll disconnect must not hang");
        assert!(
            matches!(
                result,
                Err(ReadError::Transport(_)) | Err(ReadError::Timeout)
            ),
            "expected a clean transport error or timeout after disconnect, got {result:?}"
        );
    }

    /// Live smoke against `testrig/rtu_slave.py` over a socat virtual serial
    /// pair (no `diagslave` in this environment): `socat -d -d
    /// pty,raw,echo=0,link=/tmp/ttyA pty,raw,echo=0,link=/tmp/ttyB`, then
    /// `rtu_slave.py /tmp/ttyA`. Skips quietly if the pair isn't up. Closes
    /// M2's open "polls a slave over a socat virtual serial pair" item.
    ///
    /// Note: on macOS this always skips — the `serialport` crate can't set
    /// a baud rate on a macOS pseudo-terminal (`IOSSIOSPEED` returns ENOTTY;
    /// see its own `posix/termios.rs` comment). Not a ModbusOpen bug: it's a
    /// pty-specific macOS limitation, absent on Linux and with any real
    /// serial device. Run these on Linux or against real RS-485 hardware.
    fn rtu_config(port: &str, unit_id: u8) -> RtuConfig {
        RtuConfig {
            port: port.to_string(),
            baud_rate: 9600,
            data_bits: 8,
            parity: Parity::None,
            stop_bits: 1,
            unit_id,
            timeout_ms: 1000,
            retries: 1,
            inter_frame_delay_us: None,
        }
    }

    #[tokio::test]
    async fn rtu_reads_float32_cdab_and_switches_unit_id_over_a_virtual_serial_pair() {
        let mut client = match ModbusClient::connect_rtu(&rtu_config("/tmp/ttyB", 1)).await {
            Ok(c) => c,
            Err(e) => {
                eprintln!("skipping: no socat pair / rtu_slave.py on /tmp/ttyB ({e})");
                return;
            }
        };

        let regs = client
            .read_registers(FunctionCode::ReadHoldingRegisters, 100, 8, 1)
            .await
            .expect("RTU read unit 1");
        let format = DataFormat {
            data_type: DataType::Float32,
            word_order: WordOrder::Cdab,
            scale: 1.0,
            offset: 0.0,
        };
        let rows = decode_block(&regs, 100, &format);
        match &rows[0].value {
            TypedValue::Float(v) => assert!((v - 231.0).abs() < 0.01, "voltage={v}"),
            other => panic!("expected float, got {other:?}"),
        }

        // Same connection, no reconnect — proves unit-ID switching works over RTU too.
        let regs2 = client
            .read_registers(FunctionCode::ReadHoldingRegisters, 0, 4, 2)
            .await
            .expect("RTU read unit 2");
        assert_eq!(regs2, vec![7, 7, 7, 7]);

        client.disconnect().await;
    }

    /// Kills the socat pair mid-poll (like unplugging the USB adapter) and
    /// confirms the next read fails cleanly and quickly, not a hang.
    #[tokio::test]
    async fn rtu_port_vanishing_mid_poll_fails_cleanly_not_a_hang() {
        let mut client = match ModbusClient::connect_rtu(&rtu_config("/tmp/ttyB", 1)).await {
            Ok(c) => c,
            Err(_) => {
                eprintln!("skipping: no socat pair / rtu_slave.py on /tmp/ttyB");
                return;
            }
        };
        client
            .read_registers(FunctionCode::ReadHoldingRegisters, 100, 8, 1)
            .await
            .expect("first RTU read should succeed");

        std::process::Command::new("pkill")
            .args(["-f", "socat -d -d pty"])
            .status()
            .expect("pkill socat");
        tokio::time::sleep(Duration::from_millis(200)).await;

        let result = tokio::time::timeout(
            Duration::from_secs(3),
            client.read_registers(FunctionCode::ReadHoldingRegisters, 100, 8, 1),
        )
        .await
        .expect("a read after the serial pair vanishes must not hang");
        assert!(
            matches!(
                result,
                Err(ReadError::Transport(_)) | Err(ReadError::Timeout)
            ),
            "expected a clean transport error or timeout, got {result:?}"
        );
    }

    /// Opening the same serial port twice must fail with an actionable
    /// "busy" message, not a raw errno — the real-hardware analogue of two
    /// apps fighting over one USB-RS485 adapter.
    #[tokio::test]
    async fn opening_an_already_open_port_twice_is_reported_as_busy() {
        let Ok(_first) = ModbusClient::connect_rtu(&rtu_config("/tmp/ttyB", 1)).await else {
            eprintln!("skipping: no socat pair / rtu_slave.py on /tmp/ttyB");
            return;
        };
        let second = ModbusClient::connect_rtu(&rtu_config("/tmp/ttyB", 1)).await;
        match second {
            Err(AppError::SerialOpen { reason, .. }) => {
                eprintln!("second-open error (informational): {reason}");
            }
            Ok(_) => {
                eprintln!(
                    "note: this OS/pty allowed a second concurrent open — \
                     exclusive-open enforcement is OS/device dependent for ptys; \
                     verify on a real USB-RS485 adapter before relying on this."
                );
            }
            Err(other) => panic!("expected SerialOpen or Ok, got {other:?}"),
        }
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
