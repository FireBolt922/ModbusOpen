//! Simulator datastore. One `SlaveStore` per unit ID: coils, discretes,
//! input registers, holding registers. `ModbusStore` is the shared,
//! lock-protected map the server task and the animation ticker both touch.
//! No `.await` is ever held across a lock — every method here is a quick,
//! synchronous read/write — so a plain `std::sync::Mutex` is correct and
//! avoids the tokio-mutex cost on the hot request path.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio_modbus::{Address, ExceptionCode, Quantity};

#[derive(Debug, Clone, Default)]
pub struct SlaveStore {
    pub coils: Vec<bool>,
    pub discrete_inputs: Vec<bool>,
    pub input_registers: Vec<u16>,
    pub holding_registers: Vec<u16>,
}

/// A slave's register/coil block sizes, all zero-initialized.
#[derive(Debug, Clone, Copy)]
pub struct SlaveLayout {
    pub coil_count: u16,
    pub discrete_count: u16,
    pub input_register_count: u16,
    pub holding_register_count: u16,
}

impl SlaveStore {
    fn new(layout: SlaveLayout) -> Self {
        Self {
            coils: vec![false; layout.coil_count as usize],
            discrete_inputs: vec![false; layout.discrete_count as usize],
            input_registers: vec![0; layout.input_register_count as usize],
            holding_registers: vec![0; layout.holding_register_count as usize],
        }
    }
}

fn read_bits(bits: &[bool], addr: Address, qty: Quantity) -> Result<Vec<bool>, ExceptionCode> {
    let start = addr as usize;
    let end = start
        .checked_add(qty as usize)
        .ok_or(ExceptionCode::IllegalDataAddress)?;
    bits.get(start..end)
        .map(<[bool]>::to_vec)
        .ok_or(ExceptionCode::IllegalDataAddress)
}

fn read_words(words: &[u16], addr: Address, qty: Quantity) -> Result<Vec<u16>, ExceptionCode> {
    let start = addr as usize;
    let end = start
        .checked_add(qty as usize)
        .ok_or(ExceptionCode::IllegalDataAddress)?;
    words
        .get(start..end)
        .map(<[u16]>::to_vec)
        .ok_or(ExceptionCode::IllegalDataAddress)
}

fn write_bit(bits: &mut [bool], addr: Address, value: bool) -> Result<(), ExceptionCode> {
    let slot = bits
        .get_mut(addr as usize)
        .ok_or(ExceptionCode::IllegalDataAddress)?;
    *slot = value;
    Ok(())
}

fn write_bits(bits: &mut [bool], addr: Address, values: &[bool]) -> Result<(), ExceptionCode> {
    let start = addr as usize;
    let end = start
        .checked_add(values.len())
        .ok_or(ExceptionCode::IllegalDataAddress)?;
    let target = bits
        .get_mut(start..end)
        .ok_or(ExceptionCode::IllegalDataAddress)?;
    target.copy_from_slice(values);
    Ok(())
}

fn write_word(words: &mut [u16], addr: Address, value: u16) -> Result<(), ExceptionCode> {
    let slot = words
        .get_mut(addr as usize)
        .ok_or(ExceptionCode::IllegalDataAddress)?;
    *slot = value;
    Ok(())
}

fn write_words(words: &mut [u16], addr: Address, values: &[u16]) -> Result<(), ExceptionCode> {
    let start = addr as usize;
    let end = start
        .checked_add(values.len())
        .ok_or(ExceptionCode::IllegalDataAddress)?;
    let target = words
        .get_mut(start..end)
        .ok_or(ExceptionCode::IllegalDataAddress)?;
    target.copy_from_slice(values);
    Ok(())
}

/// Shared, multi-slave simulator datastore. Cheap to clone (it's an `Arc`
/// internally via the caller holding one); every method locks briefly and
/// returns.
#[derive(Default)]
pub struct ModbusStore {
    slaves: Mutex<HashMap<u8, SlaveStore>>,
}

