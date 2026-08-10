//! The poll engine. One Tokio task per connected session, owning the
//! `ModbusClient` exclusively — nothing else touches the socket. Retuning
//! and writes go through a channel and are applied at the top of the next
//! cycle. See `docs/03-architecture.md#threading-model`.

use std::time::Instant;

use chrono::Utc;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{interval, Duration, MissedTickBehavior};
use tokio_util::sync::CancellationToken;

use super::client::{ModbusClient, ReadError};
use super::codec::{decode_block, encode};
use super::frame::{
    fc_byte, make_frame, pdu_exception, pdu_read_bits_response, pdu_read_registers_response,
    pdu_read_request, pdu_write_multiple_coils, pdu_write_multiple_echo,
    pdu_write_multiple_registers, pdu_write_single_coil, pdu_write_single_echo,
    pdu_write_single_register,
};
use super::types::{
    ConnectionLostEvent, DecodedRegister, Direction, FunctionCode, PollConfig, PollErrorEvent,
    PollResult, PollStats, ReadBlock, Transport, TypedValue, WriteRequest, WriteResult,
};
use crate::error::AppError;

pub enum PollCommand {
    SetConfig(PollConfig),
    Start,
    Stop,
    ResetStats,
    ReadOnce(PollConfig, oneshot::Sender<Result<PollResult, AppError>>),
    Write(WriteRequest, oneshot::Sender<Result<WriteResult, AppError>>),
}

struct StatsAccumulator {
    stats: PollStats,
    latency_sum_ms: f64,
    success_count: u64,
    min_latency_ms: Option<f64>,
    max_latency_ms: Option<f64>,
    last_tick: Option<Instant>,
}

impl StatsAccumulator {
    fn new() -> Self {
        Self {
            stats: PollStats::default(),
            latency_sum_ms: 0.0,
            success_count: 0,
            min_latency_ms: None,
            max_latency_ms: None,
            last_tick: None,
        }
    }

    /// Zero every counter without touching the connection. The rate estimate
    /// keeps no history either, so the next cycle starts a fresh average.
    fn reset(&mut self) {
        *self = Self::new();
    }

    fn record_rate(&mut self) {
        let now = Instant::now();
        if let Some(last) = self.last_tick {
            let dt = now.duration_since(last).as_secs_f64();
            if dt > 0.0 {
                let instantaneous = 1.0 / dt;
                self.stats.actual_rate_hz = if self.stats.actual_rate_hz == 0.0 {
                    instantaneous
                } else {
                    0.8 * self.stats.actual_rate_hz + 0.2 * instantaneous
                };
            }
        }
        self.last_tick = Some(now);
    }

    fn record_success(&mut self, latency_ms: f64) -> PollStats {
        self.stats.tx_count += 1;
        self.stats.rx_count += 1;
        self.success_count += 1;
        self.latency_sum_ms += latency_ms;
        self.stats.latency_avg_ms = self.latency_sum_ms / self.success_count as f64;
        self.min_latency_ms = Some(
            self.min_latency_ms
                .map_or(latency_ms, |m| m.min(latency_ms)),
        );
        self.max_latency_ms = Some(
            self.max_latency_ms
                .map_or(latency_ms, |m| m.max(latency_ms)),
        );
        self.stats.latency_min_ms = self.min_latency_ms.unwrap_or(0.0);
        self.stats.latency_max_ms = self.max_latency_ms.unwrap_or(0.0);
        // A good response retires the last failure. Otherwise the error line
        // stays on screen forever after one timeout, long after data resumed.
        self.stats.last_error = None;
        self.record_rate();
        self.stats.clone()
    }

    fn record_failure(&mut self, message: String, is_timeout: bool) -> PollStats {
        self.stats.tx_count += 1;
        if is_timeout {
            self.stats.timeout_count += 1;
        } else {
            self.stats.error_count += 1;
        }
        self.stats.last_error = Some(message);
        self.record_rate();
        self.stats.clone()
    }
}

/// A live scanner connection: the channel to talk to its poll task, and the
/// metadata `connection_status()` reports without needing to ask the task.
pub struct ScannerSession {
    pub session_id: u64,
    pub transport: Transport,
    pub summary: String,
    pub since: chrono::DateTime<Utc>,
    cmd_tx: mpsc::Sender<PollCommand>,
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl ScannerSession {
    pub fn spawn<R: Runtime>(
        app: AppHandle<R>,
        session_id: u64,
        transport: Transport,
        summary: String,
        client: ModbusClient,
    ) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel(16);
        let cancel = CancellationToken::new();
        let task = tokio::spawn(run_poll_loop(
            app,
            session_id,
            client,
            cmd_rx,
            cancel.clone(),
        ));
        Self {
            session_id,
            transport,
            summary,
            since: Utc::now(),
            cmd_tx,
            cancel,
            task,
        }
    }

