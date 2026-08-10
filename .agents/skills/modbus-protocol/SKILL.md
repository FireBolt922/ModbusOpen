---
name: modbus-protocol
description: Use when writing or debugging any Modbus protocol code in ModbusOpen — framing, function codes, register addressing, encoding/decoding values, word order, exception handling, CRC, or serial timing. Also use when a device returns wrong values, unexpected exceptions, or nothing at all.
---

# Modbus protocol work

Never guess at Modbus behaviour. The spec is old, vendor implementations vary, and the failure
mode for a wrong guess is a plausible-looking wrong number.

## Before writing code

Read the reference doc that covers what you're touching:

| Working on | Read |
|---|---|
| Framing, ADU/PDU, transactions, addressing | `docs/reference/modbus-primer.md` |
| A specific function code's wire layout or limits | `docs/reference/function-codes.md` |
| Decoding/encoding, float32, word order, scaling | `docs/reference/data-types-word-order.md` |
| Serial config, timeouts, CRC, RS-485 | `docs/reference/serial-timing.md` |
| A real device's register map | `docs/reference/device-profiles.md` |

## The five rules

1. **0-based wire addresses internally, always.** Convert to 1-based `4xxxx` notation only at the
   display layer. Any address in a Rust struct is 0-based, no exceptions.

2. **Raw hex ships with every decoded value.** `DecodedRegister` always carries `raw: Vec<u16>`.
   Never build a path where the UI has a value but not the bytes it came from.

3. **Never fabricate a number.** NaN, infinity, a short register block, an unsupported type — all
   produce `TypedValue::Invalid` plus the raw hex. Not `0`, not `"NaN"`, not a silently truncated
   value.

4. **Exceptions are not failures.** A slave returning "Illegal Data Address" is alive and
   communicating. Record it, display it with its name and hint, and keep polling. Only a dead
   transport ends a session.

5. **Validate client-side before transmitting.** Quantity limits (FC03 ≤ 125, FC16 ≤ 123,
   FC01/02 ≤ 2000, FC15 ≤ 1968), unit ID 1–247, and address+quantity not exceeding 0x10000. A
   locally-rejected request gives a better message than a remote exception and costs no timeout.

## Decoder work specifically

`src-tauri/src/modbus/codec.rs` is the highest-risk file in the repo.

- Write the test table **first**, from the vectors in
  `docs/reference/data-types-word-order.md#test-vectors`.
- Cover every data type × every word order. No exceptions, no "this one's obvious".
- Assert the round-trip property: `decode(encode(v)) == v`.
- Verify against an independent implementation before trusting a hand-computed vector — including
  the ones in our own docs.
- Apply `scale` then `offset`, in that order, after decoding.

The two orthogonal axes, restated so nobody re-derives them:

```
word order  = which register holds the high half   (ABCD/BADC = first | CDAB/DCBA = second)
byte order  = byte arrangement within each register (ABCD/CDAB = as-is | BADC/DCBA = swapped)
```

**CDAB is the default in this shop.** Every device the existing firmware talks to uses it
(`pymodbus` `byteorder=Big, wordorder=Little`).

## Debugging a misbehaving device

Work down this list in order — it's ordered by how often each turns out to be the cause.

1. **Wrong values, right shape?** Word order. Cycle all four and look for the sane one.
2. **Exception 02?** Addressing base. Try `start_address ± 1`, then try the same address as
   0-based vs 1-based. Then check the range doesn't run past the end of the map.
3. **Exception 01?** Wrong function code. Try FC04 if FC03 failed, and vice versa.
4. **Exception 03?** Quantity too large (>125 for FC03), or a write value the device rejects.
5. **Exception 0B?** Gateway reached, downstream serial device didn't answer. The fault is past
   the gateway — check baud, wiring, and unit ID on the serial segment.
6. **Timeout on TCP?** Wrong IP or port, firewall, or the device wants a different unit ID.
7. **Timeout on RTU?** In order: A/B polarity swapped, baud mismatch, parity mismatch, wrong slave
   ID, missing termination, no common ground.
8. **Intermittent CRC errors on RTU?** Timing. Check the inter-frame delay, lower the USB adapter's
   latency timer, slow the baud rate, check termination.

Always check the frame log first. The raw bytes answer most of these in one glance.

## Verify against a reference

When ModbusOpen and a device disagree, `mbpoll` is the tiebreaker:

```bash
mbpoll -m tcp -a 1 -r 100 -c 10 -0 -t 4 127.0.0.1 -p 5020
```

If `mbpoll` and ModbusOpen disagree, ModbusOpen is wrong. See `docs/06-testing.md` for the full
test rig, and use the `modbus-test-rig` skill to set it up.
