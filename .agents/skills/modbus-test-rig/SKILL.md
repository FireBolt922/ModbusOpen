---
name: modbus-test-rig
description: Use when you need a Modbus device to test ModbusOpen against and don't have hardware — setting up a local pymodbus TCP slave, a virtual serial port pair for RTU, or reference CLI tools (mbpoll, diagslave) to cross-check results. Use before writing or debugging any scanner code.
---

# Test rig

Never develop against production hardware. Set this up once at the start of a session.

Full detail: `docs/06-testing.md`. This skill is the fast path.

## TCP slave in 30 seconds

```bash
pip install 'pymodbus[serial]>=3.11'
python -m pymodbus.simulator --http_port 8081 --modbus_port 5020
```

Port **5020**, not 502 — unprivileged, no `sudo`.

For a slave with a known register map (two units, float32 CDAB values at address 100), use the
script in `docs/06-testing.md#a-local-tcp-slave`. Two units matters: it's what exercises "change
the unit ID on the fly".

Connect ModbusOpen to `127.0.0.1:5020`, unit `1`, FC03, start `100`, qty `10`.

## Virtual serial pair for RTU

**macOS / Linux:**
```bash
socat -d -d pty,raw,echo=0,link=/tmp/ttyA pty,raw,echo=0,link=/tmp/ttyB
diagslave -m rtu -b 9600 -d 8 -p none -s 1 /tmp/ttyA
```
Then connect ModbusOpen to `/tmp/ttyB` at 9600 8-N-1.

**Windows:** install com0com, pair `COM10`↔`COM11`.

> ⚠️ A pty pair proves framing and parsing. It does **not** reproduce RS-485 timing, turnaround
> delay, or noise. Always do a final check against a real USB-RS485 adapter before signing off RTU work.

## Cross-check with a reference

When ModbusOpen and a device disagree, `mbpoll` is the tiebreaker. If they differ, ModbusOpen is wrong.

```bash
# TCP — note -0 for 0-based addressing, -t 4 for holding registers
mbpoll -m tcp -a 1 -r 100 -c 10 -0 -t 4 127.0.0.1 -p 5020

# RTU
mbpoll -m rtu -b 9600 -P none -a 1 -r 100 -c 10 -0 -t 4 /tmp/ttyB

# float32 interpretation
mbpoll -m tcp -a 1 -r 100 -c 4 -0 -t 4:float 127.0.0.1 -p 5020
```

Install: `brew install mbpoll` / `sudo apt install mbpoll`. `diagslave` and `modpoll` are free
binaries from modbusdriver.com.

## Verify bytes on the wire

```bash
sudo tcpdump -i lo0 -X 'tcp port 5020'
```

Or Wireshark with filter `tcp.port == 5020` — it dissects Modbus natively and gives a
field-by-field breakdown to compare against ModbusOpen's frame log. They must match byte for byte.

## Reproduce the real device data

To test against what actual hardware produces, replay the existing simulator scripts:

1. Start the local pymodbus slave.
2. Point `electrical_write_data.py` at `127.0.0.1:5020` (edit `HOST`/`PORT`).
3. Point ModbusOpen at the same slave: unit 1, FC03, start 100, qty 120, format `float32 CDAB`.
4. Values must land in the script's generated ranges — Active Power 145–155, Power Factor
   0.95–0.99, Frequency 49.9–50.1.

Those scripts need `pymodbus` 2.x (`pymodbus.client.sync`, `BinaryPayloadBuilder`). Rather than
fight the version, use the map in `docs/reference/device-profiles.md` to build an equivalent slave
on modern pymodbus.

## Failure cases worth testing deliberately

Robustness bugs hide here. Each should produce a clear message, not a hang or a crash.

| Scenario | How to produce it |
|---|---|
| Connection refused | Point at `127.0.0.1:9999` with nothing listening |
| Timeout | Point at an unroutable IP like `10.255.255.1` |
| Exception 02 | Read a start address past the end of the slave's map |
| Exception 03 | Request 200 registers with FC03 (should be caught client-side first) |
| Mid-poll disconnect | Kill the slave process while polling |
| Serial port vanishes | Unplug the USB adapter, or `Ctrl-C` the `socat` process |
| Port busy | Open the same serial port in two apps |
| Wrong unit ID | Poll unit 99 on a slave that only serves 1 and 2 |
