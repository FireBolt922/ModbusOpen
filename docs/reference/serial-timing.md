# Serial timing (RTU)

Everything specific to Modbus RTU over RS-232/RS-485. TCP users can skip this file.

---

## Line settings

| Setting | Values | Default | Notes |
|---|---|---|---|
| Baud rate | 1200, 2400, 4800, **9600**, 14400, **19200**, 38400, 57600, 115200 | 9600 | 9600 and 19200 dominate. The spec's own default is 19200. |
| Data bits | **8** | 8 | RTU *requires* 8. (7 is ASCII mode only.) |
| Parity | **None**, Even, Odd | None | The spec says Even; the field says None. Try None first, then Even. |
| Stop bits | **1**, 2 | 1 | Convention: 1 stop bit with parity, 2 without. In practice most devices accept either. |

**Character frame is always 11 bits**, regardless of configuration:

```
8-E-1 / 8-O-1:  1 start + 8 data + 1 parity + 1 stop  = 11 bits
8-N-2:          1 start + 8 data + 0 parity + 2 stop  = 11 bits
8-N-1:          1 start + 8 data + 0 parity + 1 stop  = 10 bits   ← the exception
```

Most devices are configured `8-N-1`, which is technically 10 bits. Timing calculations
conventionally use 11 anyway — it's conservative, and being slightly slow never breaks anything.

Offer `8-N-1`, `8-E-1`, `8-O-1`, `8-N-2` as presets. Three separate dropdowns for one concept is
bad UX; put the individual controls under Advanced.

---

## Frame delimiting — why timing matters

An RTU frame has **no start marker and no length field**. The receiver knows a message ended
because the line went quiet for 3.5 character times.

```
│◄── frame ──►│◄─ ≥3.5 chars silence ─►│◄── frame ──►│
 01 03 00 64…              (idle)        01 03 04 43…
```

Consequences:

- **A gap of >1.5 character times *inside* a frame** is treated as a framing error and the frame is
  discarded.
- **A gap of <3.5 character times *between* frames** means the receiver may run two messages
  together and CRC-fail both.
- This is why USB-serial adapters with aggressive buffering (latency timers, chunk coalescing) can
  make an otherwise-fine RTU link flaky. FTDI adapters default to a 16 ms latency timer; dropping
  it to 1–2 ms noticeably helps at higher baud rates.

### Computing the silent interval

```
char_time_us  = 11 * 1_000_000 / baud_rate

t_1.5 = 1.5 * char_time_us     (intra-frame gap limit)
t_3.5 = 3.5 * char_time_us     (inter-frame silence)
```

**Spec exception:** above 19200 baud the computed values get impractically small, so the spec
fixes them:

```
if baud > 19200:
    t_1.5 = 750 us
    t_3.5 = 1750 us
```

| Baud | Char time | t1.5 | t3.5 |
|---|---|---|---|
| 1200 | 9.167 ms | 13.75 ms | 32.08 ms |
| 2400 | 4.583 ms | 6.875 ms | 16.04 ms |
| 4800 | 2.292 ms | 3.44 ms | 8.02 ms |
| **9600** | **1.146 ms** | **1.72 ms** | **4.01 ms** |
| **19200** | **0.573 ms** | **0.86 ms** | **2.01 ms** |
| 38400 | 0.286 ms | 0.75 ms (fixed) | 1.75 ms (fixed) |
| 57600 | 0.191 ms | 0.75 ms (fixed) | 1.75 ms (fixed) |
| 115200 | 0.095 ms | 0.75 ms (fixed) | 1.75 ms (fixed) |

```rust
fn inter_frame_delay_us(baud: u32) -> u32 {
    if baud > 19200 { 1750 } else { (3_500_000 * 11) / baud }
}
```

ModbusOpen's inter-frame delay field defaults to `auto` using this, with a manual override for
devices that need more breathing room. Some cheap slaves genuinely need 10–20 ms.

---

## Response timeout

How long to wait before declaring no answer.

```
timeout ≥ (request_bytes + response_bytes) * char_time  +  device_processing_time  +  margin
```

At 9600 baud a 8-byte request plus a 45-byte response is ~61 ms of wire time alone. Device
processing ranges from ~5 ms (a modern meter) to several hundred ms (an old PLC doing a scan-cycle
lookup).

**Practical defaults:**

| Baud | Suggested timeout |
|---|---|
| ≤ 4800 | 2000 ms |
| 9600 – 19200 | 1000 ms |
| ≥ 38400 | 500 ms |

Too short and you get phantom timeouts on a healthy bus. Too long and a genuinely dead device
makes the UI feel frozen. 1000 ms is the right default; make it easy to change.

