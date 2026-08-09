//! Simulator TCP server. Wires `ModbusStore` up as a `tokio_modbus::server::Service`
//! and runs it behind a cancellable `Server` task — the M4 "spike the server API"
//! risk called out in PLAN.md §6.
//!
//! Every successful write emits `sim-update` with a full snapshot, per the
//! documented IPC contract (`docs/03-architecture.md#events`) — the UI never
//! polls for live simulator state.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Runtime};
use tokio::net::TcpListener;
use tokio_modbus::server::tcp::{accept_tcp_connection, Server};
use tokio_modbus::server::Service;
use tokio_modbus::{ExceptionCode, Request, Response, SlaveRequest};
use tokio_util::sync::CancellationToken;

use super::animate::AnimationEngine;
use super::store::ModbusStore;
use super::types::{SimulatorSnapshot, SlaveSnapshot, TagConfig};

fn mutates_store(req: &Request<'_>) -> bool {
    matches!(
        req,
        Request::WriteSingleCoil(..)
            | Request::WriteMultipleCoils(..)
            | Request::WriteSingleRegister(..)
            | Request::WriteMultipleRegisters(..)
    )
}

fn build_snapshot(store: &ModbusStore, session_id: u64, tcp_port: u16) -> SimulatorSnapshot {
    let slaves = store
        .snapshot()
        .into_iter()
        .map(|(unit_id, s)| SlaveSnapshot {
            unit_id,
            coils: s.coils,
            discrete_inputs: s.discrete_inputs,
            input_registers: s.input_registers,
            holding_registers: s.holding_registers,
        })
        .collect();
    SimulatorSnapshot {
        session_id,
        tcp_port,
        slaves,
    }
}

#[derive(Clone)]
pub struct SimulatorService<R: Runtime> {
    store: Arc<ModbusStore>,
    app: AppHandle<R>,
    session_id: u64,
    tcp_port: u16,
}

impl<R: Runtime> Service for SimulatorService<R> {
    type Request = SlaveRequest<'static>;
    type Response = Response;
    type Exception = ExceptionCode;
    type Future = Pin<Box<dyn Future<Output = Result<Response, ExceptionCode>> + Send>>;

    fn call(&self, req: SlaveRequest<'static>) -> Self::Future {
        let store = self.store.clone();
        let app = self.app.clone();
        let session_id = self.session_id;
        let tcp_port = self.tcp_port;
        let mutates = mutates_store(&req.request);
        Box::pin(async move {
            let result = handle_request(&store, req);
            if mutates && result.is_ok() {
                let _ = app.emit("sim-update", build_snapshot(&store, session_id, tcp_port));
            }
            result
        })
    }
}

fn handle_request(
    store: &ModbusStore,
    req: SlaveRequest<'static>,
) -> Result<Response, ExceptionCode> {
    let unit_id = req.slave;
    match req.request {
        Request::ReadCoils(addr, qty) => store
            .read_coils(unit_id, addr, qty)
            .map(Response::ReadCoils),
        Request::ReadDiscreteInputs(addr, qty) => store
            .read_discrete_inputs(unit_id, addr, qty)
            .map(Response::ReadDiscreteInputs),
        Request::ReadInputRegisters(addr, qty) => store
            .read_input_registers(unit_id, addr, qty)
            .map(Response::ReadInputRegisters),
        Request::ReadHoldingRegisters(addr, qty) => store
            .read_holding_registers(unit_id, addr, qty)
            .map(Response::ReadHoldingRegisters),
        Request::WriteSingleCoil(addr, value) => store
            .write_single_coil(unit_id, addr, value)
            .map(|()| Response::WriteSingleCoil(addr, value)),
        Request::WriteMultipleCoils(addr, values) => {
            let qty = values.len() as u16;
            store
                .write_multiple_coils(unit_id, addr, &values)
                .map(|()| Response::WriteMultipleCoils(addr, qty))
        }
        Request::WriteSingleRegister(addr, value) => store
            .write_single_register(unit_id, addr, value)
            .map(|()| Response::WriteSingleRegister(addr, value)),
        Request::WriteMultipleRegisters(addr, values) => {
            let qty = values.len() as u16;
            store
                .write_multiple_registers(unit_id, addr, &values)
                .map(|()| Response::WriteMultipleRegisters(addr, qty))
        }
        _ => Err(ExceptionCode::IllegalFunction),
    }
}

