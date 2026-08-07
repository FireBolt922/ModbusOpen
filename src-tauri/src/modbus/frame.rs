//! Reconstruct Modbus ADU bytes for the frame log. We don't tap the wire —
//! tokio-modbus owns the socket — so these match the PDU (and a standard
//! MBAP / RTU envelope) for the transaction we just issued. Useful for
//! debugging and for comparing against Wireshark's Modbus dissection after
//! the transport header.

use super::types::{Direction, FrameAnnotation, FrameLogEntry, FunctionCode, Transport};
use chrono::Utc;

/// CRC-16 / Modbus (poly 0xA001, init 0xFFFF). Known vector:
/// `01 03 00 00 00 0A` → `C5 CD` (low byte first on the wire).
pub fn crc16_modbus(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &b in data {
        crc ^= u16::from(b);
        for _ in 0..8 {
            if crc & 1 != 0 {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }
    crc
}

pub fn fc_byte(fc: FunctionCode) -> u8 {
    fc as u8
}

pub fn pdu_read_request(fc: u8, start: u16, quantity: u16) -> Vec<u8> {
    vec![
        fc,
        (start >> 8) as u8,
        start as u8,
        (quantity >> 8) as u8,
        quantity as u8,
    ]
}

pub fn pdu_read_registers_response(fc: u8, regs: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + regs.len() * 2);
    out.push(fc);
    out.push((regs.len() * 2) as u8);
    for &r in regs {
        out.push((r >> 8) as u8);
        out.push(r as u8);
    }
    out
}

pub fn pdu_read_bits_response(fc: u8, bits: &[bool]) -> Vec<u8> {
    let byte_count = bits.len().div_ceil(8);
    let mut out = vec![fc, byte_count as u8];
    out.resize(2 + byte_count, 0);
    for (i, &bit) in bits.iter().enumerate() {
        if bit {
            out[2 + i / 8] |= 1 << (i % 8);
        }
    }
    out
}

pub fn pdu_write_single_coil(addr: u16, value: bool) -> Vec<u8> {
    let (hi, lo) = if value { (0xFF, 0x00) } else { (0x00, 0x00) };
    vec![0x05, (addr >> 8) as u8, addr as u8, hi, lo]
}

pub fn pdu_write_single_register(addr: u16, value: u16) -> Vec<u8> {
    vec![
        0x06,
        (addr >> 8) as u8,
        addr as u8,
        (value >> 8) as u8,
        value as u8,
    ]
}

pub fn pdu_write_multiple_registers(addr: u16, values: &[u16]) -> Vec<u8> {
    let qty = values.len() as u16;
    let mut out = vec![
        0x10,
        (addr >> 8) as u8,
        addr as u8,
        (qty >> 8) as u8,
        qty as u8,
        (values.len() * 2) as u8,
    ];
    for &v in values {
        out.push((v >> 8) as u8);
        out.push(v as u8);
    }
    out
}

pub fn pdu_write_multiple_coils(addr: u16, values: &[bool]) -> Vec<u8> {
    let qty = values.len() as u16;
    let byte_count = values.len().div_ceil(8) as u8;
    let mut out = vec![
        0x0F,
        (addr >> 8) as u8,
        addr as u8,
        (qty >> 8) as u8,
        qty as u8,
        byte_count,
    ];
    let mut data = vec![0u8; byte_count as usize];
    for (i, &bit) in values.iter().enumerate() {
        if bit {
            data[i / 8] |= 1 << (i % 8);
        }
    }
    out.extend(data);
    out
}

pub fn pdu_exception(fc: u8, code: u8) -> Vec<u8> {
    vec![fc | 0x80, code]
}

pub fn pdu_write_single_echo(fc: u8, addr: u16, value_hi: u8, value_lo: u8) -> Vec<u8> {
    vec![fc, (addr >> 8) as u8, addr as u8, value_hi, value_lo]
}

pub fn pdu_write_multiple_echo(fc: u8, addr: u16, qty: u16) -> Vec<u8> {
    vec![
        fc,
        (addr >> 8) as u8,
        addr as u8,
        (qty >> 8) as u8,
        qty as u8,
    ]
}

/// Wrap a PDU in TCP MBAP or RTU (unit + CRC) framing for the log.
pub fn wrap_adu(transport: Transport, tid: u16, unit_id: u8, pdu: &[u8]) -> Vec<u8> {
    match transport {
        Transport::Tcp => {
            let len = (pdu.len() + 1) as u16;
            let mut out = Vec::with_capacity(7 + pdu.len());
            out.extend_from_slice(&tid.to_be_bytes());
            out.extend_from_slice(&0u16.to_be_bytes());
            out.extend_from_slice(&len.to_be_bytes());
            out.push(unit_id);
            out.extend_from_slice(pdu);
            out
        }
        Transport::Rtu => {
            let mut out = Vec::with_capacity(3 + pdu.len());
            out.push(unit_id);
            out.extend_from_slice(pdu);
            let crc = crc16_modbus(&out);
            out.push((crc & 0xFF) as u8);
            out.push((crc >> 8) as u8);
            out
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn make_frame(
    session_id: u64,
    transport: Transport,
    tid: u16,
    unit_id: u8,
    direction: Direction,
    pdu: &[u8],
    rtt_ms: Option<f64>,
    is_exception: bool,
    exception_code: Option<u8>,
) -> FrameLogEntry {
    let fc = pdu.first().copied().unwrap_or(0) & 0x7F;
    FrameLogEntry {
        session_id,
        timestamp: Utc::now(),
        direction,
        bytes: wrap_adu(transport, tid, unit_id, pdu),
        unit_id,
        function: fc,
        is_exception,
        exception_code,
        rtt_ms,
        annotation: Some(FrameAnnotation {
            unit_id,
            function: fc,
            is_exception,
            exception_code,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc16_known_vector() {
        // From docs/06-testing.md: 01 03 00 00 00 0A → C5CD (LE on wire)
        let data = [0x01, 0x03, 0x00, 0x00, 0x00, 0x0A];
        assert_eq!(crc16_modbus(&data), 0xCDC5);
    }

    #[test]
    fn bit_packing_lsb_first() {
        // 0xCD = 1100_1101 → bit0=1,1=0,2=1,3=1,4=0,5=0,6=1,7=1; second byte 0x01
        let bits = vec![
            true, false, true, true, false, false, true, true, // CD
            true, false, // 01
        ];
        let pdu = pdu_read_bits_response(0x01, &bits);
        assert_eq!(pdu[0], 0x01);
        assert_eq!(pdu[1], 2);
        assert_eq!(pdu[2], 0xCD);
        assert_eq!(pdu[3], 0x01);
    }
}
