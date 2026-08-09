//! Registers ⇄ typed values. The highest-risk file in the repo: a word-order
//! bug produces a plausible-looking *wrong number*, not an error. See
//! `docs/reference/data-types-word-order.md` before touching this file.

use super::types::{DataFormat, DataType, DecodedRegister, TypedValue, WireAddress, WordOrder};

/// Assemble two registers into a u32 according to word order.
fn regs_to_u32(regs: [u16; 2], order: WordOrder) -> u32 {
    let (hi, lo) = match order {
        WordOrder::Abcd | WordOrder::Badc => (regs[0], regs[1]),
        WordOrder::Cdab | WordOrder::Dcba => (regs[1], regs[0]),
    };
    let (hi, lo) = match order {
        WordOrder::Abcd | WordOrder::Cdab => (hi, lo),
        WordOrder::Badc | WordOrder::Dcba => (hi.swap_bytes(), lo.swap_bytes()),
    };
    ((hi as u32) << 16) | (lo as u32)
}

/// Inverse of `regs_to_u32`. Exercised by the round-trip tests now; wired
/// into `write_typed` in M3.
#[allow(dead_code)]
fn u32_to_regs(v: u32, order: WordOrder) -> [u16; 2] {
    let hi = (v >> 16) as u16;
    let lo = v as u16;
    let (hi, lo) = match order {
        WordOrder::Abcd | WordOrder::Cdab => (hi, lo),
        WordOrder::Badc | WordOrder::Dcba => (hi.swap_bytes(), lo.swap_bytes()),
    };
    match order {
        WordOrder::Abcd | WordOrder::Badc => [hi, lo],
        WordOrder::Cdab | WordOrder::Dcba => [lo, hi],
    }
}

fn regs_to_u64(regs: [u16; 4], order: WordOrder) -> u64 {
    let words: [u16; 4] = match order {
        WordOrder::Abcd | WordOrder::Badc => regs,
        WordOrder::Cdab | WordOrder::Dcba => [regs[3], regs[2], regs[1], regs[0]],
    };
    let words = match order {
        WordOrder::Abcd | WordOrder::Cdab => words,
        WordOrder::Badc | WordOrder::Dcba => words.map(u16::swap_bytes),
    };
    words.iter().fold(0u64, |acc, &w| (acc << 16) | w as u64)
}

#[allow(dead_code)]
fn u64_to_regs(v: u64, order: WordOrder) -> [u16; 4] {
    let words = [
        (v >> 48) as u16,
        (v >> 32) as u16,
        (v >> 16) as u16,
        v as u16,
    ];
    let words = match order {
        WordOrder::Abcd | WordOrder::Cdab => words,
        WordOrder::Badc | WordOrder::Dcba => words.map(u16::swap_bytes),
    };
    match order {
        WordOrder::Abcd | WordOrder::Badc => words,
        WordOrder::Cdab | WordOrder::Dcba => [words[3], words[2], words[1], words[0]],
    }
}

fn regs_to_f32(regs: [u16; 2], order: WordOrder) -> f32 {
    f32::from_bits(regs_to_u32(regs, order))
}

#[allow(dead_code)]
fn f32_to_regs(v: f32, order: WordOrder) -> [u16; 2] {
    u32_to_regs(v.to_bits(), order)
}

fn regs_to_f64(regs: [u16; 4], order: WordOrder) -> f64 {
    f64::from_bits(regs_to_u64(regs, order))
}

#[allow(dead_code)]
fn f64_to_regs(v: f64, order: WordOrder) -> [u16; 4] {
    u64_to_regs(v.to_bits(), order)
}

/// Apply scale then offset, in that order, after decoding.
fn apply_scale_offset(v: f64, format: &DataFormat) -> f64 {
    v * format.scale + format.offset
}

/// Invert `apply_scale_offset` before encoding a value the user typed in.
#[allow(dead_code)]
fn undo_scale_offset(v: f64, format: &DataFormat) -> f64 {
    (v - format.offset) / format.scale
}

fn is_identity(format: &DataFormat) -> bool {
    format.scale == 1.0 && format.offset == 0.0
}

