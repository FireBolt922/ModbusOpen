//! Tag animation. One `AnimationEngine` per running simulator session — a
//! Tokio task ticks it on an interval and writes the results straight into
//! the `ModbusStore`, the same store the TCP server reads from, so a poll
//! landing between two ticks always sees a consistent value.

use std::time::{Duration, Instant};

use super::codec::encode;
use super::store::ModbusStore;
use super::types::{DataType, TagBehavior, TagConfig, TypedValue, WireAddress};

fn typed_value_for(data_type: DataType, v: f64) -> Option<TypedValue> {
    match data_type {
        DataType::Bool => Some(TypedValue::Bool(v != 0.0)),
        DataType::Uint16
        | DataType::Hex16
        | DataType::Binary16
        | DataType::Uint32
        | DataType::Uint64 => Some(TypedValue::Uint(v.max(0.0) as u64)),
        DataType::Int16 | DataType::Int32 | DataType::Int64 => Some(TypedValue::Int(v as i64)),
        DataType::Float32 | DataType::Float64 => Some(TypedValue::Float(v)),
        DataType::String => None,
    }
}

struct TagRuntime {
    unit_id: u8,
    config: TagConfig,
    current: f64,
    ramp_direction: f64,
}

impl TagRuntime {
    fn new(unit_id: u8, config: TagConfig) -> Self {
        let current = config.initial_value;
        Self {
            unit_id,
            config,
            current,
            ramp_direction: 1.0,
        }
    }

    /// `random_unit` is a caller-supplied uniform value in `[0, 1)` — kept as
    /// a parameter (instead of calling `fastrand` in here) so this method
    /// stays a pure function and is trivial to test deterministically.
    fn step(&mut self, elapsed: Duration, random_unit: f64) -> f64 {
        match self.config.behavior {
            TagBehavior::Static => self.current,
            TagBehavior::Random { min, max } => {
                self.current = min + random_unit * (max - min);
                self.current
            }
            TagBehavior::Ramp { min, max, step } => {
                let mut next = self.current + self.ramp_direction * step;
                if next >= max {
                    next = max;
                    self.ramp_direction = -1.0;
                } else if next <= min {
                    next = min;
                    self.ramp_direction = 1.0;
                }
                self.current = next;
                next
            }
            TagBehavior::Sine { min, max, period_s } => {
                let mid = (min + max) / 2.0;
                let amplitude = (max - min) / 2.0;
                let phase = if period_s > 0.0 {
                    2.0 * std::f64::consts::PI * elapsed.as_secs_f64() / period_s
                } else {
                    0.0
                };
                self.current = mid + amplitude * phase.sin();
                self.current
            }
            TagBehavior::Counter { step } => {
                self.current += step;
                self.current
            }
        }
    }

    fn write_into(&self, store: &ModbusStore, value: f64) {
        let Some(typed) = typed_value_for(self.config.format.data_type, value) else {
            return;
        };
        let Ok(regs) = encode(&typed, &self.config.format) else {
            return;
        };
        let _ = if regs.len() == 1 {
            store.write_single_register(self.unit_id, self.config.address, regs[0])
        } else {
            store.write_multiple_registers(self.unit_id, self.config.address, &regs)
        };
    }
}

/// Drives every animated tag across every slave in one simulator session.
pub struct AnimationEngine {
    tags: Vec<TagRuntime>,
    started: Instant,
}

