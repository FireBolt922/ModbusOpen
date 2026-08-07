# Data types and word order

> **The Modbus specification does not define how values larger than 16 bits are laid out across
> registers.** Every vendor picked their own. This is the second most common source of Modbus
> bugs after off-by-one addressing, and it's the more dangerous one — because the wrong word order
> produces a *number*, not an error.

---

## The problem

A Modbus register is 16 bits. A float32 needs two registers. Which register holds which half, and
in what byte order within each?

Take `231.0`. As IEEE-754 float32 that's `0x43670000`. Label the bytes:

```
 A    B    C    D
0x43 0x67 0x00 0x00
```

Four layouts exist in the wild. All four are used by real, shipping devices.

| Name | Reg N | Reg N+1 | Bytes on the wire | Also called |
|---|---|---|---|---|
| **ABCD** | `0x4367` | `0x0000` | `43 67 00 00` | Big-endian, "standard", high word first |
| **CDAB** | `0x0000` | `0x4367` | `00 00 43 67` | Word swap, "little-endian word order", mid-little-endian |
| **BADC** | `0x6743` | `0x0000` | `67 43 00 00` | Byte swap, "big-endian byte swap" |
| **DCBA** | `0x0000` | `0x6743` | `00 00 67 43` | Little-endian, full reverse |

Two independent swaps: **word order** (which register first) and **byte order** (within each
register). Four combinations.

```
ABCD  = big word, big byte        ← the "obvious" one
CDAB  = little word, big byte     ← extremely common in real devices
BADC  = big word, little byte     ← rare
DCBA  = little word, little byte  ← true little-endian
```

## Why this is dangerous

Read a float32 in the wrong order and you don't get an error. You get a number.

```
Actual value: 231.0     (ABCD: 43 67 00 00)
Read as CDAB:           0x0000_4367  →  2.43e-41
Read as BADC:           0x6743_0000  →  8.99e+21
Read as DCBA:           0x0000_6743  →  3.71e-41
```

Sometimes it's obviously wrong (`8.99e+21` volts). Sometimes — especially with small integers or
values near zero — it looks entirely plausible and you commission a system on bad data.

**This is why ModbusOpen shows raw hex next to every decoded value, always, non-optionally.** If
the value looks odd but the hex reads `43 67 00 00`, a human can spot "that's 231.0 with the words
swapped" in a second. Hide the hex and they can't.

## What the existing meters use

The simulator scripts in `carbon_minus_iot_firmware_v2/.../modbus_simulator/` use:

```python
BinaryPayloadBuilder(byteorder=Endian.Big, wordorder=Endian.Little)
```

`byteorder=Big` + `wordorder=Little` = **CDAB**. So the L&T meters, the flow meters, and every
device that firmware talks to are CDAB. Make CDAB a prominent preset in the UI, not something
buried three menus deep — and consider it the sensible default for float32 in this shop.

---

## Reference implementation

```rust
/// Assemble two registers into a u32 according to word order.
fn regs_to_u32(regs: [u16; 2], order: WordOrder) -> u32 {
    let (hi, lo) = match order {
        WordOrder::Abcd | WordOrder::Badc => (regs[0], regs[1]),  // first reg is high word
        WordOrder::Cdab | WordOrder::Dcba => (regs[1], regs[0]),  // second reg is high word
    };
    let (hi, lo) = match order {
        WordOrder::Abcd | WordOrder::Cdab => (hi, lo),                    // bytes as-is
        WordOrder::Badc | WordOrder::Dcba => (hi.swap_bytes(), lo.swap_bytes()),
    };
    ((hi as u32) << 16) | (lo as u32)
}

fn regs_to_f32(regs: [u16; 2], order: WordOrder) -> f32 {
    f32::from_bits(regs_to_u32(regs, order))
}

/// 64-bit: same two axes, applied over four registers.
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
```

Encoding is the exact inverse. **Test `decode(encode(v)) == v` for every type × order.**

### NaN and infinity

```rust
let f = regs_to_f32(regs, order);
if f.is_nan() || f.is_infinite() {
    return TypedValue::Invalid;   // show raw hex + a marker. NEVER display "NaN" as if it's data.
}
```

A NaN almost always means the word order is wrong or the register is unpopulated. Both are things
the user needs to *notice*, not squint past.

---

## Supported data types

