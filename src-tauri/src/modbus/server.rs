//! Simulator TCP server. Wires `ModbusStore` up as a `tokio_modbus::server::Service`
//! and runs it behind a cancellable `Server` task — the M4 "spike the server API"
//! risk called out in PLAN.md §6.
//!
//! M4 foundation: exercised by this file's own tests, not yet wired to a
//! `sim_start` command (that's the next M4 slice — commands + UI).
#![allow(dead_code)]

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;

use tokio::net::TcpListener;
use tokio_modbus::server::tcp::{accept_tcp_connection, Server};
use tokio_modbus::server::Service;
use tokio_modbus::{ExceptionCode, Request, Response, SlaveRequest};
use tokio_util::sync::CancellationToken;

use super::store::ModbusStore;

#[derive(Clone)]
pub struct SimulatorService {
    store: Arc<ModbusStore>,
}

impl Service for SimulatorService {
    type Request = SlaveRequest<'static>;
    type Response = Response;
    type Exception = ExceptionCode;
    type Future = Pin<Box<dyn Future<Output = Result<Response, ExceptionCode>> + Send>>;

    fn call(&self, req: SlaveRequest<'static>) -> Self::Future {
        let store = self.store.clone();
        Box::pin(async move { handle_request(&store, req) })
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
    cancel: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl SimulatorServer {
    pub async fn bind(addr: SocketAddr, store: Arc<ModbusStore>) -> std::io::Result<Self> {
        let listener = TcpListener::bind(addr).await?;
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let service_store = store.clone();

        let task = tokio::spawn(async move {
            let server = Server::new(listener);
            let new_service = move |_socket_addr: SocketAddr| {
                Ok(Some(SimulatorService {
                    store: service_store.clone(),
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
            cancel,
            task,
        })
    }

    pub fn store(&self) -> Arc<ModbusStore> {
        self.store.clone()
    }

    pub async fn shutdown(self) {
        self.cancel.cancel();
        let _ = self.task.await;
    }
}

#[cfg(test)]
mod tests {
    //! Round-trips ModbusOpen's own (already-tested) `ModbusClient` against
    //! this server — the same "eat your own dog food" pattern as
    //! `client::smoke`, just proving the *server* half instead of the client
    //! half. No external process needed, unlike the `testrig/slave.py` tests.
    use super::*;
    use crate::modbus::client::ModbusClient;
    use crate::modbus::store::SlaveLayout;
    use crate::modbus::types::TcpConfig;

    async fn start_test_server(layouts: &[(u8, SlaveLayout)]) -> (SimulatorServer, u16) {
        let store = Arc::new(ModbusStore::new());
        store.reset(layouts);
        // Port 0 asks the OS for a free ephemeral port so parallel test runs
        // never collide.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let server = SimulatorServer::bind(format!("127.0.0.1:{port}").parse().unwrap(), store)
            .await
            .unwrap();
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
        let (server, port) = start_test_server(&[(1, layout(10))]).await;
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
        let (server, port) = start_test_server(&[(1, layout(10))]).await;
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
    async fn two_slave_ids_answer_independently_on_one_port() {
        let (server, port) = start_test_server(&[(1, layout(4)), (2, layout(4))]).await;
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
        let (server, port) = start_test_server(&[(1, layout(4))]).await;
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
}