    pub async fn send(&self, cmd: PollCommand) -> Result<(), AppError> {
        self.cmd_tx
            .send(cmd)
            .await
            .map_err(|_| AppError::ConnectionLost {
                reason: "poll task already stopped".to_string(),
            })
    }

    pub async fn shutdown(self) {
        self.cancel.cancel();
        let _ = self.task.await;
    }
}

async fn run_poll_loop<R: Runtime>(
    app: AppHandle<R>,
    session_id: u64,
    mut client: ModbusClient,
    mut cmd_rx: mpsc::Receiver<PollCommand>,
    cancel: CancellationToken,
) {
    let mut config: Option<PollConfig> = None;
    let mut running = false;
    let mut sequence: u64 = 0;
    let mut stats = StatsAccumulator::new();
    let mut ticker = interval(Duration::from_millis(1000));
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let transport = client.transport;

    loop {
        tokio::select! {
            biased;

            () = cancel.cancelled() => break,

            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(PollCommand::SetConfig(new_config)) => {
                        if config.as_ref().map(|c| c.interval_ms) != Some(new_config.interval_ms) {
                            ticker = interval(Duration::from_millis(new_config.interval_ms.max(1)));
                            ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
                        }
                        config = Some(new_config);
                    }
                    Some(PollCommand::Start) => running = true,
                    Some(PollCommand::Stop) => running = false,
                    Some(PollCommand::ResetStats) => stats.reset(),
                    Some(PollCommand::ReadOnce(cfg, responder)) => {
                        let result = read_cycle(
                            &app, &mut client, &cfg, session_id, transport,
                            &mut sequence, &mut stats,
                        ).await;
                        let fatal = matches!(&result, Err(ReadOutcome::Fatal(_)));
                        let _ = responder.send(result.map_err(|e| e.into_app_error()));
                        if fatal {
                            let _ = app.emit(
                                "connection-lost",
                                &ConnectionLostEvent {
                                    session_id,
                                    message: "Connection lost — transport closed".to_string(),
                                },
                            );
                            break;
                        }
                    }
                    Some(PollCommand::Write(req, responder)) => {
                        let result = write_cycle(
                            &app, &mut client, req, session_id, transport,
                            &mut sequence, &mut stats,
                        ).await;
                        let fatal = matches!(&result, Err(ReadOutcome::Fatal(_)));
                        let _ = responder.send(result.map_err(|e| e.into_app_error()));
                        if fatal {
                            let _ = app.emit(
                                "connection-lost",
                                &ConnectionLostEvent {
                                    session_id,
                                    message: "Connection lost — transport closed".to_string(),
                                },
                            );
                            break;
                        }
                    }
                    None => break,
                }
            }

            _ = ticker.tick(), if running && config.is_some() => {
                let cfg = config.clone().expect("checked by select guard");
                match read_cycle(
                    &app, &mut client, &cfg, session_id, transport,
                    &mut sequence, &mut stats,
                ).await {
                    Ok(result) => {
                        let _ = app.emit("poll-result", &result);
                    }
                    Err(ReadOutcome::Recoverable(err)) => {
                        let _ = app.emit(
                            "poll-error",
                            &PollErrorEvent {
                                session_id,
                                message: err.to_string(),
                                stats: stats.stats.clone(),
                            },
                        );
                    }
                    Err(ReadOutcome::Fatal(err)) => {
                        let _ = app.emit(
                            "connection-lost",
                            &ConnectionLostEvent {
                                session_id,
                                message: err.to_string(),
                            },
                        );
                        break;
                    }
                }
            }
        }
    }

    client.disconnect().await;
}

enum ReadOutcome {
    Recoverable(AppError),
    Fatal(AppError),
}

impl ReadOutcome {
    fn into_app_error(self) -> AppError {
        match self {
            ReadOutcome::Recoverable(e) | ReadOutcome::Fatal(e) => e,
        }
    }
}

fn map_read_error(
    err: ReadError,
    unit_id: u8,
    timeout_ms: u64,
    stats: &mut StatsAccumulator,
) -> ReadOutcome {
    match err {
        ReadError::Exception { code, name, hint } => {
            let err = AppError::ModbusException {
                code,
                name: name.clone(),
                hint: hint.clone(),
            };
            stats.record_failure(err.to_string(), false);
            ReadOutcome::Recoverable(err)
        }
        ReadError::Timeout => {
            let err = AppError::Timeout {
                unit_id,
                timeout_ms,
                attempts: 1,
            };
            stats.record_failure(err.to_string(), true);
            ReadOutcome::Recoverable(err)
        }
        ReadError::Transport(reason) => {
            let err = AppError::ConnectionLost { reason };
            stats.record_failure(err.to_string(), false);
            ReadOutcome::Fatal(err)
        }
    }
}