impl ModbusStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replaces the whole datastore with fresh, zero-filled slaves. Used by
    /// `sim_start` / `sim_load_profile` — never partially applied.
    pub fn reset(&self, layouts: &[(u8, SlaveLayout)]) {
        let mut slaves = self.slaves.lock().unwrap();
        slaves.clear();
        for (unit_id, layout) in layouts {
            slaves.insert(*unit_id, SlaveStore::new(*layout));
        }
    }

    fn with_slave<T>(
        &self,
        unit_id: u8,
        f: impl FnOnce(&SlaveStore) -> Result<T, ExceptionCode>,
    ) -> Result<T, ExceptionCode> {
        let slaves = self.slaves.lock().unwrap();
        let slave = slaves
            .get(&unit_id)
            .ok_or(ExceptionCode::GatewayTargetDevice)?;
        f(slave)
    }

    fn with_slave_mut<T>(
        &self,
        unit_id: u8,
        f: impl FnOnce(&mut SlaveStore) -> Result<T, ExceptionCode>,
    ) -> Result<T, ExceptionCode> {
        let mut slaves = self.slaves.lock().unwrap();
        let slave = slaves
            .get_mut(&unit_id)
            .ok_or(ExceptionCode::GatewayTargetDevice)?;
        f(slave)
    }

    pub fn read_coils(
        &self,
        unit_id: u8,
        addr: Address,
        qty: Quantity,
    ) -> Result<Vec<bool>, ExceptionCode> {
        self.with_slave(unit_id, |s| read_bits(&s.coils, addr, qty))
    }

    pub fn read_discrete_inputs(
        &self,
        unit_id: u8,
        addr: Address,
        qty: Quantity,
    ) -> Result<Vec<bool>, ExceptionCode> {
        self.with_slave(unit_id, |s| read_bits(&s.discrete_inputs, addr, qty))
    }

    pub fn read_input_registers(
        &self,
        unit_id: u8,
        addr: Address,
        qty: Quantity,
    ) -> Result<Vec<u16>, ExceptionCode> {
        self.with_slave(unit_id, |s| read_words(&s.input_registers, addr, qty))
    }

    pub fn read_holding_registers(
        &self,
        unit_id: u8,
        addr: Address,
        qty: Quantity,
    ) -> Result<Vec<u16>, ExceptionCode> {
        self.with_slave(unit_id, |s| read_words(&s.holding_registers, addr, qty))
    }

    /// Simulator-internal seeding of the input-register block.
    ///
    /// Deliberately not a Modbus write path: no function code can write input
    /// registers, so this must never be reachable from `SimulatorService`. It
    /// exists so tag animation can populate the block that FC04 profiles read.
    pub fn seed_input_registers(
        &self,
        unit_id: u8,
        addr: Address,
        values: &[u16],
    ) -> Result<(), ExceptionCode> {
        self.with_slave_mut(unit_id, |s| {
            write_words(&mut s.input_registers, addr, values)
        })
    }

    pub fn write_single_coil(
        &self,
        unit_id: u8,
        addr: Address,
        value: bool,
    ) -> Result<(), ExceptionCode> {
        self.with_slave_mut(unit_id, |s| write_bit(&mut s.coils, addr, value))
    }

    pub fn write_multiple_coils(
        &self,
        unit_id: u8,
        addr: Address,
        values: &[bool],
    ) -> Result<(), ExceptionCode> {
        self.with_slave_mut(unit_id, |s| write_bits(&mut s.coils, addr, values))
    }

    pub fn write_single_register(
        &self,
        unit_id: u8,
        addr: Address,
        value: u16,
    ) -> Result<(), ExceptionCode> {
        self.with_slave_mut(unit_id, |s| {
            write_word(&mut s.holding_registers, addr, value)
        })
    }

    pub fn write_multiple_registers(
        &self,
        unit_id: u8,
        addr: Address,
        values: &[u16],
    ) -> Result<(), ExceptionCode> {
        self.with_slave_mut(unit_id, |s| {
            write_words(&mut s.holding_registers, addr, values)
        })
    }

    /// A consistent, cloned snapshot of every slave, sorted by unit ID — the
    /// source for `sim_snapshot` and the `sim-update` event payload.
    pub fn snapshot(&self) -> Vec<(u8, SlaveStore)> {
        let slaves = self.slaves.lock().unwrap();
        let mut out: Vec<(u8, SlaveStore)> =
            slaves.iter().map(|(id, s)| (*id, s.clone())).collect();
        out.sort_by_key(|(id, _)| *id);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_one_slave(layout: SlaveLayout) -> ModbusStore {
        let store = ModbusStore::new();
        store.reset(&[(1, layout)]);
        store
    }

    #[test]
    fn read_write_holding_registers_round_trip() {
        let store = store_with_one_slave(SlaveLayout {
            coil_count: 0,
            discrete_count: 0,
            input_register_count: 0,
            holding_register_count: 10,
        });
        store.write_multiple_registers(1, 2, &[10, 20, 30]).unwrap();
        assert_eq!(
            store.read_holding_registers(1, 2, 3).unwrap(),
            vec![10, 20, 30]
        );
    }

    #[test]
    fn out_of_range_read_is_illegal_data_address() {
        let store = store_with_one_slave(SlaveLayout {
            coil_count: 0,
            discrete_count: 0,
            input_register_count: 0,
            holding_register_count: 4,
        });
        assert_eq!(
            store.read_holding_registers(1, 2, 5).unwrap_err(),
            ExceptionCode::IllegalDataAddress
        );
    }

    #[test]
    fn unknown_unit_id_is_gateway_target_device() {
        let store = store_with_one_slave(SlaveLayout {
            coil_count: 0,
            discrete_count: 0,
            input_register_count: 0,
            holding_register_count: 4,
        });
        assert_eq!(
            store.read_holding_registers(99, 0, 1).unwrap_err(),
            ExceptionCode::GatewayTargetDevice
        );
    }

    #[test]
    fn write_single_coil_then_read_back() {
        let store = store_with_one_slave(SlaveLayout {
            coil_count: 8,
            discrete_count: 0,
            input_register_count: 0,
            holding_register_count: 0,
        });
        store.write_single_coil(1, 3, true).unwrap();
        assert!(store.read_coils(1, 0, 8).unwrap()[3]);
    }

    #[test]
    fn reset_replaces_all_slaves() {
        let store = store_with_one_slave(SlaveLayout {
            coil_count: 0,
            discrete_count: 0,
            input_register_count: 0,
            holding_register_count: 4,
        });
        store.write_single_register(1, 0, 42).unwrap();
        store.reset(&[(
            2,
            SlaveLayout {
                coil_count: 0,
                discrete_count: 0,
                input_register_count: 0,
                holding_register_count: 4,
            },
        )]);
        assert_eq!(
            store.read_holding_registers(1, 0, 1).unwrap_err(),
            ExceptionCode::GatewayTargetDevice
        );
        assert_eq!(store.read_holding_registers(2, 0, 1).unwrap(), vec![0]);
    }
}
