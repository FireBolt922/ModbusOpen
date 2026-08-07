# 06 — Testing

**Do not develop against production hardware.** Set the test rig up once; use it constantly.

---

## 1. Test rig

### A local TCP slave

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install 'pymodbus[repl,serial]>=3.11'

# Simplest possible slave on :5020 (unprivileged — no sudo needed)
python -m pymodbus.simulator --http_port 8081 --modbus_port 5020
```

Or a scripted one with a known register map — put this in `testrig/slave.py`:

```python
import asyncio, struct
from pymodbus.datastore import ModbusSequentialDataBlock, ModbusSlaveContext, ModbusServerContext
from pymodbus.server import StartAsyncTcpServer

def f32_cdab(v: float) -> list[int]:
    """float32, big-endian bytes, word-swapped — the CDAB layout the real meters use."""
    hi, lo = struct.unpack(">HH", struct.pack(">f", v))
    return [lo, hi]

regs = [0] * 200
regs[100:102] = f32_cdab(231.0)   # Voltage
regs[102:104] = f32_cdab(15.0)    # Current
regs[104:106] = f32_cdab(50.0)    # Frequency
regs[106:108] = f32_cdab(0.975)   # Power factor

ctx = ModbusServerContext(
    slaves={
        1: ModbusSlaveContext(hr=ModbusSequentialDataBlock(0, regs)),
        2: ModbusSlaveContext(hr=ModbusSequentialDataBlock(0, [7] * 200)),
    },
    single=False,
)

asyncio.run(StartAsyncTcpServer(context=ctx, address=("127.0.0.1", 5020)))
```

Two slave IDs on purpose — that's what exercises "change the unit ID on the fly".

### A virtual serial pair (RTU without hardware)

**macOS / Linux** — `socat` creates two linked pseudo-terminals:

```bash
brew install socat            # macOS
sudo apt install socat        # Ubuntu

socat -d -d pty,raw,echo=0,link=/tmp/ttyA pty,raw,echo=0,link=/tmp/ttyB
```

Run a slave on one end, point ModbusOpen at the other:

```bash
diagslave -m rtu -b 9600 -d 8 -p none -s 1 /tmp/ttyA
# then connect ModbusOpen RTU to /tmp/ttyB at 9600 8-N-1
```

**Windows** — install [com0com](https://sourceforge.net/projects/com0com/) and pair `COM10`↔`COM11`.

> ⚠️ A `socat` pty pair does **not** reproduce real RS-485 timing, turnaround delay, or noise.
> It proves your framing and parsing. It does not prove your timing. Always do one final check
> against a real USB-RS485 adapter before calling M2 done.

### Reference CLI tools

Keep these installed; they're the oracle when ModbusOpen and a device disagree.

```bash
brew install libmodbus mbpoll        # macOS
sudo apt install mbpoll              # Ubuntu

# read 10 holding registers from address 100 (mbpoll is 1-based by default; -0 makes it 0-based)
mbpoll -m tcp -a 1 -r 100 -c 10 -0 -t 4 127.0.0.1 -p 5020

# same over RTU
mbpoll -m rtu -b 9600 -P none -a 1 -r 100 -c 10 -0 -t 4 /tmp/ttyB
```

`diagslave` and `modpoll` are free binaries from modbusdriver.com.

---

## 2. Unit tests — Rust

### `codec.rs` — the most important tests in the repo

Table-driven, every data type × every word order, against hand-computed vectors. Start from these;
the float ones are already verified.

| Value | Type | Registers ABCD | CDAB | BADC | DCBA |
|---|---|---|---|---|---|
| `1.0` | float32 | `3F80 0000` | `0000 3F80` | `803F 0000` | `0000 803F` |
| `231.0` | float32 | `4367 0000` | `0000 4367` | `6743 0000` | `0000 6743` |
| `-1.5` | float32 | `BFC0 0000` | `0000 BFC0` | `C0BF 0000` | `0000 C0BF` |
| `0.975` | float32 | `3F79 999A` | `999A 3F79` | `793F 9A99` | `9A99 793F` |
| `305419896` (`0x12345678`) | uint32 | `1234 5678` | `5678 1234` | `3412 7856` | `7856 3412` |
| `-2` | int32 | `FFFF FFFE` | `FFFE FFFF` | `FFFF FEFF` | `FEFF FFFF` |
| `65535` | uint16 | `FFFF` | — | `FFFF` | — |
| `-1` | int16 | `FFFF` | — | `FFFF` | — |

Required properties:

- **Round-trip:** `decode(encode(v)) == v` for every type × word order, over a generated range.
- **NaN/Inf → `TypedValue::Invalid`**, never a number.
- **Short block:** decoding a float32 with only one register left returns a decode error, not a panic.
- **Scale/offset** applied after decode, in that order.

### Other Rust units

- CRC-16: known vectors — `01 03 00 00 00 0A` → `C5CD`.
- MBAP: build and parse round-trip; length field correctness.
- Exception parsing: `01 83 02` → `ModbusException { code: 2, .. }`.
- Address conversion: `40001 ↔ 0`, `30001 ↔ 0`, boundaries at `0` and `65535`.
- Quantity limits: FC03 with `qty=126` is rejected client-side with `InvalidConfig`, before hitting
  the wire. See [function codes](reference/function-codes.md).

### Integration

`src-tauri/tests/` — spawn the `pymodbus` slave as a child process, run the real client against it,
assert values. Gate behind `#[ignore]` if Python isn't guaranteed in CI, and run them locally
before every milestone sign-off.