/// A running simulator TCP server. Dropping/`shutdown`ing cancels the accept
/// loop; in-flight requests are not aborted mid-frame.
pub struct SimulatorServer {
    store: Arc<ModbusStore>,
    session_id: u64,
    tcp_port: u16,
    cancel: CancellationToken,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl SimulatorServer {
    /// Binds to `addr` (port `0` picks a free ephemeral port — read it back
    /// via `tcp_port()`) and starts accepting connections in the background.
    pub async fn bind<R: Runtime>(
        addr: SocketAddr,
        store: Arc<ModbusStore>,
        app: AppHandle<R>,
        session_id: u64,
    ) -> std::io::Result<Self> {
        let listener = TcpListener::bind(addr).await?;
        let tcp_port = listener.local_addr()?.port();
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let service_store = store.clone();

        let task = tokio::spawn(async move {
            let server = Server::new(listener);
            let new_service = move |_socket_addr: SocketAddr| {
                Ok(Some(SimulatorService {
                    store: service_store.clone(),
                    app: app.clone(),
                    session_id,
                    tcp_port,
                }))
            };
            let on_connected = move |stream, socket_addr| {
                let new_service = new_service.clone();
                async move { accept_tcp_connection(stream, socket_addr, new_service) }
            };
            let _ = server
                .serve_until(&on_connected, |_err| {}, task_cancel.cancelled_owned())
                .await;
        });

        Ok(Self {
            store,
            session_id,
            tcp_port,
            cancel,
            tasks: vec![task],
        })
    }

    /// Starts the tag-animation ticker, if there's anything to animate.
    /// Shares this server's cancellation token, so `shutdown()` stops it
    /// along with the accept loop.
    pub fn start_animation<R: Runtime>(
        &mut self,
        app: AppHandle<R>,
        tags: Vec<(u8, TagConfig)>,
        tick_ms: u64,
    ) {
        let mut engine = AnimationEngine::new(tags);
        if engine.is_empty() {
            return;
        }
        let store = self.store.clone();
        let session_id = self.session_id;
        let tcp_port = self.tcp_port;
        let cancel = self.cancel.clone();
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(tick_ms.max(1)));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    () = cancel.cancelled() => break,
                    _ = interval.tick() => {
                        engine.tick(&store);
                        let _ = app.emit(
                            "sim-update",
                            build_snapshot(&store, session_id, tcp_port),
                        );
                    }
                }
            }
        });
        self.tasks.push(task);
    }

    pub fn store(&self) -> Arc<ModbusStore> {
        self.store.clone()
    }

    pub fn session_id(&self) -> u64 {
        self.session_id
    }

    pub fn tcp_port(&self) -> u16 {
        self.tcp_port
    }

    pub fn snapshot(&self) -> SimulatorSnapshot {
        build_snapshot(&self.store, self.session_id, self.tcp_port)
    }

    pub async fn shutdown(self) {
        self.cancel.cancel();
        for task in self.tasks {
            let _ = task.await;
        }
    }
}

#[cfg(test)]
mod tests {
    //! Round-trips ModbusOpen's own (already-tested) `ModbusClient` against
    //! this server — the same "eat your own dog food" pattern as
    //! `client::smoke`, just proving the *server* half instead of the client
    //! half. No external process needed, unlike the `testrig/slave.py` tests.
    use std::sync::{Arc as StdArc, Mutex as StdMutex};

    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri::{App, Listener};

    use super::*;
    use crate::modbus::client::ModbusClient;
    use crate::modbus::store::SlaveLayout;
    use crate::modbus::types::TcpConfig;

    fn test_app() -> App<MockRuntime> {
        mock_builder()
            .build(mock_context(noop_assets()))
            .expect("failed to build mock tauri app")
    }

    async fn start_test_server(
        app: &App<MockRuntime>,
        layouts: &[(u8, SlaveLayout)],
    ) -> (SimulatorServer, u16) {
        let store = Arc::new(ModbusStore::new());
        store.reset(layouts);
        // Port 0 asks the OS for a free ephemeral port so parallel test runs
        // never collide.
        let server = SimulatorServer::bind(
            "127.0.0.1:0".parse().unwrap(),
            store,
            app.handle().clone(),
            1,
        )
        .await
        .unwrap();
        let port = server.tcp_port();
        (server, port)
    }

    async fn connect(port: u16, unit_id: u8) -> ModbusClient {
        let config = TcpConfig {
            host: "127.0.0.1".into(),
            port,
            unit_id,
            timeout_ms: 1000,
            retries: 1,
        };
        ModbusClient::connect_tcp(&config)
            .await
            .expect("connect to simulator")
    }

    fn layout(holding: u16) -> SlaveLayout {
        SlaveLayout {
            coil_count: 8,
            discrete_count: 8,
            input_register_count: 0,
            holding_register_count: holding,
        }
    }