impl AnimationEngine {
    pub fn new(tags: Vec<(u8, TagConfig)>) -> Self {
        Self {
            tags: tags
                .into_iter()
                .map(|(unit_id, config)| TagRuntime::new(unit_id, config))
                .collect(),
            started: Instant::now(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.tags.is_empty()
    }

    /// Computes every tag's next value and writes it straight into `store`.
    pub fn tick(&mut self, store: &ModbusStore) {
        let elapsed = self.started.elapsed();
        for tag in &mut self.tags {
            let value = tag.step(elapsed, fastrand::f64());
            tag.write_into(store, value);
        }
    }
}

/// Wire-address bounds check for a tag against its slave's holding-register
/// block — shared by `validate_simulator_config` and any future profile
/// loader, so the rule lives in one place.
pub fn tag_fits(address: WireAddress, data_type: DataType, holding_register_count: u16) -> bool {
    let span = data_type.register_span() as u32;
    (address as u32) + span <= holding_register_count as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modbus::types::{DataFormat, WordOrder};

    fn format(data_type: DataType) -> DataFormat {
        DataFormat {
            data_type,
            word_order: WordOrder::Cdab,
            scale: 1.0,
            offset: 0.0,
        }
    }

    fn tag(behavior: TagBehavior, initial_value: f64) -> TagConfig {
        TagConfig {
            name: "test".into(),
            address: 0,
            format: format(DataType::Uint16),
            behavior,
            initial_value,
        }
    }

    #[test]
    fn static_tag_never_changes() {
        let mut rt = TagRuntime::new(1, tag(TagBehavior::Static, 42.0));
        assert_eq!(rt.step(Duration::ZERO, 0.9), 42.0);
        assert_eq!(rt.step(Duration::from_secs(10), 0.1), 42.0);
    }

    #[test]
    fn counter_accumulates_by_step_each_tick() {
        let mut rt = TagRuntime::new(1, tag(TagBehavior::Counter { step: 5.0 }, 100.0));
        assert_eq!(rt.step(Duration::ZERO, 0.0), 105.0);
        assert_eq!(rt.step(Duration::ZERO, 0.0), 110.0);
        assert_eq!(rt.step(Duration::ZERO, 0.0), 115.0);
    }

    #[test]
    fn random_stays_within_bounds_and_uses_the_given_unit_value() {
        let mut rt = TagRuntime::new(
            1,
            tag(
                TagBehavior::Random {
                    min: 10.0,
                    max: 20.0,
                },
                0.0,
            ),
        );
        assert_eq!(rt.step(Duration::ZERO, 0.0), 10.0);
        assert_eq!(rt.step(Duration::ZERO, 1.0), 20.0);
        assert_eq!(rt.step(Duration::ZERO, 0.5), 15.0);
    }

    #[test]
    fn ramp_bounces_between_min_and_max_like_a_triangle_wave() {
        let mut rt = TagRuntime::new(
            1,
            tag(
                TagBehavior::Ramp {
                    min: 0.0,
                    max: 10.0,
                    step: 4.0,
                },
                0.0,
            ),
        );
        assert_eq!(rt.step(Duration::ZERO, 0.0), 4.0);
        assert_eq!(rt.step(Duration::ZERO, 0.0), 8.0);
        assert_eq!(rt.step(Duration::ZERO, 0.0), 10.0); // clamped, direction flips
        assert_eq!(rt.step(Duration::ZERO, 0.0), 6.0);
        assert_eq!(rt.step(Duration::ZERO, 0.0), 2.0);
        assert_eq!(rt.step(Duration::ZERO, 0.0), 0.0); // clamped again
    }

    #[test]
    fn sine_matches_known_phase_points() {
        let mut rt = TagRuntime::new(
            1,
            tag(
                TagBehavior::Sine {
                    min: 0.0,
                    max: 10.0,
                    period_s: 4.0,
                },
                0.0,
            ),
        );
        // mid=5, amplitude=5. At t=0: sin(0)=0 -> 5. At t=1 (quarter period):
        // sin(pi/2)=1 -> 10 (peak). At t=2 (half period): sin(pi)=0 -> 5.
        assert!((rt.step(Duration::from_secs(0), 0.0) - 5.0).abs() < 1e-9);
        assert!((rt.step(Duration::from_secs(1), 0.0) - 10.0).abs() < 1e-9);
        assert!((rt.step(Duration::from_secs(2), 0.0) - 5.0).abs() < 1e-6);
    }

    #[test]
    fn tick_writes_computed_values_into_the_store() {
        let store = ModbusStore::new();
        store.reset(&[(
            1,
            crate::modbus::store::SlaveLayout {
                coil_count: 0,
                discrete_count: 0,
                input_register_count: 0,
                holding_register_count: 4,
            },
        )]);
        let mut engine =
            AnimationEngine::new(vec![(1, tag(TagBehavior::Counter { step: 1.0 }, 9.0))]);
        assert!(!engine.is_empty());
        engine.tick(&store);
        assert_eq!(store.read_holding_registers(1, 0, 1).unwrap(), vec![10]);
        engine.tick(&store);
        assert_eq!(store.read_holding_registers(1, 0, 1).unwrap(), vec![11]);
    }

    #[test]
    fn tag_fits_rejects_a_span_past_the_block_end() {
        assert!(tag_fits(48, DataType::Uint16, 50));
        assert!(!tag_fits(49, DataType::Float32, 50)); // needs 2 regs, only 1 left
        assert!(tag_fits(48, DataType::Float32, 50));
    }
}
