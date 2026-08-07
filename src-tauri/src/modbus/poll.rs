//! The poll engine. One Tokio task per connected session, owning the
//! `ModbusClient` exclusively — nothing else touches the socket. Retuning
//! (unit ID, address, quantity, interval) goes through a channel and is
//! applied at the top of the next cycle, so it never requires a reconnect.
//! See `docs/03-architecture.md#threading-model`.

use std::time::Instant;

use chrono::Utc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{interval, Duration, MissedTickBehavior};
use tokio_util::sync::CancellationToken;

use super::client::{ModbusClient, ReadError};
use super::codec::decode_block;
use super::types::{PollConfig, PollResult, PollStats, Transport};
use crate::error::AppError;

pub enum PollCommand {
    SetConfig(PollConfig),
    Start,
    Stop,
    ReadOnce(PollConfig, oneshot::Sender<Result<PollResult, AppError>>),
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
    pub fn spawn(
        app: AppHandle,
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

    /// Cancels the poll task and waits for it to actually finish before
    /// returning — otherwise a zombie task keeps holding the socket and the
    /// next connect can fail with a spurious "port busy".
    pub async fn shutdown(self) {
        self.cancel.cancel();
        let _ = self.task.await;
    }
}

async fn run_poll_loop(
    app: AppHandle,
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
                    Some(PollCommand::ReadOnce(cfg, responder)) => {
                        let result = read_cycle(&mut client, &cfg, session_id, &mut sequence, &mut stats).await;
                        let fatal = matches!(&result, Err(ReadOutcome::Fatal(_)));
                        let _ = responder.send(result.map_err(|e| e.into_app_error()));
                        if fatal {
                            let _ = app.emit("connection-lost", &AppError::ConnectionLost {
                                reason: "transport closed".to_string(),
                            });
                            break;
                        }
                    }
                    None => break,
                }
            }

            _ = ticker.tick(), if running && config.is_some() => {
                let cfg = config.clone().expect("checked by select guard");
                match read_cycle(&mut client, &cfg, session_id, &mut sequence, &mut stats).await {
                    Ok(result) => {
                        let _ = app.emit("poll-result", &result);
                    }
                    Err(ReadOutcome::Recoverable(err)) => {
                        let _ = app.emit("poll-error", &err);
                    }
                    Err(ReadOutcome::Fatal(err)) => {
                        let _ = app.emit("connection-lost", &err);
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

async fn read_cycle(
    client: &mut ModbusClient,
    cfg: &PollConfig,
    session_id: u64,
    sequence: &mut u64,
    stats: &mut StatsAccumulator,
) -> Result<PollResult, ReadOutcome> {
    let started = Instant::now();
    match client
        .read_registers(cfg.function, cfg.start_address, cfg.quantity, cfg.unit_id)
        .await
    {
        Ok(regs) => {
            let latency_ms = started.elapsed().as_secs_f64() * 1000.0;
            let snapshot = stats.record_success(latency_ms);
            *sequence += 1;
            let registers = decode_block(&regs, cfg.start_address, &cfg.format);
            Ok(PollResult {
                session_id,
                sequence: *sequence,
                timestamp: Utc::now(),
                latency_ms,
                registers,
                stats: snapshot,
            })
        }
        Err(ReadError::Exception { code, name, hint }) => {
            let err = AppError::ModbusException {
                code,
                name: name.clone(),
                hint: hint.clone(),
            };
            stats.record_failure(err.to_string(), false);
            Err(ReadOutcome::Recoverable(err))
        }
        Err(ReadError::Timeout) => {
            let err = AppError::Timeout {
                unit_id: cfg.unit_id,
                timeout_ms: cfg.interval_ms,
                attempts: 1,
            };
            stats.record_failure(err.to_string(), true);
            Err(ReadOutcome::Recoverable(err))
        }
        Err(ReadError::Transport(reason)) => {
            let err = AppError::ConnectionLost { reason };
            stats.record_failure(err.to_string(), false);
            Err(ReadOutcome::Fatal(err))
        }
    }
}