fn decode_bits(bits: &[bool], start: u16) -> Vec<DecodedRegister> {
    bits.iter()
        .enumerate()
        .map(|(i, &b)| DecodedRegister {
            address: start.wrapping_add(i as u16),
            span: 1,
            raw: vec![if b { 1 } else { 0 }],
            value: TypedValue::Bool(b),
            decode_error: None,
        })
        .collect()
}

fn is_bit_function(fc: FunctionCode) -> bool {
    matches!(
        fc,
        FunctionCode::ReadCoils | FunctionCode::ReadDiscreteInputs
    )
}

#[allow(clippy::too_many_arguments)]
fn emit_tx_rx<R: Runtime>(
    app: &AppHandle<R>,
    session_id: u64,
    transport: Transport,
    tid: u16,
    unit_id: u8,
    tx_pdu: &[u8],
    rx_pdu: &[u8],
    latency_ms: f64,
    is_exception: bool,
    exception_code: Option<u8>,
) {
    let _ = app.emit(
        "frame",
        &make_frame(
            session_id,
            transport,
            tid,
            unit_id,
            Direction::Tx,
            tx_pdu,
            None,
            false,
            None,
        ),
    );
    let _ = app.emit(
        "frame",
        &make_frame(
            session_id,
            transport,
            tid,
            unit_id,
            Direction::Rx,
            rx_pdu,
            Some(latency_ms),
            is_exception,
            exception_code,
        ),
    );
}

/// Issue one request and decode what comes back.
///
/// Errors carry no partial data: a cycle either produced every block or it
/// failed, because a register table showing three of a meter's four groups
/// with the fourth silently absent is worse than an error message.
async fn read_one_block<R: Runtime>(
    app: &AppHandle<R>,
    client: &mut ModbusClient,
    cfg: &PollConfig,
    block: ReadBlock,
    session_id: u64,
    transport: Transport,
    stats: &mut StatsAccumulator,
) -> Result<(Vec<DecodedRegister>, f64), ReadOutcome> {
    let fc = fc_byte(block.function);
    let tx_pdu = pdu_read_request(fc, block.start_address, block.quantity);
    let started = Instant::now();

    if is_bit_function(block.function) {
        match client
            .read_bits(
                block.function,
                block.start_address,
                block.quantity,
                cfg.unit_id,
            )
            .await
        {
            Ok(bits) => {
                let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
                stats.record_success(latency_ms);
                let rx_pdu = pdu_read_bits_response(fc, &bits);
                emit_tx_rx(
                    app,
                    session_id,
                    transport,
                    client.last_tid(),
                    cfg.unit_id,
                    &tx_pdu,
                    &rx_pdu,
                    latency_ms,
                    false,
                    None,
                );
                Ok((decode_bits(&bits, block.start_address), latency_ms))
            }
            Err(e) => {
                if let ReadError::Exception { code, .. } = &e {
                    emit_tx_rx(
                        app,
                        session_id,
                        transport,
                        client.last_tid(),
                        cfg.unit_id,
                        &tx_pdu,
                        &pdu_exception(fc, *code),
                        started.elapsed().as_secs_f64() * 1000.0,
                        true,
                        Some(*code),
                    );
                }
                Err(map_read_error(e, cfg.unit_id, cfg.interval_ms, stats))
            }
        }
    } else {
        match client
            .read_registers(
                block.function,
                block.start_address,
                block.quantity,
                cfg.unit_id,
            )
            .await
        {
            Ok(regs) => {
                let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
                stats.record_success(latency_ms);
                let rx_pdu = pdu_read_registers_response(fc, &regs);
                emit_tx_rx(
                    app,
                    session_id,
                    transport,
                    client.last_tid(),
                    cfg.unit_id,
                    &tx_pdu,
                    &rx_pdu,
                    latency_ms,
                    false,
                    None,
                );
                Ok((
                    decode_block(&regs, block.start_address, &cfg.format),
                    latency_ms,
                ))
            }
            Err(e) => {
                if let ReadError::Exception { code, .. } = &e {
                    emit_tx_rx(
                        app,
                        session_id,
                        transport,
                        client.last_tid(),
                        cfg.unit_id,
                        &tx_pdu,
                        &pdu_exception(fc, *code),
                        started.elapsed().as_secs_f64() * 1000.0,
                        true,
                        Some(*code),
                    );
                }
                Err(map_read_error(e, cfg.unit_id, cfg.interval_ms, stats))
            }
        }
    }
}