/// Apply a format's scale to a raw integer register value.
///
/// A *scaled* integer register carries a real quantity — raw 7 at scale 0.1 is
/// 0.7 A — which no integer `TypedValue` can hold, so it decodes as a float.
/// Returning `Uint(0)` there is how a live tag reads as dead.
///
/// At the identity scale (1.0, 0.0) the exact integer is kept, which also
/// avoids the `u64 as f64` round trip that loses precision above 2^53 and
/// would otherwise corrupt the top bits of every unscaled 64-bit read.
fn scale_uint(raw: u64, format: &DataFormat) -> TypedValue {
    if is_identity(format) {
        TypedValue::Uint(raw)
    } else {
        TypedValue::Float(apply_scale_offset(raw as f64, format))
    }
}

fn scale_int(raw: i64, format: &DataFormat) -> TypedValue {
    if is_identity(format) {
        TypedValue::Int(raw)
    } else {
        TypedValue::Float(apply_scale_offset(raw as f64, format))
    }
}

fn unscale_uint(v: u64, format: &DataFormat) -> u64 {
    if is_identity(format) {
        v
    } else {
        undo_scale_offset(v as f64, format) as u64
    }
}

fn unscale_int(v: i64, format: &DataFormat) -> i64 {
    if is_identity(format) {
        v
    } else {
        undo_scale_offset(v as f64, format) as i64
    }
}

/// Decode a raw register slice into a typed value per `format`. Returns
/// `TypedValue::Invalid` (never a fabricated number) plus an explanatory
/// `decode_error` when the block is too short or the bits don't form a
/// sane value (NaN/Inf).
pub fn decode(regs: &[u16], format: &DataFormat) -> (TypedValue, Option<String>) {
    let span = format.data_type.register_span() as usize;
    if format.data_type != DataType::String && regs.len() < span {
        return (
            TypedValue::Invalid,
            Some(format!(
                "need {span} register(s), only {} available",
                regs.len()
            )),
        );
    }

    match format.data_type {
        DataType::Bool => {
            // Only meaningful for coil/discrete blocks, decoded upstream from
            // the packed bit response. A holding/input register path treats
            // any nonzero value as true.
            (TypedValue::Bool(regs[0] != 0), None)
        }
        DataType::Uint16 | DataType::Hex16 | DataType::Binary16 => {
            (scale_uint(regs[0] as u64, format), None)
        }
        DataType::Int16 => (scale_int(regs[0] as i16 as i64, format), None),
        DataType::Uint32 => {
            let v = regs_to_u32([regs[0], regs[1]], format.word_order);
            (scale_uint(v as u64, format), None)
        }
        DataType::Int32 => {
            let v = regs_to_u32([regs[0], regs[1]], format.word_order) as i32;
            (scale_int(v as i64, format), None)
        }
        DataType::Float32 => {
            let v = regs_to_f32([regs[0], regs[1]], format.word_order);
            if v.is_nan() || v.is_infinite() {
                return (
                    TypedValue::Invalid,
                    Some("decoded to NaN/Inf — check word order".to_string()),
                );
            }
            (
                TypedValue::Float(apply_scale_offset(v as f64, format)),
                None,
            )
        }
        DataType::Uint64 => {
            let v = regs_to_u64([regs[0], regs[1], regs[2], regs[3]], format.word_order);
            (scale_uint(v, format), None)
        }
        DataType::Int64 => {
            let v = regs_to_u64([regs[0], regs[1], regs[2], regs[3]], format.word_order) as i64;
            (scale_int(v, format), None)
        }
        DataType::Float64 => {
            let v = regs_to_f64([regs[0], regs[1], regs[2], regs[3]], format.word_order);
            if v.is_nan() || v.is_infinite() {
                return (
                    TypedValue::Invalid,
                    Some("decoded to NaN/Inf — check word order".to_string()),
                );
            }
            (TypedValue::Float(apply_scale_offset(v, format)), None)
        }
        DataType::String => {
            let swap_bytes = matches!(format.word_order, WordOrder::Badc | WordOrder::Dcba);
            let mut bytes = Vec::with_capacity(regs.len() * 2);
            for &reg in regs {
                let [hi, lo] = reg.to_be_bytes();
                if swap_bytes {
                    bytes.push(lo);
                    bytes.push(hi);
                } else {
                    bytes.push(hi);
                    bytes.push(lo);
                }
            }
            while bytes.last() == Some(&0) {
                bytes.pop();
            }
            (
                TypedValue::Text(String::from_utf8_lossy(&bytes).into_owned()),
                None,
            )
        }
    }
}

