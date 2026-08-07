# Function codes

Wire layouts for every function code ModbusOpen supports. All examples show the **PDU only** —
wrap in an MBAP header for TCP or address+CRC for RTU (see [primer](modbus-primer.md)).

All multi-byte fields are **big-endian**. All addresses on the wire are **0-based**.

---

## Supported in v1

| FC | Hex | Name | Table | Max qty |
|---|---|---|---|---|
| 01 | 0x01 | Read Coils | Coils | 2000 |
| 02 | 0x02 | Read Discrete Inputs | Discrete Inputs | 2000 |
| 03 | 0x03 | Read Holding Registers | Holding Registers | 125 |
| 04 | 0x04 | Read Input Registers | Input Registers | 125 |
| 05 | 0x05 | Write Single Coil | Coils | 1 |
| 06 | 0x06 | Write Single Register | Holding Registers | 1 |
| 15 | 0x0F | Write Multiple Coils | Coils | 1968 |
| 16 | 0x10 | Write Multiple Registers | Holding Registers | 123 |

Not in v1: FC07, FC08 (diagnostics), FC11, FC12, FC17, FC20/21 (file records), FC22 (mask write),
FC23 (read/write multiple), FC43 (device identification).

---

## FC01 / FC02 — Read Coils / Read Discrete Inputs

```
Request:   [FC] [start_hi] [start_lo] [qty_hi] [qty_lo]                    5 bytes
Response:  [FC] [byte_count] [data...]                          2 + ceil(qty/8) bytes
```

Bits are packed **LSB-first within each byte**. The first coil requested lands in bit 0 of the
first data byte. Unused high bits in the final byte are zero-filled.

```
Read 10 coils from address 20:
  TX  01 00 14 00 0A
  RX  01 02 CD 01
          │  │  └── byte 2: coil 28=1, 29..35 unused → coils 28,29 = 1,0
          │  └───── byte 1: 0xCD = 1100 1101 → coils 20..27 = 1,0,1,1,0,0,1,1
          └──────── byte count = 2
```

The LSB-first packing surprises people constantly. Get it wrong and every coil reading is scrambled
in a way that looks almost plausible. Unit-test it.

---

## FC03 / FC04 — Read Holding / Input Registers

The workhorses. ~90% of real traffic is FC03.

```
Request:   [FC] [start_hi] [start_lo] [qty_hi] [qty_lo]                    5 bytes
Response:  [FC] [byte_count] [reg1_hi] [reg1_lo] ...            2 + (qty * 2) bytes
```

`byte_count = qty * 2`, always.

```
Read 2 holding registers from address 100:
  TX  03 00 64 00 02
  RX  03 04 43 67 00 00
          │  └────────── 2 registers: 0x4367, 0x0000
          └───────────── byte count = 4
```

Those two registers are `231.0` as a float32 in ABCD order — or something else entirely in another
word order. The protocol gives you no way to know which. See
[data types and word order](data-types-word-order.md).

**Max 125 registers.** `125 * 2 + 2 = 252 ≤ 253`. Asking for 126 gets you exception 03 — enforce
this client-side.

---

## FC05 — Write Single Coil

```
Request:   [05] [addr_hi] [addr_lo] [value_hi] [value_lo]                  5 bytes
Response:  echo of the request                                             5 bytes
```

The value is **not** 0/1. It's:

| Meaning | Bytes |
|---|---|
| ON | `FF 00` |
| OFF | `00 00` |

Anything else is exception 03. A successful response is a byte-for-byte echo of the request.

---

## FC06 — Write Single Register

```
Request:   [06] [addr_hi] [addr_lo] [value_hi] [value_lo]                  5 bytes
Response:  echo of the request                                             5 bytes
```

```
Write 1500 (0x05DC) to holding register 106:
  TX  06 00 6A 05 DC
  RX  06 00 6A 05 DC
```

Only writes one 16-bit register. To write a float32 you need FC16 — and you must write both
registers in **one** transaction, or the device may briefly act on a half-updated value.
ModbusOpen's `write_typed` command picks FC06 vs FC16 automatically based on the data type.

---

## FC15 (0x0F) — Write Multiple Coils

```
Request:   [0F] [start_hi] [start_lo] [qty_hi] [qty_lo] [byte_count] [data...]
Response:  [0F] [start_hi] [start_lo] [qty_hi] [qty_lo]                    5 bytes
```

Same LSB-first bit packing as FC01. `byte_count = ceil(qty / 8)`.

The response echoes the address and quantity but **not** the data.

---

## FC16 (0x10) — Write Multiple Registers

```
Request:   [10] [start_hi] [start_lo] [qty_hi] [qty_lo] [byte_count] [data...]
Response:  [10] [start_hi] [start_lo] [qty_hi] [qty_lo]                    5 bytes
```

`byte_count = qty * 2`. **Max 123 registers** (fewer than FC03's 125 — the extra request-side
overhead eats two).

```
Write float32 231.0 (CDAB word order) to registers 100–101:
  TX  10 00 64 00 02 04 00 00 43 67
         │        │     │  └────────── data: reg100=0x0000, reg101=0x4367
         │        │     └───────────── byte count = 4
         │        └─────────────────── quantity = 2
         └──────────────────────────── start = 100
  RX  10 00 64 00 02
```

This is the FC the existing `electrical_write_data.py` uses to push its 120-register block.

---

## Exception responses

Any FC can return an exception instead of a normal response:

```
Response:  [FC | 0x80] [exception_code]                                    2 bytes
```

```
  TX  03 00 64 00 02
  RX  83 02              ← 0x03|0x80, exception 02 (Illegal Data Address)
```

Full exception code table with user-facing hints: [primer](modbus-primer.md#exception-responses)
and [data model](../05-data-model.md#errors).

---

## Client-side validation

Reject these **before** sending. Every one costs a full timeout otherwise, and the resulting
exception is less informative than a local message.

```rust
fn validate(fc: FunctionCode, start: u16, qty: u16) -> Result<(), AppError> {
    let max = match fc {
        ReadCoils | ReadDiscreteInputs   => 2000,
        ReadHoldingRegisters | ReadInputRegisters => 125,
        WriteMultipleCoils               => 1968,
        WriteMultipleRegisters           => 123,
        WriteSingleCoil | WriteSingleRegister => 1,
    };
    if qty == 0 || qty > max { return Err(/* "FC{n} allows 1–{max} per request" */); }
    // the range must not wrap past the end of the 16-bit address space
    if (start as u32) + (qty as u32) > 0x10000 { return Err(/* "range exceeds address space" */); }
    Ok(())
}
```

Also validate unit ID: `1..=247` for a normal request, `0` only for broadcast writes (which get no
response — don't wait for one).

---

## Sources

- [Modbus function codes — complete reference table](https://modbus.app/modbus-function-codes.html)
- [Modbus function codes explained with real examples](https://scadaprotocols.com/modbus-function-codes-explained/)
- [Modbus function codes implementation guide](https://industrialmonitordirect.com/blogs/knowledgebase/modbus-function-codes-implementation-guide-for-device-developers)