---

## Turnaround delay

RS-485 is **half duplex** — one pair of wires, one talker at a time. After the master finishes
transmitting, the driver must release the line before the slave starts. Many devices need a few
milliseconds.

Rules that follow:

1. **Never pipeline on RTU.** One outstanding transaction at a time, always. (TCP can pipeline via
   transaction IDs. RTU cannot. This is enforced structurally in ModbusOpen by the poll task owning
   the client — see [architecture](../03-architecture.md#threading-model).)
2. **Wait for a full response or a timeout before the next request.**
3. **Then wait t3.5** before transmitting again.

---

## CRC-16

Poly `0xA001` (reflected `0x8005`), init `0xFFFF`, no final XOR, **transmitted low byte first** —
the opposite of every other multi-byte field in Modbus.

```rust
fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for &b in data {
        crc ^= b as u16;
        for _ in 0..8 {
            if crc & 1 != 0 { crc = (crc >> 1) ^ 0xA001; } else { crc >>= 1; }
        }
    }
    crc
}

// append: low byte, then high byte
frame.push((crc & 0xFF) as u8);
frame.push((crc >> 8) as u8);
```

**Test vectors:**

| Frame | CRC | On the wire |
|---|---|---|
| `01 03 00 00 00 0A` | `0xCDC5` | `C5 CD` |
| `01 03 00 64 00 02` | `0xCDC5`* | — |
| `01 04 02 FF FF` | `0xB880` | `80 B8` |

\* verify each vector against a reference implementation when writing the test — do not trust a
table transcribed by hand, including this one.

`tokio-modbus` handles CRC for us. We implement it anyway for the frame log's validity indicator,
and because a "CRC mismatch" annotation in the log is a strong signal of wiring or timing trouble.

---

## RS-485 wiring gotchas

Not our code's problem, but it's what the user will actually be fighting. Worth surfacing in help
text when a bus is silent:

1. **A/B polarity swapped** — the single most common wiring fault. Symptom: total silence.
   Swapping the two wires costs nothing to try.
2. **Missing termination** — 120 Ω resistors at *both* physical ends of the bus. Symptom: works at
   9600, fails at 38400, or works with short cable and fails with long.
3. **No common ground** — RS-485 is differential but still needs a common-mode reference.
   Symptom: intermittent errors, worse between devices on different power supplies.
4. **Star topology** — RS-485 is a daisy chain, not a star. Stubs must be short.
5. **Address collision** — two devices with the same slave ID. Symptom: garbage responses or CRC
   errors that appear only when polling that specific ID.
6. **Baud/parity mismatch** — silence or consistent CRC errors. This is the one ModbusOpen can help
   with directly: a future "try common settings" sweep would be genuinely useful
   ([backlog](../backlog.md)).

---

## OS-specific serial notes

| OS | Port naming | Gotchas |
|---|---|---|
| **Linux** | `/dev/ttyUSB0`, `/dev/ttyACM0`, `/dev/ttyS0` | User must be in the `dialout` group (`sudo usermod -aG dialout $USER`, then log out and back in). `ModemManager` sometimes grabs new USB serial devices for a few seconds after plug-in. |
| **macOS** | `/dev/tty.usbserial-*`, `/dev/cu.usbserial-*` | **Use `/dev/cu.*`, not `/dev/tty.*`** — the `tty.` device blocks on open waiting for DCD. This bites everyone once. |
| **Windows** | `COM1`…`COMn` | Ports above COM9 need the `\\.\COM10` prefix in some APIs. The `serialport` crate handles this. |

Show the friendly description from the port enumeration (`FTDI FT232R USB UART`) under the device
path — nobody recognizes their adapter by `/dev/cu.usbserial-A50285BI`.

---

## Sources

- [Modbus-RTU silent interval calculation: 3.5 character times](https://industrialmonitordirect.com/blogs/knowledgebase/modbus-rtu-silent-interval-calculation-35-character-times)
- [Configuring Modbus RTU serial communication settings](https://industrialmonitordirect.com/blogs/knowledgebase/configuring-modbus-rtu-serial-communication-settings)
- [Modbus RTU CRC-16 algorithm and implementation guide](https://industrialmonitordirect.com/blogs/knowledgebase/modbus-rtu-crc-16-calculation-algorithm-and-implementation-guide)
- [RS-485 serial communication for IIoT: wiring, timing, troubleshooting](https://www.machinecdn.com/blog/2026/03/02/rs485-serial-communication-iiot-modbus-rtu-guide/)
- [Modbus RTU protocol explained: frames, timing, wiring](https://www.plcprogrammingblog.com/blog/modbus-rtu-protocol-explained)