/// Split a raw register block into per-value rows starting at `start_address`,
/// each `format.data_type.register_span()` registers wide. Used for the
/// scanner's live table.
pub fn decode_block(
    regs: &[u16],
    start_address: WireAddress,
    format: &DataFormat,
) -> Vec<DecodedRegister> {
    if format.data_type == DataType::String {
        let (value, decode_error) = decode(regs, format);
        return vec![DecodedRegister {
            address: start_address,
            span: regs.len() as u8,
            raw: regs.to_vec(),
            value,
            decode_error,
        }];
    }

    let span = format.data_type.register_span().max(1) as usize;
    let mut out = Vec::with_capacity(regs.len() / span);
    let mut offset = 0usize;
    while offset < regs.len() {
        let end = (offset + span).min(regs.len());
        let chunk = &regs[offset..end];
        let (value, decode_error) = decode(chunk, format);
        out.push(DecodedRegister {
            address: start_address.wrapping_add(offset as u16),
            span: chunk.len() as u8,
            raw: chunk.to_vec(),
            value,
            decode_error,
        });
        offset = end;
    }
    out
}

/// Encode a value the user typed in back into wire registers, ready for
/// FC06/FC16. Inverts `apply_scale_offset` before encoding.
pub fn encode(value: &TypedValue, format: &DataFormat) -> Result<Vec<u16>, String> {
    match (format.data_type, value) {
        (DataType::Bool, TypedValue::Bool(b)) => Ok(vec![if *b { 1 } else { 0 }]),
        (DataType::Uint16 | DataType::Hex16 | DataType::Binary16, TypedValue::Uint(v)) => {
            Ok(vec![unscale_uint(*v, format) as u16])
        }
        (DataType::Int16, TypedValue::Int(v)) => Ok(vec![unscale_int(*v, format) as i16 as u16]),
        (DataType::Uint32, TypedValue::Uint(v)) => {
            Ok(u32_to_regs(unscale_uint(*v, format) as u32, format.word_order).to_vec())
        }
        (DataType::Int32, TypedValue::Int(v)) => {
            let raw = unscale_int(*v, format) as i32 as u32;
            Ok(u32_to_regs(raw, format.word_order).to_vec())
        }
        (DataType::Float32, TypedValue::Float(v)) => {
            let raw = undo_scale_offset(*v, format);
            Ok(f32_to_regs(raw as f32, format.word_order).to_vec())
        }
        (DataType::Uint64, TypedValue::Uint(v)) => {
            Ok(u64_to_regs(unscale_uint(*v, format), format.word_order).to_vec())
        }
        (DataType::Int64, TypedValue::Int(v)) => {
            Ok(u64_to_regs(unscale_int(*v, format) as u64, format.word_order).to_vec())
        }
        (DataType::Float64, TypedValue::Float(v)) => {
            let raw = undo_scale_offset(*v, format);
            Ok(f64_to_regs(raw, format.word_order).to_vec())
        }
        // A scaled integer register decodes to a float (raw 7 at scale 0.1 is
        // 0.7 A), so the write path has to take that float back. Undo the
        // scale first, then round — 0.7 / 0.1 is 6.999… in binary.
        (
            DataType::Uint16
            | DataType::Hex16
            | DataType::Binary16
            | DataType::Int16
            | DataType::Uint32
            | DataType::Int32
            | DataType::Uint64
            | DataType::Int64,
            TypedValue::Float(v),
        ) if !is_identity(format) => {
            let raw = undo_scale_offset(*v, format).round();
            let typed = if matches!(
                format.data_type,
                DataType::Int16 | DataType::Int32 | DataType::Int64
            ) {
                TypedValue::Int(raw as i64)
            } else {
                TypedValue::Uint(raw.max(0.0) as u64)
            };
            let identity = DataFormat {
                scale: 1.0,
                offset: 0.0,
                ..*format
            };
            encode(&typed, &identity)
        }
        _ => Err(format!("can't encode {value:?} as {:?}", format.data_type)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fmt(data_type: DataType, word_order: WordOrder) -> DataFormat {
        DataFormat {
            data_type,
            word_order,
            scale: 1.0,
            offset: 0.0,
        }
    }

    // ---- float32, from docs/reference/data-types-word-order.md#test-vectors ----

    #[test]
    fn float32_vectors_all_word_orders() {
        let vectors: &[(f32, [u32; 4])] = &[
            // value, [ABCD, CDAB, BADC, DCBA] as packed u32 hex
            (1.0, [0x3F80_0000, 0x0000_3F80, 0x803F_0000, 0x0000_803F]),
            (-1.0, [0xBF80_0000, 0x0000_BF80, 0x80BF_0000, 0x0000_80BF]),
            (231.0, [0x4367_0000, 0x0000_4367, 0x6743_0000, 0x0000_6743]),
            (50.0, [0x4248_0000, 0x0000_4248, 0x4842_0000, 0x0000_4842]),
            (0.975, [0x3F79_999A, 0x999A_3F79, 0x793F_9A99, 0x9A99_793F]),
            (-1.5, [0xBFC0_0000, 0x0000_BFC0, 0xC0BF_0000, 0x0000_C0BF]),
            (0.0, [0x0000_0000, 0x0000_0000, 0x0000_0000, 0x0000_0000]),
        ];
        let orders = [
            WordOrder::Abcd,
            WordOrder::Cdab,
            WordOrder::Badc,
            WordOrder::Dcba,
        ];

        for &(value, packed) in vectors {
            for (i, &order) in orders.iter().enumerate() {
                let regs = [(packed[i] >> 16) as u16, packed[i] as u16];
                let format = fmt(DataType::Float32, order);
                let (decoded, err) = decode(&regs, &format);
                assert!(err.is_none(), "{value} {order:?}: unexpected error");
                match decoded {
                    TypedValue::Float(f) => assert_eq!(
                        f as f32, value,
                        "{value} {order:?}: decoded {f} from regs {regs:?}"
                    ),
                    other => panic!("{value} {order:?}: expected Float, got {other:?}"),
                }

                // round-trip
                let encoded = encode(&TypedValue::Float(value as f64), &format).unwrap();
                assert_eq!(encoded, regs, "{value} {order:?}: encode mismatch");
            }
        }
    }

    // ---- uint32 / int32, from the same vector table ----

    #[test]
    fn uint32_int32_vectors_all_word_orders() {
        let uint_vectors: &[(u32, [u32; 4])] = &[
            (1, [0x0000_0001, 0x0001_0000, 0x0000_0100, 0x0100_0000]),
            (
                0x1234_5678,
                [0x1234_5678, 0x5678_1234, 0x3412_7856, 0x7856_3412],
            ),
            (
                0xFFFF_FFFF,
                [0xFFFF_FFFF, 0xFFFF_FFFF, 0xFFFF_FFFF, 0xFFFF_FFFF],
            ),
        ];
        let orders = [
            WordOrder::Abcd,
            WordOrder::Cdab,
            WordOrder::Badc,
            WordOrder::Dcba,
        ];

        for &(value, packed) in uint_vectors {
            for (i, &order) in orders.iter().enumerate() {
                let regs = [(packed[i] >> 16) as u16, packed[i] as u16];
                let format = fmt(DataType::Uint32, order);
                let (decoded, _) = decode(&regs, &format);
                assert_eq!(decoded, TypedValue::Uint(value as u64), "{order:?}");
                let encoded = encode(&TypedValue::Uint(value as u64), &format).unwrap();
                assert_eq!(encoded, regs, "{order:?} encode");
            }
        }

        // -2 as int32
        let neg_two: [u32; 4] = [0xFFFF_FFFE, 0xFFFE_FFFF, 0xFFFF_FEFF, 0xFEFF_FFFF];
        for (i, &order) in orders.iter().enumerate() {
            let regs = [(neg_two[i] >> 16) as u16, neg_two[i] as u16];
            let format = fmt(DataType::Int32, order);
            let (decoded, _) = decode(&regs, &format);
            assert_eq!(decoded, TypedValue::Int(-2), "{order:?}");
            let encoded = encode(&TypedValue::Int(-2), &format).unwrap();
            assert_eq!(encoded, regs, "{order:?} encode");
        }
    }

    // ---- 16-bit ----

    #[test]
    fn uint16_int16_vectors() {
        let vectors: &[(u16, u64, i64)] = &[
            (0x0000, 0, 0),
            (0x7FFF, 32767, 32767),
            (0x8000, 32768, -32768),
            (0xFFFF, 65535, -1),
        ];
        for &(raw, uint_expected, int_expected) in vectors {
            let (u, _) = decode(&[raw], &fmt(DataType::Uint16, WordOrder::Abcd));
            assert_eq!(u, TypedValue::Uint(uint_expected));
            let (i, _) = decode(&[raw], &fmt(DataType::Int16, WordOrder::Abcd));
            assert_eq!(i, TypedValue::Int(int_expected));
        }
    }

    #[test]
    fn hex16_and_binary16_decode_like_uint16() {
        let format_hex = fmt(DataType::Hex16, WordOrder::Abcd);
        let format_bin = fmt(DataType::Binary16, WordOrder::Abcd);
        assert_eq!(decode(&[0x43A7], &format_hex).0, TypedValue::Uint(0x43A7));
        assert_eq!(decode(&[0x43A7], &format_bin).0, TypedValue::Uint(0x43A7));
    }

    // ---- round-trip property over a generated range, every type × every order ----

    #[test]
    fn round_trip_float32_generated_range() {
        for order in [
            WordOrder::Abcd,
            WordOrder::Cdab,
            WordOrder::Badc,
            WordOrder::Dcba,
        ] {
            let format = fmt(DataType::Float32, order);
            for i in -50..=50 {
                let v = i as f32 * 7.4213;
                let regs = encode(&TypedValue::Float(v as f64), &format).unwrap();
                let (decoded, err) = decode(&regs, &format);
                assert!(err.is_none());
                match decoded {
                    TypedValue::Float(f) => {
                        assert!((f as f32 - v).abs() < 1e-3, "{order:?} {v} -> {f}")
                    }
                    other => panic!("expected Float, got {other:?}"),
                }
            }
        }
    }

    #[test]
    fn round_trip_uint32_int32_generated_range() {
        for order in [
            WordOrder::Abcd,
            WordOrder::Cdab,
            WordOrder::Badc,
            WordOrder::Dcba,
        ] {
            let uformat = fmt(DataType::Uint32, order);
            let iformat = fmt(DataType::Int32, order);
            for i in [0u32, 1, 42, 1000, 305_419_896, 4_294_967_295] {
                let regs = encode(&TypedValue::Uint(i as u64), &uformat).unwrap();
                assert_eq!(decode(&regs, &uformat).0, TypedValue::Uint(i as u64));
            }
            for i in [0i32, 1, -1, -2, i32::MIN, i32::MAX] {
                let regs = encode(&TypedValue::Int(i as i64), &iformat).unwrap();
                assert_eq!(decode(&regs, &iformat).0, TypedValue::Int(i as i64));
            }
        }
    }

    #[test]
    fn round_trip_64_bit_generated_range() {
        for order in [
            WordOrder::Abcd,
            WordOrder::Cdab,
            WordOrder::Badc,
            WordOrder::Dcba,
        ] {
            let uformat = fmt(DataType::Uint64, order);
            let iformat = fmt(DataType::Int64, order);
            let fformat = fmt(DataType::Float64, order);
            for v in [0u64, 1, 42, u64::MAX, 0x1234_5678_9ABC_DEF0] {
                let regs = encode(&TypedValue::Uint(v), &uformat).unwrap();
                assert_eq!(decode(&regs, &uformat).0, TypedValue::Uint(v));
            }
            for v in [0i64, -1, i64::MIN, i64::MAX] {
                let regs = encode(&TypedValue::Int(v), &iformat).unwrap();
                assert_eq!(decode(&regs, &iformat).0, TypedValue::Int(v));
            }
            for v in [0.0f64, 1.0, -1.0, 231.0, 0.975, -1.5, 1e100, -1e-100] {
                let regs = encode(&TypedValue::Float(v), &fformat).unwrap();
                match decode(&regs, &fformat).0 {
                    TypedValue::Float(f) => assert!((f - v).abs() < 1e-9 * v.abs().max(1.0)),
                    other => panic!("expected Float, got {other:?}"),
                }
            }
        }
    }

    // ---- NaN / Inf never produce a fabricated number ----

    #[test]
    fn nan_and_infinity_produce_invalid() {
        let format = fmt(DataType::Float32, WordOrder::Abcd);
        let nan_regs = f32_to_regs(f32::NAN, WordOrder::Abcd);
        let (v, err) = decode(&nan_regs, &format);
        assert_eq!(v, TypedValue::Invalid);
        assert!(err.is_some());

        let inf_regs = f32_to_regs(f32::INFINITY, WordOrder::Abcd);
        let (v, err) = decode(&inf_regs, &format);
        assert_eq!(v, TypedValue::Invalid);
        assert!(err.is_some());
    }

    // ---- short block never panics, always a clean decode error ----

    #[test]
    fn short_block_returns_error_not_panic() {
        let format = fmt(DataType::Float32, WordOrder::Cdab);
        let (v, err) = decode(&[0x1234], &format);
        assert_eq!(v, TypedValue::Invalid);
        assert!(err.is_some());

        let format64 = fmt(DataType::Float64, WordOrder::Cdab);
        let (v, err) = decode(&[0x1234, 0x5678], &format64);
        assert_eq!(v, TypedValue::Invalid);
        assert!(err.is_some());
    }

    #[test]
    fn decode_block_splits_a_register_run_into_rows() {
        let format = fmt(DataType::Float32, WordOrder::Cdab);
        // Two float32 values back to back: 1.0 then 231.0, both CDAB.
        let regs = [0x0000, 0x3F80, 0x0000, 0x4367];
        let rows = decode_block(&regs, 100, &format);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].address, 100);
        assert_eq!(rows[0].span, 2);
        assert_eq!(rows[0].raw, vec![0x0000, 0x3F80]);
        assert_eq!(rows[0].value, TypedValue::Float(1.0));
        assert_eq!(rows[1].address, 102);
        assert_eq!(rows[1].value, TypedValue::Float(231.0));
    }

    // ---- scale and offset apply after decode, scale first ----

    /// The VFD profile is all 16-bit registers with implied decimals, so a
    /// scaled integer must survive encode -> decode without losing its
    /// fraction. Getting this wrong wrote 0 for every current on that meter.
    #[test]
    fn scaled_integer_values_round_trip() {
        for (raw, scale, engineering) in [
            (7u16, 0.1, 0.7),    // Input Current Ib
            (13, 0.1, 1.3),      // Input Current Ia
            (5179, 0.01, 51.79), // Running Frequency
            (98, 0.01, 0.98),    // Input Power Factor
            (1485, 1.0, 1485.0), // Running Speed (identity)
        ] {
            let format = DataFormat {
                data_type: DataType::Uint16,
                word_order: WordOrder::Cdab,
                scale,
                offset: 0.0,
            };
            let (decoded, err) = decode(&[raw], &format);
            assert!(err.is_none(), "decode of {raw} @ {scale}: {err:?}");
            let got = match decoded {
                TypedValue::Float(f) => f,
                TypedValue::Uint(u) => u as f64,
                other => panic!("unexpected {other:?}"),
            };
            assert!(
                (got - engineering).abs() < 1e-9,
                "raw {raw} @ scale {scale} decoded to {got}, expected {engineering}"
            );

            // …and back to the same register.
            let regs = encode(&decoded, &format).expect("re-encode");
            assert_eq!(
                regs,
                vec![raw],
                "re-encode of {engineering} @ scale {scale}"
            );
        }
    }

    #[test]
    fn scale_then_offset_applied_after_decode() {
        // raw 5179, scale 0.01 -> 51.79 (VFD running-frequency example)
        let format = DataFormat {
            data_type: DataType::Uint16,
            word_order: WordOrder::Abcd,
            scale: 0.01,
            offset: 0.0,
        };
        // A scaled integer register holds a real quantity, so it decodes as a
        // float. Truncating to 51 here was silently wrong — and it's what made
        // scaled simulator tags read as 0 (0.7 A -> Uint(0)).
        let (v, _) = decode(&[5179], &format);
        match v {
            TypedValue::Float(f) => assert!((f - 51.79).abs() < 1e-9, "got {f}"),
            other => panic!("expected Float, got {other:?}"),
        }

        // At the identity scale the exact integer is still preserved.
        let identity = DataFormat {
            scale: 1.0,
            offset: 0.0,
            ..format
        };
        let (v, _) = decode(&[5179], &identity);
        assert!(matches!(v, TypedValue::Uint(5179)), "got {v:?}");

        let format_f = DataFormat {
            data_type: DataType::Float32,
            word_order: WordOrder::Abcd,
            scale: 2.0,
            offset: 10.0,
        };
        let regs = f32_to_regs(3.0, WordOrder::Abcd);
        let (v, _) = decode(&regs, &format_f);
        // (3.0 * 2.0) + 10.0 = 16.0
        assert_eq!(v, TypedValue::Float(16.0));
    }
}