/// One poll cycle: every request in the config, in order, merged into a single
/// result.
///
/// A meter whose parameters are scattered across the address space needs more
/// than one request to read once — see `modbus::meters::plan_reads`. Raw
/// scanning is the one-block case and behaves exactly as it did.
async fn read_cycle<R: Runtime>(
    app: &AppHandle<R>,
    client: &mut ModbusClient,
    cfg: &PollConfig,
    session_id: u64,
    transport: Transport,
    sequence: &mut u64,
    stats: &mut StatsAccumulator,
) -> Result<PollResult, ReadOutcome> {
    let mut registers: Vec<DecodedRegister> = Vec::new();
    let mut total_latency_ms = 0.0;
    let mut snapshot = None;

    for block in &cfg.blocks {
        let (mut rows, latency_ms) =
            read_one_block(app, client, cfg, *block, session_id, transport, stats).await?;
        registers.append(&mut rows);
        total_latency_ms += latency_ms;
        snapshot = Some(stats.stats.clone());
    }

    *sequence += 1;
    Ok(PollResult {
        session_id,
        sequence: *sequence,
        timestamp: Utc::now(),
        // The whole cycle's time, not one request's — with several requests
        // per cycle that's the number that tells you whether the poll
        // interval is achievable.
        latency_ms: total_latency_ms,
        registers,
        stats: snapshot.unwrap_or_else(|| stats.stats.clone()),
    })
}