---

## 3. Manual smoke checklist

Run before declaring any milestone done. The `milestone-check` skill walks through this.

**Connection**
- [ ] TCP connect to the local slave — succeeds
- [ ] TCP connect to a closed port — clear error, no hang, app stays usable
- [ ] TCP connect to a bogus IP — times out with a useful message
- [ ] RTU connect over the socat pair — succeeds
- [ ] RTU connect to a port already in use — clear "port busy" error
- [ ] Unplug the USB adapter mid-poll — clean disconnect, clear error, no zombie task

**Polling**
- [ ] FC03 at 1000 ms — values update, actual rate reads ~1.00 Hz
- [ ] Change interval to 100 ms while polling — rate follows, no restart
- [ ] Change unit ID 1 → 2 while polling — values change to slave 2's, no reconnect
- [ ] Change start address to an out-of-range value — exception shown, last values dim, poll continues
- [ ] Change it back — recovers on the next cycle
- [ ] Pause and resume — counters keep their history

**Decoding**
- [ ] float32 CDAB matches what the reference `mbpoll` command reports
- [ ] Switching word order live changes values immediately, without a re-read
- [ ] A wrong word order gives visibly wrong numbers *and* the raw hex still reads correctly
- [ ] uint32 counter increments monotonically

**Writes**
- [ ] FC06 write — the value appears on the next read
- [ ] FC16 write of a float32 — round-trips to the same value
- [ ] Frame preview matches what lands in the frame log
- [ ] Write to a read-only register — exception 02 or 04, shown clearly

**Frame log**
- [ ] TX and RX both appear, in order, with sensible RTTs
- [ ] Hex matches Wireshark (`tcp.port == 5020`) byte for byte
- [ ] An exception frame is decoded inline
- [ ] 10,000+ entries — no memory growth, no UI lag

**Simulator**
- [ ] ModbusOpen's scanner reads ModbusOpen's simulator
- [ ] `mbpoll` reads it with matching values
- [ ] Two slave IDs on one port both answer
- [ ] A tag with random behaviour visibly changes
- [ ] A master's FC16 write shows up in the simulator's live table
- [ ] Manual edit of a value overrides the animation

**Cross-platform** (before release)
- [ ] Fresh Windows 11 — installer runs, serial ports enumerate as `COMn`
- [ ] Fresh Ubuntu 24.04 — `.deb` installs, `dialout` guidance appears when needed
- [ ] macOS Intel and Apple Silicon — app opens, ports enumerate

---

## 4. CI

```
on: [push, pull_request]
  - cargo fmt --check
  - cargo clippy -- -D warnings
  - cargo test
  - npm ci && npm run typecheck && npm run build

on: tag v*
  - tauri-action → .dmg (universal), .msi, .AppImage + .deb
```

## 5. Verify against the existing scripts

The scripts in `carbon_minus_iot_firmware_v2/iot_firmware_v2/modbus_simulator/` are the closest
thing to a real-world conformance suite this project has. Before M4 is signed off:

1. Run `electrical_write_data.py` against a `pymodbus` slave.
2. Point ModbusOpen's scanner at that slave with `float32 CDAB`, start 100.
3. The decoded values must match the ranges the script generates (Active Power 145–155,
   Power Factor 0.95–0.99, Frequency 49.9–50.1, and so on).

If they don't match, ModbusOpen's decoder is wrong — those scripts have been read by real meters.
Note that they use `byteorder=Endian.Big, wordorder=Endian.Little`, which is **CDAB**.