| Type | Registers | Range / notes |
|---|---|---|
| `bool` | — | Coils and discrete inputs (bit-addressed) |
| `uint16` | 1 | 0 – 65,535 |
| `int16` | 1 | −32,768 – 32,767 (two's complement) |
| `hex16` | 1 | Display only: `0x43A7` |
| `binary16` | 1 | Display only: `0100 0011 1010 0111` |
| `uint32` | 2 | 0 – 4,294,967,295 · 4 word orders |
| `int32` | 2 | ±2.1e9 · 4 word orders |
| `float32` | 2 | IEEE-754 single · 4 word orders · **most common in meters** |
| `uint64` | 4 | 4 word orders |
| `int64` | 4 | 4 word orders |
| `float64` | 4 | IEEE-754 double · 4 word orders |
| `string` | n | 2 ASCII chars per register; byte order applies |

Count: 4 (16-bit) + 3 types × 4 orders (32-bit) + 3 types × 4 orders (64-bit) = **28 display
formats**, which matches what Modbus Poll offers. That's the bar for parity.

## Scale and offset

Enormously common in real devices: they report integers that must be divided.

```
displayed = (decoded * scale) + offset
```

From the VFD profile:

| Register | Raw | Scale | Real value |
|---|---|---|---|
| `0x100` Running frequency | `5179` | 0.01 | 51.79 Hz |
| `0x108` Input current Ia | `13` | 0.1 | 1.3 A |
| `0x117` Input power factor | `98` | 0.01 | 0.98 |

Without scale/offset in the tool, the user does this arithmetic in their head on every reading.
Apply scale first, then offset.

---

## Test vectors

Use these directly in `codec.rs` tests. Verified by hand.

### float32

| Value | ABCD | CDAB | BADC | DCBA |
|---|---|---|---|---|
| `1.0` | `3F80 0000` | `0000 3F80` | `803F 0000` | `0000 803F` |
| `-1.0` | `BF80 0000` | `0000 BF80` | `80BF 0000` | `0000 80BF` |
| `231.0` | `4367 0000` | `0000 4367` | `6743 0000` | `0000 6743` |
| `50.0` | `4248 0000` | `0000 4248` | `4842 0000` | `0000 4842` |
| `0.975` | `3F79 999A` | `999A 3F79` | `793F 9A99` | `9A99 793F` |
| `-1.5` | `BFC0 0000` | `0000 BFC0` | `C0BF 0000` | `0000 C0BF` |
| `0.0` | `0000 0000` | `0000 0000` | `0000 0000` | `0000 0000` |

### uint32 / int32

| Value | ABCD | CDAB | BADC | DCBA |
|---|---|---|---|---|
| `1` | `0000 0001` | `0001 0000` | `0000 0100` | `0100 0000` |
| `305419896` (`0x12345678`) | `1234 5678` | `5678 1234` | `3412 7856` | `7856 3412` |
| `4294967295` | `FFFF FFFF` | `FFFF FFFF` | `FFFF FFFF` | `FFFF FFFF` |
| `-2` (int32) | `FFFF FFFE` | `FFFE FFFF` | `FFFF FEFF` | `FEFF FFFF` |

### 16-bit

| Value | uint16 | int16 |
|---|---|---|
| `0x0000` | 0 | 0 |
| `0x7FFF` | 32767 | 32767 |
| `0x8000` | 32768 | −32768 |
| `0xFFFF` | 65535 | −1 |

---

## UX guidance

- Default to **`uint16`** for a fresh connection — the least surprising, never NaN.
- Offer **`float32 CDAB`** as a one-click preset. In this domain it's the most likely correct answer.
- Let the user **cycle word orders live** without re-reading. The registers are already in memory;
  re-decode them locally. Flipping through all four while watching for the sane value takes two
  seconds and is the actual technique engineers use.
- Show the **register span** on each row (`100–101`) so multi-register values are visibly wider.
- Right-click a row → **per-row format override**. Real maps mix types: the L&T map is float32 for
  measurements and uint32 for run hours.

---

## Sources

- [Modbus data types and byte order reference — Chipkin](https://docs.chipkin.com/articles/modbus-data-types-byte-order-reference/)
- [Modbus 32-bit float byte order: word-swap troubleshooting](https://industrialmonitordirect.com/blogs/knowledgebase/modbus-32-bit-float-byte-order-resolving-word-swap-variations)
- [Modbus Poll display formats](https://www.modbustools.com/poll_display_formats.html)
- [Modbus float encoding: reading IEEE-754 from industrial PLCs](https://www.machinecdn.com/blog/2026/03/03/modbus-float-encoding-ieee754-plc-guide/)