async fn write_cycle<R: Runtime>(
    app: &AppHandle<R>,
    client: &mut ModbusClient,
    req: WriteRequest,
    session_id: u64,
    transport: Transport,
    sequence: &mut u64,
    stats: &mut StatsAccumulator,
) -> Result<WriteResult, ReadOutcome> {
    match req {
        WriteRequest::SingleCoil {
            unit_id,
            address,
            value,
        } => {
            write_single_coil_inner(
                app, client, unit_id, address, value, session_id, transport, sequence, stats,
            )
            .await
        }
        WriteRequest::SingleRegister {
            unit_id,
            address,
            value,
        } => {
            write_single_register_inner(
                app, client, unit_id, address, value, session_id, transport, sequence, stats,
            )
            .await
        }
        WriteRequest::MultipleCoils {
            unit_id,
            address,
            values,
        } => {
            write_multiple_coils_inner(
                app, client, unit_id, address, values, session_id, transport, sequence, stats,
            )
            .await
        }
        WriteRequest::MultipleRegisters {
            unit_id,
            address,
            values,
        } => {
            write_multiple_registers_inner(
                app, client, unit_id, address, values, session_id, transport, sequence, stats,
            )
            .await
        }
        WriteRequest::Typed {
            unit_id,
            address,
            value,
            format,
        } => {
            let regs = encode(&value, &format)
                .map_err(|msg| ReadOutcome::Recoverable(AppError::InvalidConfig(msg)))?;
            if regs.len() == 1 {
                write_single_register_inner(
                    app, client, unit_id, address, regs[0], session_id, transport, sequence, stats,
                )
                .await
            } else {
                write_multiple_registers_inner(
                    app, client, unit_id, address, regs, session_id, transport, sequence, stats,
                )
                .await
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn write_single_coil_inner<R: Runtime>(
    app: &AppHandle<R>,
    client: &mut ModbusClient,
    unit_id: u8,
    address: u16,
    value: bool,
    session_id: u64,
    transport: Transport,
    sequence: &mut u64,
    stats: &mut StatsAccumulator,
) -> Result<WriteResult, ReadOutcome> {
    let tx_pdu = pdu_write_single_coil(address, value);
    let started = Instant::now();
    match client.write_single_coil(address, value, unit_id).await {
        Ok(()) => {
            let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
            stats.record_success(latency_ms);
            *sequence += 1;
            let (vh, vl) = if value { (0xFF, 0x00) } else { (0x00, 0x00) };
            let rx_pdu = pdu_write_single_echo(0x05, address, vh, vl);
            emit_tx_rx(
                app,
                session_id,
                transport,
                client.last_tid(),
                unit_id,
                &tx_pdu,
                &rx_pdu,
                latency_ms,
                false,
                None,
            );
            Ok(WriteResult {
                session_id,
                latency_ms,
                function: FunctionCode::WriteSingleCoil,
                address,
                quantity: 1,
            })
        }
        Err(e) => write_err(
            app, client, e, 0x05, unit_id, address, &tx_pdu, session_id, transport, stats, started,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
async fn write_single_register_inner<R: Runtime>(
    app: &AppHandle<R>,
    client: &mut ModbusClient,
    unit_id: u8,
    address: u16,
    value: u16,
    session_id: u64,
    transport: Transport,
    sequence: &mut u64,
    stats: &mut StatsAccumulator,
) -> Result<WriteResult, ReadOutcome> {
    let tx_pdu = pdu_write_single_register(address, value);
    let started = Instant::now();
    match client.write_single_register(address, value, unit_id).await {
        Ok(()) => {
            let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
            stats.record_success(latency_ms);
            *sequence += 1;
            let rx_pdu = pdu_write_single_echo(0x06, address, (value >> 8) as u8, value as u8);
            emit_tx_rx(
                app,
                session_id,
                transport,
                client.last_tid(),
                unit_id,
                &tx_pdu,
                &rx_pdu,
                latency_ms,
                false,
                None,
            );
            Ok(WriteResult {
                session_id,
                latency_ms,
                function: FunctionCode::WriteSingleRegister,
                address,
                quantity: 1,
            })
        }
        Err(e) => write_err(
            app, client, e, 0x06, unit_id, address, &tx_pdu, session_id, transport, stats, started,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
async fn write_multiple_coils_inner<R: Runtime>(
    app: &AppHandle<R>,
    client: &mut ModbusClient,
    unit_id: u8,
    address: u16,
    values: Vec<bool>,
    session_id: u64,
    transport: Transport,
    sequence: &mut u64,
    stats: &mut StatsAccumulator,
) -> Result<WriteResult, ReadOutcome> {
    let qty = values.len() as u16;
    let tx_pdu = pdu_write_multiple_coils(address, &values);
    let started = Instant::now();
    match client.write_multiple_coils(address, &values, unit_id).await {
        Ok(()) => {
            let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
            stats.record_success(latency_ms);
            *sequence += 1;
            let rx_pdu = pdu_write_multiple_echo(0x0F, address, qty);
            emit_tx_rx(
                app,
                session_id,
                transport,
                client.last_tid(),
                unit_id,
                &tx_pdu,
                &rx_pdu,
                latency_ms,
                false,
                None,
            );
            Ok(WriteResult {
                session_id,
                latency_ms,
                function: FunctionCode::WriteMultipleCoils,
                address,
                quantity: qty,
            })
        }
        Err(e) => write_err(
            app, client, e, 0x0F, unit_id, address, &tx_pdu, session_id, transport, stats, started,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
async fn write_multiple_registers_inner<R: Runtime>(
    app: &AppHandle<R>,
    client: &mut ModbusClient,
    unit_id: u8,
    address: u16,
    values: Vec<u16>,
    session_id: u64,
    transport: Transport,
    sequence: &mut u64,
    stats: &mut StatsAccumulator,
) -> Result<WriteResult, ReadOutcome> {
    let qty = values.len() as u16;
    let tx_pdu = pdu_write_multiple_registers(address, &values);
    let started = Instant::now();
    match client
        .write_multiple_registers(address, &values, unit_id)
        .await
    {
        Ok(()) => {
            let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
            stats.record_success(latency_ms);
            *sequence += 1;
            let rx_pdu = pdu_write_multiple_echo(0x10, address, qty);
            emit_tx_rx(
                app,
                session_id,
                transport,
                client.last_tid(),
                unit_id,
                &tx_pdu,
                &rx_pdu,
                latency_ms,
                false,
                None,
            );
            Ok(WriteResult {
                session_id,
                latency_ms,
                function: FunctionCode::WriteMultipleRegisters,
                address,
                quantity: qty,
            })
        }
        Err(e) => write_err(
            app, client, e, 0x10, unit_id, address, &tx_pdu, session_id, transport, stats, started,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn write_err<R: Runtime>(
    app: &AppHandle<R>,
    client: &ModbusClient,
    e: ReadError,
    fc: u8,
    unit_id: u8,
    address: u16,
    tx_pdu: &[u8],
    session_id: u64,
    transport: Transport,
    stats: &mut StatsAccumulator,
    started: Instant,
) -> Result<WriteResult, ReadOutcome> {
    let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
    if let ReadError::Exception { code, .. } = &e {
        emit_tx_rx(
            app,
            session_id,
            transport,
            client.last_tid(),
            unit_id,
            tx_pdu,
            &pdu_exception(fc, *code),
            latency_ms,
            true,
            Some(*code),
        );
    }
    let _ = address;
    Err(map_read_error(e, unit_id, 1000, stats))
}

#[cfg(test)]
mod engine_tests {
    //! Exercises `ScannerSession`/`run_poll_loop` end to end — the poll
    //! engine's control flow (live retune, exception handling, writes) isn't
    //! covered anywhere else, since `client.rs`'s smoke test only calls
    //! `ModbusClient` directly and skips the channel/event-loop machinery.
    //! Live against `testrig/slave.py` on :5020; skips quietly offline.
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration as StdDuration;

    use serde_json::Value;
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri::{App, Listener};

    use super::*;
    use crate::modbus::types::{DataFormat, DataType, TcpConfig, WordOrder};

    fn test_app() -> App<MockRuntime> {
        mock_builder()
            .build(mock_context(noop_assets()))
            .expect("failed to build mock tauri app")
    }

    async fn connect_unit(unit_id: u8) -> Option<ModbusClient> {
        let config = TcpConfig {
            host: "127.0.0.1".into(),
            port: 5020,
            unit_id,
            timeout_ms: 1000,
            retries: 1,
        };
        ModbusClient::connect_tcp(&config).await.ok()
    }

    fn collect_events(app: &App<MockRuntime>, name: &'static str) -> Arc<StdMutex<Vec<String>>> {
        let events = Arc::new(StdMutex::new(Vec::new()));
        let sink = events.clone();
        app.handle().listen(name, move |event| {
            sink.lock().unwrap().push(event.payload().to_string());
        });
        events
    }

    fn float32_cdab_format() -> DataFormat {
        DataFormat {
            data_type: DataType::Float32,
            word_order: WordOrder::Cdab,
            scale: 1.0,
            offset: 0.0,
        }
    }

    async fn wait_for(events: &Arc<StdMutex<Vec<String>>>, min_count: usize) -> bool {
        for _ in 0..50 {
            if events.lock().unwrap().len() >= min_count {
                return true;
            }
            tokio::time::sleep(StdDuration::from_millis(20)).await;
        }
        false
    }

    #[tokio::test]
    async fn poll_loop_emits_decoded_values_and_frames_from_live_slave() {
        let Some(client) = connect_unit(1).await else {
            eprintln!("skipping: no slave on 127.0.0.1:5020");
            return;
        };
        let app = test_app();
        let results = collect_events(&app, "poll-result");
        let frames = collect_events(&app, "frame");

        let session = ScannerSession::spawn(
            app.handle().clone(),
            1,
            Transport::Tcp,
            "test".into(),
            client,
        );
        let cfg = PollConfig {
            unit_id: 1,
            blocks: vec![ReadBlock {
                function: FunctionCode::ReadHoldingRegisters,
                start_address: 100,
                quantity: 8,
            }],
            interval_ms: 50,
            format: float32_cdab_format(),
        };
        session.send(PollCommand::SetConfig(cfg)).await.unwrap();
        session.send(PollCommand::Start).await.unwrap();

        assert!(
            wait_for(&results, 1).await,
            "expected at least one poll-result event"
        );
        session.shutdown().await;

        let payload = results.lock().unwrap()[0].clone();
        let result: Value = serde_json::from_str(&payload).unwrap();
        let registers = result["registers"].as_array().unwrap();
        assert_eq!(registers.len(), 4, "4 float32 rows across 8 registers");
        let voltage = registers[0]["value"]["value"].as_f64().unwrap();
        assert!((voltage - 231.0).abs() < 0.01, "voltage={voltage}");
        let power_factor = registers[3]["value"]["value"].as_f64().unwrap();
        assert!(
            (power_factor - 0.975).abs() < 0.001,
            "power_factor={power_factor}"
        );

        // Both the request and the response must reach the frame log.
        assert!(
            frames.lock().unwrap().len() >= 2,
            "expected a tx and rx frame per cycle"
        );
    }

    /// The scanner reading a meter whose parameters are scattered: one poll
    /// cycle, several requests, every parameter present in one result.
    ///
    /// This runs against ModbusOpen's own simulator rather than an external
    /// slave, so it always runs — and it exercises the exact path the meter
    /// feature depends on: `plan_reads` -> `PollConfig.blocks` -> one
    /// `PollResult` covering both ends of the address space.
    #[tokio::test]
    async fn one_cycle_issues_every_request_in_the_plan() {
        use crate::modbus::server::SimulatorServer;
        use crate::modbus::store::{ModbusStore, SlaveLayout};

        let app = test_app();
        let store = Arc::new(ModbusStore::new());
        store.reset(&[(
            1,
            SlaveLayout {
                coil_count: 0,
                discrete_count: 0,
                input_register_count: 0,
                holding_register_count: 3010,
            },
        )]);
        // Two islands of data with 2900 dead registers between them — far
        // more than any single request can span.
        store
            .write_multiple_registers(1, 100, &[1, 2, 3, 4])
            .unwrap();
        store.write_multiple_registers(1, 3000, &[9, 9]).unwrap();

        let server = SimulatorServer::bind(
            "127.0.0.1:0".parse().unwrap(),
            store,
            app.handle().clone(),
            1,
        )
        .await
        .unwrap();
        let port = server.tcp_port();

        let client = ModbusClient::connect_tcp(&TcpConfig {
            host: "127.0.0.1".into(),
            port,
            unit_id: 1,
            timeout_ms: 1000,
            retries: 1,
        })
        .await
        .unwrap();

        let results = collect_events(&app, "poll-result");
        let frames = collect_events(&app, "frame");
        let session = ScannerSession::spawn(
            app.handle().clone(),
            1,
            Transport::Tcp,
            "test".into(),
            client,
        );

        let cfg = PollConfig {
            unit_id: 1,
            blocks: vec![
                ReadBlock {
                    function: FunctionCode::ReadHoldingRegisters,
                    start_address: 100,
                    quantity: 4,
                },
                ReadBlock {
                    function: FunctionCode::ReadHoldingRegisters,
                    start_address: 3000,
                    quantity: 2,
                },
            ],
            interval_ms: 50,
            format: DataFormat {
                data_type: DataType::Uint16,
                word_order: WordOrder::Cdab,
                scale: 1.0,
                offset: 0.0,
            },
        };
        session.send(PollCommand::SetConfig(cfg)).await.unwrap();
        session.send(PollCommand::Start).await.unwrap();
        assert!(wait_for(&results, 1).await, "expected a poll-result");
        session.shutdown().await;
        server.shutdown().await;

        let payload = results.lock().unwrap()[0].clone();
        let result: Value = serde_json::from_str(&payload).unwrap();
        let registers = result["registers"].as_array().unwrap();
        assert_eq!(
            registers.len(),
            6,
            "one result must carry both blocks, got {registers:?}"
        );

        // The far block is present and correct, not zeros and not absent.
        let far: Vec<&Value> = registers
            .iter()
            .filter(|r| r["address"].as_u64() == Some(3000) || r["address"].as_u64() == Some(3001))
            .collect();
        assert_eq!(far.len(), 2, "the second request's data is missing");
        for row in far {
            assert_eq!(row["value"]["value"].as_u64(), Some(9));
        }
        // And nothing invented data for the 2900 registers in between.
        assert!(
            !registers
                .iter()
                .any(|r| matches!(r["address"].as_u64(), Some(a) if (104..3000).contains(&a))),
            "the gap between requests must not appear in the result"
        );

        // Two requests means two tx/rx pairs on the wire per cycle.
        assert!(
            frames.lock().unwrap().len() >= 4,
            "expected a tx and rx frame for each of the two requests"
        );
    }

    #[tokio::test]
    async fn changing_unit_id_mid_poll_switches_devices_without_reconnect() {
        let Some(client) = connect_unit(1).await else {
            eprintln!("skipping: no slave on 127.0.0.1:5020");
            return;
        };
        let app = test_app();
        let results = collect_events(&app, "poll-result");

        let session = ScannerSession::spawn(
            app.handle().clone(),
            1,
            Transport::Tcp,
            "test".into(),
            client,
        );
        let mut cfg = PollConfig {
            unit_id: 1,
            blocks: vec![ReadBlock {
                function: FunctionCode::ReadHoldingRegisters,
                start_address: 0,
                quantity: 4,
            }],
            interval_ms: 50,
            format: DataFormat {
                data_type: DataType::Uint16,
                word_order: WordOrder::Cdab,
                scale: 1.0,
                offset: 0.0,
            },
        };
        session
            .send(PollCommand::SetConfig(cfg.clone()))
            .await
            .unwrap();
        session.send(PollCommand::Start).await.unwrap();
        assert!(wait_for(&results, 1).await, "unit 1 never polled");

        // Same session, same socket — only the unit ID changes.
        cfg.unit_id = 2;
        session.send(PollCommand::SetConfig(cfg)).await.unwrap();
        assert!(
            wait_for(&results, 2).await,
            "unit 2 never polled after retune"
        );
        session.shutdown().await;

        let payload = results.lock().unwrap().last().unwrap().clone();
        let result: Value = serde_json::from_str(&payload).unwrap();
        let registers = result["registers"].as_array().unwrap();
        for row in registers {
            assert_eq!(
                row["value"]["value"].as_i64().unwrap(),
                7,
                "unit 2's registers are all 7 in testrig/slave.py"
            );
        }
    }

    #[tokio::test]
    async fn out_of_range_address_is_recoverable_and_poll_continues() {
        let Some(client) = connect_unit(1).await else {
            eprintln!("skipping: no slave on 127.0.0.1:5020");
            return;
        };
        let app = test_app();
        let results = collect_events(&app, "poll-result");
        let errors = collect_events(&app, "poll-error");

        let session = ScannerSession::spawn(
            app.handle().clone(),
            1,
            Transport::Tcp,
            "test".into(),
            client,
        );
        let bad_cfg = PollConfig {
            unit_id: 1,
            blocks: vec![ReadBlock {
                function: FunctionCode::ReadHoldingRegisters,
                start_address: 60_000,
                quantity: 5,
            }],
            interval_ms: 50,
            format: DataFormat::default(),
        };
        session.send(PollCommand::SetConfig(bad_cfg)).await.unwrap();
        session.send(PollCommand::Start).await.unwrap();
        assert!(
            wait_for(&errors, 1).await,
            "expected a poll-error event for an out-of-range address"
        );
        assert!(
            results.lock().unwrap().is_empty(),
            "an exception must not also produce a poll-result"
        );

        // The session must still be alive: retuning to a valid range recovers.
        let good_cfg = PollConfig {
            unit_id: 1,
            blocks: vec![ReadBlock {
                function: FunctionCode::ReadHoldingRegisters,
                start_address: 0,
                quantity: 4,
            }],
            interval_ms: 50,
            format: DataFormat::default(),
        };
        session
            .send(PollCommand::SetConfig(good_cfg))
            .await
            .unwrap();
        assert!(
            wait_for(&results, 1).await,
            "poll did not recover after retuning back to a valid address"
        );
        session.shutdown().await;
    }

    #[tokio::test]
    async fn write_single_register_round_trips_through_read_once() {
        let Some(client) = connect_unit(1).await else {
            eprintln!("skipping: no slave on 127.0.0.1:5020");
            return;
        };
        let app = test_app();
        let session = ScannerSession::spawn(
            app.handle().clone(),
            1,
            Transport::Tcp,
            "test".into(),
            client,
        );

        let (tx, rx) = oneshot::channel();
        session
            .send(PollCommand::Write(
                WriteRequest::SingleRegister {
                    unit_id: 1,
                    address: 150,
                    value: 4242,
                },
                tx,
            ))
            .await
            .unwrap();
        rx.await.unwrap().expect("write should succeed");

        let (tx, rx) = oneshot::channel();
        let cfg = PollConfig {
            unit_id: 1,
            blocks: vec![ReadBlock {
                function: FunctionCode::ReadHoldingRegisters,
                start_address: 150,
                quantity: 1,
            }],
            interval_ms: 1000,
            format: DataFormat {
                data_type: DataType::Uint16,
                word_order: WordOrder::Cdab,
                scale: 1.0,
                offset: 0.0,
            },
        };
        session.send(PollCommand::ReadOnce(cfg, tx)).await.unwrap();
        let result = rx.await.unwrap().expect("read-once should succeed");
        session.shutdown().await;

        match &result.registers[0].value {
            TypedValue::Uint(v) => assert_eq!(*v, 4242),
            other => panic!("expected uint16, got {other:?}"),
        }
    }

    /// Byte-for-byte regression check: the frame log's transaction id must
    /// match tokio-modbus's own counter (verified live against a
    /// byte-logging TCP proxy in front of `testrig/slave.py` — see PLAN.md
    /// M3), not a fabricated one derived from the poll cycle count.
    #[tokio::test]
    async fn frame_log_bytes_match_the_real_wire_transaction_id() {
        let Some(client) = connect_unit(1).await else {
            eprintln!("skipping: no slave on 127.0.0.1:5020");
            return;
        };
        let app = test_app();
        let frames = collect_events(&app, "frame");

        let session = ScannerSession::spawn(
            app.handle().clone(),
            1,
            Transport::Tcp,
            "test".into(),
            client,
        );
        let cfg = PollConfig {
            unit_id: 1,
            blocks: vec![ReadBlock {
                function: FunctionCode::ReadHoldingRegisters,
                start_address: 100,
                quantity: 8,
            }],
            interval_ms: 100,
            format: float32_cdab_format(),
        };
        session.send(PollCommand::SetConfig(cfg)).await.unwrap();
        session.send(PollCommand::Start).await.unwrap();
        assert!(wait_for(&frames, 2).await, "expected tx+rx frames");

        // A second, out-of-range read on the same connection: tokio-modbus's
        // transaction id keeps incrementing regardless of the exception.
        let bad_cfg = PollConfig {
            unit_id: 1,
            blocks: vec![ReadBlock {
                function: FunctionCode::ReadHoldingRegisters,
                start_address: 60_000,
                quantity: 5,
            }],
            interval_ms: 100,
            format: DataFormat::default(),
        };
        session.send(PollCommand::SetConfig(bad_cfg)).await.unwrap();
        assert!(
            wait_for(&frames, 4).await,
            "expected tx+rx exception frames"
        );
        session.shutdown().await;

        fn hex_bytes(payload: &str) -> String {
            let v: Value = serde_json::from_str(payload).unwrap();
            v["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| format!("{:02x}", b.as_u64().unwrap()))
                .collect()
        }

        let captured = frames.lock().unwrap();
        // MBAP: transaction id, protocol id 0000, length, unit, PDU —
        // captured live from an unmodified wire trace (see PLAN.md M3).
        assert_eq!(hex_bytes(&captured[0]), "000000000006010300640008"); // tx tid 0, read 100x8
        assert_eq!(
            hex_bytes(&captured[1]),
            "000000000013010310000043670000417000004248999a3f79" // rx tid 0
        );
        assert_eq!(hex_bytes(&captured[2]), "0001000000060103ea600005"); // tx tid 1, read 60000x5
        assert_eq!(hex_bytes(&captured[3]), "000100000003018302"); // rx tid 1, exception 02
    }
}