    #[tokio::test]
    async fn scanner_reads_values_written_directly_into_the_store() {
        let app = test_app();
        let (server, port) = start_test_server(&app, &[(1, layout(10))]).await;
        server
            .store()
            .write_multiple_registers(1, 0, &[231, 15, 50])
            .unwrap();

        let mut client = connect(port, 1).await;
        let regs = client
            .read_registers(
                crate::modbus::types::FunctionCode::ReadHoldingRegisters,
                0,
                3,
                1,
            )
            .await
            .unwrap();
        assert_eq!(regs, vec![231, 15, 50]);

        client.disconnect().await;
        server.shutdown().await;
    }

    #[tokio::test]
    async fn write_from_a_client_updates_the_store() {
        let app = test_app();
        let (server, port) = start_test_server(&app, &[(1, layout(10))]).await;
        let mut client = connect(port, 1).await;

        client.write_single_register(5, 4242, 1).await.unwrap();
        client.disconnect().await;

        assert_eq!(
            server.store().read_holding_registers(1, 5, 1).unwrap(),
            vec![4242]
        );
        server.shutdown().await;
    }

    #[tokio::test]
    async fn write_from_a_client_emits_sim_update() {
        let app = test_app();
        let events: StdArc<StdMutex<Vec<String>>> = StdArc::new(StdMutex::new(Vec::new()));
        let sink = events.clone();
        app.handle().listen("sim-update", move |event| {
            sink.lock().unwrap().push(event.payload().to_string());
        });

        let (server, port) = start_test_server(&app, &[(1, layout(10))]).await;
        let mut client = connect(port, 1).await;
        client.write_single_register(2, 999, 1).await.unwrap();
        client.disconnect().await;

        for _ in 0..50 {
            if !events.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let payload = events.lock().unwrap().last().cloned();
        let payload = payload.expect("expected a sim-update event after a write");
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(value["slaves"][0]["holdingRegisters"][2], 999);

        server.shutdown().await;
    }

    /// A meter built in the editor and loaded into the simulator must actually
    /// produce live data on the function code that profile reads. Both halves
    /// of this have been broken before: profiles carried no tags at all (so
    /// every register stayed 0), and FC04 profiles had a zero-sized
    /// input-register block.
    #[tokio::test]
    async fn a_user_profile_simulates_live_data_on_its_own_function_code() {
        use crate::modbus::meters::{profile_to_simulator_config, test_support::sample_profile};
        use crate::modbus::types::FunctionCode;

        for function in [
            FunctionCode::ReadHoldingRegisters,
            FunctionCode::ReadInputRegisters,
        ] {
            let profile = sample_profile("mine", function);
            let cfg = profile_to_simulator_config(&profile, 0, 10);
            let slave = &cfg.slaves[0];
            assert!(
                !slave.tags.is_empty(),
                "{function:?}: no animated tags — the simulator would serve all zeros"
            );

            let app = test_app();
            let store = Arc::new(ModbusStore::new());
            store.reset(&[(
                slave.unit_id,
                SlaveLayout {
                    coil_count: slave.coil_count,
                    discrete_count: slave.discrete_count,
                    input_register_count: slave.input_register_count,
                    holding_register_count: slave.holding_register_count,
                },
            )]);
            let mut server = SimulatorServer::bind(
                "127.0.0.1:0".parse().unwrap(),
                store,
                app.handle().clone(),
                1,
            )
            .await
            .unwrap();
            let port = server.tcp_port();
            let tags: Vec<(u8, TagConfig)> = slave
                .tags
                .iter()
                .map(|t| (slave.unit_id, t.clone()))
                .collect();
            server.start_animation(app.handle().clone(), tags, 10);

            // Let the ticker run at least once.
            tokio::time::sleep(std::time::Duration::from_millis(80)).await;

            let mut client = connect(port, slave.unit_id).await;
            let regs = client
                .read_registers(
                    profile.function,
                    profile.block_start,
                    profile.block_count,
                    slave.unit_id,
                )
                .await
                .unwrap_or_else(|e| {
                    panic!(
                        "{function:?} read of {} regs at {} failed: {e:?}",
                        profile.block_count, profile.block_start
                    )
                });
            assert!(
                regs.iter().any(|&r| r != 0),
                "{function:?} block at {} is all zeros after animation",
                profile.block_start
            );

            // Per tag, not just per block: one data type could fail to encode
            // and the block would still look alive from the other tags. The
            // scaled uint16 current is the one that reads as a dead 0 when the
            // scale is applied twice.
            for tag in &slave.tags {
                let span = tag.format.data_type.register_span() as usize;
                let off = tag.address as usize - profile.block_start as usize;
                let words = &regs[off..off + span];
                let (value, err) = crate::modbus::codec::decode(words, &tag.format);
                assert!(
                    err.is_none(),
                    "tag '{}' decoded with an error: {err:?}",
                    tag.name
                );
                let n = match value {
                    crate::modbus::types::TypedValue::Float(v) => v,
                    crate::modbus::types::TypedValue::Int(v) => v as f64,
                    crate::modbus::types::TypedValue::Uint(v) => v as f64,
                    other => panic!("tag '{}' decoded as {other:?}", tag.name),
                };
                assert!(n.is_finite(), "tag '{}' decoded as {n}", tag.name);
                assert!(
                    n != 0.0,
                    "tag '{}' ({:?} {:?}) reads 0 but its behaviour {:?} can't produce 0 \
                     — it never animated",
                    tag.name,
                    tag.format.data_type,
                    tag.format.word_order,
                    tag.behavior
                );
            }

            // Input-register profiles must not be accidentally served from the
            // holding block by the request handler.
            if function == FunctionCode::ReadInputRegisters {
                assert!(
                    slave.input_register_count > 0,
                    "FC04 profile has no input registers"
                );
            }
            client.disconnect().await;
            server.shutdown().await;
        }
    }

    #[tokio::test]
    async fn two_slave_ids_answer_independently_on_one_port() {
        let app = test_app();
        let (server, port) = start_test_server(&app, &[(1, layout(4)), (2, layout(4))]).await;
        server
            .store()
            .write_multiple_registers(1, 0, &[1, 1, 1, 1])
            .unwrap();
        server
            .store()
            .write_multiple_registers(2, 0, &[2, 2, 2, 2])
            .unwrap();

        let mut client1 = connect(port, 1).await;
        let regs1 = client1
            .read_registers(
                crate::modbus::types::FunctionCode::ReadHoldingRegisters,
                0,
                4,
                1,
            )
            .await
            .unwrap();
        assert_eq!(regs1, vec![1, 1, 1, 1]);
        client1.disconnect().await;

        let mut client2 = connect(port, 2).await;
        let regs2 = client2
            .read_registers(
                crate::modbus::types::FunctionCode::ReadHoldingRegisters,
                0,
                4,
                2,
            )
            .await
            .unwrap();
        assert_eq!(regs2, vec![2, 2, 2, 2]);
        client2.disconnect().await;

        server.shutdown().await;
    }

    #[tokio::test]
    async fn out_of_range_read_surfaces_as_illegal_data_address_to_the_client() {
        let app = test_app();
        let (server, port) = start_test_server(&app, &[(1, layout(4))]).await;
        let mut client = connect(port, 1).await;

        let err = client
            .read_registers(
                crate::modbus::types::FunctionCode::ReadHoldingRegisters,
                0,
                50,
                1,
            )
            .await
            .unwrap_err();
        match err {
            crate::modbus::client::ReadError::Exception { code, .. } => assert_eq!(code, 2),
            other => panic!("expected exception 2 (illegal data address), got {other:?}"),
        }

        client.disconnect().await;
        server.shutdown().await;
    }

    #[tokio::test]
    async fn animated_tag_is_visible_to_an_external_client_and_keeps_ticking() {
        use crate::modbus::types::{DataFormat, DataType, TagBehavior, TagConfig, WordOrder};

        let app = test_app();
        let (mut server, port) = start_test_server(&app, &[(1, layout(4))]).await;
        server.start_animation(
            app.handle().clone(),
            vec![(
                1,
                TagConfig {
                    name: "counter".into(),
                    address: 0,
                    format: DataFormat {
                        data_type: DataType::Uint16,
                        word_order: WordOrder::Cdab,
                        scale: 1.0,
                        offset: 0.0,
                    },
                    behavior: TagBehavior::Counter { step: 1.0 },
                    initial_value: 0.0,
                },
            )],
            20,
        );

        let mut client = connect(port, 1).await;
        let mut first: Option<u16> = None;
        let mut saw_increase = false;
        for _ in 0..50 {
            let regs = client
                .read_registers(
                    crate::modbus::types::FunctionCode::ReadHoldingRegisters,
                    0,
                    1,
                    1,
                )
                .await
                .unwrap();
            match first {
                None => first = Some(regs[0]),
                Some(f) if regs[0] > f => {
                    saw_increase = true;
                    break;
                }
                _ => {}
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(saw_increase, "counter tag never incremented");

        client.disconnect().await;
        server.shutdown().await;
    }
}
