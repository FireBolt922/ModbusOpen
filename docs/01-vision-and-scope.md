# 01 — Vision and scope

## The 30-second test

A controls engineer is standing at a panel. A meter isn't reporting. They have a laptop.

> Open ModbusOpen → click **Scan** → click **TCP** → type `192.168.1.69`, unit `1` → **Connect** →
> start address `100`, quantity `20`, FC03 → values appear → set format to `float32 CDAB` →
> "ah, it's reporting 0.0, the meter is the problem, not my gateway."

That whole sequence should take under 30 seconds and require reading nothing. If a change makes
that path longer, the change is wrong.

## Who it's for

**Primary — the field/commissioning engineer.** Needs to know whether a device is alive and what
it's saying. Doesn't want to install Python. Doesn't want to read a manual. Is often on someone
else's laptop, possibly a Mac, possibly Ubuntu.

**Secondary — the firmware/integration developer.** Building a Modbus master and needs a fake
slave to develop against, plus a frame log to see exactly what went on the wire. Today they write
throwaway `pymodbus` scripts (see [device profiles](reference/device-profiles.md) — this project
literally started from a folder of them).

**Not for:** SCADA operators (that's an HMI), or anyone who needs a historian.

## The two modes

### Scan — Modbus master

Read and write a device's registers.

| Capability | v1 |
|---|---|
| Transports | TCP, RTU |
| Read function codes | FC01 coils, FC02 discrete inputs, FC03 holding, FC04 input |
| Write function codes | FC05, FC06, FC15, FC16 |
| Polling | Configurable interval, pause/resume, retune without reconnect |
| Data formats | 16/32/64-bit int, uint, float, double × 4 word orders, plus hex and binary |
| Unit/slave ID | Editable live, no reconnect |
| Diagnostics | TX/RX/error counters, latency, decoded exception names, raw hex frame log |
| Export | CSV snapshot; optional continuous append |

### Simulate — Modbus slave

Pretend to be a device.

| Capability | v1 |
|---|---|
| Transports | TCP (listen), RTU (serial) |
| Slaves | Multiple slave IDs on one transport |
| Blocks | Coils, discrete inputs, input registers, holding registers — arbitrary start + count |
| Tag behaviour | static, random(min,max), ramp, sine, counter |
| Typed tags | A `float32 CDAB` tag occupies and correctly fills two registers |
| Live table | Editable; reflects writes from a connected master in real time |
| Profiles | JSON device profiles, three shipped from real meters/VFDs |

## Explicitly out of scope for v1

See [PLAN.md §5](../PLAN.md#5-deliberately-not-in-v1). Summary: no ASCII, no exotic function codes,
no charts, no scripting, no tabs, no discovery, no TLS/MQTT/OPC-UA, no mobile.

## How we compare

| | ModbusOpen | ModScan/ModSim | Modbus Poll | QModMaster | ModbusTools | mbpoll/diagslave |
|---|---|---|---|---|---|---|
| Price | Free, OSS | Paid | Paid | Free, OSS | Free, OSS | Free, OSS |
| Windows | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| macOS | ✅ | ❌ | ❌ | ⚠️ build it yourself | ❌ | ✅ |
| Linux | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ |
| GUI | Modern | 1998 | 2005 | Qt-plain | Qt-plain | None (CLI) |
| Scanner + simulator in one | ✅ | Two products | Two products | Master only | ✅ | Two binaries |
| Raw frame log | ✅ built in | ⚠️ | ✅ | ✅ | ⚠️ | ❌ |
| Live word-order switching | ✅ | ✅ | ✅ | ⚠️ | ✅ | ❌ |
| Install footprint | ~10 MB, no runtime | Installer | Installer | Qt runtime | Qt runtime | Single binary |

**Where we win:** genuinely cross-platform, free, modern UI, both roles in one app, and a frame
log that's a first-class view rather than a buried dialog.

**Where we don't try to win:** breadth of exotic function codes, and the decades of field-proven
edge cases behind Modbus Poll. We're the tool you reach for first, not the tool of last resort.

## Principles

1. **Zero-to-value in 30 seconds.** Defaults everywhere. Port 502, unit 1, FC03, 1000 ms.
2. **Never lie.** If we can't decode it, show the hex and say so. Wrong numbers are the one
   unforgivable failure for a diagnostic tool.
3. **Raw is always one glance away.** Hex next to every value; the frame log is one shortcut away.
4. **Errors teach.** Every failure message says what to try next.
5. **Small and fast.** Under 15 MB, cold start under 2 seconds, no runtime prerequisites.
6. **Grow by earning it.** Ship v1 narrow. Features get added when someone hits the wall, not
   because a competitor has a checkbox.
